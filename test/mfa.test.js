// Zwei-Faktor-Anmeldung: intern ohne, extern Pflicht
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mfa-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';
// Testserver läuft auf 127.0.0.1 = vertrauter Proxy → X-Forwarded-For bestimmt die Client-IP

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

test('TOTP nach RFC 6238 (Testvektor) und Base32', () => {
  // RFC 6238, SHA1, Zeit 59 s → 94287082 (8 Stellen) → letzte 6: 287082
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.deepEqual(base32Decode(base32Encode(Buffer.from('hallo welt'))), Buffer.from('hallo welt'));
  const now = 1111111109 * 1000;
  assert.equal(verifyTotp(secret, '081804', { now }), Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(secret, '081804', { now, lastStep: Math.floor(1111111109 / 30) }), null, 'nicht zweimal');
  assert.equal(verifyTotp(secret, '000000', { now }), null);
  assert.equal(verifyTotp(secret, 'abc', { now }), null);
});

test('Wiederherstellungscodes: einmalig', () => {
  const { codes, hashes } = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.match(codes[0], /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  const rest = useRecoveryCode(hashes, codes[3].toUpperCase().replace('-', ' '));
  assert.equal(rest.length, 9);
  assert.equal(useRecoveryCode(rest, codes[3]), null);
});

test('Netze erkennen, Proxy- und Docker-Gateway-Regeln', () => {
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
  assert.equal(p.isInternal(req('172.17.0.1')), false, 'Docker-Gateway zählt nicht automatisch als intern');
  assert.equal(p.isInternal(req('10.0.0.9', '10.0.0.9', '8.8.8.8')), false, 'X-Forwarded-For von nicht vertrautem Proxy → extern');
  assert.equal(p.mfaRequired(req('8.8.8.8')), true);
  assert.equal(p.mfaRequired(req('10.0.0.5')), false);
  const explicit = createNetworkPolicy({ get: (k) => ({ 'mfa.internalNetworks': '172.17.0.1', 'mfa.mode': 'external' }[k]) }, { gateway: '172.17.0.1' });
  assert.equal(explicit.isInternal(req('172.17.0.1')), true, 'einzeln eingetragen = intern');
  assert.equal(readDefaultGateway('/gibts/nicht'), null);
});

test('Einrichtung und interne Anmeldung ohne zweiten Faktor', async () => {
  const intern = client(INTERN);
  let r = await intern('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  assert.equal(r.status, 200);
  await intern('POST', '/api/users', { username: 'max', displayName: 'Max', role: 'agent', password: 'Sehrgeheim123' });
  const max = client(INTERN);
  r = await max('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.equal(r.status, 200);
  assert.ok(r.body.user, 'intern: direkt angemeldet');
  assert.equal((await max('GET', '/api/me')).status, 200);
});

test('Extern ohne eingerichtete 2FA: kein Zugang, kein Einrichten von außen', async () => {
  const ext = client(EXTERN);
  const r = await ext('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'err.mfaEnrollInternal');
  // Profil-Einrichtung von außen geht auch nicht (keine Sitzung)
  assert.equal((await ext('POST', '/api/me/mfa/setup')).status, 401);
});

test('Interne Sitzung gilt nicht, wenn sie von außen benutzt wird', async () => {
  const s = client(INTERN);
  await s('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.equal((await s('GET', '/api/me')).status, 200);
  // Gleiches Cookie, andere Herkunft (Laptop zu Hause)
  const moved = client(EXTERN);
  Object.assign(moved.jar, s.jar);
  const r = await moved('GET', '/api/me');
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'err.mfaRequired');
  assert.equal((await moved('GET', '/api/bootstrap')).body.user, null);
});

let secret; let recovery;
test('2FA im Profil einrichten (intern), dann extern mit Code anmelden', async () => {
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
  assert.ok(raw.totp_secret.startsWith('v1:') && !raw.totp_secret.includes(secret), 'Schlüssel verschlüsselt');
  assert.ok(!raw.recovery_codes.includes(recovery[0]), 'nur Hashes gespeichert');

  // Extern: Kennwort → Code verlangt
  const ext = client(EXTERN);
  let r = await ext('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.deepEqual(r.body, { mfa: 'code' });
  assert.equal((await ext('GET', '/api/me')).status, 401, 'noch keine Sitzung');
  r = await ext('POST', '/api/auth/mfa', { code: '123456' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'err.mfaInvalid');
  // Der Code von eben (Einrichtung) ist verbraucht → Code des nächsten Zeitschritts simulieren geht nicht; nimm Wiederherstellungscode
  r = await ext('POST', '/api/auth/mfa', { code: recovery[0] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.usedRecovery, true);
  assert.equal((await ext('GET', '/api/me')).status, 200, 'extern angemeldet');
  assert.equal(JSON.parse(db.prepare("SELECT recovery_codes FROM users WHERE username='max'").get().recovery_codes).length, 9);
});

test('Extern mit App-Code; Code nur einmal; Halb-Anmeldung läuft nach Fehlversuchen ab', async () => {
  // Zeitschritt zurücksetzen, damit der aktuelle Code wieder gilt
  db.prepare("UPDATE users SET totp_last_step=0 WHERE username='max'").run();
  const ext = client(EXTERN);
  await ext('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  let r = await ext('POST', '/api/auth/mfa', { code: code(secret) });
  assert.equal(r.status, 200);
  const ext2 = client(EXTERN);
  await ext2('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  r = await ext2('POST', '/api/auth/mfa', { code: code(secret) });
  assert.equal(r.status, 401, 'derselbe Code kein zweites Mal');
  // Ohne vorherige Kennwort-Anmeldung gibt es keinen Code-Schritt
  const anon = client(EXTERN);
  assert.equal((await anon('POST', '/api/auth/mfa', { code: '123456' })).body.error.code, 'err.mfaExpired');
  // 5 Fehlversuche → abgelaufen
  ctx.limiter.success(EXTERN, 'max');
  const b = client(EXTERN);
  await b('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  let last;
  for (let i = 0; i < 5; i++) last = await b('POST', '/api/auth/mfa', { code: String(100000 + i) });
  assert.equal(last.body.error.code, 'err.mfaExpired');
  assert.equal((await b('POST', '/api/auth/mfa', { code: code(secret) })).body.error.code, 'err.mfaExpired');
  ctx.limiter.success(EXTERN, 'max');
});

test('Admin setzt 2FA zurück; Ersteinrichtung bei der Anmeldung (intern, Modus "immer")', async () => {
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
  // Admin-Sitzung stammt aus Anmeldung ohne Faktor → bei "immer" nicht mehr gültig
  assert.equal((await adm('GET', '/api/me')).status, 401);
  // zurück auf den Standard
  ctx.settings.set('mfa.mode', 'external');
});

test('Einrichtung von außen nur, wenn ausdrücklich erlaubt', async () => {
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

test('2FA abschalten braucht einen gültigen Code', async () => {
  const s = client(INTERN);
  await s('POST', '/api/auth/login', { username: 'max', password: 'Sehrgeheim123' });
  assert.equal((await s('POST', '/api/me/mfa/disable', { code: '000000' })).status, 400);
  db.prepare("UPDATE users SET totp_last_step=0 WHERE username='max'").run();
  assert.equal((await s('POST', '/api/me/mfa/disable', { code: code(secret) })).status, 200);
  assert.equal(ctx.users.byName('max').totp_enabled, 0);
});

test('SSO-Anmeldung zählt als zweiter Faktor (Standard)', () => {
  const res = { cookie() {}, clearCookie() {} };
  const u = ctx.users.byName('max');
  const out = ctx.mfa.afterPrimary({ ip: EXTERN, socket: { remoteAddress: EXTERN }, headers: {} }, res, u, 'oidc', { trustedSecondFactor: true });
  assert.deepEqual(out, { done: true });
  assert.equal(db.prepare("SELECT mfa FROM sessions WHERE auth_method='oidc' ORDER BY created_at DESC").get().mfa, 1);
});
