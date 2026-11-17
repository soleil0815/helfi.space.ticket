// Shared reply templates of a project: maintained by admins and by the project's lead and deputy
// (like the service catalog). "For all projects" stays with the admins; other agents and component
// leads only use them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let lead; let deputy; let agent; let other; let IT; let HM;
before(async () => {
  S = await startServer('canned-leads');
  lead = await S.user('lena', 'user');
  deputy = await S.user('dirk', 'user');
  agent = await S.user('anton', 'user');
  other = await S.user('hanna', 'user');
  IT = (await S.admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'IT');
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  const r = await S.admin('PUT', `/api/projects/${IT.id}/agents`, { lead: { userId: S.ids.lena }, deputy: { userId: S.ids.dirk }, members: [{ userId: S.ids.anton }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await S.admin('PUT', `/api/projects/${HM.id}/agents`, { members: [{ userId: S.ids.hanna }] });
});
after(() => S.stop());

const tpl = (title, extra = {}) => ({ title, body: `Text: ${title}`, shared: true, ...extra });

test('Lead and deputy create shared templates for their own project; agents see them there', async () => {
  const l = await lead('GET', '/api/canned');
  assert.deepEqual(l.body.manageProjects.map((p) => p.key), ['IT']);
  const r = await lead('POST', '/api/canned', tpl('Drucker neu starten', { projectId: IT.id }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.response.shared, true);
  assert.equal(r.body.response.project.key, 'IT');
  const d = await deputy('POST', '/api/canned', tpl('VPN einrichten', { projectId: IT.id }));
  assert.equal(d.status, 201);
  // The project's agents see (and use) them, without being able to change them
  const seen = (await agent('GET', '/api/canned')).body;
  assert.deepEqual(seen.responses.filter((x) => x.shared).map((x) => [x.title, x.canEdit]).sort(), [['Drucker neu starten', false], ['VPN einrichten', false]]);
  assert.deepEqual(seen.manageProjects, []);
  // Other project: invisible
  assert.equal((await other('GET', '/api/canned')).body.responses.some((x) => x.title === 'Drucker neu starten'), false);
});

test('Lead may not create "for all projects" or for someone else\'s project', async () => {
  for (const body of [tpl('Für alle'), tpl('Fremd', { projectId: HM.id }), tpl('Unbekannt', { projectId: 9999 })]) {
    const r = await lead('POST', '/api/canned', body);
    assert.ok(r.status === 403 || r.status === 400, `${body.title}: ${r.status}`);
  }
  // Ordinary agents and agents of other projects: no shared ones at all
  assert.equal((await agent('POST', '/api/canned', tpl('Darf nicht', { projectId: IT.id }))).status, 403);
  assert.equal((await other('POST', '/api/canned', tpl('Darf nicht', { projectId: IT.id }))).status, 403);
  // Personal ones as before
  assert.equal((await agent('POST', '/api/canned', { title: 'Meine', body: 'Nur für mich' })).status, 201);
});

test('Edit and delete: lead/deputy only their project\'s templates; not "for all", not other projects; moving only between own projects', async () => {
  const mine = (await deputy('POST', '/api/canned', tpl('Kennwort zurücksetzen', { projectId: IT.id }))).body.response;
  const forAll = (await S.admin('POST', '/api/canned', tpl('Danke für die Rückmeldung'))).body.response;
  const hmTpl = (await S.admin('POST', '/api/canned', tpl('Heizung entlüften', { projectId: HM.id }))).body.response;

  // The lead edits the deputy's template of the same project
  const u = await lead('PATCH', `/api/canned/${mine.id}`, { body: 'Neuer Text' });
  assert.equal(u.status, 200);
  assert.equal(u.body.response.body, 'Neuer Text');
  // … but neither "for all" nor another project's (403), and cannot move it to "for all" or to HM
  assert.equal((await lead('PATCH', `/api/canned/${forAll.id}`, { body: 'x' })).status, 403);
  assert.equal((await lead('DELETE', `/api/canned/${forAll.id}`)).status, 403);
  assert.equal((await lead('PATCH', `/api/canned/${hmTpl.id}`, { body: 'x' })).status, 403);
  assert.equal((await lead('PATCH', `/api/canned/${mine.id}`, { projectId: null })).status, 403);
  assert.equal((await lead('PATCH', `/api/canned/${mine.id}`, { projectId: HM.id })).status, 403);
  // Ordinary agent of the project: no changes
  assert.equal((await agent('PATCH', `/api/canned/${mine.id}`, { body: 'x' })).status, 403);
  assert.equal((await agent('DELETE', `/api/canned/${mine.id}`)).status, 403);
  // In the list: canEdit exactly for what the lead may change
  const flags = Object.fromEntries((await lead('GET', '/api/canned')).body.responses.filter((x) => x.shared).map((x) => [x.title, x.canEdit]));
  assert.equal(flags['Kennwort zurücksetzen'], true);
  assert.equal(flags['Danke für die Rückmeldung'], false);
  assert.equal('Heizung entlüften' in flags, false, 'other project not visible');
  // Delete own project's template
  assert.equal((await lead('DELETE', `/api/canned/${mine.id}`)).status, 200);
});

test('No longer lead: rights end at once; admins keep all rights', async () => {
  const t1 = (await lead('POST', '/api/canned', tpl('Monitor tauschen', { projectId: IT.id }))).body.response;
  await S.admin('PATCH', `/api/projects/${IT.id}`, { leadId: S.ids.hanna });
  const after = await lead('GET', '/api/canned');
  // No longer working on any project at all (403) or at least not managing it any more
  assert.ok(after.status === 403 || after.body.manageProjects.length === 0, JSON.stringify(after.body));
  assert.equal((await lead('PATCH', `/api/canned/${t1.id}`, { body: 'x' })).status, 403);
  assert.equal((await S.admin('PATCH', `/api/canned/${t1.id}`, { projectId: HM.id })).status, 200, 'admin moves freely');
  assert.equal((await S.admin('GET', '/api/canned')).body.manageProjects.length >= 2, true);
  await S.admin('PATCH', `/api/projects/${IT.id}`, { leadId: S.ids.lena });
});

test('Archived project: its lead no longer maintains its templates', async () => {
  const AR = (await S.admin('POST', '/api/projects', { key: 'AR', name: 'Archiv' })).body.project;
  await S.admin('PUT', `/api/projects/${AR.id}/agents`, { members: [{ userId: S.ids.anton }] });
  await S.admin('PATCH', `/api/projects/${AR.id}`, { leadId: S.ids.anton });
  assert.deepEqual((await agent('GET', '/api/canned')).body.manageProjects.map((p) => p.key), ['AR']);
  await S.admin('PATCH', `/api/projects/${AR.id}`, { archived: true });
  assert.deepEqual((await agent('GET', '/api/canned')).body.manageProjects, []);
});
