// Audit 2026-11, tickets and data: search, contact takeover, backups, deletion protection, import, SLA, counts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.js';
import { startMockJira } from './fixtures/mock-jira.js';

process.env.HELFI_IMPORT_ALLOW_LOCAL = '1'; // mock systems run on 127.0.0.1

let S; let anna; let karl; let paths; let backupKind;
const k = {};
before(async () => {
  S = await startServer('audit-2026-11-tickets');
  ({ paths } = await import('../src/config.js'));
  ({ backupKind } = await import('../src/db.js'));
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  k.a = (await karl('POST', '/api/tickets', { title: 'Drucker kaputt', description: 'Fach 2 klemmt' })).body.ticket.key;
  await anna('PATCH', `/api/tickets/${k.a}`, { assigneeId: S.ids.anna });
});
after(() => S.stop());

const backups = () => (fs.existsSync(paths.backups) ? fs.readdirSync(paths.backups).filter((f) => /\.sqlite(\.gz)?$/.test(f)) : []);
const keys = async (who, q) => (await who('GET', `/api/tickets?q=${encodeURIComponent(q)}`)).body.tickets.map((t) => t.key);
async function waitJob() {
  for (let i = 0; i < 200; i++) {
    const { body } = await S.admin('GET', '/api/admin/import/status');
    if (body.job && body.job.state !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import is stuck');
}

test('Search: control characters (NUL) do not cause a server error', async () => {
  for (const who of [anna, karl]) {
    for (const q of ['\u0000abc', 'ab\u0000', 'Dru\u0000cker', '\u001f\u0007']) {
      const r = await who('GET', `/api/tickets?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200, `${JSON.stringify(q)}: ${JSON.stringify(r.body)}`);
    }
  }
  // Control characters separate like whitespace: "Drucker\u0000kaputt" = "Drucker kaputt"
  assert.deepEqual(await keys(karl, 'Drucker\u0000kaputt'), [k.a]);
});

test('Search: users cannot confirm the agent\'s address and login name', async () => {
  // Display name ≠ login name (in the test setup both are "anna")
  S.db.prepare("UPDATE users SET display_name='Bea Bearbeiterin' WHERE username='anna'").run();
  assert.deepEqual(await keys(karl, 'anna@firma.local'), [], 'agent\'s email');
  assert.deepEqual(await keys(karl, 'anna'), [], 'agent\'s login name');
  assert.deepEqual(await keys(karl, 'Drucker'), [k.a], 'title still searchable');
  assert.deepEqual(await keys(karl, 'klemmt'), [k.a], 'description still searchable');
  assert.deepEqual(await keys(anna, 'anna@firma.local'), [k.a], 'agents still find via people');
  // Users can also find the agent's visible name
  assert.deepEqual(await keys(karl, 'Bearbeiterin'), [k.a], 'display name (visible in the ticket)');
});

test('Deleting a project: rejected → no backup; allowed → own kind, gets cleaned up', async () => {
  const it = S.ctx.tickets.projects.get('IT');
  // last project or invalid target: rejected, without a copy of the database
  let r = await S.admin('DELETE', `/api/projects/${it.id}`, { moveTo: 'NOPE' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.lastProject');
  const hr = (await S.admin('POST', '/api/projects', { key: 'HR', name: 'Personal' })).body.project;
  r = await S.admin('DELETE', `/api/projects/${it.id}`, { moveTo: 'NOPE' });
  assert.equal(r.status, 400);
  r = await S.admin('DELETE', `/api/projects/${it.id}`, {});
  assert.equal(r.body.error.code, 'err.projectHasTickets');
  assert.deepEqual(backups().filter((f) => f.includes('vor-loeschen')), [], 'no backup on rejection');

  // own kind: neither manual nor version change
  assert.equal(backupKind('helfi-vor-loeschen-HR-2026-01-01T00-00-00.sqlite'), 'predelete');
  assert.equal(backupKind('helfi-vor-import-2026-01-01T00-00-00.sqlite'), 'preimport');
  assert.equal(backupKind('helfi-manuell-2026-01-01T00-00-00.sqlite'), 'manual');
  assert.equal(backupKind('helfi-vor-1.9.0-2026-01-01T00-00-00.sqlite'), 'version');
  assert.equal(backupKind('helfi-vor-loeschen-HR-2026-01-01T00-00-00.sqlite.gz'), 'predelete', 'packed: same kind');
  assert.equal(backupKind('helfi-vor-1.9.0-2026-01-01T00-00-00.sqlite.gz'), 'version');

  // after the backup, cleanup runs (backup.keep per kind)
  await S.admin('PUT', '/api/admin/settings', { settings: { 'backup.keep': 1 } });
  fs.mkdirSync(paths.backups, { recursive: true });
  const old = path.join(paths.backups, 'helfi-vor-loeschen-ALT-2020-01-01T00-00-00.sqlite');
  fs.writeFileSync(old, 'x');
  fs.utimesSync(old, Date.now() / 1000 - 86400, Date.now() / 1000 - 86400);
  r = await S.admin('DELETE', `/api/projects/${hr.id}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let left = backups().filter((f) => f.includes('vor-loeschen'));
  assert.equal(left.length, 1, JSON.stringify(left));
  assert.match(left[0], /^helfi-vor-loeschen-HR-/);

  // a manual backup does not push it out
  await S.admin('POST', '/api/admin/backup');
  left = backups();
  assert.ok(left.some((f) => f.startsWith('helfi-vor-loeschen-HR-')), JSON.stringify(left));
  assert.ok(left.some((f) => f.startsWith('helfi-manuell-')));
  await S.admin('PUT', '/api/admin/settings', { settings: { 'backup.keep': 10 } });
});

test('Taking over a contact: approvals, CI owners and approver lists are preserved', async () => {
  const contact = S.ctx.users.contactForEmail('chef@firma.local', 'Chef');
  const item = (await S.admin('POST', '/api/catalog', { title: 'Laptop', approverIds: [contact.id], fields: [] })).body.item;
  const tk = (await karl('POST', `/api/catalog/${item.id}/order`, { answers: {} })).body.ticket;
  const ci = (await S.admin('POST', '/api/cis', { name: 'PC-0001', ownerId: contact.id })).body;
  assert.ok(ci);
  S.ctx.settings.set('change.approvers', `${S.ids.anna}, ${contact.id}`);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM approvals WHERE ticket_id=? AND approver_id=?').get(tk.id, contact.id).n, 1);

  // Local account gets the address → contact is taken over
  const chef = (await S.admin('POST', '/api/users', { username: 'chef', displayName: 'Chef', role: 'user', password: 'Sehrgeheim123' })).body.user;
  assert.equal((await S.admin('PATCH', `/api/users/${chef.id}`, { email: 'chef@firma.local' })).status, 200);
  assert.ok(!S.ctx.users.byId(contact.id), 'contact dissolved');

  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM approvals WHERE ticket_id=? AND approver_id=?').get(tk.id, chef.id).n, 1, 'approval reassigned');
  assert.equal(S.db.prepare("SELECT owner_id FROM config_items WHERE name='PC-0001'").get().owner_id, chef.id, 'CI owner reassigned');
  assert.equal(S.db.prepare('SELECT approver_ids FROM catalog_items WHERE id=?').get(item.id).approver_ids, String(chef.id));
  assert.equal(S.ctx.settings.get('change.approvers'), `${S.ids.anna},${chef.id}`);

  // The account can decide the request
  const c = await S.client().login('chef');
  const d = await c('POST', `/api/tickets/${tk.key}/approval`, { decision: 'approve' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
});

test('Never delete tickets: the database refuses DELETE', () => {
  const p = S.ctx.tickets.projects.create({ key: 'ZZ', name: 'zz' });
  const id = S.db.prepare("INSERT INTO tickets(project_id,number,title) VALUES(?,1,'Schutztest')").run(p.id).lastInsertRowid;
  assert.throws(() => S.db.prepare('DELETE FROM tickets WHERE id=?').run(id), /Tickets werden nie gelöscht/);
  assert.throws(() => S.db.prepare('DELETE FROM projects WHERE id=?').run(p.id), /Projekt hat Tickets/);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM tickets WHERE id=?').get(id).n, 1);
  // empty projects can still be deleted
  const empty = S.ctx.tickets.projects.create({ key: 'LEER', name: 'leer' });
  S.db.prepare('DELETE FROM projects WHERE id=?').run(empty.id);
  assert.equal(S.ctx.tickets.projects.get('LEER'), null);
});

test('SLA: imported tickets (source jira) have no SLA', () => {
  S.ctx.settings.setMany({ 'sla.enabled': true, 'sla.holidays': '' });
  try {
    const p = S.ctx.tickets.projects.get('IT');
    const mk = (source, n) => S.db.prepare("SELECT * FROM tickets WHERE id=?").get(S.db.prepare(`INSERT INTO tickets(project_id,number,title,type,reporter_id,source)
      VALUES(?,?,'SLA-Test','incident',?,?)`).run(p.id, n, S.ids.karl, source).lastInsertRowid);
    assert.ok(S.ctx.sla.forRow(mk('web', 9001)), 'cross-check: normal ticket has SLA');
    assert.equal(S.ctx.sla.forRow(mk('jira', 9002)), null);
    assert.equal(S.ctx.sla.forRow(mk('import', 9003)), null);
  } finally { S.ctx.settings.set('sla.enabled', false); }
});

test('Import: backup beforehand, numbers of moved tickets not reused, changes in the activity log', async () => {
  // Project SUP with SUP-1 … SUP-10; SUP-10 is moved to IT → number 10 is free but has been used before
  const sup = (await S.admin('POST', '/api/projects', { key: 'SUP', name: 'Support' })).body.project;
  for (let i = 1; i <= 10; i++) await S.admin('POST', '/api/tickets', { title: `lokal ${i}`, projectId: sup.id });
  const it = S.ctx.tickets.projects.get('IT');
  assert.equal((await S.admin('PATCH', '/api/tickets/SUP-10', { projectId: it.id })).status, 200);

  const before = backups().filter((f) => f.startsWith('helfi-vor-import-')).length;
  const jira = await startMockJira({ type: 'cloud' });
  try {
    const conn = { type: 'cloud', baseUrl: jira.url, email: 'admin@firma.local', token: 'cloud-token' };
    const r = await S.admin('POST', '/api/admin/import/jira/start', { connection: conn, projects: [{ key: 'SUP' }], options: { attachments: false } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const job = await waitJob();
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.equal(backups().filter((f) => f.startsWith('helfi-vor-import-')).length, before + 1, 'backup before the import');

    const nums = S.db.prepare("SELECT number FROM tickets WHERE project_id=? AND source='jira' ORDER BY number").all(sup.id).map((x) => x.number);
    assert.ok(!nums.includes(10), `SUP-10 not reused: ${nums}`);
    assert.deepEqual(nums, [11, 20, 30]);

    // Re-import with changed fields: activity log records old → new
    jira.issues[1].fields.summary = 'Vorgang 2 (geändert)';
    jira.issues[1].fields.priority = { name: 'Highest' };
    jira.issues[1].fields.updated = new Date(Date.now() + 60000).toISOString();
    await S.admin('POST', '/api/admin/import/jira/start', { connection: conn, projects: [{ key: 'SUP' }], options: { attachments: false } });
    await waitJob();
    const t = (await S.admin('GET', '/api/tickets/SUP-20')).body.ticket;
    assert.equal(t.title, 'Vorgang 2 (geändert)');
    const title = t.activity.find((a) => a.field === 'title');
    assert.deepEqual([title?.oldValue, title?.newValue], ['Vorgang 2', 'Vorgang 2 (geändert)']);
    const prio = t.activity.find((a) => a.field === 'priority');
    assert.deepEqual([prio?.oldValue, prio?.newValue], ['medium', 'highest']);
  } finally { jira.close(); }

  // No start (missing projects) → no backup
  const n = backups().filter((f) => f.startsWith('helfi-vor-import-')).length;
  const bad = await S.admin('POST', '/api/admin/import/jira/start', { connection: { type: 'cloud', baseUrl: 'http://127.0.0.1:1' }, projects: [] });
  assert.equal(bad.status, 400);
  assert.equal(backups().filter((f) => f.startsWith('helfi-vor-import-')).length, n);
});

test('Counts: "Assigned to me" without archived projects, archived project explicitly, unknown project', async () => {
  const p = (await S.admin('POST', '/api/projects', { key: 'ARC', name: 'Archiv' })).body.project;
  await anna('POST', '/api/tickets', { title: 'archiviert', projectId: p.id, assigneeId: S.ids.anna });
  await S.admin('PATCH', `/api/projects/${p.id}`, { archived: true });
  const st = (await anna('GET', '/api/stats')).body;
  const q = (await anna('GET', '/api/queues')).body.counts;
  assert.equal(st.mine, q.mine, 'statistics and queue equal');
  const sum = (await anna('GET', '/api/summary?project=ARC')).body;
  assert.equal(sum.counts.open, 1, 'summary of an archived project shows its tickets');
  const all = (await anna('GET', '/api/summary')).body;
  assert.equal(all.urgent.some((x) => x.title === 'archiviert'), false, 'overall summary without archived ones');
  const none = (await anna('GET', '/api/queues?project=NOPE')).body.counts;
  assert.equal(none.open, 0, 'unknown project → 0 instead of all');
});
