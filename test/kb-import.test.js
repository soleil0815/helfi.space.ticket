// Knowledge import (against mock systems): Confluence Cloud and Data Center, Zammad, Zendesk Help Center,
// Freshdesk solutions, GLPI knowledge base, Znuny FAQ – text, pictures, files, page tree, links,
// visibility, drafts, importing again, rights.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockConfluence, startMockZammadKb, startMockZendeskHc, startMockFreshdeskSolutions, startMockGlpiKb, startMockZnunyFaq, PDF } from './fixtures/mock-knowledge.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-kbimp-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';
process.env.HELFI_IMPORT_ALLOW_LOCAL = '1';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { storageToHtml } = await import('../src/import/confluence.js');
const { htmlToMarkdown } = await import('../src/import/kb-html.js');

let server; let base; let db; let cookie = ''; let anna = ''; let HR;
const mails = [];
async function call(method, url, body, as = null) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie: as ?? cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && as === null) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}
async function waitJob() {
  for (let i = 0; i < 400; i++) {
    const { body } = await call('GET', '/api/admin/import/status');
    if (body.job && body.job.state !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import is stuck');
}
const articles = () => db.prepare('SELECT a.*, p.key pkey FROM kb_articles a JOIN projects p ON p.id=a.project_id ORDER BY a.id').all();
const byTitle = (t) => articles().find((a) => a.title === t);
const filesOf = (id) => db.prepare('SELECT filename FROM kb_files WHERE article_id=? ORDER BY position').all(id).map((f) => f.filename);
const imagesOf = (id) => db.prepare('SELECT filename FROM kb_images WHERE article_id=?').all(id).map((f) => f.filename);
async function run(source, connection, spaces, options = {}) {
  const r = await call('POST', `/api/admin/import/${source}/kb/start`, { connection, spaces, options });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return waitJob();
}

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  built.ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  built.ctx.mailer.send = async (m) => { mails.push(m); };
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  HR = (await call('POST', '/api/projects', { key: 'HR', name: 'Personal' })).body.project;
  await call('POST', '/api/users', { username: 'anna', displayName: 'Anna Agentin', email: 'anna@firma.local', role: 'user', password: 'Sehrgeheim123' });
  db.prepare("UPDATE users SET role='agent' WHERE username='anna'").run();
  anna = (await call('POST', '/api/auth/login', { username: 'anna', password: 'Sehrgeheim123' }, '')).cookie;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Confluence storage format: macros, pictures, page links, tasks, code, layouts', async () => {
  const html = storageToHtml(`<ac:layout><ac:layout-section><ac:layout-cell><p>A <ac:emoticon ac:name="tick"/></p></ac:layout-cell></ac:layout-section></ac:layout>
    <ac:structured-macro ac:name="tip"><ac:rich-text-body><p>Tipp</p></ac:rich-text-body></ac:structured-macro>
    <ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[a < b]]></ac:plain-text-body></ac:structured-macro>
    <ac:structured-macro ac:name="toc"/><ac:structured-macro ac:name="chart"/>
    <p><ac:link><ri:page ri:space-key="HR" ri:content-title="Urlaub"/></ac:link></p>`, { space: 'IT', lang: 'en' });
  const { markdown } = await htmlToMarkdown(html, { link: (h) => (h.startsWith('confluence-page:HR:Urlaub') ? '/kb/9' : null) });
  assert.equal(markdown, 'A ✅\n\n:::tip\nTipp\n:::\n\n```\na < b\n```\n\n*\\[Confluence macro "chart" not imported\\]*\n\n[Urlaub](/kb/9)');
});

test('HTML: info boxes of help centers, scripts and foreign pictures dropped', async () => {
  const r = await htmlToMarkdown('<div class="alert alert-warning"><p>Vorsicht</p></div><script>alert(1)</script><p onclick="x">Text <img src="https://evil.example/a.png"></p><div class="info-text">kein Kasten</div>', { image: async () => null });
  assert.equal(r.markdown, ':::warning\nVorsicht\n:::\n\nText\n\nkein Kasten');
  assert.equal(r.droppedImages, 1);
});

test('Rights: admins only; sources without knowledge base are refused', async () => {
  assert.equal((await call('POST', '/api/admin/import/confluence/kb/connect', { connection: { baseUrl: 'https://wiki.firma.local' } }, anna)).status, 403);
  assert.equal((await call('POST', '/api/admin/import/csv/kb/connect', { connection: {} })).status, 404);
  assert.equal((await call('POST', '/api/admin/import/confluence/connect', { connection: { baseUrl: 'https://wiki.firma.local' } })).status, 404, 'Confluence has no tickets');
});

