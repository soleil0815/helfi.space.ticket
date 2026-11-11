// Project rights: agents work on all projects (default, the behaviour so far) or only on selected ones.
// For tickets of other projects an agent limited to projects is a normal user: their own requests only,
// no internal notes, no history, no agent tools – and nothing of those projects in counts and reports.
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
  hma = await S.user('hma', 'agent');
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
  // hma: agent of HM only
  const r = await S.admin('PATCH', `/api/users/${S.ids.hma}`, { agentScope: 'projects', projectIds: [HM] });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.agentScope, 'projects');
});
after(() => S.stop());

test('Existing and new agents work on all projects (nothing changes on update)', async () => {
  assert.equal(S.db.prepare('SELECT agent_scope FROM users WHERE id=?').get(S.ids.ita).agent_scope, 'all');
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
  // writes a reply (internal flag ignored), cannot change status or priority
  const c = await hma('POST', `/api/tickets/${keys.hmOwnIt}/comments`, { body: 'Danke!', internal: true });
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
  // hma cannot move tickets into IT
  assert.equal((await hma('PATCH', `/api/tickets/${keys.hm}`, { projectId: IT })).status, 404);
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

test('Admin: agents of a project (group + by hand), user list shows what someone sees', async () => {
  assert.equal((await hma('GET', `/api/projects/${HM}/agents`)).status, 403);
  let r = await S.admin('PUT', `/api/projects/${IT}/agents`, { agentGroup: 'IT-Helpdesk', userIds: [S.ids.hma] });
  assert.equal(r.status, 200);
  assert.equal(r.body.agentGroup, 'IT-Helpdesk');
  assert.deepEqual(r.body.agents.map((a) => [a.id, a.source]), [[S.ids.hma, 'manual']]);
  // now hma sees IT tickets too
  assert.equal((await hma('GET', `/api/tickets/${keys.itOther}`)).status, 200);
  const users = (await S.admin('GET', '/api/users?all=1')).body.users;
  const h = users.find((u) => u.username === 'hma');
  assert.equal(h.agentScope, 'projects');
  assert.deepEqual(h.projects.map((p) => p.key).sort(), ['HM', 'IT']);
  // only agents may be assigned by hand
  assert.equal((await S.admin('PUT', `/api/projects/${IT}/agents`, { agentGroup: '', userIds: [S.ids.karl] })).status, 400);
  r = await S.admin('PUT', `/api/projects/${IT}/agents`, { agentGroup: '', userIds: [] });
  assert.equal(r.body.agents.length, 0);
  assert.equal((await hma('GET', `/api/tickets/${keys.itOther}`)).status, 404);
  // changing the scope by hand locks the role (groups do not overwrite it)
  assert.equal(S.db.prepare('SELECT role_locked FROM users WHERE id=?').get(S.ids.hma).role_locked, 1);
});

test('Groups: project groups make agents of those projects, never demote, follow every sign-in', async () => {
  const cfg = { adminGroup: 'Admins', agentGroup: 'IT-Team', projectGroups: [{ id: IT, key: 'IT', group: 'IT-Helpdesk' }, { id: HM, key: 'HM', group: 'Haustechnik' }] };
  assert.deepEqual(projectAccessFromGroups({ admin: false, agent: true, projects: [HM] }, cfg), { scope: 'all', projects: [HM] });
  assert.deepEqual(projectAccessFromGroups({ admin: false, agent: false, projects: [HM] }, cfg), { scope: 'projects', projects: [HM] });
  assert.deepEqual(projectAccessFromGroups({ admin: false, agent: false, projects: [] }, cfg), { scope: null, projects: [] });
  // no project groups configured: nothing from groups
  assert.deepEqual(projectAccessFromGroups({ admin: false, agent: false, projects: [HM] }, { agentGroup: 'x' }), { scope: null, projects: [] });
  // the role from groups stays as before
  assert.equal(roleFromGroups({ admin: false, agent: false, projects: [HM] }, cfg), 'user');

  const up = (name, groups, role = roleFromGroups(groups, cfg)) => S.ctx.users.upsertExternal({
    source: 'ldap', username: name, displayName: name, email: `${name}@firma.local`, externalId: `guid-${name}`, role, access: projectAccessFromGroups(groups, cfg),
  });
  // only in "Haustechnik": agent of HM only
  let u = up('hausmeister', { admin: false, agent: false, user: true, projects: [HM] });
  assert.equal(u.role, 'agent');
  assert.equal(u.agent_scope, 'projects');
  assert.deepEqual(agentProjects(u), [HM]);
  assert.equal(agentOn(u, IT), false);
  // later also in the general agent group: all projects
  u = up('hausmeister', { admin: false, agent: true, user: true, projects: [HM] });
  assert.equal(u.agent_scope, 'all');
  assert.equal(agentProjects(u), null);
  // out of every group: back to user, group rows gone
  u = up('hausmeister', { admin: false, agent: false, user: true, projects: [] });
  assert.equal(u.role, 'user');
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM project_agents WHERE user_id=? AND source='group'").get(u.id).n, 0);
  // a project group never demotes an admin
  u = up('chefin', { admin: true, agent: false, user: true, projects: [] });
  assert.equal(u.role, 'admin');
  S.db.prepare('UPDATE users SET role_locked=0 WHERE id=?').run(u.id);
  u = up('chefin', { admin: true, agent: false, user: true, projects: [HM] });
  assert.equal(u.role, 'admin');
  // without admin/agent groups (role from groups: null): the project group still makes users agents
  const cfg2 = { projectGroups: cfg.projectGroups };
  const r2 = S.ctx.users.upsertExternal({ source: 'ldap', username: 'gast', displayName: 'Gast', email: 'gast@firma.local', externalId: 'guid-gast', role: roleFromGroups({ projects: [IT] }, cfg2), access: projectAccessFromGroups({ projects: [IT] }, cfg2) });
  assert.equal(r2.role, 'agent');
  assert.deepEqual(agentProjects(r2), [IT]);
  // … but does not restrict an agent made by hand (all projects)
  S.db.prepare("UPDATE users SET role='agent', agent_scope='all' WHERE username='hausmeister'").run();
  u = S.ctx.users.upsertExternal({ source: 'ldap', username: 'hausmeister', displayName: 'hausmeister', email: 'hausmeister@firma.local', externalId: 'guid-hausmeister', role: roleFromGroups({ projects: [HM] }, cfg2), access: projectAccessFromGroups({ projects: [HM] }, cfg2) });
  assert.equal(u.agent_scope, 'all');
  // locked role: groups keep their rows, scope stays as set by hand
  S.db.prepare("UPDATE users SET role_locked=1, agent_scope='projects' WHERE username='hausmeister'").run();
  u = up('hausmeister', { admin: false, agent: true, user: true, projects: [IT] });
  assert.equal(u.agent_scope, 'projects');
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
  const u = { id: 1, role: 'agent', agent_scope: 'projects' };
  assert.deepEqual(agentProjects(u), []);
  assert.equal(agentOn(u, IT), false);
  assert.equal(agentOn({ id: 2, role: 'admin', agent_scope: 'projects' }, IT), true);
  assert.equal(agentOn({ id: 3, role: 'user' }, IT), false);
});
