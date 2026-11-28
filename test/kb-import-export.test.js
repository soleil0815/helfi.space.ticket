// Knowledge import from a Confluence space export (HTML, ZIP file): upload, spaces, page tree from the
// breadcrumbs, pictures and files from the archive, links between pages, rendered macros, importing again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipStream } from '../src/zip.js';
import { PNG, PDF } from './fixtures/mock-knowledge.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-kbzip-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { openZip } = await import('../src/lib/unzip.js');

let server; let base; let db; let cookie = ''; let anna = '';
async function call(method, url, body, as = null) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie: as ?? cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && as === null) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}
async function upload(buf, name = 'IT-Wissen.zip', as = null) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/zip' }), name);
  const r = await fetch(`${base}/api/admin/import/confluence-zip/upload`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie: as ?? cookie }, body: fd });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function waitJob() {
  for (let i = 0; i < 400; i++) {
    const { body } = await call('GET', '/api/admin/import/status');
    if (body.job && body.job.state !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import is stuck');
}
async function zipOf(files) {
  const chunks = [];
  for await (const c of zipStream(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) })))) chunks.push(c);
  return Buffer.concat(chunks);
}
const page = (title, crumbs, content, attachments = '') => `<!DOCTYPE html><html><head><title>IT-Wissen : ${title}</title></head><body>
<div id="page"><div id="main"><div id="main-header"><div id="breadcrumb-section"><ol id="breadcrumbs">${crumbs.map(([h, t]) => `<li><span><a href="${h}">${t}</a></span></li>`).join('')}</ol></div>
<h1 id="title-heading" class="pagetitle"><span id="title-text">IT-Wissen : ${title}</span></h1></div>
<div id="content" class="view"><div class="page-metadata">Created by <span class="author">Anna Agentin</span>, last modified on Jan 02, 2026</div>
<div id="main-content" class="wiki-content group">${content}</div>${attachments}</div></div></div></body></html>`;
const files = (v2 = false) => ({
  'IT/index.html': '<html><head><title>IT-Wissen : Home</title></head><body><span id="title-text">IT-Wissen : Home</span><div id="main-content">Willkommen</div></body></html>',
  'IT/Start_101.html': page('Start', [['index.html', 'IT-Wissen']], `<h2>Überblick</h2><p>Siehe <a href="VPN-einrichten_102.html">die VPN-Anleitung</a> und <a href="Weg_999.html">Weg</a>.</p>
    <div class="confluence-information-macro confluence-information-macro-warning"><span class="aui-icon aui-icon-small aui-iconfont-error confluence-information-macro-icon"></span><div class="confluence-information-macro-body"><p>Nie das Kennwort weitergeben.</p></div></div>
    <p>Fertig <img class="emoticon emoticon-tick" src="images/icons/emoticons/check.svg" alt="(Haken)"></p>`),
  'IT/VPN-einrichten_102.html': page('VPN einrichten', [['index.html', 'IT-Wissen'], ['Start_101.html', 'Start']], `<p>${v2 ? 'Neue Fassung: ' : ''}Client starten.</p>
    <p><span class="confluence-embedded-file-wrapper"><img class="confluence-embedded-image" src="attachments/102/201.png" alt="Fenster"></span></p>
    <div class="code panel pdl"><div class="codeContent panelContent pdl"><pre class="syntaxhighlighter-pre">vpn --connect &lt;firma&gt;</pre></div></div>
    <ul class="inline-task-list"><li class="checked">Zertifikat</li><li>Starten</li></ul>
    <p><a href="attachments/102/202.pdf">Profil.pdf</a></p>`,
  `<div class="pageSection group"><div class="pageSectionHeader"><h2 id="attachments" class="pageSectionTitle">Attachments:</h2></div><div class="greybox" align="left">
    <img src="images/icons/bullet_blue.gif" height="8" width="8" alt=""/><a href="attachments/102/201.png">fenster.png</a> (image/png)<br/>
    <img src="images/icons/bullet_blue.gif" height="8" width="8" alt=""/><a href="attachments/102/202.pdf">Profil.pdf</a> (application/pdf)<br/>
    <img src="images/icons/bullet_blue.gif" height="8" width="8" alt=""/><a href="attachments/102/203.txt">Notiz.txt</a> (text/plain)<br/></div></div>`),
  'IT/Zertifikat_103.html': page('Zertifikat', [['index.html', 'IT-Wissen'], ['Start_101.html', 'Start'], ['VPN-einrichten_102.html', 'VPN einrichten']],
    '<div class="expand-container"><div class="expand-control"><span class="expand-control-icon"></span><span class="expand-control-text">Details anzeigen</span></div><div class="expand-content"><p>Gültig ein Jahr.</p></div></div>'),
  'IT/attachments/102/201.png': PNG,
  'IT/attachments/102/202.pdf': PDF,
  'IT/attachments/102/203.txt': 'Notiz',
  'IT/images/icons/emoticons/check.svg': '<svg/>',
});

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  built.ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  await call('POST', '/api/users', { username: 'anna', displayName: 'Anna Agentin', email: 'anna@firma.local', role: 'user', password: 'Sehrgeheim123' });
  db.prepare("UPDATE users SET role='agent' WHERE username='anna'").run();
  anna = (await call('POST', '/api/auth/login', { username: 'anna', password: 'Sehrgeheim123' }, '')).cookie;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const byTitle = (t) => db.prepare('SELECT * FROM kb_articles WHERE title=?').get(t);
