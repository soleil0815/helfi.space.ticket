// Audit 2026-11 (tickets, mail, catalog): placeholders from the writer's view in bulk actions, mail via
// [KEY-n] only from current parties, approved requests keep their text, orphaned catalog offerings
// are never taken over by a new project with the same key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.js';

let S; let ctx; let db; let karl; let hma; let it; let hm;
const eml = (lines) => Buffer.from(lines.join('\r\n'));
const mail = async (lines) => { const p = ctx.processor; return p.process(await p.parse(eml(lines))); };

before(async () => {
  S = await startServer('audit-data');
  ctx = S.ctx; db = S.db;
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
  it = db.prepare("SELECT id FROM projects WHERE key='IT'").get().id;
  hm = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  karl = await S.user('karl', 'user');
  await S.user('hma', 'user');
  db.prepare("INSERT INTO project_agents(project_id,user_id,source) VALUES(?,?,'manual')").run(hm.id, S.ids.hma);
  hma = await S.client().login('hma');
});
after(() => S?.stop());

test('Bulk comment and resolve: {melder} is filled from the writer\'s view (no address for a non-agent of the project)', async () => {
  const contact = ctx.users.contactForEmail('max.muster@extern.example', 'max.muster@extern.example');
  const tk = (await S.admin('POST', '/api/tickets', { title: 'Zugang', projectId: it })).body.ticket;
  db.prepare('UPDATE tickets SET reporter_id=? WHERE id=?').run(contact.id, tk.id);
  // hma works on HM only, but takes part in this IT request
  db.prepare('INSERT INTO ticket_participants(ticket_id,user_id) VALUES(?,?)').run(tk.id, S.ids.hma);
  const r = await hma('POST', '/api/tickets/bulk', { keys: [tk.key], comment: 'Hallo {melder}, danke!' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const body = db.prepare('SELECT body FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(tk.id).body;
  assert.doesNotMatch(body, /max\.muster@extern\.example/, 'no full address');
  assert.match(body, /max\.muster@…/);
  // an agent of the project still gets the full name
  await S.admin('POST', '/api/tickets/bulk', { keys: [tk.key], comment: 'Hallo {melder}' });
  assert.match(db.prepare('SELECT body FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(tk.id).body, /max\.muster@extern\.example/);
});

test('Mail with [KEY-n] in the subject: a former commenter is no longer a party (new ticket instead of a public comment)', async () => {
  const first = await mail(['From: lieferant@extern.example', 'To: helpdesk@firma.local', 'Subject: Angebot', 'Message-ID: <d1@extern.example>', '', 'Hallo']);
  const key = db.prepare('SELECT p.key || \'-\' || t.number k FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(first.ticketId).k;
  // the supplier writes once more while still the reporter (a comment), …
  const reply = await mail(['From: lieferant@extern.example', 'To: helpdesk@firma.local', `Subject: [${key}] Nachtrag`, 'Message-ID: <d1b@extern.example>', '', 'Nachtrag']);
  assert.equal(reply.ticketId, first.ticketId);
  // … then is no longer the reporter (moved to the right person)
  const nora = ctx.users.contactForEmail('nora@firma.local', 'Nora');
  db.prepare('UPDATE tickets SET reporter_id=?, reporter_email=NULL WHERE id=?').run(nora.id, first.ticketId);
  const before = db.prepare('SELECT COUNT(*) n FROM comments WHERE ticket_id=?').get(first.ticketId).n;
  const r = await mail(['From: lieferant@extern.example', 'To: helpdesk@firma.local', `Subject: [${key}] noch etwas`, 'Message-ID: <d2@extern.example>', '', 'Neuer Preis']);
  assert.notEqual(r.ticketId, first.ticketId, 'new ticket');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM comments WHERE ticket_id=?').get(first.ticketId).n, before, 'no comment on the old ticket');
  // the current reporter still writes via the subject
  const r2 = await mail(['From: nora@firma.local', 'To: helpdesk@firma.local', `Subject: [${key}] Rückfrage`, 'Message-ID: <d3@firma.local>', '', 'Passt so']);
  assert.equal(r2.ticketId, first.ticketId);
  assert.equal(r2.action, 'comment');
});

test('Catalog request: reporter cannot change title or description while it waits for or holds an approval', async () => {
  const item = (await S.admin('POST', '/api/catalog', { title: 'Laptop', approverIds: [S.ids.hma], fields: [], projectId: it })).body.item;
  const tk = (await karl('POST', `/api/catalog/${item.id}/order`, { answers: {} })).body.ticket;
  const desc = db.prepare('SELECT description FROM tickets WHERE id=?').get(tk.id).description;
  let r = await karl('PATCH', `/api/tickets/${tk.key}`, { description: 'Bitte gleich zwei Laptops, Modell Pro Max' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'err.approvalLocked');
  assert.match(r.body.error.message, /Kommentar|comment/);
  assert.equal((await karl('GET', `/api/tickets/${tk.key}`)).body.ticket.approval.state, 'pending');
  await hma('POST', `/api/tickets/${tk.key}/approval`, { decision: 'approve' });
  r = await karl('PATCH', `/api/tickets/${tk.key}`, { title: 'Zwei Laptops' });
  assert.equal(r.status, 409, 'also after approval');
  assert.equal(db.prepare('SELECT description FROM tickets WHERE id=?').get(tk.id).description, desc);
  // a comment still works, an agent may still correct the text
  assert.equal((await karl('POST', `/api/tickets/${tk.key}/comments`, { body: 'Gern in Silber' })).status, 201);
  assert.equal((await S.admin('PATCH', `/api/tickets/${tk.key}`, { title: 'Laptop (Silber)' })).status, 200);
  // also when the requester is an agent of the project themselves
  const own = (await S.admin('POST', `/api/catalog/${item.id}/order`, { answers: {} })).body.ticket;
  assert.equal((await S.admin('PATCH', `/api/tickets/${own.key}`, { description: 'Lieber drei' })).status, 409);
  // an ordinary ticket of the reporter stays editable
  const plain = (await karl('POST', '/api/tickets', { title: 'Maus defekt', projectId: it })).body.ticket;
  assert.equal((await karl('PATCH', `/api/tickets/${plain.key}`, { description: 'Linke Taste' })).status, 200);
});

test('Orphaned catalog offerings: a new project with the same key does not take them over', async () => {
  db.prepare("INSERT INTO catalog_items(title, description, emoji, project_key, fields, approver_ids, approval_mode, active, sort) VALUES('Altes Angebot', '', '', 'FIN', '[]', '', 'any', 1, 0)").run();
  const fin = await S.admin('POST', '/api/projects', { key: 'FIN', name: 'Finanzen' });
  assert.equal(fin.status, 201, JSON.stringify(fin.body));
  const row = db.prepare("SELECT project_key, active FROM catalog_items WHERE title='Altes Angebot'").get();
  assert.deepEqual([row.project_key, row.active], ['', 0]);
});

test('Migration 50 switches existing orphaned offerings off (backup first), offerings of existing projects stay', async () => {
  const { openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mig50-'));
  try {
    const file = path.join(dir, 'h.sqlite');
    let d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    d.prepare("INSERT INTO projects(key, name) VALUES('IT', 'IT')").run();
    const add = d.prepare("INSERT INTO catalog_items(title, description, emoji, project_key, fields, approver_ids, approval_mode, active, sort) VALUES(?, '', '', ?, '[]', '', 'any', 1, 0)");
    add.run('verwaist', 'ALT'); add.run('gültig', 'IT'); add.run('ohne', '');
    d.prepare("UPDATE meta SET value='49' WHERE key='schema_version'").run();
    d.close();
    d = await openDatabase(file, { appVersion: '1.0.1', backupDir: path.join(dir, 'b') });
    const get = (t) => d.prepare('SELECT project_key k, active a FROM catalog_items WHERE title=?').get(t);
    assert.deepEqual(get('verwaist'), { k: '', a: 0 });
    assert.deepEqual(get('gültig'), { k: 'IT', a: 1 });
    assert.deepEqual(get('ohne'), { k: '', a: 1 });
    d.close();
    assert.equal(fs.readdirSync(path.join(dir, 'b')).length, 1, 'backup before the migration');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
