// Tests: AI assistance (OpenAI-compatible endpoint, here a fake server)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-ai-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { cleanAnswer, looksRemote, ticketContext, normalizeBaseUrl } = await import('../src/ai.js');

// ---------- Fake model server ----------
const calls = [];
let mode = 'ok';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    calls.push({ url: req.url, auth: req.headers.authorization || '', body: json });
    if (mode === 'noReasoning' && json.reasoning_effort) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Unrecognized request argument: reasoning_effort' } }));
    }
    if (mode === 'error') { res.writeHead(500); return res.end('boom'); }
    if (mode === 'slow') return setTimeout(() => res.end('{}'), 3000);
    const sys = json.messages?.[0]?.content || '';
    const content = sys.includes('Summarize') ? '<think>hmm</think>**Worum es geht**\n- Drucker druckt nicht'
      : sys.includes('single word OK') ? 'OK'
        : sys.includes('write a reply') ? 'Bitte starten Sie den Drucker neu.'
          : `REWRITTEN: ${json.messages[1].content}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, reasoning: 'internal thoughts' } }] }));
  });
});

let server; let base; let db; let ctx; let fakeUrl;
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`;
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fake.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const headers = { Accept: 'application/json', 'X-Helfi-Request': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const admin = client();
const PW = 'Sehrgeheim123';
let key;

test('Setup and a ticket with a public comment and an internal note', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: PW, email: 'admin@firma.example', projectKey: 'IT', projectName: 'IT' })).status, 200);
  const r = await admin('POST', '/api/tickets', { title: 'Drucker', description: 'Der Drucker im 2. OG druckt nicht.', type: 'incident' });
  key = r.body.ticket.key;
  await admin('POST', `/api/tickets/${key}/comments`, { body: 'Schon neu gestartet?', internal: false });
  await admin('POST', `/api/tickets/${key}/comments`, { body: 'GEHEIME INTERNE NOTIZ', internal: true });
});

test('Off by default: nothing offered, endpoints refuse', async () => {
  assert.equal((await admin('GET', '/api/bootstrap')).body.ai, false);
  assert.equal((await admin('POST', `/api/tickets/${key}/ai/summary`)).status, 404);
  assert.equal(calls.length, 0);
});

test('Admin settings: address checked, key stored encrypted and only as placeholder', async () => {
  assert.equal((await admin('PUT', '/api/admin/settings', { settings: { 'ai.baseUrl': 'ftp://x' } })).status, 400);
  assert.equal((await admin('PUT', '/api/admin/settings', { settings: { 'ai.baseUrl': 'http://user:pw@host/v1' } })).status, 400);
  assert.equal((await admin('PUT', '/api/admin/settings', { settings: { 'ai.reasoning': 'max' } })).status, 400);
  const r = await admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `${fakeUrl}/`, 'ai.model': 'gpt-oss:120b-cloud', 'ai.apiKey': 'sk-geheim' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings['ai.apiKey'], '••••••••');
  assert.equal(r.body.settings['ai.baseUrl'], fakeUrl, 'trailing slash removed');
  const row = db.prepare("SELECT value, secret FROM settings WHERE key='ai.apiKey'").get();
  assert.equal(row.secret, 1);
  assert.ok(!row.value.includes('sk-geheim'));
  assert.equal((await admin('GET', '/api/bootstrap')).body.ai, true);
});

test('Connection test from the admin page', async () => {
  const r = await admin('POST', '/api/admin/ai/test', { settings: {} });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.answer, 'OK');
  assert.equal(r.body.remote, true, 'cloud model is pointed out');
  assert.equal(calls.at(-1).auth, 'Bearer sk-geheim');
  assert.equal(calls.at(-1).url, '/v1/chat/completions');
  assert.equal(calls.at(-1).body.reasoning_effort, 'low');
  // Another address: the stored key is not sent there
  await admin('POST', '/api/admin/ai/test', { settings: { 'ai.baseUrl': `http://127.0.0.1:${fake.address().port}/other` } });
  assert.equal(calls.at(-1).url, '/other/chat/completions');
  assert.equal(calls.at(-1).auth, '', 'key not sent to a changed address');
});

