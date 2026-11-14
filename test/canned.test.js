// Tests: canned responses (permissions, limits, placeholders)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-canned-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { MAX_PERSONAL } = await import('../src/canned.js');
const { fillPlaceholders } = await import('../public/js/placeholders.js');

let server; let base; let db; let ctx;
before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
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
const anna = client();
const bert = client();
const karl = client();

test('Setup', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  for (const [u, role] of [['anna', 'agent'], ['bert', 'agent'], ['karl', 'user']]) {
    assert.equal((await admin('POST', '/api/users', { username: u, displayName: u, email: `${u}@firma.local`, role: role === 'agent' ? 'user' : role, password: 'Sehrgeheim123' })).status, 201);
  }
  // legacy all-projects agents: the API no longer gives out role 'agent'
  db.prepare("UPDATE users SET role='agent' WHERE username IN ('anna','bert')").run();
  for (const [c, u] of [[anna, 'anna'], [bert, 'bert'], [karl, 'karl']]) assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'Sehrgeheim123' })).status, 200);
});

let shared; let annas;
test('Admin creates a shared response, agents personal ones; users have no access', async () => {
  const r = await admin('POST', '/api/canned', { title: 'Neustart', body: 'Hallo {melder},\nbitte starten Sie den Rechner neu.', shared: true });
  assert.equal(r.status, 201);
  shared = r.body.response;
  assert.equal(shared.shared, true);

  const r2 = await anna('POST', '/api/canned', { title: 'Passwort', body: 'Ihr Kennwort wurde zurückgesetzt.', shared: true });
  assert.equal(r2.status, 403, 'agents may not create shared responses');
  annas = (await anna('POST', '/api/canned', { title: 'Passwort', body: 'Ihr Kennwort wurde zurückgesetzt.' })).body.response;
  assert.equal(annas.shared, false);
  assert.equal(annas.mine, true);

  assert.equal((await karl('GET', '/api/canned')).status, 403);
  assert.equal((await karl('POST', '/api/canned', { title: 'x', body: 'y' })).status, 403);
});

test('Everyone sees the shared ones and only their own', async () => {
  assert.deepEqual((await anna('GET', '/api/canned')).body.responses.map((x) => x.title), ['Neustart', 'Passwort']);
  assert.deepEqual((await bert('GET', '/api/canned')).body.responses.map((x) => x.title), ['Neustart']);
});

test('Edit/delete: own yes, others\' personal invisible, shared admins only', async () => {
  assert.equal((await bert('PATCH', `/api/canned/${annas.id}`, { title: 'gekapert' })).status, 404);
  assert.equal((await bert('DELETE', `/api/canned/${annas.id}`)).status, 404);
  assert.equal((await admin('PATCH', `/api/canned/${annas.id}`, { title: 'gekapert' })).status, 404, 'not even admins');
  assert.equal((await anna('PATCH', `/api/canned/${shared.id}`, { body: 'anders' })).status, 403);
  assert.equal((await anna('DELETE', `/api/canned/${shared.id}`)).status, 403);

  const r = await anna('PATCH', `/api/canned/${annas.id}`, { title: 'Kennwort' });
  assert.equal(r.status, 200);
  assert.equal(r.body.response.title, 'Kennwort');
  assert.equal(r.body.response.body, 'Ihr Kennwort wurde zurückgesetzt.', 'body stays');
  assert.equal((await admin('PATCH', `/api/canned/${shared.id}`, { body: 'Hallo {melder}, bitte neu starten.' })).status, 200);
  assert.equal((await anna('DELETE', `/api/canned/${annas.id}`)).status, 200);
  assert.deepEqual((await anna('GET', '/api/canned')).body.responses.map((x) => x.title), ['Neustart']);
});

test('Input validation and maximum count', async () => {
  assert.equal((await anna('POST', '/api/canned', { title: '  ', body: 'x' })).status, 400);
  assert.equal((await anna('POST', '/api/canned', { title: 'x', body: ' \n ' })).status, 400);
  assert.equal((await anna('PATCH', '/api/canned/99999', { title: 'x' })).status, 404);
  const long = (await anna('POST', '/api/canned', { title: 'L'.repeat(300), body: 'B'.repeat(20000) })).body.response;
  assert.equal(long.title.length, 100);
  assert.equal(long.body.length, 10000);
  const stmt = db.prepare('INSERT INTO canned_responses(title,body,owner_id) VALUES(?,?,(SELECT id FROM users WHERE username=?))');
  for (let i = 1; i < MAX_PERSONAL; i++) stmt.run(`v${i}`, 'x', 'anna');
  assert.equal((await anna('POST', '/api/canned', { title: 'zuviel', body: 'x' })).status, 400);
  assert.equal((await bert('POST', '/api/canned', { title: 'geht', body: 'x' })).status, 201, 'limit applies per person');
});

test('Deleted agent: their personal responses disappear, shared ones stay', async () => {
  const bertId = db.prepare("SELECT id FROM users WHERE username='bert'").get().id;
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(bertId);
  db.prepare('DELETE FROM users WHERE id=?').run(bertId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canned_responses WHERE owner_id=?').get(bertId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canned_responses WHERE owner_id IS NULL').get().n, 1);
});

test('Placeholders (German and English), unknown ones stay as they are', () => {
  const tk = { key: 'IT-7', title: 'Drucker', reporter: { displayName: 'Max Muster' } };
  const me = { displayName: 'Anna Admin' };
  assert.equal(fillPlaceholders('Hallo {melder}, zu {ticket} „{titel}“ – {bearbeiter}', tk, me), 'Hallo Max Muster, zu IT-7 „Drucker“ – Anna Admin');
  assert.equal(fillPlaceholders('Hi {Reporter}, {TICKET} {title} – {agent}', tk, me), 'Hi Max Muster, IT-7 Drucker – Anna Admin');
  assert.equal(fillPlaceholders('{unbekannt} {melder}', { key: 'IT-1' }, me), '{unbekannt} ');
  assert.equal(fillPlaceholders('$& {melder}', { reporter: { displayName: '$1 $&' } }, me), '$& $1 $&', 'replacement without pattern evaluation');
});
