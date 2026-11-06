// Import from GLPI, Zendesk and Freshdesk (against mock systems)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockGlpi, startMockZendesk, startMockFreshdesk } from './fixtures/mock-helpdesks.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-imp2-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';
process.env.HELFI_IMPORT_ALLOW_LOCAL = '1'; // mock systems run on 127.0.0.1

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { glpiText } = await import('../src/import/glpi.js');

let server; let base; let db; let cookie = '';
const events = [];
async function call(method, url, body, as = null) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie: as ?? cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc && as === null) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}
async function waitJob() {
  for (let i = 0; i < 400; i++) {
    const { body } = await call('GET', '/api/admin/import/status');
    if (body.job && body.job.state !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import is stuck');
}
const ticket = async (key, as) => (await call('GET', `/api/tickets/${key}`, undefined, as)).body.ticket;
const files = (t) => Object.fromEntries(t.attachments.map((a) => [a.filename, a.commentId ?? null]));
let kurt = '';

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  built.ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  for (const e of ['created', 'commented', 'assigned', 'resolved']) built.ctx.tickets.events.on(e, () => events.push(e));
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  await call('POST', '/api/users', { username: 'anna', displayName: 'Anna Agentin', email: 'anna@firma.local', role: 'agent', password: 'Sehrgeheim123' });
  await call('POST', '/api/users', { username: 'kurt', displayName: 'Kurt Kunde', email: 'kurt@kunde.example', role: 'user', password: 'Sehrgeheim123' });
  kurt = (await call('POST', '/api/auth/login', { username: 'kurt', password: 'Sehrgeheim123' }, '')).cookie;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('GLPI text: entity-encoded HTML becomes text', () => {
  assert.equal(glpiText('&lt;p&gt;Der &lt;b&gt;Beamer&lt;/b&gt; &amp;amp; Ton&lt;/p&gt;'), 'Der Beamer & Ton');
  assert.equal(glpiText('Nur Text'), 'Nur Text');
});

test('GLPI: session, entities, followups/tasks/solutions, documents, deleted tickets left out', async () => {
  const g = await startMockGlpi();
  try {
    const conn = { baseUrl: `${g.url}/apirest.php`, token: 'falsch' };
    const bad = await call('POST', '/api/admin/import/glpi/connect', { connection: conn });
    assert.equal(bad.body.ok, false);
    conn.token = 'glpi-token';
    const r = await call('POST', '/api/admin/import/glpi/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.server.version, '10.0.18');
    assert.deepEqual(r.body.projects.map((p) => [p.key, p.name, p.count]), [['0', 'Root entity', 2], ['2', 'Root entity > Labor', 1]]);
    const ins = await call('POST', '/api/admin/import/glpi/inspect', { connection: conn, projects: ['0'] });
    assert.deepEqual(ins.body.statuses.map((s) => [s.name, s.suggested]), [['Pending', 'waiting'], ['Closed', 'done']]);
    assert.deepEqual(ins.body.types.map((s) => [s.name, s.suggested]), [['Incident', 'incident'], ['Request', 'request']]);

    await call('POST', '/api/admin/import/glpi/start', { connection: conn, projects: [{ key: '0', name: 'Root entity', targetKey: 'GL' }] });
    const job = await waitJob();
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.deepEqual([job.counts.created, job.counts.comments, job.counts.attachments, job.counts.failed], [2, 4, 2, 0]);
    const t = await ticket('GL-41');
    assert.equal(t.description, 'Der Beamer zeigt kein Bild.');
    assert.deepEqual([t.status, t.type, t.priority, t.dueDate], ['waiting', 'incident', 'high', '2025-04-10']);
    assert.deepEqual(t.labels, ['beamer']);
    assert.equal(t.reporter.email, 'kurt@kunde.example');
    assert.equal(t.assignee.displayName, 'Anna Agentin');
    assert.deepEqual(t.comments.map((c) => [c.body, c.internal]), [['Kabel getauscht', true], ['Ersatzlampe bestellen', true], ['Bitte testen', false]]);
    assert.deepEqual(files(t), { 'foto.jpg': null, 'intern.txt': t.comments[0].id });
    const mouse = await ticket('GL-42');
    assert.equal(mouse.status, 'done');
    assert.equal(mouse.reporter.email, 'gast@kunde.example', 'alternative email of an anonymous requester');
    assert.deepEqual(mouse.comments.map((c) => [c.body, c.internal]), [['Maus ausgegeben', false]]);
    assert.ok(!db.prepare("SELECT 1 FROM tickets WHERE title='Gelöscht'").get(), 'deleted tickets are not imported');
    // The reporter sees neither internal notes nor their files
    const kt = await ticket('GL-41', kurt);
    assert.deepEqual(kt.comments.map((c) => c.body), ['Bitte testen']);
    assert.deepEqual(kt.attachments.map((a) => a.filename), ['foto.jpg']);
  } finally { g.close(); }
});

test('Zendesk: incremental export (archived, deleted left out), private comments, attachments; fallback without admin rights', async () => {
  for (const incremental of [true, false]) {
    const z = await startMockZendesk({ incremental });
    try {
      const conn = { baseUrl: z.url, email: 'admin@firma.local', token: incremental ? 'falsch' : 'zd-token' };
      if (incremental) {
        assert.equal((await call('POST', '/api/admin/import/zendesk/connect', { connection: conn })).body.ok, false);
        conn.token = 'zd-token';
      }
      const r = await call('POST', '/api/admin/import/zendesk/connect', { connection: conn });
      assert.equal(r.body.ok, true, JSON.stringify(r.body));
      assert.deepEqual(r.body.projects.map((p) => [p.key, p.name, p.count]), [['77', 'IT Support', 2], ['*', 'Zendesk', 1]]);
      if (!incremental) { assert.ok(z.calls.some((c) => c.startsWith('GET /api/v2/tickets.json')), 'normal list as fallback'); continue; }
      const ins = await call('POST', '/api/admin/import/zendesk/inspect', { connection: conn, projects: ['77'] });
      assert.deepEqual(ins.body.statuses.map((s) => [s.name, s.suggested]), [['hold', 'waiting'], ['closed', 'done']]);
      await call('POST', '/api/admin/import/zendesk/start', { connection: conn, projects: [{ key: '77', name: 'IT Support', targetKey: 'ZD' }] });
      const job = await waitJob();
      assert.equal(job.state, 'done', JSON.stringify(job.errors));
      assert.deepEqual([job.counts.created, job.counts.comments, job.counts.attachments], [2, 3, 2]);
      const t = await ticket('ZD-501');
      assert.equal(t.description, 'Das WLAN bricht ab.');
      assert.deepEqual([t.status, t.type, t.priority], ['waiting', 'incident', 'highest']);
      assert.deepEqual(t.labels, ['wlan', 'seminar']);
      assert.deepEqual(t.comments.map((c) => [c.body, c.internal]), [['AP neu gestartet', true], ['Geht es wieder?', false]]);
      assert.deepEqual(files(t), { 'screenshot.png': null, 'ap.log': t.comments[0].id });
      const lic = await ticket('ZD-502');
      assert.equal(lic.description, '', 'a private first comment does not become the visible description');
      assert.deepEqual(lic.comments.map((c) => c.internal), [true]);
      assert.ok(!db.prepare("SELECT 1 FROM tickets WHERE title='weg'").get(), 'deleted tickets are not imported');
    } finally { z.close(); }
  }
});

test('Freshdesk: all tickets (not only 30 days), private notes and their files, presigned downloads', async () => {
  const f = await startMockFreshdesk();
  try {
    const conn = { baseUrl: f.url, token: 'fd-key' };
    const r = await call('POST', '/api/admin/import/freshdesk/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.user, 'Anna Agentin');
    assert.deepEqual(r.body.projects.map((p) => [p.key, p.name, p.count]), [['*', 'Freshdesk', 1], ['9', 'Telefonie', 1]]);
    await call('POST', '/api/admin/import/freshdesk/start', { connection: conn, projects: [{ key: '9', name: 'Telefonie', targetKey: 'TEL' }, { key: '*', name: 'Freshdesk', targetKey: 'FD' }] });
    const job = await waitJob();
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.deepEqual([job.counts.created, job.counts.comments, job.counts.attachments], [2, 2, 2]);
    const t = await ticket('TEL-61');
    assert.equal(t.description, 'Das Telefon klingelt nicht.');
    assert.deepEqual([t.status, t.priority, t.dueDate], ['waiting', 'high', '2025-06-05']);
    assert.equal(t.reporter.email, 'kurt@kunde.example');
    assert.equal(t.assignee.displayName, 'Anna Agentin');
    assert.deepEqual(t.comments.map((c) => [c.body, c.internal]), [['Akku getauscht', true], ['Bitte noch einmal probieren', false]]);
    assert.deepEqual(files(t), { 'foto.jpg': null, 'beleg.pdf': t.comments[0].id });
    const toner = await ticket('FD-62');
    assert.equal(toner.status, 'done');
    assert.equal(toner.resolvedAt, '2025-06-04T07:00:00.000Z');
    assert.equal(toner.reporter.displayName, 'Anna Agentin', 'requester who is an agent');
    assert.deepEqual(events, [], 'no events/emails during the imports');
  } finally { f.close(); }
});