const filesOf = (id) => db.prepare('SELECT filename FROM kb_files WHERE article_id=? ORDER BY position').all(id).map((f) => f.filename);

test('ZIP reader: names outside the archive are left out, size limit while unpacking', async () => {
  const buf = await zipOf({ 'a/ok.txt': 'x'.repeat(5000), 'b/../../böse.txt': 'nein' });
  const f = path.join(dataDir, 't.zip'); fs.writeFileSync(f, buf);
  const z = openZip(f);
  try {
    assert.deepEqual([...z.entries.keys()], ['a/ok.txt']);
    assert.equal(z.read('a/ok.txt').length, 5000);
    assert.throws(() => z.read('a/ok.txt', 100), /zu groß/);
  } finally { z.close(); }
});

test('Upload: admins only, ZIP files only', async () => {
  assert.equal((await upload(await zipOf(files()), 'x.zip', anna)).status, 403);
  const bad = await upload(Buffer.from('kein zip'), 'x.zip');
  assert.equal(bad.status, 200);
  assert.equal(bad.body.ok, false);
});

test('Confluence export: spaces, page tree, pictures, files, links, macros; importing again', async () => {
  const up = await upload(await zipOf(files()));
  assert.equal(up.body.ok, true, JSON.stringify(up.body));
  const r = await call('POST', '/api/admin/import/confluence-zip/kb/connect', { connection: { uploadId: up.body.uploadId } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.spaces.map((s) => [s.key, s.name, s.count]), [['IT/', 'IT-Wissen', 3]]);
  const it = r.body.projects.find((p) => p.key === 'IT');
  const start = await call('POST', '/api/admin/import/confluence-zip/kb/start', { connection: { uploadId: up.body.uploadId }, spaces: [{ key: 'IT/', name: 'IT-Wissen', projectId: it.id }] });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const job = await waitJob();
  assert.equal(job.state, 'done', JSON.stringify(job.errors));
  assert.deepEqual([job.counts.created, job.counts.images, job.counts.files], [3, 1, 2]);
  const s = byTitle('Start'); const vpn = byTitle('VPN einrichten'); const cert = byTitle('Zertifikat');
  assert.equal(vpn.parent_id, s.id);
  assert.equal(cert.parent_id, vpn.id);
  assert.match(s.body, new RegExp(`\\[die VPN-Anleitung\\]\\(/kb/${vpn.id}\\)`));
  assert.match(s.body, /und Weg\./, 'link to a page not in the export → text');
  assert.match(s.body, /:::warning\nNie das Kennwort weitergeben\.\n:::/);
  assert.match(s.body, /Fertig ✅/);
  assert.match(vpn.body, /!\[Fenster\]\(\/api\/kb\/images\/[\w-]+\)/);
  assert.match(vpn.body, /```\nvpn --connect <firma>\n```/);
  assert.match(vpn.body, /- \[x\] Zertifikat\n- \[ \] Starten/);
  assert.deepEqual(filesOf(vpn.id), ['Profil.pdf', 'Notiz.txt'], 'the picture in the text is not attached again');
  const tok = db.prepare("SELECT token FROM kb_files WHERE filename='Profil.pdf'").get().token;
  assert.match(vpn.body, new RegExp(`\\[Profil\\.pdf\\]\\(/api/kb/files/${tok}\\)`));
  assert.match(cert.body, /\*\*Details anzeigen\*\*\n\nGültig ein Jahr\./);
  assert.equal(db.prepare('SELECT note FROM kb_versions WHERE article_id=?').get(vpn.id).note, 'Importiert aus Confluence (Anna Agentin)');
  // the uploaded file is removed after the import
  assert.equal(fs.readdirSync(path.join(paths.attachments, '.tmp')).filter((f) => f.startsWith('kbzip-')).length, 0);

  // newer export: only the changed page gets a new version
  const up2 = await upload(await zipOf(files(true)));
  await call('POST', '/api/admin/import/confluence-zip/kb/start', { connection: { uploadId: up2.body.uploadId }, spaces: [{ key: 'IT/', name: 'IT-Wissen', projectId: it.id }] });
  const again = await waitJob();
  assert.deepEqual([again.counts.created, again.counts.updated, again.counts.unchanged], [0, 1, 2], JSON.stringify(again));
  assert.match(byTitle('VPN einrichten').body, /^Neue Fassung: Client starten\./);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM kb_articles').get().n, 3);
});

test('An upload that is gone (other upload, expired) is refused', async () => {
  const r = await call('POST', '/api/admin/import/confluence-zip/kb/connect', { connection: { uploadId: 'gibtsnicht' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.importFileGone');
});
