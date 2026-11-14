// Project rights are set in the project: its lead, its agent group (AD/SSO) and people added by hand
// work on its tickets – whatever their role. Agents and admins work on all projects. For tickets of
// other projects such a person is a normal user: their own requests only, no internal notes, no
// history, no agent tools – and nothing of those projects in counts and reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let projectAccessFromGroups; let roleFromGroups; let agentOn; let agentProjects;
let S; let ita; let hma; let karl; let IT; let HM;
const keys = {};
before(async () => {
  S = await startServer('projperm');
  ({ projectAccessFromGroups, roleFromGroups } = await import('../src/users.js'));
  ({ agentOn, agentProjects } = await import('../src/auth/access.js'));
  ita = await S.user('ita', 'agent');
  hma = await S.user('hma', 'user');
  karl = await S.user('karl', 'user');
  const p = await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' });
  assert.equal(p.status, 201);
  IT = S.db.prepare("SELECT id FROM projects WHERE key='IT'").get().id;
  HM = p.body.project.id;
  // Tickets: two in IT, one in HM, and hma's own request in IT
  keys.itOther = (await karl('POST', '/api/tickets', { title: 'Drucker 2. OG', projectId: IT })).body.ticket.key;
  keys.itSecret = (await karl('POST', '/api/tickets', { title: 'VPN-Zugang', projectId: IT })).body.ticket.key;
  keys.hm = (await karl('POST', '/api/tickets', { title: 'Heizung Raum 12 kalt', projectId: HM })).body.ticket.key;
  keys.hmOwnIt = (await hma('POST', '/api/tickets', { title: 'Mein Laptop startet nicht', projectId: IT })).body.ticket.key;
  await S.admin('POST', `/api/tickets/${keys.hmOwnIt}/comments`, { body: 'Kennwort für den Testzugang: geheimwort42', internal: true });
  await S.admin('POST', `/api/tickets/${keys.hmOwnIt}/comments`, { body: 'Wir schauen es uns an.' });
  // hma (role user): added to HM by hand → works on HM only
  const r = await S.admin('PUT', `/api/projects/${HM}/agents`, { members: [{ userId: S.ids.hma }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.members.map((m) => m.id), [S.ids.hma]);
  assert.equal((await hma('GET', '/api/me')).body.user.role, 'agent', 'acts as an agent (of HM)');
});
after(() => S.stop());

test('Agents work on all projects (nothing changes on update)', async () => {
  const list = (await ita('GET', '/api/tickets')).body.tickets.map((x) => x.key);
  for (const k of Object.values(keys)) assert.ok(list.includes(k), k);
  const d = (await ita('GET', `/api/tickets/${keys.hm}`)).body.ticket;
  assert.equal(d.agentView, true);
  const projects = (await ita('GET', '/api/projects')).body.projects;
  assert.ok(projects.every((p) => p.agent), 'agent of every project');
});

test('Agent of some projects: their tickets there, their own requests elsewhere – nothing else', async () => {
  const list = (await hma('GET', '/api/tickets')).body.tickets;
  const got = list.map((x) => x.key).sort();
  assert.deepEqual(got, [keys.hm, keys.hmOwnIt].sort());
  // own request in IT: user view (no component, no internal counts)
  const own = list.find((x) => x.key === keys.hmOwnIt);
  assert.equal(own.commentCount, 1, 'only the public reply counts');
  // other IT tickets: as if they did not exist
  assert.equal((await hma('GET', `/api/tickets/${keys.itOther}`)).status, 404);
  assert.equal((await hma('PATCH', `/api/tickets/${keys.itOther}`, { status: 'done' })).status, 404);
  assert.equal((await hma('GET', `/api/tickets?project=IT`)).body.tickets.map((x) => x.key).join(), keys.hmOwnIt);
  // project list: every project for requests, agent flag only for HM
  const projects = (await hma('GET', '/api/projects')).body.projects;
  assert.deepEqual(projects.filter((p) => p.agent).map((p) => p.key), ['HM']);
  assert.ok(projects.some((p) => p.key === 'IT'), 'requests may still go to IT');
});

test('Own request in a foreign project: no internal notes, no history, no agent fields', async () => {
  const d = (await hma('GET', `/api/tickets/${keys.hmOwnIt}`)).body.ticket;
  assert.equal(d.agentView, false);
  assert.deepEqual(d.activity, []);
  assert.ok(d.comments.every((c) => !c.internal), 'internal note hidden');
  assert.ok(!JSON.stringify(d).includes('geheimwort42'));
  assert.equal(d.assignableIds, undefined);
  // an internal note is refused (never downgraded to a public reply); a reply works,
  // but status and priority cannot be changed
  const n = await hma('POST', `/api/tickets/${keys.hmOwnIt}/comments`, { body: 'Danke!', internal: true });
  assert.equal(n.status, 403);
  const c = await hma('POST', `/api/tickets/${keys.hmOwnIt}/comments`, { body: 'Danke!' });
  assert.equal(c.status, 201);
  assert.equal(c.body.comment.internal, false);
  const u = await hma('PATCH', `/api/tickets/${keys.hmOwnIt}`, { priority: 'highest', status: 'done' });
  assert.equal(u.status, 200);
  const row = S.db.prepare("SELECT priority, status FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key='IT' AND t.number=?").get(Number(keys.hmOwnIt.split('-')[1]));
  assert.equal(row.priority, 'medium');
  assert.notEqual(row.status, 'done');
  // agent-only endpoints on it: refused
  assert.equal((await hma('GET', `/api/tickets/${keys.hmOwnIt}/mention-candidates`)).status, 403);
  assert.equal((await hma('POST', `/api/tickets/${keys.hmOwnIt}/resolve`, { resolution: 'rejected', reason: 'x' })).status, 403);
  assert.equal((await hma('PATCH', `/api/tickets/${keys.hmOwnIt}/fields`, { workaround: 'x' })).status, 403);
  assert.equal((await hma('POST', `/api/tickets/${keys.hmOwnIt}/links`, { kind: 'relates', target: keys.hm })).status, 403);
});

test('Search: internal notes of foreign projects never match', async () => {
  const hits = (await hma('GET', '/api/tickets?q=geheimwort42')).body.tickets;
  assert.equal(hits.length, 0);
  const itHits = (await ita('GET', '/api/tickets?q=geheimwort42')).body.tickets.map((x) => x.key);
  assert.deepEqual(itHits, [keys.hmOwnIt]);
  // public text of the own request still matches
  assert.deepEqual((await hma('GET', '/api/tickets?q=Laptop')).body.tickets.map((x) => x.key), [keys.hmOwnIt]);
});

test('Counts, queues, summary and stats: only their projects', async () => {
  const q = (await hma('GET', '/api/queues')).body.counts;
  assert.equal(q.open, 1, 'only the HM ticket');
  assert.equal(q.unassigned, 1);
  const s = (await hma('GET', '/api/stats')).body;
  assert.equal(s.unassigned, 1);
  const sum = (await hma('GET', '/api/summary')).body;
  assert.equal(sum.counts.open, 1);
  assert.deepEqual(sum.urgent.map((x) => x.key), [keys.hm]);
  assert.equal((await hma('GET', '/api/summary?project=IT')).status, 404);
  assert.equal((await hma('GET', '/api/queues?project=IT')).body.counts.open, 0);
  // full agents unchanged
  assert.ok((await ita('GET', '/api/queues')).body.counts.open >= 4);
});

test('Reports: only their projects, another project → 404', async () => {
  const r = (await hma('GET', '/api/reports')).body;
  assert.equal(r.totals.created, 1, 'only the HM ticket was created in their projects');
  assert.equal((await hma('GET', '/api/reports?project=IT')).status, 404);
  assert.equal((await hma('GET', '/api/reports/itil?project=IT')).status, 404);
  assert.equal((await hma('GET', '/api/reports/satisfaction?project=IT')).status, 200, 'satisfaction: other project gives nothing');
  assert.equal((await hma('GET', '/api/reports/satisfaction?project=IT')).body.sent, 0);
  // the agent list of their report: agents of HM (and those of all projects), not agents of other projects only
  assert.ok((await ita('GET', '/api/reports')).body.agents.some((a) => a.username === 'hma'), 'ita sees everyone');
  assert.equal((await hma('GET', '/api/reports')).body.totals.open, 1);
});

test('Assignment: only agents of the ticket\'s project; moving clears an assignee of another project', async () => {
  // HM ticket to hma: fine
  assert.equal((await S.admin('PATCH', `/api/tickets/${keys.hm}`, { assigneeId: S.ids.hma })).status, 200);
  // IT ticket to hma: not an agent of IT
  assert.equal((await S.admin('PATCH', `/api/tickets/${keys.itOther}`, { assigneeId: S.ids.hma })).status, 400);
  // assignable list in the ticket
  const d = (await S.admin('GET', `/api/tickets/${keys.itOther}`)).body.ticket;
  assert.ok(!d.assignableIds.includes(S.ids.hma));
  assert.ok(d.assignableIds.includes(S.ids.ita));
  // agent list for assigning: per project
  assert.equal((await hma('GET', '/api/users?project=IT')).status, 404);
  const hmAgents = (await hma('GET', '/api/users?project=HM')).body.users.map((u) => u.username);
  assert.ok(hmAgents.includes('hma') && hmAgents.includes('ita') && hmAgents.includes('admin'));
  // moving into any active project is allowed (see mail-routing.test.js) – not into an unknown one
  assert.equal((await hma('PATCH', `/api/tickets/${keys.hm}`, { projectId: 99999 })).status, 404);
  // admin moves the HM ticket (assigned to hma) to IT: assignee removed
  const moved = await S.admin('PATCH', `/api/tickets/${keys.hm}`, { projectId: IT });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.ticket.assignee, null);
  // … and back (keys.hm keeps pointing to an HM ticket for the following tests)
  const back = await S.admin('PATCH', `/api/tickets/${moved.body.ticket.key}`, { projectId: HM });
  keys.hm = back.body.ticket.key;
  // creating for someone else in a foreign project: refused
  const onBehalf = await hma('POST', '/api/tickets', { title: 'Für Karl', projectId: IT, reporter: { userId: S.ids.karl } });
  assert.equal(onBehalf.status, 403);
  const inHm = await hma('POST', '/api/tickets', { title: 'Für Karl im HM', projectId: HM, reporter: { userId: S.ids.karl }, notifyReporter: false });
  assert.equal(inHm.status, 201);
  assert.equal(inHm.body.ticket.reporter.id, S.ids.karl);
});

test('@-mentions: agents of other projects are not mentioned in internal notes', async () => {
  const c = await S.admin('POST', `/api/tickets/${keys.itOther}/comments`, { body: `@[hma](user:${S.ids.hma}) bitte prüfen`, internal: true });
  assert.equal(c.status, 201);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM comment_mentions WHERE user_id=?').get(S.ids.hma).n, 0);
  const cands = (await S.admin('GET', `/api/tickets/${keys.itOther}/mention-candidates?q=hm&internal=1`)).body.people;
  assert.ok(!cands.some((p) => p.id === S.ids.hma));
});

test('Bulk actions on foreign tickets fail per ticket', async () => {
  const r = await hma('POST', '/api/tickets/bulk', { keys: [keys.hm, keys.itOther], changes: { priority: 'high' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.ok, [keys.hm]);
  assert.deepEqual(r.body.failed.map((f) => f.key), [keys.itOther]);
});

test('Devices: ticket history of a device shows only their projects', async () => {
  const ci = (await S.admin('POST', '/api/cis', { name: 'Drucker-2OG' })).body.item;
  assert.equal((await S.admin('POST', `/api/tickets/${keys.itOther}/cis`, { ciId: ci.id })).status, 200);
  assert.equal((await S.admin('POST', `/api/tickets/${keys.hm}/cis`, { ciId: ci.id })).status, 200);
  const seen = (await hma('GET', `/api/cis/${ci.id}`)).body.item.history.map((x) => x.key);
  assert.deepEqual(seen, [keys.hm]);
  assert.equal((await hma('POST', `/api/tickets/${keys.hmOwnIt}/cis`, { ciId: ci.id })).status, 403);
});

test('Major incidents in the notice bar: only their projects', async () => {
  await S.admin('PATCH', `/api/tickets/${keys.itSecret}`, { major: true });
  const boot = (await hma('GET', '/api/bootstrap')).body;
  assert.ok(!(boot.majorIncidents || []).some((m) => m.key === keys.itSecret));
  const bootIt = (await ita('GET', '/api/bootstrap')).body;
  assert.ok(bootIt.majorIncidents.some((m) => m.key === keys.itSecret));
});

test('Admin: lead, group and people are set in the project – the role under Users does not matter', async () => {
  assert.equal((await hma('GET', `/api/projects/${HM}/agents`)).status, 403);
  // lead of IT: a plain user who now works on IT
  let r = await S.admin('PUT', `/api/projects/${IT}/agents`, { lead: { userId: S.ids.karl }, agentGroup: 'IT-Helpdesk', members: [{ userId: S.ids.hma }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.lead.id, S.ids.karl);
  assert.equal(r.body.agentGroup, 'IT-Helpdesk');
  assert.deepEqual(r.body.members.map((m) => m.id), [S.ids.hma]);
  assert.equal(S.db.prepare('SELECT lead_id FROM projects WHERE id=?').get(IT).lead_id, S.ids.karl);
  assert.equal((await karl('GET', `/api/tickets/${keys.itOther}`)).body.ticket.agentView, true, 'the lead works on IT');
  assert.equal((await hma('GET', `/api/tickets/${keys.itOther}`)).status, 200);
  // admin list: base role stays "user", the projects are shown with how
  const list = (await S.admin('GET', '/api/users?all=1')).body.users;
  const k = list.find((u) => u.username === 'karl');
  assert.equal(k.role, 'user');
  assert.deepEqual(k.projects.map((p) => [p.key, p.source]), [['IT', 'lead']]);
  const projects = (await S.admin('GET', '/api/projects?all=1')).body.projects;
  const it = projects.find((p) => p.key === 'IT');
  assert.equal(it.lead.id, S.ids.karl);
  assert.equal(it.agentGroup, 'IT-Helpdesk');
  assert.equal(it.memberCount, 1);
  // changing someone's account does not touch their project rights, and never stores the effective role
  assert.equal((await S.admin('PATCH', `/api/users/${S.ids.karl}`, { roleLocked: true })).body.user.role, 'user');
  assert.equal(S.db.prepare('SELECT role FROM users WHERE id=?').get(S.ids.karl).role, 'user', 'never written back as agent');
  assert.equal(S.db.prepare('SELECT lead_id FROM projects WHERE id=?').get(IT).lead_id, S.ids.karl);
  // email contacts and unknown people cannot be added
  const contact = S.ctx.users.contactForEmail('extern@example.org', 'Extern');
  assert.equal((await S.admin('PUT', `/api/projects/${IT}/agents`, { members: [{ userId: contact.id }] })).status, 400);
  assert.equal((await S.admin('PUT', `/api/projects/${IT}/agents`, { lead: { userId: 99999 } })).status, 400);
  // removing lead and people takes the rights away at once
  r = await S.admin('PUT', `/api/projects/${IT}/agents`, { lead: null, agentGroup: '', members: [] });
  assert.equal(r.body.lead, null);
  assert.equal(r.body.members.length, 0);
  assert.equal((await hma('GET', `/api/tickets/${keys.itOther}`)).status, 404);
  assert.equal((await karl('GET', `/api/tickets/${keys.itOther}`)).body.ticket.agentView, false, 'karl is its reporter again only');
  // the lead set via PATCH counts as well
  await S.admin('PATCH', `/api/projects/${HM}`, { leadId: S.ids.karl });
  assert.equal((await karl('GET', '/api/projects')).body.projects.find((p) => p.key === 'HM').agent, true);
  await S.admin('PATCH', `/api/projects/${HM}`, { leadId: null });
  assert.equal((await karl('GET', '/api/projects')).body.projects.find((p) => p.key === 'HM').agent, false);
});

test('Groups: the agent group of a project gives rights there only, follows every sign-in, never changes the role', async () => {
  const cfg = { adminGroup: 'Admins', agentGroup: 'IT-Team', projectGroups: [{ id: IT, key: 'IT', group: 'IT-Helpdesk' }, { id: HM, key: 'HM', group: 'Haustechnik' }] };
  assert.deepEqual(projectAccessFromGroups({ admin: false, agent: false, projects: [HM] }, cfg), { projects: [HM] });
  assert.deepEqual(projectAccessFromGroups({ admin: false, agent: false, projects: [HM] }, { agentGroup: 'x' }), { projects: [] }, 'no project groups configured');
  assert.equal(roleFromGroups({ admin: false, agent: false, projects: [HM] }, cfg), 'user', 'the role is not touched');

  const up = (name, groups) => S.ctx.users.upsertExternal({
    source: 'ldap', username: name, displayName: name, email: `${name}@firma.local`, externalId: `guid-${name}`, role: roleFromGroups(groups, cfg), access: projectAccessFromGroups(groups, cfg),
  });
  // only in "Haustechnik": a user who works on HM
  let u = up('hausmeister', { admin: false, agent: false, user: true, projects: [HM] });
  assert.equal(S.db.prepare('SELECT role FROM users WHERE id=?').get(u.id).role, 'user');
  assert.deepEqual(agentProjects(u), [HM]);
  assert.equal(agentOn(u, IT), false);
  // an old general agent group no longer gives anything
  u = up('hausmeister', { admin: false, agent: true, user: true, projects: [HM] });
  assert.deepEqual(agentProjects(u), [HM]);
  // out of every group: no project rows from groups anymore
  u = up('hausmeister', { admin: false, agent: false, user: true, projects: [] });
  assert.equal(u.role, 'user');
  assert.deepEqual(agentProjects(u), []);
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM project_agents WHERE user_id=? AND source='group'").get(u.id).n, 0);
  // an admin in a project group stays admin
  u = up('chefin', { admin: true, agent: false, user: true, projects: [HM] });
  assert.equal(u.role, 'admin');
  // locked role: the group rows are still synced (project rights are not a role)
  S.db.prepare("UPDATE users SET role_locked=1 WHERE username='hausmeister'").run();
  u = up('hausmeister', { admin: false, agent: true, user: true, projects: [IT] });
  assert.equal(S.db.prepare('SELECT role FROM users WHERE id=?').get(u.id).role, 'user', 'locked: agent group ignored');
  assert.deepEqual(agentProjects(u), [IT]);
});

test('Changing the project group drops the memberships of the old one', async () => {
  S.db.prepare("INSERT OR IGNORE INTO project_agents(project_id,user_id,source) VALUES(?,?,'group')").run(HM, S.ids.ita);
  await S.admin('PUT', `/api/projects/${HM}/agents`, { agentGroup: 'Haustechnik-Neu' });
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM project_agents WHERE project_id=? AND source='group'").get(HM).n, 0);
  // the manual assignment of hma to HM stays (no userIds given = unchanged)
  assert.ok(S.db.prepare("SELECT 1 FROM project_agents WHERE project_id=? AND user_id=? AND source='manual'").get(HM, S.ids.hma));
});

test('A forgotten project list denies instead of revealing', () => {
  const u = { id: 1, role: 'user' };
  assert.deepEqual(agentProjects(u), [], 'user row not loaded: no projects');
  assert.equal(agentOn(u, IT), false);
  assert.equal(agentOn({ id: 2, role: 'admin' }, IT), true);
  assert.equal(agentOn({ id: 3, role: 'agent' }, IT), true);
});

test('Deputy: works on the project and gets the reminder mail together with the lead', async () => {
  const r = await S.admin('PUT', `/api/projects/${HM}/agents`, { lead: { userId: S.ids.karl }, deputy: { userId: S.ids.hma } });
  assert.equal(r.status, 200);
  assert.equal(r.body.deputy.id, S.ids.hma);
  assert.equal((await S.admin('GET', '/api/projects?all=1')).body.projects.find((p) => p.key === 'HM').deputy.id, S.ids.hma);
  const hm = (await S.admin('GET', '/api/users?all=1')).body.users.find((u) => u.username === 'hma');
  assert.ok(hm.projects.some((p) => p.key === 'HM' && p.source === 'deputy'));
  const sent = [];
  const mailer = S.ctx.mailer;
  const orig = { enabled: mailer.enabled, send: mailer.send };
  mailer.enabled = () => true; mailer.send = async (m) => { sent.push(m.to); return true; };
  try {
    S.db.prepare("UPDATE tickets SET created_at='2020-01-01T00:00:00.000Z', assignee_id=NULL WHERE project_id=?").run(HM);
    S.ctx.settings.set('reminder.unassignedDays', 1);
    await S.ctx.reminders.check({ force: true });
    const hmMails = sent.filter((to) => ['karl@firma.local', 'hma@firma.local'].includes(to));
    assert.deepEqual(hmMails.sort(), ['hma@firma.local', 'karl@firma.local']);
  } finally { Object.assign(mailer, orig); S.ctx.settings.set('reminder.unassignedDays', 0); }
  // removing the deputy takes the rights from that role away
  await S.admin('PUT', `/api/projects/${HM}/agents`, { lead: null, deputy: null });
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM project_agents WHERE project_id=? AND source IN ('lead','deputy')").get(HM).n, 0);
});

test('Migration 42: agents limited to projects (1.40) become users with the same projects, leads get theirs', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-m42-'));
  try {
    const file = path.join(dir, 'h.sqlite');
    let d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    const add = (n, role, scope = 'all') => d.prepare("INSERT INTO users(username,display_name,role,source,agent_scope) VALUES(?,?,?,'local',?)").run(n, n, role, scope).lastInsertRowid;
    const scoped = add('scoped', 'agent', 'projects');
    const full = add('full', 'agent');
    const lead = add('lead', 'user');
    const pid = d.prepare("INSERT INTO projects(key,name,lead_id) VALUES('HM','HM',?)").run(lead).lastInsertRowid;
    d.prepare("INSERT INTO project_agents(project_id,user_id,source) VALUES(?,?,'manual')").run(pid, scoped);
    d.prepare("INSERT OR REPLACE INTO settings(key,value,secret) VALUES('ldap.agentGroup','\"Helfi-Bearbeiter\"',0)").run();
    d.exec('DROP TABLE user_passkeys; ALTER TABLE users DROP COLUMN passkey_prompt_until; ALTER TABLE users DROP COLUMN activity_order; ALTER TABLE projects DROP COLUMN portal_show; ALTER TABLE projects DROP COLUMN portal_desc; ALTER TABLE projects DROP COLUMN portal_intro; ALTER TABLE projects DROP COLUMN portal_icon; ALTER TABLE projects DROP COLUMN portal_color; ALTER TABLE projects DROP COLUMN portal_sort; ALTER TABLE canned_responses DROP COLUMN project_id; DROP INDEX idx_kb_articles_project; ALTER TABLE kb_articles DROP COLUMN project_id; ALTER TABLE projects DROP COLUMN deputy_id');
    d.prepare("UPDATE meta SET value='41' WHERE key='schema_version'").run();
    d.close();
    d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    const role = (id) => d.prepare('SELECT role FROM users WHERE id=?').get(id).role;
    assert.equal(role(scoped), 'user');
    assert.equal(role(full), 'user', 'no role "agent" any more – the admin assigns the projects');
    assert.equal(d.prepare("SELECT COUNT(*) n FROM settings WHERE key='ldap.agentGroup'").get().n, 0, 'general agent group gone');
    assert.ok(d.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'deputy_id'));
    assert.ok(d.prepare("SELECT 1 FROM project_agents WHERE project_id=? AND user_id=? AND source='manual'").get(pid, scoped), 'keeps the project');
    assert.ok(d.prepare("SELECT 1 FROM project_agents WHERE project_id=? AND user_id=? AND source='lead'").get(pid, lead), 'lead works on it');
    d.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
