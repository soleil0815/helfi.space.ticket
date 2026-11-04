// Two-factor login: not needed internally, required externally
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mfa-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';
// Test server runs on 127.0.0.1 = trusted proxy → X-Forwarded-For determines the client IP

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { totpAt, currentStep, verifyTotp, base32Encode, base32Decode, generateRecoveryCodes, useRecoveryCode } = await import('../src/auth/totp.js');
const { parseNetworks, normalizeIp, createNetworkPolicy, readDefaultGateway } = await import('../src/auth/network.js');

const INTERN = '10.0.10.25';
const EXTERN = '203.0.113.7';
let server; let base; let db; let ctx;

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client(ip) {
  const jar = {};
  const fn = async (method, url, body, extraHeaders = {}) => {
    const headers = { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', ...(ip ? { 'X-Forwarded-For': ip } : {}), ...extraHeaders };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const [k, v] = kv.split('=');
      if (/Expires=Thu, 01 Jan 1970/i.test(sc) || v === '') delete jar[k]; else jar[k] = v;
    }
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  fn.jar = jar;
  return fn;
}
const code = (secret) => totpAt(secret, currentStep());

test('TOTP per RFC 6238 (test vector) and Base32', () => {
  // RFC 6238, SHA1, time 59 s → 94287082 (8 digits) → last 6: 287082
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.deepEqual(base32Decode(base32Encode(Buffer.from('hallo welt'))), Buffer.from('hallo welt'));
  const now = 1111111109 * 1000;
  assert.equal(verifyTotp(secret, '081804', { now }), Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(secret, '081804', { now, lastStep: Math.floor(1111111109 / 30) }), null, 'not twice');
  assert.equal(verifyTotp(secret, '000000', { now }), null);
  assert.equal(verifyTotp(secret, 'abc', { now }), null);
});

test('Recovery codes: single use', () => {
  const { codes, hashes } = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.match(codes[0], /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  const rest = useRecoveryCode(hashes, codes[3].toUpperCase().replace('-', ' '));
  assert.equal(rest.length, 9);
  assert.equal(useRecoveryCode(rest, codes[3]), null);
});

test('Network detection, proxy and Docker gateway rules', () => {
  const { list, invalid } = parseNetworks('10.0.0.0/8, 192.168.1.5, fd00::/8, quatsch, 10.0.0.0/40');
  assert.deepEqual(invalid, ['quatsch', '10.0.0.0/40']);
  assert.equal(list.check('10.9.9.9', 'ipv4'), true);
  assert.equal(list.check('192.168.1.6', 'ipv4'), false);
  assert.equal(list.check('fd00::1', 'ipv6'), true);
  assert.equal(normalizeIp('::ffff:10.1.1.1'), '10.1.1.1');

  const settings = { get: (k) => ({ 'mfa.internalNetworks': '172.16.0.0/12, 10.0.0.0/8', 'mfa.mode': 'external' }[k]) };
  const p = createNetworkPolicy(settings, { gateway: '172.17.0.1' });
  const req = (ip, peer = ip, xff) => ({ ip, socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(p.isInternal(req('10.0.0.5')), true);
  assert.equal(p.isInternal(req('8.8.8.8')), false);
  assert.equal(p.isInternal(req('::ffff:10.0.0.5')), true);
  assert.equal(p.isInternal(req('172.17.0.1')), false, 'Docker gateway does not automatically count as internal');
  assert.equal(p.isInternal(req('10.0.0.9', '10.0.0.9', '8.8.8.8')), false, 'X-Forwarded-For from an untrusted proxy → external');
  assert.equal(p.mfaRequired(req('8.8.8.8')), true);
  assert.equal(p.mfaRequired(req('10.0.0.5')), false);
  const explicit = createNetworkPolicy({ get: (k) => ({ 'mfa.internalNetworks': '172.17.0.1', 'mfa.mode': 'external' }[k]) }, { gateway: '172.17.0.1' });
  assert.equal(explicit.isInternal(req('172.17.0.1')), true, 'listed individually = internal');
  assert.equal(readDefaultGateway('/gibts/nicht'), null);
});

test('Setup and internal login without second factor', async () => {
  const intern = client(INTERN);
  let r = await intern('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  assert.equal(r.status, 200);
  await intern('POST', '/api/users', { username: 'max', displayName: 'Max', role: 'agent', password: 'Sehrgeheim123' });
  const max = client(INTERN);
  r = await max('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.equal(r.status, 200);
  assert.ok(r.body.user, 'internal: logged in directly');
  assert.equal((await max('GET', '/api/me')).status, 200);
});

test('External without 2FA set up: no access, no setup from outside', async () => {
  const ext = client(EXTERN);
  const r = await ext('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'err.mfaEnrollInternal');
  // Profile setup from outside does not work either (no session)
  assert.equal((await ext('POST', '/api/me/mfa/setup')).status, 401);
});

test('Internal session is not valid when used from outside', async () => {
  const s = client(INTERN);
  await s('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.equal((await s('GET', '/api/me')).status, 200);
  // Same cookie, different origin (laptop at home)
  const moved = client(EXTERN);
  Object.assign(moved.jar, s.jar);
  const r = await moved('GET', '/api/me');
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'err.mfaRequired');
  assert.equal((await moved('GET', '/api/bootstrap')).body.user, null);
});

let secret; let recovery;
test('Set up 2FA in the profile (internally), then log in externally with a code', async () => {
  const s = client(INTERN);
  await s('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  let st = (await s('GET', '/api/me/mfa')).body;
  assert.equal(st.enabled, false);
  assert.equal(st.network.internal, true);
  assert.equal(st.network.ip, INTERN);
  const setup = (await s('POST', '/api/me/mfa/setup')).body;
  assert.match(setup.uri, /^otpauth:\/\/totp\/Helfi\.Space%3Amax\?secret=[A-Z2-7]+/);
  assert.match(setup.qr, /^data:image\/svg\+xml;base64,/);
  assert.equal((await s('POST', '/api/me/mfa/enable', { code: '000000' })).status, 400);
  const en = await s('POST', '/api/me/mfa/enable', { code: code(setup.secret) });
  assert.equal(en.status, 200);
  assert.equal(en.body.recoveryCodes.length, 10);
  secret = setup.secret;
  recovery = en.body.recoveryCodes;
  st = (await s('GET', '/api/me/mfa')).body;
  assert.equal(st.enabled, true);
  const raw = db.prepare("SELECT totp_secret, recovery_codes FROM users WHERE username='max'").get();
  assert.ok(raw.totp_secret.startsWith('v1:') && !raw.totp_secret.includes(secret), 'secret encrypted');
  assert.ok(!raw.recovery_codes.includes(recovery[0]), 'only hashes stored');

  // External: password → code required
  const ext = client(EXTERN);
  let r = await ext('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.deepEqual(r.body, { mfa: 'code' });
  assert.equal((await ext('GET', '/api/me')).status, 401, 'no session yet');
  r = await ext('POST', '/api/auth/mfa', { code: '123456' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'err.mfaInvalid');
  // The code just used (setup) is consumed → simulating the next time step's code is not possible; use a recovery code
  r = await ext('POST', '/api/auth/mfa', { code: recovery[0] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.usedRecovery, true);
  assert.equal((await ext('GET', '/api/me')).status, 200, 'logged in externally');
  assert.equal(JSON.parse(db.prepare("SELECT recovery_codes FROM users WHERE username='max'").get().recovery_codes).length, 9);
});

test('External with app code; code only once; half-login expires after failed attempts', async () => {
  // Reset the time step so the current code is valid again
  db.prepare("UPDATE users SET totp_last_step=0 WHERE username='max'").run();
  const ext = client(EXTERN);
  await ext('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  let r = await ext('POST', '/api/auth/mfa', { code: code(secret) });
  assert.equal(r.status, 200);
  const ext2 = client(EXTERN);
  await ext2('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  r = await ext2('POST', '/api/auth/mfa', { code: code(secret) });
  assert.equal(r.status, 401, 'the same code not a second time');
  // Without a prior password login there is no code step
  const anon = client(EXTERN);
  assert.equal((await anon('POST', '/api/auth/mfa', { code: '123456' })).body.error.code, 'err.mfaExpired');
  // 5 failed attempts → expired
  ctx.limiter.success(EXTERN, 'max');
  const b = client(EXTERN);
  await b('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  let last;
  for (let i = 0; i < 5; i++) last = await b('POST', '/api/auth/mfa', { code: String(100000 + i) });
  assert.equal(last.body.error.code, 'err.mfaExpired');
  assert.equal((await b('POST', '/api/auth/mfa', { code: code(secret) })).body.error.code, 'err.mfaExpired');
  ctx.limiter.success(EXTERN, 'max');
});

test('Admin resets 2FA; enrollment at login (internal, mode "always")', async () => {
  const adm = client(INTERN);
  await adm('POST', '/api/auth/login', { username: 'admin', password: 'Sehrgeheim123' });
  const maxId = db.prepare("SELECT id FROM users WHERE username='max'").get().id;
  assert.equal((await adm('PATCH', `/api/users/${maxId}`, { resetMfa: true })).status, 200);
  assert.equal(db.prepare('SELECT totp_enabled FROM users WHERE id=?').get(maxId).totp_enabled, 0);

  await adm('PUT', '/api/admin/settings', { settings: { 'mfa.mode': 'always' } });
  const s = client(INTERN);
  let r = await s('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.deepEqual(r.body, { mfa: 'enroll' });
  const info = (await s('POST', '/api/auth/mfa/enroll')).body;
  r = await s('POST', '/api/auth/mfa', { code: code(info.secret) });
  assert.equal(r.status, 200);
  secret = info.secret;
  assert.equal(r.body.recoveryCodes.length, 10);
  assert.equal((await s('GET', '/api/me')).status, 200);
  // Admin session comes from a login without factor → no longer valid with "always"
  assert.equal((await adm('GET', '/api/me')).status, 401);
  // back to the default
  ctx.settings.set('mfa.mode', 'external');
});

test('Setup from outside only if explicitly allowed', async () => {
  ctx.settings.set('mfa.enrollExternal', true);
  const ext = client(EXTERN);
  const r = await ext('POST', '/api/auth/login', { username: 'agentlos', password: 'x' });
  assert.equal(r.status, 401);
  const adm = client(INTERN);
  await adm('POST', '/api/auth/login', { username: 'admin', password: 'Sehrgeheim123' });
  await adm('POST', '/api/users', { username: 'remote', displayName: 'Remote', role: 'agent', password: 'Sehrgeheim123' });
  const rem = client(EXTERN);
  assert.deepEqual((await rem('POST', '/api/auth/login', { username: 'remote', password: 'Sehrgeheim123' })).body, { mfa: 'enroll' });
  ctx.settings.set('mfa.enrollExternal', false);
});

test('Disabling 2FA needs a valid code', async () => {
  const s = client(INTERN);
  await s('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.equal((await s('POST', '/api/me/mfa/disable', { code: '000000' })).status, 400);
  db.prepare("UPDATE users SET totp_last_step=0 WHERE username='max'").run();
  assert.equal((await s('POST', '/api/me/mfa/disable', { code: code(secret) })).status, 200);
  assert.equal(ctx.users.byName('max').totp_enabled, 0);
});

test('SSO login counts as second factor (default)', () => {
  const res = { cookie() {}, clearCookie() {} };
  const u = ctx.users.byName('max');
  const out = ctx.mfa.afterPrimary({ ip: EXTERN, socket: { remoteAddress: EXTERN }, headers: {} }, res, u, 'oidc', { trustedSecondFactor: true });
  assert.deepEqual(out, { done: true });
  assert.equal(db.prepare("SELECT mfa FROM sessions WHERE auth_method='oidc' ORDER BY created_at DESC").get().mfa, 1);
});

test('Requirement per role: users from outside without code, agents with; invalid level rejected', async () => {
  const adm = client(INTERN);
  await adm('POST', '/api/auth/login', { username: 'admin', password: 'Sehrgeheim123' });
  assert.equal((await adm('PUT', '/api/admin/settings', { settings: { 'mfa.external': 'alle' } })).status, 400);
  assert.equal((await adm('PUT', '/api/admin/settings', { settings: { 'mfa.external': 'agents', 'mfa.internal': 'none' } })).status, 200);
  const net = (await adm('GET', '/api/admin/mfa/network')).body;
  assert.deepEqual(net.levels, { external: 'agents', internal: 'none' });
  assert.ok(Array.isArray(net.own.ips));
  await adm('POST', '/api/users', { username: 'kunde', displayName: 'Kunde', role: 'user', password: 'Sehrgeheim123' });
  const k = client(EXTERN);
  const r = await k('POST', '/api/auth/login', { username: 'kunde', password: 'Sehrgeheim123' });
  assert.equal(r.status, 200);
  assert.ok(r.body.user);
  assert.equal((await k('GET', '/api/bootstrap')).body.mfa.mode, 'off');
  const rem = client(EXTERN);
  // Agents without a factor set up: locked out from outside (setup only internally)
  assert.equal((await rem('POST', '/api/auth/login', { username: 'remote', password: 'Sehrgeheim123' })).body.error.code, 'err.mfaEnrollInternal');
  ctx.settings.set('mfa.external', '');
  ctx.settings.set('mfa.internal', '');
});
