// Knowledge base articles: versions (history, restore) and custom templates
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let tom; let karl;
before(async () => {
  S = await startServer('kbversions');
  anna = await S.user('anna', 'agent');
  tom = await S.user('tom', 'agent');
  karl = await S.user('karl', 'user');
});
after(() => S.stop());

test('Every change is a version; saving unchanged creates none', async () => {
  const a = (await anna('POST', '/api/kb', { title: 'VPN', body: '# Schritt 1\n\nClient installieren', visibility: 'public', note: 'erste Fassung' })).body.article;
  assert.equal(a.version, 1);
  let r = await tom('PUT', `/api/kb/${a.id}`, { title: 'VPN einrichten', body: '# Schritt 1\n\nClient aus dem Softwarecenter installieren', visibility: 'public', note: 'Softwarecenter' });
  assert.equal(r.body.article.version, 2);
  r = await tom('PUT', `/api/kb/${a.id}`, { title: 'VPN einrichten', body: '# Schritt 1\n\nClient aus dem Softwarecenter installieren', visibility: 'public' });
  assert.equal(r.body.article.version, 2, 'nothing changed');
  const list = (await anna('GET', `/api/kb/${a.id}/versions`)).body.versions;
  assert.deepEqual(list.map((v) => [v.version, v.author, v.note]), [[2, 'tom', 'Softwarecenter'], [1, 'anna', 'erste Fassung']]);
  assert.equal(list[0].body, undefined, 'list without body');
  const v1 = (await anna('GET', `/api/kb/${a.id}/versions/1`)).body.version;
  assert.equal(v1.title, 'VPN');
  assert.equal(v1.body, '# Schritt 1\n\nClient installieren');
  assert.equal((await anna('GET', `/api/kb/${a.id}/versions/9`)).status, 404);
  // Users do not see the history
  assert.equal((await karl('GET', `/api/kb/${a.id}/versions`)).status, 403);
  assert.equal((await karl('POST', `/api/kb/${a.id}/versions/1/restore`)).status, 403);
});

test('Restoring creates a new version, nothing is lost', async () => {
  const id = (await anna('GET', '/api/kb')).body.articles[0].id;
  const r = await anna('POST', `/api/kb/${id}/versions/1/restore`);
  assert.equal(r.status, 200);
  assert.equal(r.body.article.version, 3);
  assert.equal(r.body.article.title, 'VPN');
  const list = (await anna('GET', `/api/kb/${id}/versions`)).body.versions;
  assert.deepEqual(list.map((v) => v.version), [3, 2, 1]);
  assert.equal(list[0].note, '↩ 1');
  // Deleting also removes the versions
  await anna('DELETE', `/api/kb/${id}`);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM kb_versions WHERE article_id=?').get(id).n, 0);
});

test('Custom templates: agents only', async () => {
  assert.equal((await karl('GET', '/api/kb/templates')).status, 403);
  assert.equal((await anna('POST', '/api/kb/templates', { title: ' ' })).status, 400);
  const t = (await anna('POST', '/api/kb/templates', { title: 'Störungsbericht', description: 'Für Ausfälle', body: '## Ursache\n\n## Lösung' })).body.template;
  assert.equal((await tom('PUT', `/api/kb/templates/${t.id}`, { title: 'Störungsbericht', body: '## Ursache\n\n## Lösung\n\n## Nachbereitung' })).body.template.author, 'tom');
  assert.deepEqual((await anna('GET', '/api/kb/templates')).body.templates.map((x) => x.title), ['Störungsbericht']);
  assert.match((await anna('GET', `/api/kb/templates/${t.id}`)).body.template.body, /Nachbereitung/);
  assert.equal((await anna('DELETE', `/api/kb/templates/${t.id}`)).status, 200);
  assert.equal((await anna('GET', `/api/kb/templates/${t.id}`)).status, 404);
});

test('Migration 19: existing articles get version 1', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const { MIGRATIONS, openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mig19-'));
  const file = path.join(dir, 'h.sqlite');
  const d = new Database(file);
  d.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS.filter((x) => x.id < 19)) d.exec(m.sql);
  d.exec("INSERT INTO meta(key,value) VALUES('schema_version','18'),('app_version','1.7.0')");
  d.exec("INSERT INTO kb_articles(id,title,body,visibility,category,updated_at) VALUES(1,'Alt','**Text**','public','Drucker','2026-01-02T03:04:05.000Z'),(2,'Zwei','','internal','','2026-02-01T00:00:00.000Z')");
  d.close();
  const db = await openDatabase(file, { appVersion: '1.8.0', backupDir: path.join(dir, 'b') });
  const rows = db.prepare('SELECT article_id, version, title, body, category, visibility, created_at FROM kb_versions ORDER BY article_id').all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [
    { article_id: 1, version: 1, title: 'Alt', body: '**Text**', category: 'Drucker', visibility: 'public', created_at: '2026-01-02T03:04:05.000Z' },
    { article_id: 2, version: 1, title: 'Zwei', body: '', category: '', visibility: 'internal', created_at: '2026-02-01T00:00:00.000Z' },
  ]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Text diff: lines and words', async () => {
  const { diffLines, diffWords } = await import('../public/js/diff.js');
  const d = diffLines('# Titel\n\nAlter Satz hier.\nbleibt\nweg', '# Titel\n\nNeuer Satz hier.\nbleibt\nneu');
  assert.deepEqual(d.map((x) => x.op), ['=', '=', '~', '=', '~']);
  assert.deepEqual(d[2].words, [{ op: '-', text: 'Alter' }, { op: '+', text: 'Neuer' }, { op: '=', text: ' Satz hier.' }]);
  assert.deepEqual(diffLines('a\nb', 'a\nb\nc').map((x) => x.op), ['=', '=', '+']);
  assert.deepEqual(diffLines('a\nb\nc', 'a\nc').map((x) => x.op), ['=', '-', '=']);
  assert.equal(diffWords('gleich', 'gleich').length, 1);
  // large texts stay fast
  const big = Array.from({ length: 3000 }, (_, i) => `Zeile ${i}`).join('\n');
  const t0 = Date.now();
  diffLines(big, big.replace('Zeile 1500', 'Zeile X'));
  assert.ok(Date.now() - t0 < 2000);
});
