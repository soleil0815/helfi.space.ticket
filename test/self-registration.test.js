// Tests: self-registration (confirmation link, email contact takeover, approval) and "forgot password"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-register-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { parseDomains, domainAllowed, createRateLimit } = await import('../src/auth/selfservice.js');

let server; let base; let db; let ctx;
const sent = [];
before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  // Mail sending: record instead of SMTP
  ctx.mailer.enabled = () => true;
  ctx.mailer.send = async (m) => { sent.push(m); return true; };
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const headers = { Accept: 'application/json', 'X-Helfi-Request': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const admin = client();
const anon = client();
const PW = 'Sehrgeheim123';
const tick = () => new Promise((r) => setTimeout(r, 20));
/** Last mail to an address (mails go out in the background) */
async function mailTo(addr) {
  await tick();
  return [...sent].reverse().find((m) => m.to === addr);
}
const tokenFrom = (mail) => mail.text.match(/#([A-Za-z0-9_-]{20,})/)[1];

test('Setup', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: PW, email: 'admin@firma.example', projectKey: 'IT', projectName: 'IT' })).status, 200);
});

test('Registration is off by default and hidden on the sign-in page', async () => {
  const boot = (await anon('GET', '/api/bootstrap')).body;
  assert.equal(boot.auth.register, false);
  const r = await anon('POST', '/api/auth/register', { displayName: 'Eva', email: 'eva@partner.example', password: PW });
  assert.equal(r.status, 404);
  assert.equal(sent.length, 0);
});

test('Without working mail sending there is no registration even if enabled', async () => {
  ctx.settings.set('register.enabled', true);
  ctx.mailer.enabled = () => false;
  assert.equal((await anon('GET', '/api/bootstrap')).body.auth.register, false);
  assert.equal((await anon('POST', '/api/auth/register', { displayName: 'Eva', email: 'eva@partner.example', password: PW })).status, 404);
  ctx.mailer.enabled = () => true;
  assert.equal((await anon('GET', '/api/bootstrap')).body.auth.register, true);
});

