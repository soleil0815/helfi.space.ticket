// Import from Zammad, Znuny/OTRS and CSV files (against mock systems)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockZammad } from './fixtures/mock-zammad.js';
import { startMockZnuny } from './fixtures/mock-znuny.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-imp-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';
process.env.HELFI_IMPORT_ALLOW_LOCAL = '1'; // mock systems run on 127.0.0.1

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { suggestColumns, csvDate, csvCategory } = await import('../src/import/csv.js');
const { parseFrom, zammadCategory } = await import('../src/import/zammad.js');
const { znunyInternal, znunyDate } = await import('../src/import/znuny.js');
const { wantedNumber, sanitizeProjectKey, mapPriority } = await import('../src/import/core.js');
const { blockedAddress } = await import('../src/import/http.js');

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
async function upload(name, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  const r = await fetch(`${base}/api/admin/import/csv/upload`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd });
  return { status: r.status, body: await r.json() };
}
async function waitJob() {
  for (let i = 0; i < 400; i++) {
    const { body } = await call('GET', '/api/admin/import/status');
    if (body.job && body.job.state !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import is stuck');
}
const ticket = async (key) => (await call('GET', `/api/tickets/${key}`)).body.ticket;

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  for (const e of ['created', 'commented', 'assigned', 'resolved']) ctx.tickets.events.on(e, () => events.push(e));
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  // Since migration 42 agents are users with project rights (no global role 'agent'): anna works on the
  // import's target projects, which exist beforehand – only then can she be matched as assignee
  const anna = (await call('POST', '/api/users', { username: 'anna', displayName: 'Anna Agentin', email: 'anna@firma.local', role: 'user', password: 'Sehrgeheim123' })).body.user;
  for (const key of ['IT', 'SD', 'RAW']) {
    let p = (await call('GET', '/api/projects')).body.projects.find((x) => x.key === key);
    if (!p) p = (await call('POST', '/api/projects', { key, name: key })).body.project;
    await call('PUT', `/api/projects/${p.id}/agents`, { members: [{ userId: anna.id }] });
  }
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Helpers: names, dates, categories, numbers', () => {
  assert.deepEqual(parseFrom('"Kurt Kunde" <kurt@kunde.example>'), { name: 'Kurt Kunde', email: 'kurt@kunde.example' });
  assert.deepEqual(parseFrom('kurt@kunde.example'), { name: 'kurt@kunde.example', email: 'kurt@kunde.example' });
  assert.deepEqual(parseFrom('Anna Agentin'), { name: 'Anna Agentin', email: '' });
  assert.equal(zammadCategory('pending close'), 'waiting');
  assert.equal(zammadCategory('merged'), 'done');
  assert.equal(znunyInternal({ IsVisibleForCustomer: '0' }), true);
  assert.equal(znunyInternal({ ArticleType: 'note-internal' }), true);
  assert.equal(znunyInternal({ ArticleType: 'email-external' }), false);
  assert.equal(znunyDate('2025-03-01 08:00:00'), new Date(2025, 2, 1, 8, 0, 0).toISOString());
  assert.equal(csvDate('02.01.2026 9:05'), new Date(2026, 0, 2, 9, 5).toISOString());
  assert.equal(csvDate('2026-01-02 9:05'), new Date(2026, 0, 2, 9, 5).toISOString());
  assert.equal(csvDate('kein Datum'), null);
  assert.equal(csvCategory('Geschlossen'), 'done');
  assert.equal(csvCategory('Wartet auf Kunde'), 'waiting');
  assert.equal(wantedNumber('#31011'), 31011);
  assert.equal(wantedNumber('#20250301100002'), null, 'date-based numbers are not kept');
  assert.equal(sanitizeProjectKey('Service Desk', 'Z'), 'SERVICEDES');
  assert.equal(sanitizeProjectKey('Bürokommunikation', 'Z'), 'BUEROKOMMU');
  assert.equal(sanitizeProjectKey('2nd Level', 'Q'), 'Q2NDLEVEL');
  assert.equal(mapPriority('3 high'), 'high');
  assert.equal(mapPriority('1 low'), 'low');
  assert.equal(mapPriority('5 very high'), 'highest');
  assert.equal(mapPriority('2 normal'), 'medium');
  assert.equal(mapPriority('2 low'), 'low');
  assert.equal(mapPriority('3 normal'), 'medium');
  assert.deepEqual(suggestColumns(['Ticket ID', 'Betreff', 'Status', 'E-Mail', 'Erstellt am', 'Abteilung', 'Sonstiges']),
    { id: 'Ticket ID', title: 'Betreff', status: 'Status', reporterEmail: 'E-Mail', created: 'Erstellt am', project: 'Abteilung' });
});

