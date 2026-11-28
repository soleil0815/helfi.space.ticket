// Knowledge base: files attached to an article (PDF, documents …) – upload as a draft, taken over on
// saving, visibility like the article, always a download, removing, limits, search by file name
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers/server.js';

let S; let anna; let berta; let karl;
const cookies = {};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
async function login(username) {
  const r = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username, password: 'Sehrgeheim123' }) });
  return r.headers.get('set-cookie').split(';')[0];
}
async function upload(who, files) {
  const fd = new FormData();
  for (const [buf, name, type] of files) fd.append('files', new Blob([buf], { type }), name);
  const r = await fetch(`${S.base}/api/kb/files`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie: cookies[who] }, body: fd });
  return { status: r.status, body: await r.json() };
}
const get = (who, url) => fetch(`${S.base}${url}`, { headers: { cookie: cookies[who] || '' } });
const filePath = async (token) => `${(await import('../src/config.js')).paths.attachments}/kb-files/${token}`;

before(async () => {
  S = await startServer('kbfiles');
  anna = await S.user('anna', 'agent');
  berta = await S.user('berta', 'agent');
  karl = await S.user('karl', 'user');
  for (const u of ['anna', 'berta', 'karl']) cookies[u] = await login(u);
});
after(() => S.stop());

test('Upload: agents only, a draft only its uploader sees, served as a download', async () => {
  assert.equal((await upload('karl', [[PDF, 'a.pdf', 'application/pdf']])).status, 403);
  const r = await upload('anna', [[PDF, 'VPN-Anleitung.pdf', 'application/pdf'], [Buffer.from('<html><script>alert(1)</script>'), 'seite.html', 'text/html']]);
  assert.equal(r.status, 201);
  assert.equal(r.body.files.length, 2);
  const [pdf, html] = r.body.files;
  assert.equal(pdf.name, 'VPN-Anleitung.pdf');
  assert.equal(pdf.size, PDF.length);
  assert.match(pdf.url, /^\/api\/kb\/files\/[\w-]{16,}$/);
  const d = await get('anna', html.url);
  assert.equal(d.status, 200);
  assert.equal(d.headers.get('content-type'), 'application/octet-stream', 'never shown as a page, whatever the browser claimed');
  assert.match(d.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''seite\.html$/);
  assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
  assert.match(d.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await get('berta', pdf.url)).status, 404, 'a draft is only for its uploader');
  assert.equal((await get('karl', pdf.url)).status, 404);
  assert.equal((await get('', pdf.url)).status, 401);
});

test('Saving takes the files over; visibility follows the article; removing deletes the file', async () => {
  const { files } = (await upload('anna', [[PDF, 'Handbuch.pdf', 'application/pdf'], [Buffer.from('a;b\n1;2\n'), 'Liste.csv', 'text/csv']])).body;
  const art = (await anna('POST', '/api/kb', { title: 'Drucker einrichten', visibility: 'internal', body: 'Siehe Anhang.', files: files.map((f) => f.token) })).body.article;
  assert.deepEqual(art.files.map((f) => f.name), ['Handbuch.pdf', 'Liste.csv'], 'in the given order');
  assert.equal(art.version, 1);
  assert.equal((await get('berta', files[0].url)).status, 200, 'internal article: the project people');
  assert.equal((await get('karl', files[0].url)).status, 404, 'internal article: not for users');
  // Only the files change → no new version, but the article counts as changed
  const reordered = (await anna('PUT', `/api/kb/${art.id}`, { title: art.title, body: art.body, visibility: 'public', files: [files[1].token, files[0].token] })).body.article;
  assert.deepEqual(reordered.files.map((f) => f.name), ['Liste.csv', 'Handbuch.pdf']);
  assert.equal((await get('karl', files[0].url)).status, 200, 'public article: everyone signed in');
  const karlView = (await karl('GET', `/api/kb/${art.id}`)).body.article;
  assert.equal(karlView.files.length, 2);
  // List shows the number of files, search finds the file name
  const hit = (await karl('GET', '/api/kb?q=Handbuch')).body.articles;
  assert.equal(hit.length, 1);
  assert.equal(hit[0].fileCount, 2);
  // Removing one: gone from the article and from the disk
  const path0 = await filePath(files[0].token);
  assert.ok(fs.existsSync(path0));
  const kept = (await anna('PUT', `/api/kb/${art.id}`, { title: art.title, body: art.body, visibility: 'public', files: [files[1].token] })).body.article;
  assert.equal(kept.files.length, 1);
  assert.equal(S.db.prepare('SELECT MAX(version) v FROM kb_versions WHERE article_id=?').get(art.id).v, 2, 'only the visibility change made a version');
  assert.ok(!fs.existsSync(path0));
  assert.equal((await get('anna', files[0].url)).status, 404);
  // Saving without "files" (e.g. restoring a version) leaves them alone
  await anna('POST', `/api/kb/${art.id}/versions/1/restore`);
  assert.equal((await anna('GET', `/api/kb/${art.id}`)).body.article.files.length, 1);
  // Deleting the article removes its files
  const path1 = await filePath(files[1].token);
  await anna('DELETE', `/api/kb/${art.id}`);
  assert.ok(!fs.existsSync(path1));
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM kb_files WHERE token=?').get(files[1].token).n, 0);
});

