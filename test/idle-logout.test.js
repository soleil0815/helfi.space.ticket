// Tests: automatic sign-out after inactivity (periods per role/network, status vs. ping, browser session)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-idle-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { idleMinutes } = await import('../src/auth/session.js');

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

function client({ from } = {}) {
  let cookie = '';
  const c = async (method, url, body) => {
    const headers = { Accept: 'application/json', 'X-Helfi-Request': '1' };
    if (from) headers['X-Forwarded-For'] = from; // behind the (loopback) proxy
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    c.lastSetCookie = sc;
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return c;
}
const PW = 'Sehrgeheim123';
const MIN = 60000;
/** Pretend the last activity of all sessions of a user was this long ago */
const idleFor = (userId, ms) => db.prepare('UPDATE sessions SET last_seen=? WHERE user_id=?').run(Date.now() - ms, userId);

let adminId; let agentId;
test('Setup: admin and agent, office network is 127.0.0.1', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: PW, email: 'admin@firma.example', projectKey: 'IT', projectName: 'IT' })).status, 200);
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  ctx.settings.set('mfa.mode', 'off');
  adminId = ctx.users.byName('admin').id;
  agentId = ctx.users.createLocal({ username: 'anna', displayName: 'Anna', password: PW, role: 'agent', email: 'anna@firma.example' }).id;
});

test('Defaults: everyone 12 h (HELFI_SESSION_HOURS), admins 60 min; bootstrap tells the client', async () => {
  const anna = client();
  await anna('POST', '/api/auth/login', { username: 'anna', password: PW });
  const s = (await anna('GET', '/api/bootstrap')).body.session;
  assert.equal(s.idleMs, 12 * 60 * MIN);
  assert.equal(s.warnMs, 2 * MIN);
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: PW });
  assert.equal((await admin('GET', '/api/bootstrap')).body.session.idleMs, 60 * MIN);
  assert.equal((await client()('GET', '/api/bootstrap')).body.session, null, 'not signed in: nothing');
});

test('Idle too long: signed out; the agent still has time', async () => {
  const admin = client();
  const anna = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: PW });
  await anna('POST', '/api/auth/login', { username: 'anna', password: PW });
  idleFor(adminId, 61 * MIN);
  idleFor(agentId, 61 * MIN);
  const before = db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(adminId).n;
  assert.equal((await admin('GET', '/api/me')).status, 401, 'admin: 60 minutes');
  assert.equal((await anna('GET', '/api/me')).status, 200, 'agent: 12 hours');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(adminId).n, before - 1, 'session removed');
});

test('Status does not count as activity, ping does', async () => {
  const anna = client();
  await anna('POST', '/api/auth/login', { username: 'anna', password: PW });
  idleFor(agentId, 30 * MIN);
  const st = await anna('GET', '/api/session/status');
  assert.equal(st.status, 200);
  assert.ok(st.body.remainingMs < 12 * 60 * MIN - 29 * MIN, 'status left last activity alone');
  const seen = db.prepare('SELECT MAX(last_seen) t FROM sessions WHERE user_id=?').get(agentId).t;
  assert.ok(Date.now() - seen >= 29 * MIN);
  const p = await anna('POST', '/api/session/ping');
  assert.ok(p.body.remainingMs > 12 * 60 * MIN - MIN, 'ping renewed it');
});

test('Shorter period from outside the company network', async () => {
  ctx.settings.set('session.externalIdleMinutes', 30);
  const outside = client({ from: '203.0.113.7' });
  assert.equal((await outside('POST', '/api/auth/login', { username: 'anna', password: PW })).status, 200);
  assert.equal((await outside('GET', '/api/session/status')).body.idleMs, 30 * MIN);
  const inside = client();
  await inside('POST', '/api/auth/login', { username: 'anna', password: PW });
  assert.equal((await inside('GET', '/api/session/status')).body.idleMs, 12 * 60 * MIN);
  idleFor(agentId, 31 * MIN);
  assert.equal((await outside('GET', '/api/me')).status, 401);
  assert.equal((await inside('GET', '/api/me')).status, 200);
  ctx.settings.set('session.externalIdleMinutes', 0);
});

test('Everyone: own value instead of HELFI_SESSION_HOURS; admins never longer than everyone', async () => {
  ctx.settings.set('session.idleMinutes', 30);
  ctx.settings.set('session.adminIdleMinutes', 120);
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: PW });
  assert.equal((await admin('GET', '/api/session/status')).body.idleMs, 30 * MIN, 'the shorter one counts');
  ctx.settings.set('session.idleMinutes', 0);
  ctx.settings.set('session.adminIdleMinutes', 60);
});

test('Browser session: cookie without expiry', async () => {
  const anna = client();
  await anna('POST', '/api/auth/login', { username: 'anna', password: PW });
  assert.match(anna.lastSetCookie, /Max-Age=|Expires=/i);
  ctx.settings.set('session.browserSession', true);
  const bob = client();
  await bob('POST', '/api/auth/login', { username: 'anna', password: PW });
  assert.doesNotMatch(bob.lastSetCookie, /Max-Age=|Expires=/i);
  assert.equal((await bob('GET', '/api/session/status')).body.browserSession, true);
  ctx.settings.set('session.browserSession', false);
});

test('Settings: minutes are clamped (0 = not set, at least 5, at most 30 days)', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: PW });
  const r = await admin('PUT', '/api/admin/settings', { settings: { 'session.idleMinutes': '1', 'session.adminIdleMinutes': '-3', 'session.externalIdleMinutes': '999999' } });
  assert.equal(r.status, 200);
  assert.equal(ctx.settings.get('session.idleMinutes'), 5);
  assert.equal(ctx.settings.get('session.adminIdleMinutes'), 0);
  assert.equal(ctx.settings.get('session.externalIdleMinutes'), 43200);
  assert.equal(idleMinutes('abc'), 0);
  assert.equal(idleMinutes(90), 90);
});