test('Zammad: connect, groups as projects, mapping suggestions', async () => {
  const z = await startMockZammad();
  try {
    const bad = await call('POST', '/api/admin/import/zammad/connect', { connection: { baseUrl: z.url, token: 'falsch' } });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.error, /Anmeldung/);
    const r = await call('POST', '/api/admin/import/zammad/connect', { connection: { baseUrl: z.url, token: 'zammad-token' } });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.server.version, '6.4.1');
    assert.equal(r.body.user, 'Anna Agentin');
    const sd = r.body.projects.find((p) => p.name === 'IT::Service Desk');
    assert.deepEqual([sd.key, sd.suggestedKey, sd.count], ['2', 'SERVICEDES', 2]);
    assert.ok(!r.body.projects.some((p) => p.name === 'Alt'), 'inactive empty groups are left out');
    const ins = await call('POST', '/api/admin/import/zammad/inspect', { connection: { baseUrl: z.url, token: 'zammad-token' }, projects: ['2'] });
    assert.deepEqual(ins.body.statuses.map((s) => [s.name, s.suggested]), [['pending reminder', 'waiting'], ['closed', 'done']]);
    assert.deepEqual(ins.body.types.map((s) => [s.name, s.suggested]), [['Incident', 'incident'], ['', 'request']]);
    assert.equal(ins.body.counts['2'], 2);
  } finally { z.close(); }
});

test('Zammad: import with articles, internal notes and their files, tags – without emails', async () => {
  const z = await startMockZammad({ perPage: 2 }); // several pages
  try {
    const conn = { baseUrl: z.url, token: 'zammad-token' };
    const s = await call('POST', '/api/admin/import/zammad/start', { connection: conn, projects: [{ key: '2', name: 'Service Desk', targetKey: 'SD' }], options: { maxAttachmentMb: 5 } });
    assert.equal(s.status, 202, JSON.stringify(s.body));
    const job = await waitJob();
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.deepEqual([job.counts.created, job.counts.comments, job.counts.attachments, job.counts.failed], [2, 2, 2, 0]);
    assert.equal(job.kind, 'zammad');

    const t = await ticket('SD-31011');
    assert.equal(t.title, 'Drucker druckt nicht');
    assert.equal(t.status, 'waiting');
    assert.equal(t.priority, 'high');
    assert.equal(t.type, 'incident');
    assert.equal(t.source, 'import');
    assert.match(t.description, /Drucker/);
    assert.match(t.description, /druckt nicht/);
    assert.doesNotMatch(t.description, /<p>/, 'HTML becomes text');
    assert.deepEqual(t.labels, ['drucker', '2.og']);
    assert.equal(t.assignee.displayName, 'Anna Agentin');
    assert.equal(t.reporter.email, 'kurt@kunde.example');
    assert.deepEqual(t.comments.map((c) => [c.body, c.internal, c.author.displayName]), [['Toner bestellt, intern.', true, 'Anna Agentin'], ['Bitte morgen noch einmal testen.', false, 'Anna Agentin']]);
    // fehler.txt from the description (ticket), bestellung.pdf belongs to the internal note; the inline logo is skipped
    const files = Object.fromEntries(t.attachments.map((a) => [a.filename, a]));
    assert.deepEqual(Object.keys(files).sort(), ['bestellung.pdf', 'fehler.txt']);
    assert.equal(files['bestellung.pdf'].commentId, t.comments[0].id);
    assert.equal(t.activity[0].oldValue, '#31011');

    const laptop = db.prepare("SELECT t.number, t.status, t.assignee_id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key='SD' AND t.title='Neuer Laptop'").get();
    assert.notEqual(laptop.number, 20250301100002, 'date-based number gets a new one');
    assert.equal(laptop.status, 'done');
    assert.equal(laptop.assignee_id, null, 'unknown agent stays empty');
    assert.deepEqual(events, [], 'no events/emails during import');

    // A customer sees neither the internal note nor its file
    await call('POST', '/api/users', { username: 'kurt', displayName: 'Kurt', email: 'kurt@kunde.example', role: 'user', password: 'Sehrgeheim123' }).catch(() => {});
    const adminCookie = cookie;
    cookie = '';
    await call('POST', '/api/auth/login', { username: 'kurt', password: 'Sehrgeheim123' });
    const kt = await ticket('SD-31011');
    cookie = adminCookie;
    assert.deepEqual(kt.comments.map((c) => c.body), ['Bitte morgen noch einmal testen.']);
    assert.deepEqual(kt.attachments.map((a) => a.filename), ['fehler.txt']);

    // Again: nothing double, a changed ticket is updated
    z.tickets[0].title = 'Drucker druckt wieder nicht';
    z.tickets[0].updated_at = new Date(Date.now() + 60000).toISOString();
    await call('POST', '/api/admin/import/zammad/start', { connection: conn, projects: [{ key: '2', targetKey: 'SD' }] });
    const again = await waitJob();
    assert.deepEqual([again.counts.created, again.counts.updated, again.counts.unchanged, again.counts.comments, again.counts.attachments], [0, 1, 1, 0, 0]);
    assert.equal((await ticket('SD-31011')).title, 'Drucker druckt wieder nicht');
  } finally { z.close(); }
});

