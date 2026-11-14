// Knowledge base and canned responses per project: public articles for everyone signed in,
// internal ones only for the project's people; only they edit, move, delete; subpages inherit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.js';

let S; let it; let hm; let karl; let IT; let HM;
before(async () => {
  S = await startServer('kbprojects');
  it = await S.user('itagent', 'user');
  hm = await S.user('hmagent', 'user');
  karl = await S.user('karl', 'user');
  IT = (await S.admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'IT');
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  await S.admin('PUT', `/api/projects/${IT.id}/agents`, { members: [{ userId: S.ids.itagent }] });
  await S.admin('PUT', `/api/projects/${HM.id}/agents`, { members: [{ userId: S.ids.hmagent }] });
});
after(() => S.stop());

const art = (title, extra = {}) => ({ title, body: `# ${title}\n\nText zu ${title}`, visibility: 'internal', ...extra });

test('Internal articles only for the project; public ones readable by all, editable only by the project', async () => {
  const intern = (await hm('POST', '/api/kb', art('Heizungsplan', { projectId: HM.id, category: 'Heizung' }))).body.article;
  assert.equal(intern.project.key, 'HM');
  assert.equal(intern.canEdit, true);
  const pub = (await hm('POST', '/api/kb', art('Raum zu kalt?', { projectId: HM.id, visibility: 'public' }))).body.article;

  // IT agent: internal HM article invisible everywhere
  assert.equal((await it('GET', `/api/kb/${intern.id}`)).status, 404);
  const itList = (await it('GET', '/api/kb')).body;
  assert.deepEqual(itList.articles.map((a) => a.title), ['Raum zu kalt?']);
  assert.equal(itList.categories.some((c) => c.name === 'Heizung'), false, 'categories only from readable articles');
  assert.equal(JSON.stringify((await it('GET', '/api/kb/tree')).body).includes('Heizungsplan'), false);
  assert.equal((await it('GET', '/api/kb?q=Heizungsplan')).body.articles.length, 0);
  assert.equal((await it('GET', `/api/kb/${intern.id}/comments`)).status, 404);

  // Public HM article: read and comment yes, change no
  const r = await it('GET', `/api/kb/${pub.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.article.canEdit, false);
  assert.equal((await it('PUT', `/api/kb/${pub.id}`, art('Übernommen', { visibility: 'public' }))).status, 403);
  assert.equal((await it('DELETE', `/api/kb/${pub.id}`)).status, 403);
  assert.equal((await it('GET', `/api/kb/${pub.id}/versions`)).status, 403);
  assert.equal((await it('PATCH', `/api/kb/${pub.id}/parent`, { parentId: null })).status, 403);
  assert.equal((await it('POST', '/api/kb', art('Unterseite', { parentId: pub.id }))).status, 403, 'no subpages under other projects');
  assert.equal((await it('GET', `/api/kb/${pub.id}/feedback`)).status, 403);
  const c = (await karl('POST', `/api/kb/${pub.id}/comments`, { body: 'Bei mir 17 Grad' })).body.comment;
  assert.equal((await it('PATCH', `/api/kb/comments/${c.id}`, { resolved: true })).status, 403);
  assert.equal((await hm('PATCH', `/api/kb/comments/${c.id}`, { resolved: true })).status, 200);

  // Users: public only
  assert.equal((await karl('GET', `/api/kb/${intern.id}`)).status, 404);
  assert.equal((await karl('GET', `/api/kb/${pub.id}`)).status, 200);
  assert.deepEqual((await karl('GET', '/api/kb/projects')).body, { projects: [{ id: HM.id, key: 'HM', name: 'Haustechnik' }], writable: [] });

  // Writing into another project: no; without project: the user's own
  assert.equal((await it('POST', '/api/kb', art('Fremd', { projectId: HM.id }))).status, 403);
  const own = (await it('POST', '/api/kb', art('VPN einrichten'))).body.article;
  assert.equal(own.project.key, 'IT');
  assert.deepEqual((await it('GET', '/api/kb/projects')).body.writable.map((p) => p.key), ['IT']);
  assert.equal((await karl('POST', '/api/kb', art('Benutzer'))).status, 403);

  // Filter by project
  assert.deepEqual((await S.admin('GET', '/api/kb?project=HM')).body.articles.map((a) => a.title).sort(), ['Heizungsplan', 'Raum zu kalt?']);
  assert.deepEqual((await S.admin('GET', '/api/kb')).body.projects.map((p) => p.key), ['HM', 'IT']);
});

test('Subpages inherit the project; moving takes the new parent\'s project along for the whole subtree', async () => {
  const root = (await hm('POST', '/api/kb', art('Gebäude A', { projectId: HM.id, visibility: 'public' }))).body.article;
  const child = (await hm('POST', '/api/kb', art('Etage 1', { parentId: root.id, projectId: IT.id }))).body.article;
  assert.equal(child.project.key, 'HM', 'projectId ignored for subpages');
  const grand = (await hm('POST', '/api/kb', art('Raum 101', { parentId: child.id }))).body.article;
  const itRoot = (await it('POST', '/api/kb', art('IT-Räume', { visibility: 'public' }))).body.article;

  // HM agent may not move into an IT page
  assert.equal((await hm('PATCH', `/api/kb/${child.id}/parent`, { parentId: itRoot.id })).status, 403);
  // Admin moves "Etage 1" (with "Raum 101") below the IT page → both IT
  assert.equal((await S.admin('PATCH', `/api/kb/${child.id}/parent`, { parentId: itRoot.id })).status, 200);
  const proj = (id) => S.db.prepare('SELECT p.key FROM kb_articles a JOIN projects p ON p.id=a.project_id WHERE a.id=?').get(id).key;
  assert.equal(proj(child.id), 'IT');
  assert.equal(proj(grand.id), 'IT');
  assert.equal(proj(root.id), 'HM');
  // HM agent no longer sees the internal subpage; IT agent may edit it now
  assert.equal((await hm('GET', `/api/kb/${grand.id}`)).status, 404);
  assert.equal((await it('PUT', `/api/kb/${grand.id}`, art('Raum 101', { parentId: child.id }))).status, 200);

  // Top-level page to another project via the editor (admin) – subtree comes along, no new version
  const v = (id) => S.db.prepare('SELECT MAX(version) v FROM kb_versions WHERE article_id=?').get(id).v;
  const before = v(itRoot.id);
  const r = await S.admin('PUT', `/api/kb/${itRoot.id}`, { title: 'IT-Räume', body: itRoot.body, visibility: 'public', parentId: null, projectId: HM.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.article.project.key, 'HM');
  assert.equal(v(itRoot.id), before);
  assert.equal(proj(grand.id), 'HM');
  // IT agent may not hand an article over to HM
  const mine = (await it('POST', '/api/kb', art('Drucker'))).body.article;
  assert.equal((await it('PUT', `/api/kb/${mine.id}`, art('Drucker', { parentId: null, projectId: HM.id }))).status, 403);
});

test('Canned responses: shared ones optionally per project', async () => {
  const r = await S.admin('POST', '/api/canned', { title: 'Heizung entlüften', body: 'Bitte das Ventil …', shared: true, projectId: HM.id });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.response.project, { id: HM.id, key: 'HM', name: 'Haustechnik' });
  await S.admin('POST', '/api/canned', { title: 'Für alle', body: 'Danke!', shared: true });
  const titles = async (u) => (await u('GET', '/api/canned')).body.responses.map((x) => x.title);
  assert.deepEqual(await titles(hm), ['Für alle', 'Heizung entlüften']);
  assert.deepEqual(await titles(it), ['Für alle']);
  assert.equal((await S.admin('POST', '/api/canned', { title: 'X', body: 'Y', shared: true, projectId: 9999 })).status, 400);
  // Back to "all projects"
  await S.admin('PATCH', `/api/canned/${r.body.response.id}`, { projectId: null });
  assert.deepEqual(await titles(it), ['Für alle', 'Heizung entlüften']);
});

test('Migration 43: existing articles go to the default project', async () => {
  const { openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-m43-'));
  try {
    const file = path.join(dir, 'h.sqlite');
    let d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    d.prepare("INSERT INTO projects(key,name) VALUES('AA','Erstes')").run();
    const hmId = d.prepare("INSERT INTO projects(key,name) VALUES('HM','Haustechnik')").run().lastInsertRowid;
    d.prepare("INSERT OR REPLACE INTO settings(key,value,secret) VALUES('general.defaultProject','\"HM\"',0)").run();
    d.exec('DROP TABLE user_passkeys; ALTER TABLE users DROP COLUMN activity_order; ALTER TABLE projects DROP COLUMN portal_show; ALTER TABLE projects DROP COLUMN portal_desc; ALTER TABLE projects DROP COLUMN portal_intro; ALTER TABLE projects DROP COLUMN portal_icon; ALTER TABLE projects DROP COLUMN portal_color; ALTER TABLE projects DROP COLUMN portal_sort; ALTER TABLE canned_responses DROP COLUMN project_id; DROP INDEX idx_kb_articles_project; ALTER TABLE kb_articles DROP COLUMN project_id;');
    d.prepare("INSERT INTO kb_articles(title, body, visibility) VALUES('Alt', '', 'public')").run();
    d.prepare("UPDATE meta SET value='42' WHERE key='schema_version'").run();
    d.close();
    d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    assert.equal(d.prepare("SELECT project_id FROM kb_articles WHERE title='Alt'").get().project_id, hmId);
    d.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
