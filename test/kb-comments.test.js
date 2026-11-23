// Comments on knowledge base articles
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let tom; let karl; let lisa; const sent = [];
before(async () => {
  S = await startServer('kbcomments');
  anna = await S.user('anna', 'agent');
  tom = await S.user('tom', 'agent');
  karl = await S.user('karl', 'user');
  lisa = await S.user('lisa', 'user');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
});
after(() => S.stop());

test('Comment, mail to author and last editor, resolve, delete', async () => {
  const pub = (await anna('POST', '/api/kb', { title: 'VPN', body: 'a', visibility: 'public' })).body.article;
  await tom('PUT', `/api/kb/${pub.id}`, { title: 'VPN', body: 'b', visibility: 'public' });
  const int = (await anna('POST', '/api/kb', { title: 'Intern', body: 'x', visibility: 'internal' })).body.article;
  assert.equal((await karl('POST', `/api/kb/${int.id}/comments`, { body: 'hallo' })).status, 404, 'internal article');
  assert.equal((await karl('POST', `/api/kb/${pub.id}/comments`, { body: '  ' })).status, 400);
  sent.length = 0;
  const c = (await karl('POST', `/api/kb/${pub.id}/comments`, { body: 'Schritt 3 stimmt seit dem Update nicht mehr' })).body.comment;
  assert.equal(c.author.displayName, 'karl');
  assert.equal(c.canDelete, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent.map((m) => m.to).sort(), ['anna@firma.local', 'tom@firma.local']);
  assert.match(sent[0].text, /Schritt 3/);
  assert.match(sent[0].text, /\/kb\/\d+#comments/);
  // author's own comment → no mail to themselves
  sent.length = 0;
  await anna('POST', `/api/kb/${pub.id}/comments`, { body: 'Danke, schaue ich mir an' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent.map((m) => m.to), ['tom@firma.local']);

  const list = (await lisa('GET', `/api/kb/${pub.id}/comments`)).body.comments;
  assert.equal(list.length, 2);
  assert.equal(list[0].canDelete, false);
  assert.equal((await anna('GET', '/api/kb')).body.articles.find((a) => a.id === pub.id).openComments, 2);
  assert.equal((await karl('GET', '/api/kb')).body.articles[0].openComments, undefined, 'users do not see counters');

  assert.equal((await karl('PATCH', `/api/kb/comments/${c.id}`, { resolved: true })).status, 403);
  const r = (await anna('PATCH', `/api/kb/comments/${c.id}`, { resolved: true })).body.comment;
  assert.deepEqual([r.resolved, r.resolvedBy], [true, 'anna']);
  assert.equal((await anna('GET', '/api/kb')).body.articles.find((a) => a.id === pub.id).openComments, 1);
  assert.equal((await lisa('DELETE', `/api/kb/comments/${c.id}`)).status, 403);
  assert.equal((await karl('DELETE', `/api/kb/comments/${c.id}`)).status, 200);
  assert.equal((await S.admin('DELETE', `/api/kb/comments/${list[1].id}`)).status, 200, 'admin may clean up');
  // Deleting the article removes its comments
  await karl('POST', `/api/kb/${pub.id}/comments`, { body: 'noch einer' });
  await anna('DELETE', `/api/kb/${pub.id}`);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM kb_comments').get().n, 0);
});

test('Comment mails only go to people who may still read the article (moved to another project: no mail)', async () => {
  const it = S.db.prepare("SELECT id FROM projects WHERE key='IT'").get().id;
  const hr = (await S.admin('POST', '/api/projects', { key: 'HR', name: 'Personal' })).body.project;
  await S.user('hra', 'user');
  S.db.prepare("INSERT INTO project_agents(project_id,user_id,source) VALUES(?,?,'manual')").run(it, S.ids.hra);
  const hra = await S.client().login('hra');
  const art = (await hra('POST', '/api/kb', { title: 'Server-Kennwörter', body: 'intern', visibility: 'internal', projectId: it })).body.article;
  assert.ok(art?.id, 'article created in IT');
  sent.length = 0;
  await anna('POST', `/api/kb/${art.id}/comments`, { body: 'Bitte aktualisieren' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent.map((m) => m.to), ['hra@firma.local'], 'still in the project: mail');
  // moved from IT to HR: still an agent (of HR), but no longer allowed to read the internal IT article
  S.db.prepare('DELETE FROM project_agents WHERE user_id=?').run(S.ids.hra);
  S.db.prepare("INSERT INTO project_agents(project_id,user_id,source) VALUES(?,?,'manual')").run(hr.id, S.ids.hra);
  sent.length = 0;
  await anna('POST', `/api/kb/${art.id}/comments`, { body: 'Neues Kennwort für srv01 ist …' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent.map((m) => m.to), [], 'no mail to a former member');
});