test('Znuny/OTRS: session, queues, internal articles, attachments; classic web service', async () => {
  for (const classic of [false, true]) {
    const zn = await startMockZnuny({ classic });
    try {
      const conn = { baseUrl: zn.url, username: 'import', password: 'falsch' };
      const bad = await call('POST', '/api/admin/import/znuny/connect', { connection: conn });
      assert.equal(bad.body.ok, false);
      assert.match(bad.body.error, /AuthFail/);
      conn.password = 'geheim';
      const r = await call('POST', '/api/admin/import/znuny/connect', { connection: conn });
      assert.equal(r.body.ok, true, JSON.stringify(r.body));
      assert.deepEqual(r.body.projects.map((p) => [p.key, p.name, p.count]), [['3', 'Junk', 1], ['2', 'Raw', 2]]);
      if (classic) { assert.ok(zn.calls.includes('GET /otrs/nph-genericinterface.pl/Webservice/Helfi/Ticket'), 'falls back to GET /Ticket'); continue; }
      const ins = await call('POST', '/api/admin/import/znuny/inspect', { connection: conn, projects: ['2'] });
      assert.deepEqual(ins.body.statuses.map((s) => [s.name, s.suggested]), [['open', 'in_progress'], ['closed successful', 'done']]);
      await call('POST', '/api/admin/import/znuny/start', { connection: conn, projects: [{ key: '2', name: 'Raw', targetKey: 'RAW' }] });
      const job = await waitJob();
      assert.equal(job.state, 'done', JSON.stringify(job.errors));
      assert.deepEqual([job.counts.created, job.counts.comments, job.counts.attachments], [2, 2, 2]);
      const pw = await ticket('RAW-123');
      assert.equal(pw.status, 'done');
      assert.equal(pw.assignee, null, 'root@localhost = nobody');
      assert.equal(pw.reporter.email, 'kurt@kunde.example');
      const vpn = db.prepare("SELECT t.id, p.key || '-' || t.number k FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.title='VPN geht nicht'").get();
      const t = await ticket(vpn.k);
      assert.equal(t.description, 'VPN verbindet nicht.');
      assert.equal(t.assignee.displayName, 'Anna Agentin', 'owner matched by username');
      assert.equal(t.priority, 'high');
      assert.deepEqual(t.comments.map((c) => [c.body, c.internal]), [['Zertifikat abgelaufen.', true], ['Bitte neu verbinden.', false]]);
      const files = Object.fromEntries(t.attachments.map((a) => [a.filename, a.commentId]));
      assert.deepEqual(Object.keys(files).sort(), ['cert.pem', 'log.txt'], 'HTML body part file-2 skipped');
      assert.equal(files['cert.pem'], t.comments[0].id, 'file of the internal note stays with it');
      assert.equal(t.createdAt, new Date(2025, 2, 1, 8, 0, 0).toISOString());
    } finally { zn.close(); }
  }
});

