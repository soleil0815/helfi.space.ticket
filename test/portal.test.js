// Portal: "my requests" counters and latest, departments (projects shown in the portal) with their
// offerings and public articles, project settings for the portal, start page setting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.js';

let S; let karl; let anna; let IT; let HM; let VW;
before(async () => {
  S = await startServer('portal');
  karl = await S.user('karl', 'user');
  anna = await S.user('anna', 'user');
  IT = (await S.admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'IT');
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  VW = (await S.admin('POST', '/api/projects', { key: 'VW', name: 'Verwaltung' })).body.project;
  await S.admin('PUT', `/api/projects/${HM.id}/agents`, { members: [{ userId: S.ids.anna }] });
});
after(() => S.stop());

test('New projects are shown in the portal; portal fields are saved and checked', async () => {
  assert.deepEqual(HM.portal, { show: true, description: '', intro: '', icon: '', color: '', sort: 0 });
  let r = await S.admin('PATCH', `/api/projects/${HM.id}`, { portal: { show: true, description: 'Heizung, Wasser, Schlüssel', intro: 'Notfall: Durchwahl 1234', icon: 'home', color: 'orange', sort: 2 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.project.portal, { show: true, description: 'Heizung, Wasser, Schlüssel', intro: 'Notfall: Durchwahl 1234', icon: 'home', color: 'orange', sort: 2 });
  // Unknown symbol/colour are not stored (fall back to the defaults when shown)
  r = await S.admin('PATCH', `/api/projects/${VW.id}`, { portal: { show: false, icon: '<script>', color: 'pink', sort: 99999 } });
  assert.deepEqual(r.body.project.portal, { show: false, description: '', intro: '', icon: '', color: '', sort: 999 });
  await S.admin('PATCH', `/api/projects/${IT.id}`, { portal: { show: true, icon: 'monitor', color: 'blue', sort: 1, description: 'Computer' } });
  // Only admins change projects
  assert.equal((await anna('PATCH', `/api/projects/${HM.id}`, { portal: { show: false } })).status, 403);
  // Leaving out "portal" keeps the settings
  r = await S.admin('PATCH', `/api/projects/${HM.id}`, { name: 'Haustechnik' });
  assert.equal(r.body.project.portal.icon, 'home');
});

test('Start page: departments in order, hidden and archived left out; counts of offerings and public articles', async () => {
  await S.admin('POST', '/api/catalog', { title: 'Raum zu kalt', projectKey: 'HM', fields: [] });
  await S.admin('POST', '/api/catalog', { title: 'Schlüssel', projectKey: 'HM', fields: [] });
  await S.admin('POST', '/api/catalog', { title: 'Entwurf', projectKey: 'HM', active: false, fields: [] });
  await S.admin('POST', '/api/catalog', { title: 'Laptop', projectKey: 'IT', fields: [] });
  await anna('POST', '/api/kb', { title: 'Heizkörper einstellen', body: 'x', visibility: 'public', projectId: HM.id });
  await anna('POST', '/api/kb', { title: 'Intern: Heizungsplan', body: 'x', visibility: 'internal', projectId: HM.id });
  const r = await karl('GET', '/api/portal');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.departments.map((d) => [d.key, d.icon, d.color, d.offers, d.articles]), [['IT', 'monitor', 'blue', 1, 0], ['HM', 'home', 'orange', 2, 1]]);
  assert.equal(r.body.departments[1].description, 'Heizung, Wasser, Schlüssel');
  // Default symbol/colour when none was chosen
  await S.admin('PATCH', `/api/projects/${VW.id}`, { portal: { show: true } });
  const vw = (await karl('GET', '/api/portal')).body.departments.find((d) => d.key === 'VW');
  assert.deepEqual([vw.icon, vw.color], ['inbox', 'blue']);
  await S.admin('PATCH', `/api/projects/${VW.id}`, { archived: true });
  assert.equal((await karl('GET', '/api/portal')).body.departments.some((d) => d.key === 'VW'), false);
  assert.equal((await karl('GET', '/api/portal/vw')).status, 404, 'archived department not reachable');
  await S.admin('PATCH', `/api/projects/${VW.id}`, { archived: false, portal: { show: false } });
  assert.equal((await karl('GET', '/api/portal/vw')).status, 404, 'hidden department not reachable');
});

test('Department page: active offerings, public articles only, intro', async () => {
  const r = await karl('GET', '/api/portal/hm');
  assert.equal(r.status, 200);
  assert.equal(r.body.department.name, 'Haustechnik');
  assert.equal(r.body.department.intro, 'Notfall: Durchwahl 1234');
  assert.equal(r.body.department.id, HM.id);
  assert.deepEqual(r.body.offers.map((x) => x.title).sort(), ['Raum zu kalt', 'Schlüssel']);
  assert.deepEqual(r.body.faq.map((a) => a.title), ['Heizkörper einstellen']);
  // Also for the project's agent: internal articles do not appear in the portal
  assert.deepEqual((await anna('GET', '/api/portal/hm')).body.faq.map((a) => a.title), ['Heizkörper einstellen']);
});

test('My requests: counters by status and the latest, only the own', async () => {
  const mk = async (u, pid, title) => (await u('POST', '/api/tickets', { projectId: pid, type: 'request', title, description: '' })).body.ticket;
  const a = await mk(karl, HM.id, 'Büro zu kalt');
  const b = await mk(karl, IT.id, 'Laufwerk');
  const c = await mk(karl, IT.id, 'Laptop');
  await mk(anna, HM.id, 'Nicht von Karl');
  await S.admin('PATCH', `/api/tickets/${b.key}`, { status: 'waiting' });
  await S.admin('PATCH', `/api/tickets/${c.key}`, { status: 'done' });
  await S.admin('PATCH', `/api/tickets/${a.key}`, { status: 'in_progress' });
  const r = (await karl('GET', '/api/portal')).body;
  assert.deepEqual(r.counts, { active: 1, waiting: 1, done: 1 });
  assert.deepEqual(r.recent.map((x) => x.key).slice(-1), [c.key], 'done ones last');
  assert.equal(r.recent.length, 3);
  assert.equal(r.recent.find((x) => x.key === a.key).project, 'Haustechnik');
});

test('Start page setting in the bootstrap (default portal)', async () => {
  assert.equal((await karl('GET', '/api/bootstrap')).body.userStart, 'portal');
  await S.admin('PUT', '/api/admin/settings', { settings: { 'general.userStart': 'requests' } });
  assert.equal((await karl('GET', '/api/bootstrap')).body.userStart, 'requests');
  await S.admin('PUT', '/api/admin/settings', { settings: { 'general.userStart': 'nonsense' } });
  assert.equal((await karl('GET', '/api/bootstrap')).body.userStart, 'portal');
  assert.equal((await karl('PUT', '/api/admin/settings', { settings: { 'general.userStart': 'requests' } })).status, 403);
});

test('Migration 44: existing projects are shown in the portal', async () => {
  const { openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-m44-'));
  try {
    const file = path.join(dir, 'h.sqlite');
    let d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    d.exec('ALTER TABLE projects DROP COLUMN portal_show; ALTER TABLE projects DROP COLUMN portal_desc; ALTER TABLE projects DROP COLUMN portal_intro; ALTER TABLE projects DROP COLUMN portal_icon; ALTER TABLE projects DROP COLUMN portal_color; ALTER TABLE projects DROP COLUMN portal_sort;');
    d.prepare("INSERT INTO projects(key,name) VALUES('AA','Alt')").run();
    d.prepare("UPDATE meta SET value='43' WHERE key='schema_version'").run();
    d.close();
    d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    assert.deepEqual({ ...d.prepare("SELECT portal_show, portal_icon, portal_sort FROM projects WHERE key='AA'").get() }, { portal_show: 1, portal_icon: '', portal_sort: 0 });
    d.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