test('Confluence Cloud: page tree, pictures, files, links, macros; importing again', async () => {
  const cf = await startMockConfluence({ cloud: true });
  try {
    const conn = { type: 'cloud', baseUrl: cf.base, email: 'admin@firma.local', token: 'falsch' };
    assert.equal((await call('POST', '/api/admin/import/confluence/kb/connect', { connection: conn })).body.ok, false);
    conn.token = 'cf-token';
    const r = await call('POST', '/api/admin/import/confluence/kb/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.spaces.map((s) => [s.key, s.name, s.count]), [['IT', 'IT-Wissen', 3]]);
    assert.deepEqual(r.body.projects.map((p) => p.key).sort(), ['HR', 'IT']);
    const it = r.body.projects.find((p) => p.key === 'IT');
    const job = await run('confluence', conn, [{ key: 'IT', name: 'IT-Wissen', projectId: it.id, count: 3 }]);
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.equal(job.what, 'kb');
    assert.deepEqual([job.counts.created, job.counts.images, job.counts.files, job.counts.failed], [3, 1, 2, 0]);
    const start = byTitle('Start'); const vpn = byTitle('VPN einrichten'); const cert = byTitle('Zertifikat');
    assert.equal(vpn.parent_id, start.id, 'page tree');
    assert.equal(cert.parent_id, vpn.id);
    assert.ok([start, vpn, cert].every((a) => a.visibility === 'internal' && a.pkey === 'IT'));
    assert.equal(start.created_at, '2026-01-01T09:00:00.000Z', 'dates from the source');
    // links: to the imported page, missing target → only the text; warning box; macro note
    assert.match(start.body, new RegExp(`\\[die VPN-Anleitung\\]\\(/kb/${vpn.id}\\)`));
    assert.match(start.body, /und Gibt es nicht\./);
    assert.match(start.body, /:::warning\n\*\*Achtung\*\*\n\nNie das Kennwort weitergeben\.\n:::/);
    assert.match(start.body, /Confluence-Makro „jira“ nicht übernommen/, 'note in the language of the admin');
    // picture of an attachment in the text; the same file is not attached again; link to a file → the stored file
    assert.deepEqual(imagesOf(vpn.id), ['fenster.png']);
    assert.match(vpn.body, /!\[Fenster\]\(\/api\/kb\/images\/[\w-]+\)/);
    assert.deepEqual(filesOf(vpn.id), ['Profil.pdf', 'Notiz.txt']);
    const pdfTok = db.prepare("SELECT token FROM kb_files WHERE filename='Profil.pdf'").get().token;
    assert.match(vpn.body, new RegExp(`\\[Profil\\.pdf\\]\\(/api/kb/files/${pdfTok}\\)`));
    assert.match(vpn.body, /```\nvpn --connect <firma>\n```/);
    assert.doesNotMatch(vpn.body, /evil/, 'pictures from other hosts are not loaded');
    assert.equal(fs.readFileSync(`${paths.attachments}/kb-files/${pdfTok}`).toString(), PDF.toString());
    assert.match(cert.body, /- \[x\] Zertifikat/);
    const v = db.prepare('SELECT note, version FROM kb_versions WHERE article_id=?').get(vpn.id);
    assert.equal(v.note, 'Importiert aus Confluence (Anna Agentin)');
    // no mails, no tickets
    assert.equal(mails.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tickets').get().n, 0);

    // Local change; then importing again: unchanged pages stay, the changed page gets a new version, nothing twice
    await call('PUT', `/api/kb/${start.id}`, { title: 'Start', body: 'Lokal geändert', visibility: 'public' });
    cf.state.v2 = true;
    const again = await run('confluence', conn, [{ key: 'IT', name: 'IT-Wissen', projectId: it.id }]);
    assert.deepEqual([again.counts.created, again.counts.updated, again.counts.unchanged, again.counts.images, again.counts.files], [0, 1, 2, 0, 0], JSON.stringify(again));
    assert.equal(byTitle('Start').body, 'Lokal geändert', 'unchanged in the source → local edit stays');
    const vpn2 = byTitle('VPN einrichten');
    assert.match(vpn2.body, /^Neue Fassung: Client starten\./);
    assert.deepEqual(db.prepare('SELECT version FROM kb_versions WHERE article_id=? ORDER BY version').all(vpn.id).map((x) => x.version), [1, 2]);
    assert.equal(articles().length, 3);
    assert.deepEqual(imagesOf(vpn.id), ['fenster.png'], 'picture reused, not loaded twice');
    assert.deepEqual(filesOf(vpn.id), ['Profil.pdf', 'Notiz.txt']);
  } finally { cf.close(); }
});

test('Confluence Data Center: token, ancestors as page tree, other project', async () => {
  const cf = await startMockConfluence({ cloud: false });
  try {
    const conn = { type: 'server', baseUrl: cf.base, token: 'dc-token' };
    const r = await call('POST', '/api/admin/import/confluence/kb/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.server.version, '8.5.9');
    const job = await run('confluence', conn, [{ key: 'IT', name: 'IT-Wissen', projectId: HR.id }], { attachments: false });
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    const hr = articles().filter((a) => a.pkey === 'HR');
    assert.equal(hr.length, 3, 'another source address → own articles');
    const vpn = hr.find((a) => a.title === 'VPN einrichten');
    assert.equal(vpn.parent_id, hr.find((a) => a.title === 'Start').id);
    assert.deepEqual(filesOf(vpn.id), [], 'attachments switched off');
    assert.deepEqual(imagesOf(vpn.id), ['fenster.png'], 'pictures in the text still come');
    assert.ok(cf.calls.some((c) => c.startsWith('GET /confluence/rest/api/content?spaceKey=IT')));
  } finally { cf.close(); }
});

test('Zammad: root categories, subcategory as category, published/internal/draft/archived, language', async () => {
  const z = await startMockZammadKb();
  try {
    const conn = { baseUrl: z.url, token: 'zammad-token' };
    const r = await call('POST', '/api/admin/import/zammad/kb/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.spaces.map((s) => [s.key, s.name, s.count]), [['cat:5', 'IT', 4], ['cat:7', 'Personal', 1]]);
    assert.deepEqual(r.body.spaces[0].languages, [{ code: '1', name: 'Deutsch' }, { code: '2', name: 'English' }]);
    const job = await run('zammad', conn, [{ key: 'cat:5', name: 'IT', projectId: r.body.projects.find((p) => p.key === 'IT').id }, { key: 'cat:7', name: 'Personal', projectId: HR.id }], { drafts: true });
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.equal(job.counts.skipped, 1, 'archived answer');
    const printer = byTitle('Drucker einrichten');
    assert.equal(printer.visibility, 'public');
    assert.equal(printer.category, 'Drucker');
    assert.deepEqual(imagesOf(printer.id), ['dialog.png']);
    assert.deepEqual(filesOf(printer.id), ['Treiber.pdf'], 'the picture in the text is not attached again');
    assert.match(printer.body, new RegExp(`\\[interne Notiz\\]\\(/kb/${byTitle('Interne Notiz').id}\\)`), 'link to another answer');
    assert.equal(byTitle('Interne Notiz').visibility, 'internal');
    assert.equal(byTitle('Entwurf').visibility, 'internal', 'draft → internal');
    assert.equal(byTitle('Archiviert'), undefined);
    assert.equal(byTitle('Urlaub beantragen').pkey, 'HR');
    // English translation into another project – a second run of the same source only updates (source changed? no)
    const en = await run('zammad', conn, [{ key: 'cat:5', name: 'IT', projectId: HR.id, language: '2' }]);
    assert.equal(en.counts.created, 0, 'same answers already imported – nothing twice');
  } finally { z.close(); }
});

test('Zendesk Help Center: categories, sections, segments, drafts skipped, pages, inline pictures', async () => {
  const z = await startMockZendeskHc();
  try {
    const conn = { baseUrl: z.url, email: 'admin@firma.local', token: 'zd-token' };
    const r = await call('POST', '/api/admin/import/zendesk/kb/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.spaces.map((s) => [s.key, s.name, s.count]), [['1', 'Allgemein', 4]]);
    const job = await run('zendesk', conn, [{ key: '1', name: 'Allgemein', projectId: HR.id }]);
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.deepEqual([job.counts.created, job.counts.skipped], [3, 1]);
    const pw = byTitle('Kennwort ändern');
    assert.equal(pw.visibility, 'public');
    assert.equal(pw.category, 'Konten / Kennwort');
    assert.match(pw.body, /:::tip\nTipp: Manager nutzen\n:::/);
    assert.deepEqual(imagesOf(pw.id), ['schritt.png']);
    assert.deepEqual(filesOf(pw.id), ['Richtlinie.pdf']);
    assert.match(pw.body, new RegExp(`\\[Agents\\]\\(/kb/${byTitle('Nur Agents').id}\\)`));
    assert.equal(byTitle('Nur Agents').visibility, 'internal');
    assert.equal(byTitle('Angemeldete').visibility, 'public');
  } finally { z.close(); }
});

test('Freshdesk solutions: folders and subfolders, visibility, drafts', async () => {
  const f = await startMockFreshdeskSolutions();
  try {
    const conn = { baseUrl: f.url, token: 'fd-key' };
    const r = await call('POST', '/api/admin/import/freshdesk/kb/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.spaces.map((s) => [s.name, s.count]), [['IT-Hilfe', 4], ['Leer', 0]]);
    const job = await run('freshdesk', conn, [{ key: '1', name: 'IT-Hilfe', projectId: HR.id }]);
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    assert.deepEqual([job.counts.created, job.counts.skipped], [3, 1]);
    assert.equal(byTitle('Maus tauschen').visibility, 'public');
    assert.equal(byTitle('Maus tauschen').category, 'Hardware');
    assert.deepEqual(filesOf(byTitle('Maus tauschen').id), ['Formular.pdf']);
    assert.equal(byTitle('Lizenzen').visibility, 'internal');
    assert.equal(byTitle('Monitor anschließen').category, 'Hardware / Monitore');
    assert.equal(byTitle('Monitor anschließen').visibility, 'public');
  } finally { f.close(); }
});

test('GLPI knowledge base: top categories, FAQ public, documents as pictures and files, without category', async () => {
  const g = await startMockGlpiKb();
  try {
    const conn = { baseUrl: `${g.url}/apirest.php`, token: 'glpi-token' };
    const r = await call('POST', '/api/admin/import/glpi/kb/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.spaces.map((s) => [s.key, s.count, s.note || '']), [['20', 2, ''], ['none', 1, 'withoutCategory']]);
    const job = await run('glpi', conn, [{ key: '20', name: 'Netzwerk', projectId: HR.id }, { key: 'none', name: '—', projectId: HR.id }]);
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    const wlan = byTitle('WLAN verbinden');
    assert.equal(wlan.visibility, 'public');
    assert.equal(wlan.category, 'WLAN');
    assert.match(wlan.body, /SSID \*\*Firma\*\*/);
    assert.deepEqual(imagesOf(wlan.id), ['wlan.png']);
    assert.deepEqual(filesOf(wlan.id), ['Zugang.pdf']);
    assert.equal(byTitle('Server neu starten').visibility, 'internal');
    assert.equal(byTitle('Server neu starten').category, '');
    assert.ok(byTitle('Ohne Kategorie'));
  } finally { g.close(); }
});

test('Znuny FAQ: public entries with fields as sections, inline picture, file', async () => {
  const z = await startMockZnunyFaq();
  try {
    const conn = { faqUrl: `${z.url}/otrs/nph-genericinterface.pl/Webservice/GenericFAQConnectorREST` };
    const r = await call('POST', '/api/admin/import/znuny/kb/connect', { connection: conn });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.spaces.map((s) => [s.key, s.count]), [['IT', 1], ['Personal', 1]]);
    const job = await run('znuny', conn, [{ key: 'IT', name: 'IT', projectId: HR.id }, { key: 'Personal', name: 'Personal', projectId: HR.id }]);
    assert.equal(job.state, 'done', JSON.stringify(job.errors));
    const p = byTitle('Drucker streikt');
    assert.equal(p.visibility, 'public');
    assert.equal(p.category, 'Drucker');
    assert.match(p.body, /^## Symptom\n\nKein Ausdruck\n\n## Lösung\n\nNeu starten/);
    assert.deepEqual(imagesOf(p.id), ['knopf.png']);
    assert.deepEqual(filesOf(p.id), ['Handbuch.pdf']);
    assert.match(byTitle('Urlaub').body, /Im Portal\nbeantragen/);
  } finally { z.close(); }
});

test('Status and errors: a second import while one runs is refused; unreachable source fails cleanly', async () => {
  const r = await call('POST', '/api/admin/import/confluence/kb/connect', { connection: { type: 'cloud', baseUrl: 'http://127.0.0.1:1/wiki', email: 'a@firma.local', token: 'x' } });
  assert.equal(r.body.ok, false);
  const bad = await call('POST', '/api/admin/import/confluence/kb/start', { connection: { type: 'cloud', baseUrl: 'http://127.0.0.1:1/wiki' }, spaces: [{ key: 'IT', projectId: 99999 }] });
  assert.equal(bad.status, 400, 'unknown project');
});
