// Audit 2026-11 (second round), import area: SSRF via IPv4-mapped IPv6, headers on cross-origin
// redirects, CSV re-import and duplicates, mapping names like "constructor", adapter errors,
// deep ADF, Znuny "-int" articles, AI reply/article draft without internal notes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startMockZammad } from './fixtures/mock-zammad.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-audit11b-imp-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';
process.env.HELFI_IMPORT_ALLOW_LOCAL = '1'; // mock systems run on 127.0.0.1

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { blockedAddress, createSourceHttp } = await import('../src/import/http.js');
const { znunyInternal } = await import('../src/import/znuny.js');
const { adfToText } = await import('../src/import/jira-text.js');

// Fake AI model: records what is sent
const aiCalls = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    aiCalls.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Antwort' } }] }));
  });
});

let server; let base; let db; let ctx; let cookie = '';

async function call(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function upload(name, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  const r = await fetch(`${base}/api/admin/import/csv/upload`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd });
  return { status: r.status, body: await r.json() };
}
async function waitJob() {
  for (let i = 0; i < 400; i++) {
    const { body } = await call('GET', '/api/admin/import/status');
    if (body.job && body.job.state !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import is stuck');
}
async function csvRun(file, csv, name, columns, targetKey = 'IT') {
  const up = await upload(file, csv);
  assert.equal(up.body.ok, true, JSON.stringify(up.body));
  const connection = { uploadId: up.body.uploadId, name, columns: columns || up.body.suggested };
  const s = await call('POST', '/api/admin/import/csv/start', { connection, projects: [{ key: '*', targetKey }] });
  assert.equal(s.status, 202, JSON.stringify(s.body));
  return waitJob();
}
const ticket = async (key) => (await call('GET', `/api/tickets/${key}`)).body.ticket;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

before(async () => {
  await listen(fakeAi);
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  server = await new Promise((r) => { const s = built.app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await call('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  assert.equal(s.status, 200);
});
after(async () => {
  await new Promise((r) => setTimeout(r, 100));
  server?.closeAllConnections(); server?.close(); fakeAi.closeAllConnections(); fakeAi.close(); db?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('SSRF: IPv4 embedded in IPv6 in any notation is checked as IPv4', () => {
  for (const a of ['::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1',
    '::7f00:1', '::ffff:0:7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1', '::', '::1', 'fe80::1', 'ff02::1']) {
    assert.equal(blockedAddress(a), true, a);
  }
  for (const a of ['::ffff:a00:a05', '::ffff:10.0.10.5', '64:ff9b::cb00:7104', '2001:db8::1', 'fd00::1', '10.0.10.5', '203.0.113.4']) {
    assert.equal(blockedAddress(a), false, a);
  }
});

test('SSRF: a URL with a hex IPv4-mapped loopback address is refused', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"reached":true}'); });
  await listen(srv);
  const { port } = srv.address();
  delete process.env.HELFI_IMPORT_ALLOW_LOCAL;
  try {
    for (const host of ['[::ffff:7f00:1]', '[::ffff:127.0.0.1]']) {
      const c = createSourceHttp({ baseUrl: `http://${host}:${port}` });
      await assert.rejects(c.json('/x'), (e) => e.status === 400 && /gesperrt/.test(e.message), host);
    }
  } finally {
    process.env.HELFI_IMPORT_ALLOW_LOCAL = '1';
    srv.close();
  }
});

test('Cross-origin redirect: credentials passed as request headers (GLPI login) are not forwarded', async () => {
  let seen = null;
  const other = http.createServer((req, res) => { seen = req.headers; res.setHeader('content-type', 'application/json'); res.end('{}'); });
  await listen(other);
  const source = http.createServer((req, res) => { res.statusCode = 302; res.setHeader('location', `http://localhost:${other.address().port}/elsewhere`); res.end(); });
  await listen(source);
  const c = createSourceHttp({ baseUrl: `http://127.0.0.1:${source.address().port}/apirest.php`, headers: () => ({ 'Session-Token': 'S' }) });
  await c.json('/initSession', { headers: { Authorization: 'user_token SECRET', 'App-Token': 'APP', 'X-Custom': 'c', Accept: 'application/json' }, withAuth: false });
  assert.ok(seen, 'redirect target reached');
  assert.equal(seen.authorization, undefined);
  assert.equal(seen['app-token'], undefined);
  assert.equal(seen['x-custom'], undefined);
  assert.equal(seen['session-token'], undefined);
  assert.equal(seen.accept, 'application/json', 'neutral headers still go along');
  // Same origin: the headers stay
  seen = null;
  const same = http.createServer((req, res) => {
    if (req.url === '/a') { res.statusCode = 302; res.setHeader('location', '/b'); return res.end(); }
    seen = req.headers; res.setHeader('content-type', 'application/json'); return res.end('{}');
  });
  await listen(same);
  await createSourceHttp({ baseUrl: `http://127.0.0.1:${same.address().port}` }).json('/a', { headers: { 'App-Token': 'APP' }, withAuth: false });
  assert.equal(seen['app-token'], 'APP');
  for (const x of [other, source, same]) { x.closeAllConnections(); x.close(); }
});

test('CSV re-import without "updated" column does not overwrite an already imported ticket or local edits', async () => {
  let job = await csvRun('export.csv', 'ID;Betreff;Beschreibung\n500;Drucker A;Original aus System 1\n', 'export');
  assert.equal(job.counts.created, 1);
  const p = await call('PATCH', '/api/tickets/IT-500', { description: 'Lokal ergänzt: wichtige Notiz' });
  assert.equal(p.status, 200);
  job = await csvRun('export.csv', 'ID;Betreff;Beschreibung\n500;Ganz anderes Ticket;System 2\n', 'export');
  assert.equal(job.counts.updated, 0);
  assert.equal(job.counts.unchanged, 1);
  const t = await ticket('IT-500');
  assert.equal(t.title, 'Drucker A');
  assert.equal(t.description, 'Lokal ergänzt: wichtige Notiz');
});

test('Import that updates a description keeps old and new text in the history (restorable)', async () => {
  let job = await csvRun('hist.csv', 'ID;Betreff;Beschreibung;Aktualisiert\n600;Laptop;Erste Fassung;2020-01-01 10:00\n', 'hist');
  assert.equal(job.counts.created, 1);
  job = await csvRun('hist.csv', 'ID;Betreff;Beschreibung;Aktualisiert\n600;Laptop;Zweite Fassung;2099-01-01 10:00\n', 'hist');
  assert.equal(job.counts.updated, 1, JSON.stringify(job));
  const t = await ticket('IT-600');
  assert.equal(t.description, 'Zweite Fassung');
  const rows = db.prepare("SELECT id, old_value, new_value FROM activity WHERE ticket_id=? AND field='description'").all(t.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].old_value, 'Erste Fassung');
  assert.equal(rows[0].new_value, 'Zweite Fassung');
});

test('CSV without ID column: identical rows become separate tickets, re-import stays idempotent', async () => {
  const csv = 'Betreff;Beschreibung\nPasswort vergessen;Bitte zurücksetzen\nPasswort vergessen;Bitte zurücksetzen\nAnderes;x\n';
  const count = () => db.prepare("SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key='DUP'").get().n;
  let job = await csvRun('dup.csv', csv, 'dup', undefined, 'DUP');
  assert.equal(job.counts.created, 3, JSON.stringify(job.counts));
  assert.equal(count(), 3);
  job = await csvRun('dup.csv', csv, 'dup', undefined, 'DUP');
  assert.equal(job.counts.created, 0);
  assert.equal(count(), 3);
});

test('Status/type names like Object.prototype members do not break the ticket', async () => {
  const job = await csvRun('proto.csv', 'Betreff;Status;Typ\nT1;constructor;x\nT2;offen;toString\nT3;__proto__;hasOwnProperty\n', 'proto',
    { title: 'Betreff', status: 'Status', type: 'Typ' }, 'PROTO');
  assert.equal(job.counts.failed, 0, JSON.stringify(job.errors));
  assert.equal(job.counts.created, 3);
});

test('Adapter error while reading: job and project end as failed, not running', async () => {
  const adapter = {
    sourceId: 'fake:abort', host: 'x', kind: 'fake', keyPrefix: 'F',
    count: async () => 3,
    async *tickets() {
      yield { extId: '1', extKey: '#1', title: 'ok 1' };
      throw new Error('HTTP 500 while listing');
    },
  };
  ctx.importer.start(adapter, { projects: [{ key: 'a', targetKey: 'FAB' }] }, 1);
  const job = await ctx.importer.wait();
  assert.equal(job.state, 'failed');
  assert.equal(job.counts.created, 1);
  assert.notEqual(job.projects[0].state, 'running');
  assert.equal(job.projects[0].state, 'failed');
  assert.equal(ctx.importer.running(), false);
});

test('Zammad: one ticket whose articles cannot be read counts as failed, the import goes on', async () => {
  const z = await startMockZammad();
  // Proxy in front of the mock: articles of ticket 11 answer HTTP 500
  const proxy = http.createServer((req, res) => {
    if (/\/ticket_articles\/by_ticket\/11$/.test(req.url)) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"boom"}'); }
    const up = http.request(`${z.url}${req.url}`, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    return req.pipe(up);
  });
  await listen(proxy);
  try {
    const s = await call('POST', '/api/admin/import/zammad/start', { connection: { baseUrl: `http://127.0.0.1:${proxy.address().port}`, token: 'zammad-token' }, projects: [{ key: '2', targetKey: 'ZF' }] });
    assert.equal(s.status, 202, JSON.stringify(s.body));
    const job = await waitJob();
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(job.counts.failed, 1);
    assert.equal(job.counts.created, 1, 'ticket 12 still imported');
    assert.ok(job.errors.some((e) => /#31011/.test(e) && /500/.test(e)), JSON.stringify(job.errors));
    assert.equal(job.projects[0].state, 'done');
  } finally { proxy.closeAllConnections(); proxy.close(); z.close(); }
});

test('Jira ADF: very deep nesting does not crash, the text is kept', () => {
  const doc = { type: 'doc', content: [] };
  let cur = doc;
  for (let i = 0; i < 20000; i++) { const k = { type: i % 2 ? 'blockquote' : 'paragraph', content: [] }; cur.content.push(k); cur = k; }
  cur.content.push({ type: 'text', text: 'ganz unten' });
  const text = adfToText(doc);
  assert.match(text, /ganz unten/);
  // Normal nesting is unchanged
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }] }), '- a');
});

test('Znuny/OTRS 5: article types ending in "-int" are internal', () => {
  for (const t of ['email-notification-int', 'note-int', 'phone-int', 'email-internal', 'note-internal', 'Note-Internal', 'EMAIL-NOTIFICATION-INT']) {
    assert.equal(znunyInternal({ ArticleType: t }), true, t);
  }
  for (const t of ['email-external', 'note-external', 'phone', 'email-notification-ext', 'webrequest']) {
    assert.equal(znunyInternal({ ArticleType: t }), false, t);
  }
  assert.equal(znunyInternal({ IsVisibleForCustomer: 1, ArticleType: 'note-int' }), false, 'Znuny 6+ flag wins');
});

test('AI: reply suggestion and article draft never contain internal notes, even with includeInternal on', async () => {
  const r = await call('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `http://127.0.0.1:${fakeAi.address().port}/v1`, 'ai.model': 'm', 'ai.reasoning': 'off', 'ai.includeInternal': true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const tk = (await call('POST', '/api/tickets', { title: 'VPN', description: 'VPN bricht ab.', type: 'incident' })).body.ticket;
  await call('POST', `/api/tickets/${tk.key}/comments`, { body: 'Öffentliche Antwort', internal: false });
  await call('POST', `/api/tickets/${tk.key}/comments`, { body: 'GEHEIME INTERNE NOTIZ', internal: true });
  const sent = () => aiCalls.at(-1).messages[1].content;

  assert.equal((await call('POST', `/api/tickets/${tk.key}/ai/reply`, { draft: '' })).status, 200);
  assert.ok(sent().includes('Öffentliche Antwort'));
  assert.ok(!sent().includes('GEHEIME INTERNE NOTIZ'), 'reply without internal note');

  assert.equal((await call('POST', `/api/tickets/${tk.key}/ai/kb-draft`)).status, 200);
  assert.ok(!sent().includes('GEHEIME INTERNE NOTIZ'), 'article draft without internal note');

  // Summaries still follow the setting
  assert.equal((await call('POST', `/api/tickets/${tk.key}/ai/summary`)).status, 200);
  assert.ok(sent().includes('GEHEIME INTERNE NOTIZ'), 'summary with internal note when switched on');
});