test('Foreign files cannot be taken over; limits; discarding an unsaved upload', async () => {
  const mine = (await upload('anna', [[PDF, 'a.pdf', 'application/pdf']])).body.files[0];
  const r = await berta('POST', '/api/kb', { title: 'Fremd', body: '', files: [mine.token] });
  assert.equal(r.status, 400, "someone else's draft");
  assert.equal(r.body.error.code, 'err.kbFileGone');
  const other = (await anna('POST', '/api/kb', { title: 'Mit Datei', body: '', files: [mine.token] })).body.article;
  const steal = await berta('POST', '/api/kb', { title: 'Klau', body: '', files: [mine.token] });
  assert.equal(steal.status, 400, 'a file of another article');
  assert.equal((await anna('GET', `/api/kb/${other.id}`)).body.article.files.length, 1, 'still at its article');
  // At most 20 per article
  const many = [];
  for (let i = 0; i < 21; i++) many.push((await upload('anna', [[PDF, `d${i}.pdf`, 'application/pdf']])).body.files[0].token);
  const tooMany = await anna('POST', '/api/kb', { title: 'Viele', body: '', files: many });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, 'err.kbTooManyFiles');
  // Discarding: only one's own unsaved upload
  assert.equal((await berta('DELETE', `/api/kb/files/${many[0]}`)).status, 200);
  assert.ok(S.db.prepare('SELECT 1 FROM kb_files WHERE token=?').get(many[0]), "berta cannot discard anna's upload");
  await anna('DELETE', `/api/kb/files/${many[0]}`);
  assert.ok(!S.db.prepare('SELECT 1 FROM kb_files WHERE token=?').get(many[0]));
  await anna('DELETE', `/api/kb/files/${mine.token}`);
  assert.ok(S.db.prepare('SELECT 1 FROM kb_files WHERE token=?').get(mine.token), 'a saved file is not removed this way');
});

test('Unsaved uploads expire after two days; too many unsaved uploads are refused', async () => {
  S.db.prepare("UPDATE kb_files SET created_at='2020-01-01T00:00:00.000Z' WHERE article_id IS NULL").run();
  const old = S.db.prepare('SELECT token FROM kb_files WHERE article_id IS NULL').all();
  assert.ok(old.length > 0);
  await upload('anna', [[PDF, 'neu.pdf', 'application/pdf']]);
  for (const o of old) {
    assert.ok(!S.db.prepare('SELECT 1 FROM kb_files WHERE token=?').get(o.token));
    assert.ok(!fs.existsSync(await filePath(o.token)));
  }
  for (let i = 0; i < 29; i++) assert.equal((await upload('anna', [[PDF, `x${i}.pdf`, 'application/pdf']])).status, 201);
  const full = await upload('anna', [[PDF, 'zuviel.pdf', 'application/pdf']]);
  assert.equal(full.status, 400);
  assert.equal(full.body.error.code, 'err.kbTooManyDrafts');
});