test('CSV: upload, column suggestions, projects from a column, import and repeat', async () => {
  const csv = '﻿Ticket ID;Betreff;Beschreibung;Status;Priorität;E-Mail;Name;Bearbeiter;Erstellt am;Abteilung;Tags\n'
    + '1001;Monitor flackert;"Seit gestern;\nflackert er";Offen;Hoch;eva@firma.local;Eva Berger;anna@firma.local;02.01.2026 09:05;IT;hardware, monitor\n'
    + '1002;Zugang Wiki;;Geschlossen;Niedrig;tom@firma.local;Tom;;03.01.2026;IT;\n'
    + 'A-7;Stuhl kaputt;;Wartet auf Kunde;;;;;;Haustechnik;\n';
  const up = await upload('altsystem-export.csv', csv);
  assert.equal(up.body.ok, true, JSON.stringify(up.body));
  assert.equal(up.body.rows, 3);
  assert.equal(up.body.name, 'altsystem-export');
  assert.deepEqual(up.body.suggested, { id: 'Ticket ID', title: 'Betreff', description: 'Beschreibung', status: 'Status', priority: 'Priorität', reporterEmail: 'E-Mail', reporterName: 'Name', assignee: 'Bearbeiter', created: 'Erstellt am', project: 'Abteilung', labels: 'Tags' });
  const connection = { uploadId: up.body.uploadId, name: 'Altsystem', columns: up.body.suggested };
  const r = await call('POST', '/api/admin/import/csv/connect', { connection });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.projects.map((p) => [p.key, p.suggestedKey, p.count]), [['IT', 'IT', 2], ['Haustechnik', 'HAUSTECHNI', 1]]);
  assert.ok(r.body.projects[0].exists);
  const ins = await call('POST', '/api/admin/import/csv/inspect', { connection, projects: ['IT', 'Haustechnik'] });
  assert.deepEqual(ins.body.statuses.map((s) => [s.name, s.suggested]), [['Offen', 'open'], ['Geschlossen', 'done'], ['Wartet auf Kunde', 'waiting']]);
  // Missing title column → understandable error
  const noTitle = await call('POST', '/api/admin/import/csv/connect', { connection: { ...connection, columns: { id: 'Ticket ID' } } });
  assert.match(noTitle.body.error, /Titel/);

  await call('POST', '/api/admin/import/csv/start', { connection, projects: [{ key: 'IT', targetKey: 'IT' }, { key: 'Haustechnik', targetKey: 'HT', name: 'Haustechnik' }] });
  const job = await waitJob();
  assert.equal(job.state, 'done', JSON.stringify(job.errors));
  assert.equal(job.counts.created, 3);
  const m = await ticket('IT-1001');
  assert.equal(m.description, 'Seit gestern;\nflackert er');
  assert.equal(m.priority, 'high');
  assert.equal(m.status, 'open');
  assert.deepEqual(m.labels, ['hardware', 'monitor']);
  assert.equal(m.assignee.displayName, 'Anna Agentin');
  assert.equal(m.reporter.email, 'eva@firma.local');
  assert.equal(m.createdAt, new Date(2026, 0, 2, 9, 5).toISOString());
  assert.equal((await ticket('IT-1002')).status, 'done');
  assert.equal((await ticket('HT-7')).status, 'waiting');

  // Same file again → nothing new
  await call('POST', '/api/admin/import/csv/start', { connection, projects: [{ key: 'IT', targetKey: 'IT' }] });
  const again = await waitJob();
  assert.equal(again.counts.created, 0);

  // Latin-1 (Excel) is read too; an empty file is refused
  const latin = await upload('alt.csv', Buffer.from('Betreff;Status\nDrucker grün;offen\n', 'latin1'));
  assert.equal(latin.body.ok, true);
  assert.equal(latin.body.preview[0].Betreff, 'Drucker grün');
  const empty = await upload('leer.csv', 'Betreff\n');
  assert.equal(empty.body.ok, false);
  // An old upload id no longer works
  const gone = await call('POST', '/api/admin/import/csv/connect', { connection });
  assert.equal(gone.status, 400);
});

test('Admins only; unknown sources do not exist', async () => {
  assert.equal((await fetch(`${base}/api/admin/import/zammad/connect`, { method: 'POST', headers: { 'X-Helfi-Request': '1' } })).status, 401);
  assert.equal((await call('POST', '/api/admin/import/otrs5/connect', { connection: {} })).status, 404);
  assert.equal((await call('POST', '/api/admin/import/zammad/connect', { connection: { baseUrl: 'ftp://x' } })).status, 400);
});

test('SSRF protection: loopback, link-local (cloud metadata) and multicast are refused, own network stays reachable', async () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.169.254', '224.0.0.1', '::1', '[::1]', '::', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) assert.equal(blockedAddress(ip), true, ip);
  for (const ip of ['10.0.10.5', '192.168.1.10', '172.16.0.1', '203.0.113.7', 'fd12::1', '2001:db8::1']) assert.equal(blockedAddress(ip), false, ip);
  const z = await startMockZammad();
  delete process.env.HELFI_IMPORT_ALLOW_LOCAL;
  try {
    for (const url of [z.url, z.url.replace('127.0.0.1', 'localhost'), 'http://169.254.169.254', 'http://[::1]:8080']) {
      const r = await call('POST', '/api/admin/import/zammad/connect', { connection: { baseUrl: url, token: 'zammad-token' } });
      assert.equal(r.body.ok, false, url);
      assert.match(r.body.error, /gesperrt/, url);
    }
    assert.equal(z.calls.length, 0, 'nothing reached the local system');
  } finally {
    process.env.HELFI_IMPORT_ALLOW_LOCAL = '1';
    z.close();
  }
});
