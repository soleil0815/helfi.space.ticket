// Knowledge base articles: page tree (parent, path, child pages, visibility, deletion) and print bundle
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; const id = {};
before(async () => {
  S = await startServer('kbtree');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  const mk = async (key, title, parentId, visibility = 'public') => { id[key] = (await anna('POST', '/api/kb', { title, body: `# ${title}`, visibility, parentId })).body.article.id; };
  await mk('onb', 'Onboarding');
  await mk('acc', 'Konten', id.onb);
  await mk('int', 'Interne Notizen', id.onb, 'internal');
  await mk('vpn', 'VPN', id.int); // public below internal
  await mk('pc', 'PC einrichten', id.acc);
});
after(() => S.stop());

const titles = (nodes) => nodes.map((n) => [n.title, titles(n.children)]);

test('Tree, path and child pages; users only see public pages', async () => {
  assert.deepEqual(titles((await anna('GET', '/api/kb/tree')).body.tree),
    [['Onboarding', [['Interne Notizen', [['VPN', []]]], ['Konten', [['PC einrichten', []]]]]]]);
  // a public page below an internal one moves up one level for users
  assert.deepEqual(titles((await karl('GET', '/api/kb/tree')).body.tree),
    [['Onboarding', [['Konten', [['PC einrichten', []]]], ['VPN', []]]]]);
  const pc = (await anna('GET', `/api/kb/${id.pc}`)).body.article;
  assert.deepEqual(pc.path.map((x) => x.title), ['Onboarding', 'Konten']);
  const vpnUser = (await karl('GET', `/api/kb/${id.vpn}`)).body.article;
  assert.deepEqual(vpnUser.path.map((x) => x.title), ['Onboarding'], 'internal page not in the path');
  assert.deepEqual((await karl('GET', `/api/kb/${id.onb}`)).body.article.children.map((c) => c.title), ['Konten', 'VPN']);
});

test('Moving: no loops, no new version', async () => {
  assert.equal((await anna('PUT', `/api/kb/${id.onb}`, { title: 'Onboarding', body: '# Onboarding', visibility: 'public', parentId: id.pc })).status, 400, 'below its own child page');
  assert.equal((await anna('PUT', `/api/kb/${id.onb}`, { title: 'Onboarding', body: '# Onboarding', visibility: 'public', parentId: id.onb })).status, 400, 'below itself');
  assert.equal((await anna('PUT', `/api/kb/${id.pc}`, { title: 'PC einrichten', body: '# PC einrichten', visibility: 'public', parentId: 99999 })).status, 400);
  const r = await anna('PUT', `/api/kb/${id.pc}`, { title: 'PC einrichten', body: '# PC einrichten', visibility: 'public', parentId: id.onb });
  assert.equal(r.body.article.parentId, id.onb);
  assert.equal(r.body.article.version, 1, 'moving is not a version');
  // without parentId the position stays (e.g. when restoring)
  const r2 = await anna('PUT', `/api/kb/${id.pc}`, { title: 'PC einrichten', body: '# PC neu', visibility: 'public' });
  assert.equal(r2.body.article.parentId, id.onb);
  assert.equal(r2.body.article.version, 2);
});

test('Print bundle in reading order, visible pages only', async () => {
  const a = (await anna('GET', `/api/kb/${id.onb}/bundle`)).body.articles.map((x) => [x.title, x.depth]);
  assert.deepEqual(a, [['Onboarding', 0], ['Interne Notizen', 1], ['VPN', 2], ['Konten', 1], ['PC einrichten', 1]]);
  const k = (await karl('GET', `/api/kb/${id.onb}/bundle`)).body.articles.map((x) => x.title);
  assert.deepEqual(k, ['Onboarding', 'Konten', 'PC einrichten', 'VPN']);
  assert.equal((await karl('GET', `/api/kb/${id.int}/bundle`)).status, 404);
});

test('Deleting: child pages move up one level', async () => {
  await anna('DELETE', `/api/kb/${id.int}`);
  assert.equal((await anna('GET', `/api/kb/${id.vpn}`)).body.article.parentId, id.onb);
  await anna('DELETE', `/api/kb/${id.onb}`);
  assert.deepEqual(titles((await anna('GET', '/api/kb/tree')).body.tree).map((x) => x[0]), ['Konten', 'PC einrichten', 'VPN']);
});

test('Moving via page tree (position only, no version)', async () => {
  const a = (await anna('POST', '/api/kb', { title: 'Windows', body: '', visibility: 'public' })).body.article;
  const b = (await anna('POST', '/api/kb', { title: 'CMD-Befehle', body: 'x', visibility: 'public' })).body.article;
  assert.equal((await karl('PATCH', `/api/kb/${b.id}/parent`, { parentId: a.id })).status, 403);
  const r = await anna('PATCH', `/api/kb/${b.id}/parent`, { parentId: a.id });
  assert.equal(r.body.article.parentId, a.id);
  assert.equal(r.body.article.version, 1);
  assert.equal((await anna('PATCH', `/api/kb/${a.id}/parent`, { parentId: b.id })).status, 400, 'loop');
  assert.equal((await anna('PATCH', `/api/kb/${b.id}/parent`, { parentId: null })).body.article.parentId, null);
});
