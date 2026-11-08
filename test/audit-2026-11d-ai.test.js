// Audit 2026-11d (AI functions): capped AI response body, timeout while the body arrives, backfill
// reaches older tickets beyond the scan window, backfill stops after failures in a row, duplicate
// candidates filtered before the search limit, pending duplicate hints settled when a ticket closes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers/server.js';

// Fake model, controlled by markers in the last message:
//  "huge"  → a 3 MB answer      "stall" → headers, then the body never ends
//  "-> X"  → component X ("fail" = HTTP 500)      "dup-> KEY" → duplicate KEY
const calls = [];
const open = new Set();
const fake = http.createServer((req, res) => {
  open.add(res);
  res.on('close', () => open.delete(res));
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    calls.push(json);
    const user = json.messages?.at(-1)?.content || '';
    if (/\bhuge\b/.test(user)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(3 * 1024 * 1024) } }] }));
      return;
    }
    if (/\bstall\b/.test(user)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"choices":'); return; }
    const dup = /dup->\s*(\S+)/.exec(user)?.[1];
    if (dup) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `{"duplicate": "${dup}", "reason": "same"}` } }] }));
      return;
    }
    const want = /->\s*([^\n]+)/.exec(user)?.[1]?.trim();
    if (want === 'fail') { res.writeHead(500); res.end('{}'); return; }
    const content = !want || want === 'none' ? '{"component": null, "reason": "none"}' : `{"component": "${want}", "reason": "fits"}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

let S; let admin; let anna; let karl;
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await startServer('audit-d-ai');
  admin = S.admin;
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  await admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `http://127.0.0.1:${fake.address().port}/v1`, 'ai.model': 'test-model', 'ai.reasoning': 'off' } });
});
after(async () => { for (const r of open) r.destroy(); await S?.stop(); fake.close(); });

const newProject = async (key) => (await admin('POST', '/api/projects', { key, name: key })).body.project;
const mk = async (title, projectId, description = '') => (await karl('POST', '/api/tickets', { title, description, projectId })).body.ticket;
const idOf = (key) => S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(key).id;

test('AI answer larger than the cap is refused (502) instead of being buffered completely', async () => {
  const cfg = S.ctx.ai.config();
  await assert.rejects(S.ctx.ai.chat([{ role: 'user', content: 'huge' }], { cfg }), (e) => e.status === 502);
});

test('timeout while the AI answer body is still arriving gives 504 err.aiTimeout', async () => {
  const cfg = { ...S.ctx.ai.config(), timeoutMs: 300 };
  await assert.rejects(S.ctx.ai.chat([{ role: 'user', content: 'stall' }], { cfg }), (e) => e.status === 504 && /aiTimeout/.test(e.code || e.message));
});

test('backfill reaches older tickets although the newest 20000 were already asked', async () => {
  const p = await newProject('OLD');
  await admin('POST', `/api/projects/${p.id}/components`, { name: 'VPN', keywords: 'forticlient' });
  const oldest = await mk('Oldest ticket nobody asked about', p.id);
  const tpl = S.db.prepare('SELECT * FROM tickets WHERE id=?').get(oldest.id);
  const ins = S.db.prepare('INSERT INTO tickets(project_id, number, title, description, type, status, priority, reporter_id) VALUES (?,?,?,?,?,?,?,?)');
  const sug = S.db.prepare("INSERT INTO component_suggestions(ticket_id, state) VALUES (?, 'none')");
  S.db.transaction(() => {
    for (let i = 0; i < 20000; i++) {
      const id = ins.run(p.id, 1000 + i, `Asked ticket ${i}`, '', tpl.type, tpl.status, tpl.priority, tpl.reporter_id).lastInsertRowid;
      sug.run(id);
    }
  })();
  await admin('PUT', '/api/admin/settings', { settings: { 'ai.classify': true } });
  const pv = (await admin('GET', `/api/admin/components/backfill?project=${p.id}`)).body;
  await admin('PUT', '/api/admin/settings', { settings: { 'ai.classify': false } });
  assert.equal(pv.total, 20001, 'real number of tickets without component');
  assert.equal(pv.skipped, 20000);
  assert.equal(pv.ai, 1, 'the oldest, never asked ticket goes to the AI');
});

test('backfill stops after 5 AI failures in a row, even after many successes', async () => {
  const p = await newProject('FAIL');
  for (let i = 0; i < 15; i++) await mk(`Broken ${i} -> fail`, p.id);
  for (let i = 0; i < 20; i++) await mk(`Works ${i} -> VPN`, p.id);
  await admin('POST', `/api/projects/${p.id}/components`, { name: 'VPN', keywords: 'forticlient' });
  await admin('PUT', '/api/admin/settings', { settings: { 'ai.classify': true, 'ai.classifyMode': 'suggest' } });
  calls.length = 0;
  const r = await admin('POST', '/api/admin/components/backfill', { project: p.id, mode: 'suggest' });
  assert.equal(r.status, 200);
  await S.ctx.aiClassifier.backfillIdle();
  await admin('PUT', '/api/admin/settings', { settings: { 'ai.classify': false } });
  const st = (await admin('GET', '/api/admin/components/backfill/status')).body.run;
  assert.equal(st.suggested, 20);
  assert.equal(st.failed, 5, 'stopped after five failures in a row');
  assert.equal(st.error, 'aiFailing');
  assert.equal(calls.length, 25);
});

test('duplicate candidates: closed tickets with better matches do not push the open one out', async () => {
  const p = await newProject('DUP');
  const orig = await mk('Plotter Raum 7 Papierstau', p.id, 'plotter jammed');
  // 45 done tickets that match the words much better (title repeated) – they used to fill the search limit
  for (let i = 0; i < 45; i++) {
    const t = await mk('Plotter Plotter Papierstau Papierstau Raum Raum', p.id, 'plotter papierstau raum');
    S.db.prepare("UPDATE tickets SET status='done' WHERE id=?").run(t.id);
  }
  await admin('PUT', '/api/admin/settings', { settings: { 'ai.duplicates': true } });
  calls.length = 0;
  const neu = await mk('Plotter Raum 7 Papierstau wieder', p.id, `dup-> ${orig.key}`);
  await new Promise((r) => setTimeout(r, 40)); await S.ctx.aiDuplicates.idle();
  const s = S.db.prepare('SELECT * FROM duplicate_suggestions WHERE ticket_id=?').get(neu.id);
  assert.ok(s, 'the AI was asked');
  assert.equal(s.state, 'pending');
  assert.equal(s.original_id, orig.id);
});

test('pending duplicate hint is settled (not left pending) when the ticket is closed normally', async () => {
  await admin('PUT', '/api/admin/settings', { settings: { 'ai.duplicates': false } });
  const p = await newProject('SET');
  const a = await mk('Monitor flackert', p.id);
  const b = await mk('Monitor flackert wieder', p.id);
  S.db.prepare("INSERT OR REPLACE INTO duplicate_suggestions(ticket_id, original_id, state) VALUES (?,?,'pending')").run(b.id, a.id);
  const key = b.key;
  const before = S.ctx.aiDuplicates.stats().pending;
  assert.equal((await anna('PATCH', `/api/tickets/${key}`, { status: 'done' })).status, 200);
  await new Promise((r) => setTimeout(r, 40));
  const s = S.db.prepare('SELECT * FROM duplicate_suggestions WHERE ticket_id=?').get(idOf(key));
  assert.equal(s.state, 'none');
  assert.equal(s.decided_by, S.ids.anna, 'the closing agent is recorded');
  assert.equal(S.ctx.aiDuplicates.stats().pending, before - 1);
});
