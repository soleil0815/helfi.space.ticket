// Jira-Import gegen ein nachgebautes Jira (Cloud und Server/Data Center)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockJira } from './fixtures/mock-jira.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-jira-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { adfToText, wikiToText } = await import('../src/import/jira-text.js');
const { suggestStatus, suggestType, mapPriority, isInternalComment, sanitizeProjectKey } = await import('../src/import/jira-import.js');
const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');

let server; let base; let db; let ctx; let cookie = '';
const events = [];

async function call(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function waitJob() {
  for (let i = 0; i < 200; i++) {
    const { body } = await call('GET', '/api/admin/import/status');
    if (body.job && body.job.state !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import hängt');
}

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  // Tests laufen direkt auf 127.0.0.1 – als internes Netz eintragen (sonst wäre 2FA Pflicht)
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  for (const e of ['created', 'commented', 'assigned', 'resolved']) ctx.tickets.events.on(e, () => events.push(e));
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  await call('POST', '/api/users', { username: 'anna', displayName: 'Anna Agentin', email: 'anna@firma.local', role: 'agent', password: 'Sehrgeheim123' });
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Textumwandlung ADF und Wiki-Markup', () => {
  const adf = { type: 'doc', content: [
    { type: 'heading', content: [{ type: 'text', text: 'Titel' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Siehe ' }, { type: 'text', text: 'hier', marks: [{ type: 'link', attrs: { href: 'https://x.example' } }] }, { type: 'hardBreak' }, { type: 'mention', attrs: { text: '@Anna' } }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'eins' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'zwei' }] }] }] },
    { type: 'codeBlock', content: [{ type: 'text', text: 'ls -l' }] },
  ] };
  assert.equal(adfToText(adf), 'Titel\n\nSiehe hier (https://x.example)\n@Anna\n\n1. eins\n2. zwei\n\n```\nls -l\n```');
  assert.equal(wikiToText('h1. Titel\n*fett* und _kursiv_\n* a\n** b\n[Doku|https://d.example] {{code}}\n!bild.png|thumbnail!'),
    'Titel\nfett und kursiv\n- a\n  - b\nDoku (https://d.example) code\n[bild.png]');
});

test('Zuordnungsvorschläge', () => {
  assert.equal(suggestStatus('Waiting for customer', 'indeterminate'), 'waiting');
  assert.equal(suggestStatus('In Progress', 'indeterminate'), 'in_progress');
  assert.equal(suggestStatus('Closed', 'done'), 'done');
  assert.equal(suggestStatus('Backlog', 'new'), 'open');
  assert.equal(suggestType('Bug'), 'incident');
  assert.equal(suggestType('Sub-task'), 'task');
  assert.equal(suggestType('IT Help'), 'request');
  assert.equal(mapPriority('Blocker'), 'highest');
  assert.equal(mapPriority('Minor'), 'low');
  assert.equal(isInternalComment({ jsdPublic: false }), true);
  assert.equal(isInternalComment({ visibility: { type: 'group', value: 'x' } }), true);
  assert.equal(isInternalComment({ properties: [{ key: 'sd.public.comment', value: { internal: true } }] }), true);
  assert.equal(isInternalComment({ jsdPublic: true }), false);
  assert.equal(sanitizeProjectKey('DEV_OPS'), 'DEVOPS');
  assert.equal(sanitizeProjectKey('1A'), 'J1A');
});

test('Jira Cloud: Verbindung, Projekte, Zuordnung', async () => {
  const jira = await startMockJira({ type: 'cloud' });
  try {
    const conn = { type: 'cloud', baseUrl: jira.url, email: 'admin@firma.local', token: 'falsch' };
    const bad = await call('POST', '/api/admin/import/jira/connect', { connection: conn });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.error, /Anmeldung/);
    conn.token = 'cloud-token';
    const r = await call('POST', '/api/admin/import/jira/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.projects.map((p) => p.suggestedKey), ['SUP', 'DEVOPS']);
    const ins = await call('POST', '/api/admin/import/jira/inspect', { connection: conn, projects: ['SUP'] });
    assert.equal(ins.body.statuses.find((s) => s.name === 'Waiting for customer').suggested, 'waiting');
    assert.equal(ins.body.counts.SUP, 3);
    // Nur Admins
    const agent = await fetch(`${base}/api/admin/import/status`);
    assert.equal(agent.status, 401);
  } finally { jira.close(); }
});

test('Jira Cloud: Import mit Nummern, Kommentaren, Anhängen – ohne E-Mails', async () => {
  const jira = await startMockJira({ type: 'cloud' });
  try {
    const conn = { type: 'cloud', baseUrl: jira.url, email: 'admin@firma.local', token: 'cloud-token' };
    const start = await call('POST', '/api/admin/import/jira/start', {
      connection: conn,
      projects: [{ key: 'SUP', name: 'Support' }],
      statusMap: { 'To Do': 'open' },
      typeMap: { 'Service Request': 'request' },
      options: { comments: true, attachments: true, maxAttachmentMb: 10 },
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    const job = await waitJob();
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.deepEqual(job.counts, { created: 3, updated: 0, unchanged: 0, comments: 2, attachments: 1, skippedAttachments: 1, failed: 0 });
    assert.ok(jira.calls.includes('POST /rest/api/3/search/jql'), 'neue Cloud-Suche');
    assert.ok(!jira.calls.includes('GET /rest/api/3/search'), 'alte (entfernte) Suche nicht benutzt');

    const t1 = (await call('GET', '/api/tickets/SUP-10')).body.ticket;
    assert.equal(t1.title, 'Vorgang 1');
    assert.equal(t1.type, 'incident');
    assert.equal(t1.status, 'waiting');
    assert.equal(t1.priority, 'highest');
    assert.equal(t1.dueDate, '2024-12-24');
    assert.deepEqual(t1.labels, ['drucker', 'import-test']);
    assert.equal(t1.source, 'jira');
    assert.equal(t1.assignee.displayName, 'Anna Agentin', 'Bearbeiter per E-Mail zugeordnet');
    assert.equal(t1.reporter.email, 'kurt@kunde.example');
    assert.equal(t1.createdAt, '2024-01-01T08:00:00.000Z', 'Datum aus Jira');
    assert.match(t1.description, /Handbuch \(https:\/\/wiki\.firma\.local\/d\)/);
    assert.match(t1.description, /- Punkt A/);
    assert.deepEqual(t1.comments.map((c) => [c.body, c.internal]), [['Bitte schnell!', false], ['Intern: Toner bestellt', true]]);
    assert.equal(t1.attachments.length, 1);
    const dl = await fetch(`${base}/api/attachments/${t1.attachments[0].id}`, { headers: { cookie } });
    assert.equal(await dl.text(), 'Fehler 4711', 'Anhang über Umleitung ohne Anmeldedaten geladen');
    assert.equal(t1.activity[0].action, 'imported');
    assert.equal(t1.activity[0].oldValue, 'SUP-10');

    const t2 = (await call('GET', '/api/tickets/SUP-20')).body.ticket;
    assert.equal(t2.status, 'done');
    assert.ok(t2.resolvedAt);
    assert.equal(t2.assignee, null, 'Bearbeiter ohne Konto bleibt leer');
    assert.equal(t2.activity[0].newValue, 'Geist ohne Mail', 'Name im Verlauf festgehalten');
    const t3 = (await call('GET', '/api/tickets/SUP-30')).body.ticket;
    assert.equal(t3.reporter.displayName, 'Geist ohne Mail');
    assert.equal(t3.type, 'task');

    // Nächste neue Nummer schließt an
    const n = await call('POST', '/api/tickets', { title: 'Neu', projectId: t1.projectId });
    assert.equal(n.body.ticket.key, 'SUP-31');

    assert.deepEqual(events, ['created'], 'beim Import keine Ereignisse/E-Mails – nur das eben von Hand angelegte Ticket');

    // Erneuter Import: aktualisiert, legt nichts doppelt an
    // Lokale Änderung an SUP-20 (in Jira unverändert) darf ein erneuter Import nicht überschreiben (Audit)
    await call('PATCH', '/api/tickets/SUP-20', { status: 'open', title: 'Lokal bearbeitet' });
    jira.issues[0].fields.summary = 'Vorgang 1 (geändert)';
    jira.issues[0].fields.updated = new Date(Date.now() + 60000).toISOString();
    await call('POST', '/api/admin/import/jira/start', { connection: conn, projects: [{ key: 'SUP' }] });
    const again = await waitJob();
    assert.deepEqual([again.counts.created, again.counts.updated, again.counts.unchanged, again.counts.comments, again.counts.attachments], [0, 1, 2, 0, 0]);
    assert.equal((await call('GET', '/api/tickets/SUP-10')).body.ticket.title, 'Vorgang 1 (geändert)');
    const local = (await call('GET', '/api/tickets/SUP-20')).body.ticket;
    assert.deepEqual([local.title, local.status], ['Lokal bearbeitet', 'open']);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key='SUP'").get().n, 4);
  } finally { jira.close(); }
});

test('Kontakte aus Jira werden beim späteren Anmelden übernommen', () => {
  const kurt = ctx.users.byEmail('kurt@kunde.example');
  assert.equal(kurt.source, 'email');
  const u = ctx.users.upsertExternal({ source: 'ldap', username: 'k.kunde', displayName: 'Kurt', email: 'kurt@kunde.example', externalId: 'g1', role: null });
  assert.equal(u.id, kurt.id);
});

test('Jira Server/Data Center: Import mit Token, Wiki-Markup, Nummernkonflikt', async () => {
  const jira = await startMockJira({ type: 'server', issueCount: 2 });
  try {
    // Projekt "OPS" gibt es schon mit Ticket 10 → Nummer wird neu vergeben
    const p = (await call('POST', '/api/projects', { key: 'OPS', name: 'Ops' })).body.project;
    for (let i = 0; i < 10; i++) await call('POST', '/api/tickets', { title: `lokal ${i}`, projectId: p.id });
    const conn = { type: 'server', baseUrl: jira.url, token: 'pat-123' };
    const c = await call('POST', '/api/admin/import/jira/connect', { connection: conn });
    assert.equal(c.body.ok, true, JSON.stringify(c.body));
    assert.equal(c.body.server.deploymentType, 'Server');
    await call('POST', '/api/admin/import/jira/start', { connection: conn, projects: [{ key: 'SUP', targetKey: 'OPS', name: 'Ops' }], options: { attachments: true } });
    const job = await waitJob();
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.equal(job.counts.created, 2);
    assert.ok(jira.calls.some((x) => x === 'GET /rest/api/2/search'), 'Server-Suche');
    const keys = db.prepare("SELECT number FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key='OPS' AND source='jira' ORDER BY number").all().map((r) => r.number);
    assert.deepEqual(keys, [11, 20], 'SUP-10 kollidiert → 11, SUP-20 bleibt 20');
    const t = (await call('GET', '/api/tickets/OPS-11')).body.ticket;
    assert.match(t.description, /^Drucker\n- Punkt A\nHandbuch \(https:\/\/wiki\.firma\.local\/d\)\n```\nx=1\n```$/);
    assert.equal(t.comments.find((x) => x.body.startsWith('Intern')).internal, true, 'eingeschränkte Sichtbarkeit = intern');
    assert.equal(t.attachments.length, 1);
  } finally { jira.close(); }
});

test('Zertifikatsfehler und falsche Adressen werden verständlich gemeldet', async () => {
  const r = await call('POST', '/api/admin/import/jira/connect', { connection: { type: 'server', baseUrl: 'http://127.0.0.1:1', token: 'x' } });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /nicht erreichbar/);
  const bad = await call('POST', '/api/admin/import/jira/connect', { connection: { type: 'server', baseUrl: 'file:///etc/passwd' } });
  assert.equal(bad.status, 400);
});

test('Server/DC: kleinere Seiten als angefragt – kein Vorgang geht verloren (Audit)', async () => {
  const jira = await startMockJira({ type: 'server', issueCount: 5 });
  try {
    const conn = { type: 'server', baseUrl: jira.url, token: 'pat-123' };
    await call('POST', '/api/admin/import/jira/start', { connection: conn, projects: [{ key: 'SUP', targetKey: 'PAGE', name: 'Paging' }], options: { attachments: false, comments: false } });
    const job = await waitJob();
    assert.equal(job.counts.created, 5, JSON.stringify(job));
  } finally { jira.close(); }
});

test('Cloud: gleiches Seiten-Token zweimal → Abbruch statt Endlosschleife (Audit)', async () => {
  const { createJiraClient } = await import('../src/import/jira-client.js');
  const http = await import('node:http');
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ issues: [{ id: '1', key: 'X-1', fields: {} }], nextPageToken: 'immer-gleich' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = createJiraClient({ type: 'cloud', baseUrl: `http://127.0.0.1:${srv.address().port}`, email: 'a', token: 'b' });
    await assert.rejects(async () => { for await (const _ of c.issues('X')) { /* nichts */ } }, /dieselbe Seite/);
    assert.ok(calls <= 3, `nur wenige Abrufe (${calls})`);
  } finally { srv.close(); }
});

test('Ungültige Datumsangaben brechen den Vorgang nicht ab (Audit)', async () => {
  const { iso } = await import('../src/import/jira-import.js');
  assert.equal(iso('kein datum'), null);
  assert.equal(iso('2024-01-01T10:00:00.000+0200'), '2024-01-01T08:00:00.000Z');
  assert.equal(iso(null), null);
});

test('Importierte Tickets lassen sich nicht löschen; Import-Zuordnung bleibt', async () => {
  const t = db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key='SUP' AND t.number=10").get();
  assert.ok(db.prepare("SELECT 1 FROM import_map WHERE kind='issue' AND local_id=?").get(t.id));
  assert.equal((await call('DELETE', '/api/tickets/SUP-10')).status, 405);
  assert.ok(db.prepare("SELECT 1 FROM import_map WHERE kind='issue' AND local_id=?").get(t.id));
});

