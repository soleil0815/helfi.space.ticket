// Tests: Warteschlangen-Zahlen, Zusammenfassung, Filter „kürzlich erledigt“ und „überfällig“
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-queues-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');

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
const karl = client();
const k = {};

test('Vorbereitung: zwei Projekte, gemischte Tickets', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  await admin('POST', '/api/users', { username: 'karl', displayName: 'Karl', email: 'karl@firma.local', role: 'user', password: 'Sehrgeheim123' });
  assert.equal((await karl('POST', '/api/auth/login', { username: 'karl', password: 'Sehrgeheim123' })).status, 200);
  await admin('POST', '/api/projects', { key: 'HR', name: 'Personal' });
  const hr = (await admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'HR');
  const me = (await admin('GET', '/api/me')).body.user.id;
  const mk = async (title, extra = {}) => (await admin('POST', '/api/tickets', { title, ...extra })).body.ticket.key;
  k.a = await mk('Anfrage offen', { type: 'request' });
  k.b = await mk('Störung mir', { type: 'incident', assigneeId: me, priority: 'highest' });
  k.c = await mk('Wartet', { type: 'task' });
  k.d = await mk('Erledigt neu', { type: 'request' });
  k.e = await mk('Erledigt alt', { type: 'question' });
  k.f = await mk('Überfällig', { type: 'incident', dueDate: '2020-01-01' });
  k.h = await mk('HR-Sache', { type: 'request', projectId: hr.id });
  await admin('PATCH', `/api/tickets/${k.c}`, { status: 'waiting' });
  await admin('PATCH', `/api/tickets/${k.d}`, { status: 'done' });
  await admin('PATCH', `/api/tickets/${k.e}`, { status: 'done' });
  db.prepare("UPDATE tickets SET resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') WHERE title='Erledigt alt'").run();
});

test('Zahlen je Warteschlange, je Projekt und gesamt; nur Bearbeiter', async () => {
  assert.equal((await karl('GET', '/api/queues')).status, 403);
  const it = (await admin('GET', '/api/queues?project=IT')).body.counts;
  assert.deepEqual(it, { open: 4, mine: 1, unassigned: 3, waiting: 1, recent: 1, total: 6, requests: 1, incidents: 2, problems: 0 });
  const all = (await admin('GET', '/api/queues')).body.counts;
  assert.equal(all.total, 7);
  assert.equal(all.requests, 2);
});

test('Listen-Filter passen zu den Zahlen (kürzlich erledigt, überfällig)', async () => {
  const keys = async (q) => (await admin('GET', `/api/tickets?${q}`)).body.tickets.map((x) => x.key).sort();
  assert.deepEqual(await keys('project=IT&status=done&resolvedDays=7'), [k.d]);
  assert.deepEqual(await keys('project=IT&status=done'), [k.d, k.e].sort());
  assert.deepEqual(await keys('project=IT&overdue=1'), [k.f]);
  assert.deepEqual(await keys('project=IT&type=incident&status=unresolved'), [k.b, k.f].sort());
});

test('Zusammenfassung', async () => {
  assert.equal((await karl('GET', '/api/summary')).status, 403);
  assert.equal((await admin('GET', '/api/summary?project=XX')).status, 404);
  const s = (await admin('GET', '/api/summary?project=IT')).body;
  assert.equal(s.project.key, 'IT');
  assert.deepEqual(s.counts, { open: 4, created7: 6, resolved7: 1, overdue: 1, unassigned: 3 });
  assert.deepEqual(s.byStatus, { open: 3, in_progress: 0, waiting: 1, done: 2 });
  assert.deepEqual(s.byType, { incident: 2, request: 1, task: 1, question: 0, problem: 0, change: 0 });
  assert.equal(s.urgent[0].key, k.b, 'höchste Priorität zuerst');
  assert.ok(!s.urgent.some((x) => x.status === 'done'));
  assert.equal(s.urgent[1].key, k.f, 'dann überfällige');
});