test('Summary: stored, think block removed, internal notes left out by default, outdated after a new comment', async () => {
  const r = await admin('POST', `/api/tickets/${key}/ai/summary`);
  assert.equal(r.status, 200);
  assert.equal(r.body.summary.text, '**Worum es geht**\n- Drucker druckt nicht');
  const sent = calls.at(-1).body.messages[1].content;
  assert.ok(sent.includes('druckt nicht') && sent.includes('Schon neu gestartet?'));
  assert.ok(!sent.includes('GEHEIME INTERNE NOTIZ'), 'internal note not sent');
  let g = await admin('GET', `/api/tickets/${key}/ai/summary`);
  assert.equal(g.body.summary.outdated, false);
  await admin('POST', `/api/tickets/${key}/comments`, { body: 'Toner leer.', internal: false });
  g = await admin('GET', `/api/tickets/${key}/ai/summary`);
  assert.equal(g.body.summary.outdated, true);
  // Internal notes only when switched on
  ctx.settings.set('ai.includeInternal', true);
  await admin('POST', `/api/tickets/${key}/ai/summary`);
  assert.ok(calls.at(-1).body.messages[1].content.includes('GEHEIME INTERNE NOTIZ'));
  ctx.settings.set('ai.includeInternal', false);
});

test('Reply suggestion and rewrite', async () => {
  const r = await admin('POST', `/api/tickets/${key}/ai/reply`, { draft: 'Toner bestellt' });
  assert.equal(r.body.text, 'Bitte starten Sie den Drucker neu.');
  assert.ok(calls.at(-1).body.messages[1].content.includes('Toner bestellt'));
  assert.match(calls.at(-1).body.messages[0].content, /admin/);
  const w = await admin('POST', '/api/ai/rewrite', { text: 'mach ma neu starten', mode: 'polish' });
  assert.equal(w.body.text, 'REWRITTEN: mach ma neu starten');
  assert.equal((await admin('POST', '/api/ai/rewrite', { text: 'x', mode: 'evil' })).status, 400);
  assert.equal((await admin('POST', '/api/ai/rewrite', { text: '', mode: 'polish' })).status, 400);
});

test('Server without reasoning_effort: retried without it; errors are reported', async () => {
  mode = 'noReasoning';
  const r = await admin('POST', '/api/ai/rewrite', { text: 'hallo', mode: 'en' });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).body.reasoning_effort, undefined);
  mode = 'error';
  const e = await admin('POST', '/api/ai/rewrite', { text: 'hallo', mode: 'en' });
  assert.equal(e.status, 502);
  assert.equal(e.body.error.code, 'err.aiFailed');
  mode = 'ok';
});

test('Requesters cannot use it', async () => {
  const u = ctx.users.createLocal({ username: 'eva', displayName: 'Eva', password: PW, role: 'user', email: 'eva@firma.example' });
  const eva = client();
  assert.equal((await eva('POST', '/api/auth/login', { username: 'eva', password: PW })).status, 200);
  assert.equal((await eva('GET', '/api/bootstrap')).body.ai, false);
  assert.equal((await eva('POST', `/api/tickets/${key}/ai/summary`)).status, 403);
  assert.equal((await eva('POST', '/api/ai/rewrite', { text: 'x', mode: 'polish' })).status, 403);
  assert.ok(u.id);
});

test('Helpers: think blocks, remote detection, context shortening', () => {
  assert.equal(normalizeBaseUrl(' http://ollama:11434/v1/// '), 'http://ollama:11434/v1');
  // No regex backtracking: many slashes followed by another character stay fast
  const start = Date.now();
  normalizeBaseUrl(`http://x/${'/'.repeat(100000)}x`);
  assert.ok(Date.now() - start < 200);
  assert.equal(cleanAnswer('<think>a\nb</think>\n Antwort '), 'Antwort');
  assert.equal(cleanAnswer('reasoning…</think>Antwort'), 'Antwort');
  assert.equal(looksRemote('http://ollama:11434/v1', 'llama3'), false);
  assert.equal(looksRemote('http://10.0.10.5:11434/v1', 'qwen3:14b'), false);
  assert.equal(looksRemote('http://ollama.firma.local/v1', 'gpt-oss:120b-cloud'), true);
  assert.equal(looksRemote('https://api.openai.com/v1', 'gpt-4o-mini'), true);
  const tk = { key: 'IT-1', title: 'T', type: 'incident', status: 'open', priority: 'medium', description: 'D', reporter: { id: 1, displayName: 'R' },
    comments: Array.from({ length: 50 }, (_, i) => ({ createdAt: '2026-11-05T10:00:00Z', author: { id: 2, displayName: 'A' }, body: `Kommentar ${i} ${'x'.repeat(400)}`, internal: false })) };
  const c = ticketContext(tk, { includeInternal: false, maxChars: 3000 });
  assert.ok(c.length <= 3200);
  assert.ok(c.includes('Kommentar 49'), 'newest kept');
  assert.ok(!c.includes('Kommentar 0 '), 'oldest dropped');
  assert.match(c, /older comment\(s\) left out/);
});
