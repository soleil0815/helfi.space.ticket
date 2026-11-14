// Tests: reports (metrics per agent, time range, project, permissions)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-reports-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { parseRange, MAX_RANGE_DAYS } = await import('../src/reports.js');

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
const ids = {};
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

test('Setup: two agents, one reporter, two projects', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  for (const [u, role] of [['anna', 'agent'], ['bert', 'agent'], ['karl', 'user']]) {
    ids[u] = (await admin('POST', '/api/users', { username: u, displayName: u[0].toUpperCase() + u.slice(1), email: `${u}@firma.local`, role: role === 'agent' ? 'user' : role, password: 'Sehrgeheim123' })).body.user.id;
  }
  // legacy all-projects agents: the API no longer gives out role 'agent'
  db.prepare("UPDATE users SET role='agent' WHERE username IN ('anna','bert')").run();
  for (const [c, u] of [[anna, 'anna'], [bert, 'bert'], [karl, 'karl']]) assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'Sehrgeheim123' })).status, 200);
  assert.equal((await admin('POST', '/api/projects', { key: 'HR', name: 'Personal' })).status, 201);

  const mk = async (title, project) => (await karl('POST', '/api/tickets', { title, projectId: project })).body.ticket.key;
  const hr = (await admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'HR').id;
  const [t1, t2, t3, t4] = [await mk('A'), await mk('B'), await mk('C'), await mk('D', hr)];
  // Anna resolves two IT tickets, writes replies and a note
  await anna('PATCH', `/api/tickets/${t1}`, { assigneeId: ids.anna });
  await anna('POST', `/api/tickets/${t1}/comments`, { body: 'Antwort 1' });
  await anna('POST', `/api/tickets/${t1}/comments`, { body: 'Notiz', internal: true });
  await anna('PATCH', `/api/tickets/${t1}`, { status: 'done' });
  await anna('PATCH', `/api/tickets/${t2}`, { status: 'done' });
  // Bert: one HR ticket resolved, one open and assigned
  await bert('PATCH', `/api/tickets/${t4}`, { status: 'done' });
  await bert('PATCH', `/api/tickets/${t3}`, { assigneeId: ids.bert });
  // An old resolution (60 days ago) does not count in the last 30 days
  db.prepare("INSERT INTO activity(ticket_id,user_id,action,field,old_value,new_value,created_at) VALUES((SELECT id FROM tickets WHERE title='C'),?,'changed','status','open','done',?)")
    .run(ids.anna, daysAgo(60));
  // Only creating a ticket does not count as "worked on"
  await admin('POST', '/api/tickets', { title: 'Nur angelegt' });
  // A reporter's comment does not count as agent work
  await karl('POST', `/api/tickets/${t3}/comments`, { body: 'Danke' });
});

test('Metrics per agent (last 30 days)', async () => {
  const r = await bert('GET', '/api/reports');
  assert.equal(r.status, 200, 'all agents may see reports');
  const by = Object.fromEntries(r.body.agents.map((a) => [a.username, a]));
  assert.ok(!('karl' in by), 'reporters do not appear');
  assert.ok('admin' in by, 'active agents/admins appear even with 0');
  assert.equal(by.anna.resolved, 2);
  assert.equal(by.anna.replies, 1);
  assert.equal(by.anna.notes, 1);
  assert.equal(by.anna.touched, 2);
  assert.equal(by.anna.openAssigned, 0, 'resolved ones do not count as open');
  assert.ok(by.anna.avgResolutionHours >= 0 && by.anna.avgResolutionHours < 1);
  assert.equal(by.bert.resolved, 1);
  assert.equal(by.bert.openAssigned, 1);
  assert.equal(by.bert.touched, 2);
  assert.equal(by.admin.resolved, 0);
  assert.equal(by.admin.touched, 0, 'creating alone is not working on it');
  assert.equal(by.admin.avgResolutionHours, null);
  assert.equal(r.body.agents[0].username, 'anna', 'sorted by resolved');
  assert.equal(r.body.totals.created, 5);
  assert.equal(r.body.totals.resolved, 3);
  assert.equal(r.body.totals.open, 2);
  assert.equal(r.body.series.unit, 'day');
  assert.equal(r.body.series.points.length, 30);
  assert.deepEqual(r.body.series.points.at(-1), { date: today, created: 5, resolved: 3 });
});

test('Time range: older resolution only in the longer range, weekly points from 93 days', async () => {
  const from = new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);
  const r = await anna('GET', `/api/reports?from=${from}&to=${today}`);
  assert.equal(r.body.agents.find((a) => a.username === 'anna').resolved, 3);
  assert.equal(r.body.series.unit, 'day');
  const from2 = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const w = await anna('GET', `/api/reports?from=${from2}&to=${today}`);
  assert.equal(w.body.series.unit, 'week');
  assert.ok(w.body.series.points.every((p) => new Date(`${p.date}T00:00:00Z`).getUTCDay() === 1), 'weeks start on Monday');
  assert.equal(w.body.series.points.reduce((n, p) => n + p.resolved, 0), 4);
});

test('Project filter', async () => {
  const r = await anna('GET', '/api/reports?project=hr');
  const by = Object.fromEntries(r.body.agents.map((a) => [a.username, a]));
  assert.equal(by.anna.resolved, 0);
  assert.equal(by.bert.resolved, 1);
  assert.equal(by.bert.openAssigned, 0, 'open ticket is in the IT project');
  assert.equal(r.body.totals.created, 1);
  assert.equal((await anna('GET', '/api/reports?project=XX')).status, 404);
});

test('Permissions and input', async () => {
  assert.equal((await karl('GET', '/api/reports')).status, 403);
  assert.equal((await anna('GET', '/api/reports?from=2026-13-01')).status, 400);
  assert.equal((await anna('GET', '/api/reports?from=gestern')).status, 400);
  assert.equal((await anna('GET', `/api/reports?from=${today}&to=2020-01-01`)).status, 400);
  assert.throws(() => parseRange({ from: '2020-01-01', to: '2026-01-01' }), /badRequest/);
  const r = parseRange({}, new Date('2026-11-01T15:00:00Z'));
  assert.deepEqual([r.from, r.to, r.days], ['2026-10-03', '2026-11-01', 30]);
  assert.equal(r.toIso, '2026-11-02T00:00:00.000Z', 'last day counts fully');
  assert.ok(MAX_RANGE_DAYS >= 366 * 3);
});

test('Deactivated agent with resolved tickets stays in the report', async () => {
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(ids.bert);
  const r = await anna('GET', '/api/reports');
  const b = r.body.agents.find((a) => a.username === 'bert');
  assert.ok(b);
  assert.equal(b.active, false);
  assert.equal(b.resolved, 1);
  db.prepare('UPDATE users SET active=1 WHERE id=?').run(ids.bert);
});
