// Tests: bulk actions (multi-select)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-bulk-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');

let server; let base; let db; let ctx;
const events = [];
before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  for (const e of ['commented', 'resolved', 'assigned']) ctx.tickets.events.on(e, (p) => events.push({ e, key: p.ticket.key, body: p.comment?.body }));
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => setTimeout(r, 100)); server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

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
const karl = client();
const ids = {};
let keys;
const tick = () => new Promise((r) => setTimeout(r, 30));

test('Setup', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  for (const [u, role, name] of [['anna', 'agent', 'Anna'], ['karl', 'user', 'Karl Kunde']]) {
    ids[u] = (await admin('POST', '/api/users', { username: u, displayName: name, email: `${u}@firma.local`, role, password: 'Sehrgeheim123' })).body.user.id;
  }
  for (const [c, u] of [[anna, 'anna'], [karl, 'karl']]) assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'Sehrgeheim123' })).status, 200);
  await admin('POST', '/api/projects', { key: 'HR', name: 'Personal' });
  keys = [];
  for (const title of ['Eins', 'Zwei', 'Drei']) keys.push((await karl('POST', '/api/tickets', { title })).body.ticket.key);
});

test('Agents only; empty or oversized requests are rejected', async () => {
  assert.equal((await karl('POST', '/api/tickets/bulk', { keys, changes: { status: 'done' } })).status, 403);
  assert.equal((await anna('POST', '/api/tickets/bulk', { keys: [], changes: { status: 'done' } })).status, 400);
  assert.equal((await anna('POST', '/api/tickets/bulk', { keys })).status, 400, 'without action');
  assert.equal((await anna('POST', '/api/tickets/bulk', { keys: Array.from({ length: 501 }, (_, i) => `IT-${i}`), changes: { status: 'done' } })).status, 400);
  assert.equal((await anna('POST', '/api/tickets/bulk', { keys, delete: true })).status, 400, 'deleting does not exist');
});

test('Assign, priority, status – with activity and notification per ticket', async () => {
  events.length = 0;
  let r = await anna('POST', '/api/tickets/bulk', { keys, changes: { assigneeId: ids.anna, priority: 'high' } });
  assert.deepEqual(r.body, { ok: keys, failed: [] });
  for (const k of keys) {
    const tk = (await anna('GET', `/api/tickets/${k}`)).body.ticket;
    assert.equal(tk.assignee.username, 'anna');
    assert.equal(tk.priority, 'high');
    assert.ok(tk.activity.some((a) => a.field === 'priority'));
  }
  r = await anna('POST', '/api/tickets/bulk', { keys: [keys[0]], changes: { status: 'in_progress' } });
  assert.equal(r.body.ok.length, 1);
  await tick();
  assert.equal(events.filter((x) => x.e === 'assigned').length, 0, 'no assignment mail to oneself');
});

test('Resolve with reply: placeholders per ticket, no additional resolved mail', async () => {
  events.length = 0;
  const r = await anna('POST', '/api/tickets/bulk', { keys: keys.slice(0, 2), changes: { status: 'done' }, comment: 'Hallo {melder}, {ticket} ist erledigt. – {bearbeiter}' });
  assert.deepEqual(r.body.failed, []);
  await tick();
  const comments = events.filter((x) => x.e === 'commented');
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, `Hallo Karl Kunde, ${keys[0]} ist erledigt. – Anna`);
  assert.equal(events.filter((x) => x.e === 'resolved').length, 0, 'only the reply, no second mail');
  for (const k of keys.slice(0, 2)) assert.equal((await anna('GET', `/api/tickets/${k}`)).body.ticket.status, 'done');

  events.length = 0;
  await anna('POST', '/api/tickets/bulk', { keys: [keys[2]], changes: { status: 'done' } });
  await tick();
  assert.equal(events.filter((x) => x.e === 'resolved').length, 1, 'without reply the normal resolved mail');
});

test('Moving: new numbers, result contains new keys', async () => {
  const hr = (await admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'HR');
  const r = await anna('POST', '/api/tickets/bulk', { keys: keys.slice(0, 2), changes: { projectId: hr.id } });
  assert.deepEqual(r.body.failed, []);
  assert.deepEqual(r.body.ok, ['HR-1', 'HR-2']);
  keys = ['HR-1', 'HR-2', keys[2]];
});

test('Errors on single tickets do not abort the rest', async () => {
  const r = await anna('POST', '/api/tickets/bulk', { keys: ['IT-999', keys[2], 'kaputt'], changes: { priority: 'low' } });
  assert.deepEqual(r.body.ok, [keys[2]]);
  assert.deepEqual(r.body.failed.map((x) => x.key), ['IT-999', 'kaputt']);
  assert.ok(r.body.failed[0].error.length > 3, 'understandable message');
  const bad = await anna('POST', '/api/tickets/bulk', { keys: [keys[2]], changes: { assigneeId: ids.karl } });
  assert.equal(bad.body.failed.length, 1, 'assign to agents only');
});

test('Deleting does not exist – not even for admins', async () => {
  const r = await admin('POST', '/api/tickets/bulk', { keys: keys.slice(0, 2), delete: true, changes: { status: 'done' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.ticketDeleteDisabled');
  for (const k of keys.slice(0, 2)) assert.equal((await admin('GET', `/api/tickets/${k}`)).status, 200);
});
