// Wissensartikel-Editor: Bilder (Upload, Typprüfung, Sichtbarkeit), Kurztext aus dem Textformat
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers/server.js';

let S; let anna; let karl;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let annaCookie = ''; let karlCookie = '';
async function login(username) {
  const r = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username, password: 'Sehrgeheim123' }) });
  return r.headers.get('set-cookie').split(';')[0];
}
async function upload(cookie, buf, name = 'bild.png', type = 'image/png') {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  const r = await fetch(`${S.base}/api/kb/images`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd });
  return { status: r.status, body: await r.json() };
}
const getImg = (cookie, url) => fetch(`${S.base}${url}`, { headers: { cookie } });

before(async () => {
  S = await startServer('kbeditor');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  annaCookie = await login('anna');
  karlCookie = await login('karl');
});
after(() => S.stop());

test('Bild hochladen: nur Bearbeiter, Typ an den Bytes erkannt', async () => {
  assert.equal((await upload(karlCookie, PNG)).status, 403);
  const bad = await upload(annaCookie, Buffer.from('<svg onload=alert(1)>'), 'x.png', 'image/png');
  assert.equal(bad.status, 400, 'als PNG getarnt, ist aber keins');
  const ok = await upload(annaCookie, PNG, 'Bildschirmfoto.png');
  assert.equal(ok.status, 201);
  assert.match(ok.body.url, /^\/api\/kb\/images\/[\w-]{16,}$/);
  const r = await getImg(annaCookie, ok.body.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await getImg(karlCookie, ok.body.url)).status, 404, 'Entwurf: nur Bearbeiter');
  assert.equal((await getImg('', ok.body.url)).status, 401);
});

test('Sichtbarkeit folgt dem Artikel; Löschen entfernt die Bilder', async () => {
  const { url } = (await upload(annaCookie, PNG)).body;
  const art = (await anna('POST', '/api/kb', { title: 'Drucker', visibility: 'internal', body: `# Schritte\n\n![Fach 2|medium](${url})\n\n- [ ] Toner\n- [x] Papier\n\n:::warning\nVorsicht **heiß**\n:::` })).body.article;
  assert.equal((await getImg(karlCookie, url)).status, 404, 'interner Artikel');
  await anna('PUT', `/api/kb/${art.id}`, { title: 'Drucker', visibility: 'public', body: art.body });
  assert.equal((await getImg(karlCookie, url)).status, 200, 'öffentlicher Artikel');
  // Kurztext ohne Formatierungszeichen
  const list = (await karl('GET', '/api/kb')).body.articles;
  assert.equal(list[0].excerpt, 'Schritte Toner Papier Vorsicht heiß');
  // Suche findet Text in Infobox
  assert.equal((await karl('GET', '/api/kb?q=heiß')).body.articles.length, 1);
  const file = S.db.prepare('SELECT token FROM kb_images WHERE article_id=?').get(art.id);
  assert.ok(file, 'Bild gehört zum Artikel');
  await anna('DELETE', `/api/kb/${art.id}`);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM kb_images').get().n, 1, 'nur das Bild aus dem ersten Test (Entwurf) bleibt');
  assert.equal((await getImg(annaCookie, url)).status, 404);
});

test('Entwürfe ohne Artikel verfallen nach zwei Tagen', async () => {
  S.db.prepare("UPDATE kb_images SET created_at='2020-01-01T00:00:00.000Z' WHERE article_id IS NULL").run();
  const old = S.db.prepare('SELECT token FROM kb_images WHERE article_id IS NULL').all();
  await upload(annaCookie, PNG);
  for (const o of old) assert.ok(!S.db.prepare('SELECT 1 FROM kb_images WHERE token=?').get(o.token));
  const { paths } = await import('../src/config.js');
  for (const o of old) assert.ok(!fs.existsSync(`${paths.attachments}/kb/${o.token}`));
});

test('Textformat: Kurztext', async () => {
  const { plainText } = await import('../src/itil/kb.js');
  assert.equal(plainText('## Titel\n\n1. **eins** und [Link](https://x.example)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```'), 'Titel eins und Link a b 1 2 code');
});
