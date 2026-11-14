// Audit 2026-11f (data consistency, project moves): assignees without rights, AI hints after a
// manual move, duplicate hints of foreign projects, deleting a project, fallback project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from './helpers/server.js';

// Fake model: answers only when released (to move a ticket while it is "thinking")
let releaseAi = null;
const fake = http.createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    await new Promise((r) => { releaseAi = r; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"component": "Haus / Heizung", "reason": "passt"}' } }] }));
  });
});

let S; let anna; let karl; let IT; let HM; let FI;
const row = (title) => S.db.prepare("SELECT t.*, p.key project_key FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.title=?").get(title);
const keyOf = (r) => `${r.project_key}-${r.number}`;
const lastAssigneeLog = (id) => S.db.prepare("SELECT old_value, new_value FROM activity WHERE ticket_id=? AND field='assignee' ORDER BY id DESC").get(id);
const newTicket = async (title, projectId) => (await karl('POST', '/api/tickets', { title, projectId })).body.ticket;
const assign = async (key, userId) => assert.equal((await S.admin('PATCH', `/api/tickets/${key}`, { assigneeId: userId })).status, 200);

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await startServer('audit11f-data');
  anna = await S.user('anna', 'user');
  karl = await S.user('karl', 'user');
  await S.user('lena', 'user');
  IT = S.db.prepare("SELECT id FROM projects WHERE key='IT'").get().id;
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haus' })).body.project.id;
  FI = (await S.admin('POST', '/api/projects', { key: 'FI', name: 'Finanzen' })).body.project.id;
  assert.equal((await S.admin('PUT', `/api/projects/${HM}/agents`, { members: [{ userId: S.ids.anna }] })).status, 200);
});
after(async () => { await S?.stop(); fake.close(); });

