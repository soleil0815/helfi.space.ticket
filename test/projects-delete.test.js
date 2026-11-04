// Tests: deleting projects (empty, with moving, with deleting tickets, protection rules)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-projdel-'));
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
const anna = client();
const pid = {};

test('Setup', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  await admin('POST', '/api/users', { username: 'anna', displayName: 'Anna', email: 'anna@firma.local', role: 'agent', password: 'Sehrgeheim123' });
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'Sehrgeheim123' })).status, 200);
  for (const [k, n] of [['HR', 'Personal'], ['ALT', 'Altlasten'], ['LEER', 'Leer']]) await admin('POST', '/api/projects', { key: k, name: n });
  for (const p of (await admin('GET', '/api/projects')).body.projects) pid[p.key] = p.id;
  for (const title of ['Eins', 'Zwei']) await admin('POST', '/api/tickets', { title, projectId: pid.ALT });
  await admin('POST', '/api/tickets', { title: 'HR-Ticket', projectId: pid.HR });
});

test('Delete empty project; admins only', async () => {
  assert.equal((await anna('DELETE', `/api/projects/${pid.LEER}`, {})).status, 403);
  const r = await admin('DELETE', `/api/projects/${pid.LEER}`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { key: 'LEER', moved: 0, target: null });
  assert.equal(ctx.tickets.projects.get('LEER'), null);
  assert.equal((await admin('DELETE', `/api/projects/${pid.LEER}`, {})).status, 404);
});

test('Project with tickets: rejected without target, deleting tickets along does not exist', async () => {
  assert.equal((await admin('DELETE', `/api/projects/${pid.ALT}`, {})).status, 400);
  assert.equal((await admin('DELETE', `/api/projects/${pid.ALT}`, { deleteTickets: true, confirmKey: 'ALT' })).status, 400);
  assert.equal((await admin('DELETE', `/api/projects/${pid.ALT}`, { moveTo: 'ALT' })).status, 400, 'not into itself');
  assert.equal((await admin('DELETE', `/api/projects/${pid.ALT}`, { moveTo: 'GIBTSNICHT' })).status, 400);
  assert.ok(ctx.tickets.projects.get('ALT'), 'nothing deleted');
});

test('Moving: new numbers in the target, old ones in the activity log, settings switched, backup created', async () => {
  ctx.settings.set('imap.project', 'ALT');
  ctx.settings.set('general.defaultProject', 'ALT');
  const itBefore = (await admin('GET', '/api/tickets?project=IT')).body.tickets.length;
  const r = await admin('DELETE', `/api/projects/${pid.ALT}`, { moveTo: 'it' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { key: 'ALT', moved: 2, target: 'IT' });
  const it = (await admin('GET', '/api/tickets?project=IT')).body.tickets;
  assert.equal(it.length, itBefore + 2);
  const eins = it.find((x) => x.title === 'Eins');
  assert.match(eins.key, /^IT-\d+$/);
  const hist = (await admin('GET', `/api/tickets/${eins.key}`)).body.ticket.activity.find((a) => a.field === 'project');
  assert.equal(hist.oldValue, 'ALT-1');
  assert.equal(hist.newValue, eins.key);
  assert.equal(ctx.settings.get('imap.project'), 'IT');
  assert.equal(ctx.settings.get('general.defaultProject'), 'IT');
  assert.ok(fs.readdirSync(paths.backups).some((f) => f.includes('vor-loeschen-ALT')), 'backup beforehand');
});

test('Tickets with attachments are never deleted along', async () => {
  const hr = (await admin('GET', '/api/tickets?project=HR')).body.tickets[0];
  const r = await admin('DELETE', `/api/projects/${pid.HR}`, { deleteTickets: true, confirmKey: 'HR' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.projectHasTickets');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tickets WHERE id=?').get(hr.id).n, 1);
  assert.ok(ctx.tickets.projects.get('HR'));
});

test('The last project stays; no moving into archived projects', async () => {
  await admin('POST', '/api/projects', { key: 'ARCH', name: 'Archiv' });
  const arch = (await admin('GET', '/api/projects?all=1')).body.projects.find((p) => p.key === 'ARCH')
    || ctx.tickets.projects.get('ARCH');
  await admin('PATCH', `/api/projects/${arch.id}`, { archived: true });
  assert.equal((await admin('DELETE', `/api/projects/${pid.IT}`, { moveTo: 'ARCH' })).status, 400);
  assert.equal((await admin('DELETE', `/api/projects/${arch.id}`, {})).status, 200);
  assert.equal((await admin('DELETE', `/api/projects/${pid.IT}`, { deleteTickets: true, confirmKey: 'IT' })).status, 400, 'last project');
  assert.ok(ctx.tickets.projects.get('IT'));
});