test('Register → confirmation link → the email contact becomes the account with its tickets', async () => {
  // Eva mailed before: email contact with a ticket
  const contact = ctx.users.contactForEmail('eva@partner.example', 'Eva Extern');
  const ticket = ctx.tickets.create(contact, { title: 'Drucker', description: 'geht nicht', type: 'request' }, { source: 'email', reporterEmail: 'eva@partner.example', reporterId: contact.id });

  const r = await anon('POST', '/api/auth/register', { displayName: 'Eva Muster', email: 'Eva@Partner.example', password: PW, language: 'de' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  const mail = await mailTo('eva@partner.example');
  assert.match(mail.subject, /bestätigen/);
  assert.ok(mail.text.includes('/register/confirm#'), 'token in the fragment, not in the query');
  const token = tokenFrom(mail);
  // Only the hash is stored, and nothing is created before the confirmation
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_tokens WHERE token_hash=?').get(token).n, 0);
  assert.equal(ctx.users.byId(contact.id).source, 'email');
  assert.equal((await anon('POST', '/api/auth/login', { username: 'eva@partner.example', password: PW })).status, 401);

  const c = await anon('POST', '/api/auth/register/confirm', { token });
  assert.equal(c.status, 200);
  assert.equal(c.body.pending, false);
  const u = ctx.users.byId(contact.id);
  assert.equal(u.source, 'local', 'same row – tickets stay with it');
  assert.equal(u.username, 'eva@partner.example');
  assert.equal(u.role, 'user');
  assert.equal(u.self_registered, 1);
  assert.equal(u.display_name, 'Eva Muster');
  // The link works only once
  assert.equal((await anon('POST', '/api/auth/register/confirm', { token })).status, 400);

  const eva = client();
  const login = await eva('POST', '/api/auth/login', { username: 'eva@partner.example', password: PW });
  assert.equal(login.status, 200);
  const list = (await eva('GET', '/api/tickets')).body;
  assert.ok(JSON.stringify(list).includes(ticket.key), 'previous request visible');
});

test('Self-registered accounts cannot move their address to someone else\'s contact', async () => {
  const other = ctx.users.contactForEmail('opfer@partner.example', 'Opfer');
  ctx.tickets.create(other, { title: 'Geheim', description: 'x', type: 'request' }, { source: 'email', reporterEmail: 'opfer@partner.example', reporterId: other.id });
  const eva = client();
  await eva('POST', '/api/auth/login', { username: 'eva@partner.example', password: PW });
  const r = await eva('PATCH', '/api/me', { email: 'opfer@partner.example', currentPassword: PW });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.emailFixed');
  assert.equal(ctx.users.byId(other.id).source, 'email', 'contact untouched');
  // Name and unchanged address are fine
  assert.equal((await eva('PATCH', '/api/me', { displayName: 'Eva M.', email: 'eva@partner.example' })).status, 200);
});

test('Registering an address that already has an account reveals nothing on the page', async () => {
  const before = sent.length;
  const r = await anon('POST', '/api/auth/register', { displayName: 'Jemand', email: 'admin@firma.example', password: 'Anderes1234' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true }, 'same answer as for a new address');
  const mail = await mailTo('admin@firma.example');
  assert.ok(sent.length > before);
  assert.match(mail.subject, /bereits ein Konto/);
  assert.ok(!/#[A-Za-z0-9_-]{20,}/.test(mail.text), 'no confirmation link');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account_tokens WHERE email='admin@firma.example'").get().n, 0);
});

test('Domains, bot field, weak password', async () => {
  ctx.settings.set('register.domains', 'partner.example');
  const r = await anon('POST', '/api/auth/register', { displayName: 'X', email: 'x@anders.example', password: PW });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.registerDomain');
  assert.equal((await anon('POST', '/api/auth/register', { displayName: 'X', email: 'x@sub.partner.example', password: 'kurz' })).status, 400);
  const before = sent.length;
  assert.equal((await anon('POST', '/api/auth/register', { displayName: 'Bot', email: 'bot@partner.example', password: PW, website: 'http://spam.example' })).status, 200);
  await tick();
  assert.equal(sent.length, before, 'bot field filled in: nothing sent');
  ctx.settings.set('register.domains', '');

  assert.deepEqual(parseDomains('@a.example, *.b.example\nC.example'), ['a.example', 'b.example', 'c.example']);
  assert.ok(domainAllowed('x@sub.a.example', ['a.example']));
  assert.ok(!domainAllowed('x@nota.example', ['a.example']));
  assert.ok(domainAllowed('x@any.example', []));
});

test('Approval: account stays inactive until an admin approves it, admins and the person are told', async () => {
  ctx.settings.set('register.approval', true);
  await anon('POST', '/api/auth/register', { displayName: 'Paul', email: 'paul@partner.example', password: PW });
  const token = tokenFrom(await mailTo('paul@partner.example'));
  const c = await anon('POST', '/api/auth/register/confirm', { token });
  assert.equal(c.body.pending, true);
  assert.match((await mailTo('admin@firma.example')).subject, /Freigabe/);

  const paul = client();
  let login = await paul('POST', '/api/auth/login', { username: 'paul@partner.example', password: PW });
  assert.equal(login.status, 403);
  assert.equal(login.body.error.code, 'err.approvalPending');
  // Wrong password: the usual answer (no hint about the pending account)
  assert.equal((await paul('POST', '/api/auth/login', { username: 'paul@partner.example', password: 'Falsch12345' })).status, 401);

  const boot = (await admin('GET', '/api/bootstrap')).body;
  assert.ok(boot.warnings.some((w) => w.code === 'accountsPending' && w.count === 1));
  const u = ctx.users.byName('paul@partner.example');
  const r = await admin('PATCH', `/api/users/${u.id}`, { active: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.approvalPending, false);
  assert.match((await mailTo('paul@partner.example')).subject, /freigeschaltet/);
  login = await paul('POST', '/api/auth/login', { username: 'paul@partner.example', password: PW });
  assert.equal(login.status, 200);
  ctx.settings.set('register.approval', false);
});

test('Forgot password: link by mail, only once, signs out everywhere', async () => {
  const eva = client();
  assert.equal((await eva('POST', '/api/auth/login', { username: 'eva@partner.example', password: PW })).status, 200);
  assert.equal((await anon('GET', '/api/bootstrap')).body.auth.passwordReset, true);

  const r = await anon('POST', '/api/auth/password/forgot', { email: 'EVA@partner.example' });
  assert.deepEqual(r.body, { ok: true });
  const mail = await mailTo('eva@partner.example');
  assert.ok(mail.text.includes('/reset#'));
  const token = tokenFrom(mail);

  assert.equal((await anon('POST', '/api/auth/password/reset', { token, password: 'kurz' })).status, 400);
  assert.equal((await anon('POST', '/api/auth/password/reset', { token: 'falsch', password: 'NeuesKennwort1' })).status, 400);
  assert.equal((await anon('POST', '/api/auth/password/reset', { token, password: 'NeuesKennwort1' })).status, 200);
  assert.match((await mailTo('eva@partner.example')).subject, /geändert/);
  assert.equal((await anon('POST', '/api/auth/password/reset', { token, password: 'NochEinsNeu12' })).status, 400, 'only once');
  assert.equal((await eva('GET', '/api/me')).status, 401, 'old session ended');
  assert.equal((await client()('POST', '/api/auth/login', { username: 'eva@partner.example', password: 'NeuesKennwort1' })).status, 200);
});

test('Forgot password: same answer for unknown addresses, admins only with "all"', async () => {
  let before = sent.length;
  assert.deepEqual((await anon('POST', '/api/auth/password/forgot', { email: 'niemand@partner.example' })).body, { ok: true });
  // Admin account (role admin): not with the default "users"
  assert.deepEqual((await anon('POST', '/api/auth/password/forgot', { email: 'admin@firma.example' })).body, { ok: true });
  await tick();
  assert.equal(sent.length, before, 'no mails');

  ctx.settings.set('register.passwordReset', 'all');
  before = sent.length;
  await anon('POST', '/api/auth/password/forgot', { email: 'admin@firma.example' });
  await tick();
  assert.equal(sent.length, before + 1);
  ctx.settings.set('register.passwordReset', 'off');
  assert.equal((await anon('GET', '/api/bootstrap')).body.auth.passwordReset, false);
  assert.equal((await anon('POST', '/api/auth/password/forgot', { email: 'eva@partner.example' })).status, 404);
  ctx.settings.set('register.passwordReset', 'users');
});

test('Reset link no longer works once the account was disabled', async () => {
  await anon('POST', '/api/auth/password/forgot', { email: 'paul@partner.example' });
  const token = tokenFrom(await mailTo('paul@partner.example'));
  const u = ctx.users.byName('paul@partner.example');
  await admin('PATCH', `/api/users/${u.id}`, { active: false });
  assert.equal((await anon('POST', '/api/auth/password/reset', { token, password: 'NeuesKennwort1' })).status, 400);
  await admin('PATCH', `/api/users/${u.id}`, { active: true });
});

test('Expired links are refused and cleaned up', async () => {
  await anon('POST', '/api/auth/register', { displayName: 'Spät', email: 'spaet@partner.example', password: PW });
  const token = tokenFrom(await mailTo('spaet@partner.example'));
  db.prepare("UPDATE account_tokens SET expires_at=? WHERE email='spaet@partner.example'").run(Date.now() - 1000);
  assert.equal((await anon('POST', '/api/auth/register/confirm', { token })).status, 400);
  assert.ok(ctx.selfService.purgeExpired() >= 1);
  assert.equal(ctx.users.byName('spaet@partner.example'), undefined);
});

test('Rate limit', () => {
  const rl = createRateLimit({ limit: 2, windowMs: 1000 });
  assert.ok(rl.take('a', 0));
  assert.ok(rl.take('a', 10));
  assert.ok(!rl.take('a', 20));
  assert.ok(rl.take('b', 20));
  assert.ok(rl.take('a', 1500), 'window passed');
});

test('Admin settings validate the reset mode and tidy the domain list', async () => {
  assert.equal((await admin('PUT', '/api/admin/settings', { settings: { 'register.passwordReset': 'jeder' } })).status, 400);
  const r = await admin('PUT', '/api/admin/settings', { settings: { 'register.domains': '@Partner.example, firma.example' } });
  assert.equal(r.status, 200);
  assert.equal(ctx.settings.get('register.domains'), 'partner.example\nfirma.example');
});
