// Wissensartikel: Seitenbaum (Eltern, Pfad, Unterseiten, Sichtbarkeit, Löschen) und Druck-Bündel
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
  await mk('vpn', 'VPN', id.int); // öffentlich unter intern
  await mk('pc', 'PC einrichten', id.acc);
});
after(() => S.stop());

const titles = (nodes) => nodes.map((n) => [n.title, titles(n.children)]);

test('Baum, Pfad und Unterseiten; Benutzer sehen nur öffentliche Seiten', async () => {
  assert.deepEqual(titles((await anna('GET', '/api/kb/tree')).body.tree),
    [['Onboarding', [['Interne Notizen', [['VPN', []]]], ['Konten', [['PC einrichten', []]]]]]]);
  // öffentliche Seite unter interner rückt für Benutzer eine Ebene hoch
  assert.deepEqual(titles((await karl('GET', '/api/kb/tree')).body.tree),
    [['Onboarding', [['Konten', [['PC einrichten', []]]], ['VPN', []]]]]);
  const pc = (await anna('GET', `/api/kb/${id.pc}`)).body.article;
  assert.deepEqual(pc.path.map((x) => x.title), ['Onboarding', 'Konten']);
  const vpnUser = (await karl('GET', `/api/kb/${id.vpn}`)).body.article;
  assert.deepEqual(vpnUser.path.map((x) => x.title), ['Onboarding'], 'interne Seite nicht im Pfad');
  assert.deepEqual((await karl('GET', `/api/kb/${id.onb}`)).body.article.children.map((c) => c.title), ['Konten', 'VPN']);
});

test('Verschieben: keine Schleifen, keine neue Version', async () => {
  assert.equal((await anna('PUT', `/api/kb/${id.onb}`, { title: 'Onboarding', body: '# Onboarding', visibility: 'public', parentId: id.pc })).status, 400, 'unter eigene Unterseite');
  assert.equal((await anna('PUT', `/api/kb/${id.onb}`, { title: 'Onboarding', body: '# Onboarding', visibility: 'public', parentId: id.onb })).status, 400, 'unter sich selbst');
  assert.equal((await anna('PUT', `/api/kb/${id.pc}`, { title: 'PC einrichten', body: '# PC einrichten', visibility: 'public', parentId: 99999 })).status, 400);
  const r = await anna('PUT', `/api/kb/${id.pc}`, { title: 'PC einrichten', body: '# PC einrichten', visibility: 'public', parentId: id.onb });
  assert.equal(r.body.article.parentId, id.onb);
  assert.equal(r.body.article.version, 1, 'Verschieben ist keine Version');
  // ohne parentId bleibt der Platz (z. B. beim Wiederherstellen)
  const r2 = await anna('PUT', `/api/kb/${id.pc}`, { title: 'PC einrichten', body: '# PC neu', visibility: 'public' });
  assert.equal(r2.body.article.parentId, id.onb);
  assert.equal(r2.body.article.version, 2);
});

test('Druck-Bündel in Lesereihenfolge, nur sichtbare Seiten', async () => {
  const a = (await anna('GET', `/api/kb/${id.onb}/bundle`)).body.articles.map((x) => [x.title, x.depth]);
  assert.deepEqual(a, [['Onboarding', 0], ['Interne Notizen', 1], ['VPN', 2], ['Konten', 1], ['PC einrichten', 1]]);
  const k = (await karl('GET', `/api/kb/${id.onb}/bundle`)).body.articles.map((x) => x.title);
  assert.deepEqual(k, ['Onboarding', 'Konten', 'PC einrichten', 'VPN']);
  assert.equal((await karl('GET', `/api/kb/${id.int}/bundle`)).status, 404);
});

test('Löschen: Unterseiten rücken eine Ebene hoch', async () => {
  await anna('DELETE', `/api/kb/${id.int}`);
  assert.equal((await anna('GET', `/api/kb/${id.vpn}`)).body.article.parentId, id.onb);
  await anna('DELETE', `/api/kb/${id.onb}`);
  assert.deepEqual(titles((await anna('GET', '/api/kb/tree')).body.tree).map((x) => x[0]), ['Konten', 'PC einrichten', 'VPN']);
});