// ---------- 1. Assignee without rights ----------
test('Deleting a project with moveTo takes the assignee off when they do not work on the target project', async () => {
  const XX = (await S.admin('POST', '/api/projects', { key: 'XX', name: 'xx' })).body.project.id;
  await S.admin('PUT', `/api/projects/${XX}/agents`, { members: [{ userId: S.ids.anna }] });
  const t = await newTicket('Lampe defekt', XX);
  await assign(t.key, S.ids.anna);
  const d = await S.admin('DELETE', `/api/projects/${XX}`, { moveTo: 'IT' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const r = row('Lampe defekt');
  assert.equal(r.project_key, 'IT');
  assert.equal(r.assignee_id, null, 'anna does not work on IT');
  assert.deepEqual(lastAssigneeLog(r.id), { old_value: 'anna', new_value: null }, 'release is in the history');
});

test('Removing a person from the project people releases their open tickets; closed ones keep the assignee', async () => {
  const P = (await S.admin('POST', '/api/projects', { key: 'PP', name: 'pp' })).body.project.id;
  await S.admin('PUT', `/api/projects/${P}/agents`, { members: [{ userId: S.ids.anna }] });
  const open = await newTicket('Fenster klemmt', P);
  const closed = await newTicket('Tür quietscht', P);
  await assign(open.key, S.ids.anna);
  await assign(closed.key, S.ids.anna);
  assert.equal((await S.admin('PATCH', `/api/tickets/${closed.key}`, { status: 'done' })).status, 200);
  assert.equal((await S.admin('PUT', `/api/projects/${P}/agents`, { members: [] })).status, 200);
  assert.equal(row('Fenster klemmt').assignee_id, null);
  assert.equal(row('Tür quietscht').assignee_id, S.ids.anna, 'closed tickets keep who handled them');
  // shows up as unassigned for the daily reminder again
  assert.ok(S.ctx.reminders.forgotten(P, 0, Date.now() + 1000).some((x) => x.title === 'Fenster klemmt'));
});

test('Replacing the project lead releases the former lead\'s open tickets', async () => {
  const P = (await S.admin('POST', '/api/projects', { key: 'LD', name: 'ld' })).body.project.id;
  await S.admin('PUT', `/api/projects/${P}/agents`, { lead: { userId: S.ids.lena } });
  const t = await newTicket('Leitung weg', P);
  await assign(t.key, S.ids.lena);
  // lead → anna (in the same request lena is not added as a member)
  assert.equal((await S.admin('PUT', `/api/projects/${P}/agents`, { lead: { userId: S.ids.anna } })).status, 200);
  assert.equal(row('Leitung weg').assignee_id, null);
  // lead changed while the old lead becomes a member in the same request: the assignment stays
  const t2 = await newTicket('Leitung bleibt Person', P);
  await assign(t2.key, S.ids.anna);
  assert.equal((await S.admin('PUT', `/api/projects/${P}/agents`, { lead: { userId: S.ids.lena }, members: [{ userId: S.ids.anna }] })).status, 200);
  assert.equal(row('Leitung bleibt Person').assignee_id, S.ids.anna);
});

test('Losing the project group at sign-in releases the open tickets of that project', async () => {
  const ext = { source: 'ldap', username: 'gina', displayName: 'Gina', email: 'gina@firma.local', externalId: '00112233445566778899aabbccddeeff', role: 'user' };
  const gina = S.ctx.users.upsertExternal({ ...ext, access: { projects: [FI] } });
  const t = await newTicket('Rechnung fehlt', FI);
  await assign(t.key, gina.id);
  S.ctx.users.upsertExternal({ ...ext, access: { projects: [] } });
  assert.equal(row('Rechnung fehlt').assignee_id, null);
});

test('Deactivating an account releases its open tickets', async () => {
  await S.user('otto', 'user');
  await S.admin('PUT', `/api/projects/${FI}/agents`, { members: [{ userId: S.ids.otto }] });
  const t = await newTicket('Mahnung', FI);
  await assign(t.key, S.ids.otto);
  assert.equal((await S.admin('PATCH', `/api/users/${S.ids.otto}`, { active: false })).status, 200);
  assert.equal(row('Mahnung').assignee_id, null);
});

test('Migration 46 releases open tickets of former all-project agents (backup first)', async () => {
  const { MIGRATIONS, openDatabase } = await import('../src/db.js');
  const { default: Database } = await import('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-m46-'));
  const file = path.join(dir, 'h.sqlite');
  try {
    const d = new Database(file); d.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.filter((x) => x.id <= 41)) d.exec(m.sql);
    d.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','41'),('app_version','1.40.0')").run();
    d.prepare("INSERT INTO users(username,display_name,role,source) VALUES('agentall','Agent All','agent','local'),('rep','Rep','user','local'),('boss','Boss','admin','local')").run();
    d.prepare("INSERT INTO projects(key,name) VALUES('IT','IT')").run();
    d.prepare("INSERT INTO tickets(project_id,number,title,reporter_id,assignee_id,status) VALUES(1,1,'offen',2,1,'open'),(1,2,'erledigt',2,1,'done'),(1,3,'chef',2,3,'open')").run();
    d.close();
    const db = await openDatabase(file, { appVersion: '9.9.9', backupDir: path.join(dir, 'b') });
    try {
      const a = Object.fromEntries(db.prepare('SELECT title, assignee_id FROM tickets').all().map((x) => [x.title, x.assignee_id]));
      assert.deepEqual(a, { offen: null, erledigt: 1, chef: 3 });
      assert.deepEqual(db.prepare("SELECT ticket_id, user_id, old_value, new_value FROM activity WHERE field='assignee'").all(),
        [{ ticket_id: 1, user_id: null, old_value: 'Agent All', new_value: null }]);
    } finally { db.close(); }
    assert.equal(fs.readdirSync(path.join(dir, 'b')).length, 1, 'backup before the migration');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 2. AI component routing vs. manual moves ----------
test('A manual move settles pending AI hints; a stale suggestion never moves the ticket back', async () => {
  const printer = (await S.admin('POST', `/api/projects/${IT}/components`, { name: 'Drucker', keywords: 'druckerxyz' })).body.component;
  const t = await newTicket('Gerät piept', IT);
  const orig = await newTicket('Gerät piept auch', IT);
  S.db.prepare("INSERT INTO component_suggestions(ticket_id, component_id, component_name, reason, model, state) VALUES(?,?,?,?,?,'pending')").run(t.id, printer.id, 'Drucker', 'x', 'm');
  S.db.prepare("INSERT INTO duplicate_suggestions(ticket_id, original_id, reason, model, state) VALUES(?,?,?,?,'pending')").run(t.id, orig.id, 'r', 'm');
  const mv = await S.admin('PATCH', `/api/tickets/${t.key}`, { projectId: HM });
  assert.equal(mv.status, 200);
  const moved = mv.body.ticket.key;
  assert.equal(S.db.prepare('SELECT state FROM component_suggestions WHERE ticket_id=?').get(t.id).state, 'corrected');
  assert.equal(S.db.prepare('SELECT state FROM duplicate_suggestions WHERE ticket_id=?').get(t.id).state, 'closed');
  const det = (await S.admin('GET', `/api/tickets/${moved}`)).body.ticket;
  assert.equal(det.componentSuggestion, undefined);
  assert.equal(det.duplicateSuggestion, undefined);
  // A pending suggestion of another project left over from before (old data): not shown, accepting is refused
  S.db.prepare("UPDATE component_suggestions SET state='pending' WHERE ticket_id=?").run(t.id);
  assert.equal((await S.admin('GET', `/api/tickets/${moved}`)).body.ticket.componentSuggestion, undefined);
  const acc = await S.admin('POST', `/api/tickets/${moved}/component-suggestion/accept`);
  assert.equal(acc.status, 409);
  assert.equal(row('Gerät piept').project_key, 'HM', 'ticket stays where the agent put it');
  assert.equal(S.db.prepare('SELECT state FROM component_suggestions WHERE ticket_id=?').get(t.id).state, 'corrected',
    'a suggestion that was not applied is never counted as accepted (hit rate)');
  S.db.prepare("UPDATE component_suggestions SET state='pending' WHERE ticket_id=?").run(t.id);
  const many = await S.admin('POST', '/api/component-suggestions/decide', { keys: [moved], action: 'accept' });
  assert.equal(many.body.done, 0);
  assert.equal(row('Gerät piept').project_key, 'HM');
});

test('An AI answer that arrives after a manual move does not move the ticket again', async () => {
  await S.admin('POST', `/api/projects/${HM}/components`, { name: 'Heizung', keywords: 'heizungxyz' });
  S.ctx.settings.set('imap.project', 'IT');
  const set = await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `http://127.0.0.1:${fake.address().port}/v1`, 'ai.model': 'm', 'ai.reasoning': 'off', 'ai.classify': true, 'ai.classifyMode': 'auto', 'ai.duplicates': false } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  try {
    const raw = Buffer.from(['From: Erika <erika@firma.local>', 'To: helpdesk@firma.local', 'Subject: Reisekosten Frage', 'Message-ID: <f11-ai1@firma.local>',
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'bitte', ''].join('\r\n'));
    const r = S.ctx.processor.process(await S.ctx.processor.parse(raw));
    for (let i = 0; i < 100 && !releaseAi; i++) await new Promise((x) => setTimeout(x, 20)); // eslint-disable-line no-await-in-loop
    assert.ok(releaseAi, 'model was asked');
    const key = keyOf(S.db.prepare('SELECT t.*, p.key project_key FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(r.ticketId));
    assert.match(key, /^IT-/);
    assert.equal((await S.admin('PATCH', `/api/tickets/${key}`, { projectId: FI })).status, 200);
    releaseAi();
    await new Promise((x) => setTimeout(x, 50));
    await S.ctx.aiClassifier.idle();
    const after = S.db.prepare('SELECT p.key, t.component_id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(r.ticketId);
    assert.deepEqual(after, { key: 'FI', component_id: null });
  } finally {
    await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': false, 'ai.classify': false } });
    releaseAi = null;
  }
});

// ---------- 3. Duplicate hint of a foreign project ----------
test('A duplicate hint is only shown to someone who may open the original', async () => {
  const secret = await newTicket('GEHEIM Gehaltsliste', IT);
  const t = await newTicket('Heizung kalt', HM);
  S.db.prepare("INSERT INTO duplicate_suggestions(ticket_id, original_id, reason, model, state) VALUES(?,?,?,?,'pending')").run(t.id, secret.id, 'Gehaltsliste', 'm');
  const seen = (await anna('GET', `/api/tickets/${t.key}`)).body.ticket;
  assert.equal(seen.duplicateSuggestion, undefined, 'anna works on HM only');
  assert.equal((await S.admin('GET', `/api/tickets/${t.key}`)).body.ticket.duplicateSuggestion.key, secret.key, 'admins see it');
});

// ---------- 4. Deleting a project: canned responses, KB articles, offerings ----------
async function projectWithContent(key) {
  const id = (await S.admin('POST', '/api/projects', { key, name: key })).body.project.id;
  const c = await S.admin('POST', '/api/canned', { shared: true, projectId: id, title: `${key} intern`, body: 'Tresor-Code 4711' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const kb = await S.admin('POST', '/api/kb', { projectId: id, title: `${key} Artikel`, body: 'intern', visibility: 'internal' });
  assert.equal(kb.status, 201, JSON.stringify(kb.body));
  const cat = await S.admin('POST', '/api/catalog', { title: `${key} Angebot`, projectKey: key });
  assert.equal(cat.status, 201, JSON.stringify(cat.body));
  return { id, canned: c.body.response.id, kb: kb.body.article.id, cat: cat.body.item.id };
}

test('Deleting a project with moveTo moves its canned responses, knowledge articles and offerings along', async () => {
  const x = await projectWithContent('QA');
  const d = await S.admin('DELETE', `/api/projects/${x.id}`, { moveTo: 'HM' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(S.db.prepare('SELECT project_id FROM canned_responses WHERE id=?').get(x.canned).project_id, HM);
  assert.equal(S.db.prepare('SELECT project_id FROM kb_articles WHERE id=?').get(x.kb).project_id, HM);
  assert.deepEqual(S.db.prepare('SELECT project_key, active FROM catalog_items WHERE id=?').get(x.cat), { project_key: 'HM', active: 1 });
  assert.ok((await anna('GET', '/api/canned')).body.responses.some((r) => r.title === 'QA intern'), 'HM people now use it');
});

test('Deleting a project without target never makes its canned responses visible to everyone', async () => {
  const x = await projectWithContent('QB');
  const d = await S.admin('DELETE', `/api/projects/${x.id}`, {});
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.ok(!(await anna('GET', '/api/canned')).body.responses.some((r) => r.title === 'QB intern'), 'not shared with everyone');
  const c = S.db.prepare('SELECT owner_id, project_id FROM canned_responses WHERE id=?').get(x.canned);
  assert.deepEqual(c, { owner_id: S.db.prepare("SELECT id FROM users WHERE username='admin'").get().id, project_id: null }, 'kept as a personal one of the admin');
  assert.deepEqual(S.db.prepare('SELECT project_key, active FROM catalog_items WHERE id=?').get(x.cat), { project_key: '', active: 0 }, 'offering off, no stale key');
  // a new project with the same key does not adopt the offering
  await S.admin('POST', '/api/projects', { key: 'QB', name: 'neu' });
  assert.equal(S.db.prepare('SELECT project_key FROM catalog_items WHERE id=?').get(x.cat).project_key, '');
});

// ---------- 5. Fallback project ----------
test('A ticket without a usable project goes to the default project, not the first one', async () => {
  S.ctx.settings.set('general.defaultProject', 'HM');
  try {
    const cat = await S.admin('POST', '/api/catalog', { title: 'Ohne Projekt' });
    assert.equal(cat.status, 201);
    const o = await karl('POST', `/api/catalog/${cat.body.item.id}/order`, { answers: {} });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    assert.equal(o.body.ticket.projectKey, 'HM');
    // archived project given
    const ar = (await S.admin('POST', '/api/projects', { key: 'AR', name: 'alt' })).body.project.id;
    await S.admin('PATCH', `/api/projects/${ar}`, { archived: true });
    assert.equal(S.ctx.tickets.create(null, { title: 'ins Archiv', projectId: ar }, { source: 'web' }).projectKey, 'HM');
  } finally { S.ctx.settings.set('general.defaultProject', ''); }
});

test('A sender rule naming an archived project is ignored: the mail goes to the inbox project', async () => {
  const ar = (await S.admin('POST', '/api/projects', { key: 'OLD', name: 'alt' })).body.project.id;
  await S.admin('PATCH', `/api/projects/${ar}`, { archived: true });
  S.ctx.settings.set('imap.project', 'FI');
  S.ctx.settings.set('imap.senderRules', JSON.stringify([{ pattern: 'mon@firma.local', action: 'noreply', project: 'OLD' }]));
  try {
    const raw = Buffer.from(['From: mon@firma.local', 'To: helpdesk@firma.local', 'Subject: Alarm', 'Message-ID: <f11-rule1@firma.local>', '', 'x', ''].join('\r\n'));
    const r = S.ctx.processor.process(await S.ctx.processor.parse(raw));
    assert.match(r.key, /^FI-/);
  } finally {
    S.ctx.settings.set('imap.senderRules', '[]');
    S.ctx.settings.set('imap.project', '');
  }
});

test('Reopening a closed ticket releases an assignee who no longer works on the project (web and mail reply)', async () => {
  const P = (await S.admin('POST', '/api/projects', { key: 'RO', name: 'ro' })).body.project.id;
  await S.admin('PUT', `/api/projects/${P}/agents`, { members: [{ userId: S.ids.anna }] });
  const a = await newTicket('Rollo klemmt im Büro', P);
  const b = await newTicket('Wasserhahn tropft RO', P);
  for (const x of [a, b]) {
    await assign(x.key, S.ids.anna);
    assert.equal((await S.admin('PATCH', `/api/tickets/${x.key}`, { status: 'done' })).status, 200);
  }
  assert.equal((await S.admin('PUT', `/api/projects/${P}/agents`, { members: [] })).status, 200);
  assert.equal(row('Rollo klemmt im Büro').assignee_id, S.ids.anna, 'closed tickets keep who handled them');
  // reopened in the web UI
  assert.equal((await S.admin('PATCH', `/api/tickets/${a.key}`, { status: 'open' })).status, 200);
  assert.equal(row('Rollo klemmt im Büro').assignee_id, null);
  // reopened by the reporter's reply
  assert.equal((await karl('POST', `/api/tickets/${b.key}/comments`, { body: 'Tropft wieder' })).status, 201);
  const rb = row('Wasserhahn tropft RO');
  assert.equal(rb.status, 'open');
  assert.equal(rb.assignee_id, null);
});
