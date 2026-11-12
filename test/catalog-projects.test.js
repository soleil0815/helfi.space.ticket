// Service catalog per project: grouping, "not yet assigned", only lead/deputy (and admins) manage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let lead; let deputy; let agent; let karl; let IT; let HM;
before(async () => {
  S = await startServer('catalogprojects');
  lead = await S.user('hmlead', 'user');
  deputy = await S.user('hmdeputy', 'user');
  agent = await S.user('hmagent', 'user');
  karl = await S.user('karl', 'user');
  IT = (await S.admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'IT');
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  const r = await S.admin('PUT', `/api/projects/${HM.id}/agents`, {
    lead: { userId: S.ids.hmlead }, deputy: { userId: S.ids.hmdeputy }, members: [{ userId: S.ids.hmagent }],
  });
  assert.equal(r.status, 200);
  // An offering from before projects (no project key) and one of a since archived project
  S.db.prepare("INSERT INTO catalog_items(title, description, emoji, project_key, fields, approver_ids, approval_mode, active, sort) VALUES('Altes Angebot', '', '', '', '[]', '', 'any', 1, 0)").run();
});
after(() => S.stop());

test('Lead and deputy manage only their project; other agents and users not', async () => {
  // Bootstrap tells the client who may manage
  assert.equal((await lead('GET', '/api/bootstrap')).body.catalogManage, true);
  assert.equal((await agent('GET', '/api/bootstrap')).body.catalogManage, false);
  assert.equal((await karl('GET', '/api/bootstrap')).body.catalogManage, false);
  assert.deepEqual((await deputy('GET', '/api/catalog')).body.manageProjects, [{ key: 'HM', name: 'Haustechnik' }]);
  assert.deepEqual((await agent('GET', '/api/catalog')).body.manageProjects, []);

  // Create: own project yes, other project/none no
  let r = await lead('POST', '/api/catalog', { title: 'Raum heizen', projectKey: 'HM', fields: [] });
  assert.equal(r.status, 201);
  const heat = r.body.item;
  assert.equal(heat.projectKey, 'HM');
  assert.deepEqual(heat.project, { key: 'HM', name: 'Haustechnik' });
  assert.equal((await lead('POST', '/api/catalog', { title: 'Laptop', projectKey: 'IT', fields: [] })).status, 403);
  assert.equal((await lead('POST', '/api/catalog', { title: 'Ohne', fields: [] })).status, 400);
  assert.equal((await lead('POST', '/api/catalog', { title: 'Gibt es nicht', projectKey: 'XX', fields: [] })).status, 400);
  assert.equal((await agent('POST', '/api/catalog', { title: 'Agent', projectKey: 'HM', fields: [] })).status, 403);
  assert.equal((await karl('POST', '/api/catalog', { title: 'User', projectKey: 'HM', fields: [] })).status, 403);

  // Deputy edits it, approvers come back with names; moving it to another project is not allowed
  r = await deputy('PUT', `/api/catalog/${heat.id}`, { ...heat, title: 'Raum zu kalt', approverIds: [S.ids.karl] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.item.approvers, [{ id: S.ids.karl, displayName: 'karl' }]);
  assert.equal((await deputy('PUT', `/api/catalog/${heat.id}`, { ...heat, projectKey: 'IT' })).status, 403);
  assert.equal((await agent('PUT', `/api/catalog/${heat.id}`, { ...heat, title: 'X' })).status, 403);

  // Admin's IT offering: the HM lead may neither edit nor delete it nor see its management data
  const it = (await S.admin('POST', '/api/catalog', { title: 'Laptop', projectKey: 'IT', fields: [] })).body.item;
  assert.equal((await lead('PUT', `/api/catalog/${it.id}`, { title: 'Meins', projectKey: 'HM' })).status, 403);
  assert.equal((await lead('DELETE', `/api/catalog/${it.id}`)).status, 403);
  assert.equal((await lead('GET', `/api/catalog/${it.id}`)).body.item.approverIds, undefined);

  // Management list: lead sees only HM, admin everything incl. the unassigned one
  const mine = (await lead('GET', '/api/catalog?all=1')).body.items;
  assert.deepEqual(mine.map((x) => x.title), ['Raum zu kalt']);
  assert.equal(mine[0].canEdit, true);
  const all = (await S.admin('GET', '/api/catalog?all=1')).body.items;
  assert.deepEqual(all.map((x) => x.project?.key ?? null), ['HM', 'IT', null], 'grouped by project name, unassigned last');

  // Inactive offering of the own project: visible to the lead, not to others
  const off = (await lead('POST', '/api/catalog', { title: 'Entwurf', projectKey: 'HM', active: false, fields: [] })).body.item;
  assert.equal((await lead('GET', `/api/catalog/${off.id}`)).status, 200);
  assert.equal((await agent('GET', `/api/catalog/${off.id}`)).status, 404);
  assert.equal((await lead('DELETE', `/api/catalog/${off.id}`)).status, 200);
  assert.equal((await deputy('DELETE', `/api/catalog/${heat.id}`)).status, 200);
});

test('Overview for users: grouped by project, the unassigned one still orderable (lands in the default project)', async () => {
  await S.admin('POST', '/api/catalog', { title: 'Wasserschaden', projectKey: 'HM', fields: [] });
  const items = (await karl('GET', '/api/catalog')).body.items;
  assert.deepEqual(items.map((x) => [x.project?.name ?? null, x.title]), [['Haustechnik', 'Wasserschaden'], ['IT', 'Laptop'], [null, 'Altes Angebot']]);
  assert.equal(items[0].projectKey, undefined, 'no management data for users');
  const old = items.find((x) => !x.project);
  const tk = (await karl('POST', `/api/catalog/${old.id}/order`, { answers: {} })).body.ticket;
  assert.equal(tk.projectKey, IT.key);
  const water = items.find((x) => x.title === 'Wasserschaden');
  assert.equal((await karl('POST', `/api/catalog/${water.id}/order`, { answers: {} })).body.ticket.projectKey, 'HM');
  // Admin sorts the old one in – it is never moved automatically
  assert.equal(S.db.prepare("SELECT project_key FROM catalog_items WHERE title='Altes Angebot'").get().project_key, '');
  const r = await S.admin('PUT', `/api/catalog/${old.id}`, { title: 'Altes Angebot', projectKey: 'HM', fields: [] });
  assert.equal(r.body.item.project.key, 'HM');
  // An archived project's offerings count as unassigned again
  await S.admin('PATCH', `/api/projects/${HM.id}`, { archived: true });
  assert.equal((await karl('GET', '/api/catalog')).body.items.filter((x) => !x.project).length, 2);
  assert.equal((await lead('GET', '/api/bootstrap')).body.catalogManage, false);
  await S.admin('PATCH', `/api/projects/${HM.id}`, { archived: false });
});
