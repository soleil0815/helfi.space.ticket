// Sorting existing tickets without component afterwards: rules first, then the AI (fake model),
// suggestions to review in bulk; no assignment, no "updated" change, no mails; admins only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers/server.js';

// Fake model: picks the component named after "->" in the title ("none" = nothing fits, "fail" = error)
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    calls.push(json);
    const user = json.messages?.[1]?.content || '';
    const want = /->\s*([^\n]+)/.exec(user)?.[1]?.trim();
    if (want === 'fail') { res.writeHead(500); res.end('{}'); return; }
    const content = want === 'none' ? '{"component": null, "reason": "passt nirgends"}' : `{"component": "${want}", "reason": "passt"}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

let S; let anna; let karl; let admin; let project; let vpn; let printer;
const sent = [];
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await startServer('aibackfill');
  admin = S.admin;
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  project = (await admin('GET', '/api/projects')).body.projects[0];
});
after(async () => { await S?.stop(); fake.close(); });

const ticket = async (key) => (await admin('GET', `/api/tickets/${key}`)).body.ticket;
const raw = (key) => S.db.prepare("SELECT t.* FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(key);
const preview = async (q = '') => (await admin('GET', `/api/admin/components/backfill?project=${project.id}${q}`)).body;
const finished = () => S.ctx.aiClassifier.backfillIdle();

let keys = {};
test('setup: old tickets without component, then components are added', async () => {
  const mk = async (title, extra = {}) => (await karl('POST', '/api/tickets', { title, ...extra })).body.ticket.key;
  keys = {
    rule: await mk('FortiClient verbindet nicht'), // keyword rule
    ai: await mk('Kein Zugang von zuhause -> VPN'),
    none: await mk('Kaffeemaschine -> none'),
    done: await mk('Alter Fall -> Drucker'),
  };
  S.db.prepare("UPDATE tickets SET status='done' WHERE id=?").run(raw(keys.done).id);
  S.db.prepare("UPDATE tickets SET updated_at='2025-01-01T00:00:00.000Z'").run();
  vpn = (await admin('POST', `/api/projects/${project.id}/components`, { name: 'VPN', keywords: 'forticlient', leadId: S.ids.anna })).body.component;
  printer = (await admin('POST', `/api/projects/${project.id}/components`, { name: 'Drucker', keywords: 'toner', leadId: S.ids.anna })).body.component;
  for (const k of Object.values(keys)) assert.equal(raw(k).component_id, null);
});

test('admins only; without AI only the rules run', async () => {
  assert.equal((await anna('GET', `/api/admin/components/backfill?project=${project.id}`)).status, 403);
  assert.equal((await anna('POST', '/api/admin/components/backfill', { project: project.id })).status, 403);
  const p = await preview('&includeDone=0');
  assert.equal(p.aiOn, false);
  assert.deepEqual([p.total, p.rules, p.ai, p.remaining], [3, 1, 0, 2], 'open tickets only');
  assert.equal((await preview()).total, 3, 'open tickets only by default');
  assert.equal((await preview('&includeDone=1')).total, 4, 'done ones only on request');
});

test('run with AI in suggest mode: rules applied, suggestions saved, nothing assigned, no mails, updated time kept', async () => {
  await admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `http://127.0.0.1:${fake.address().port}/v1`, 'ai.model': 'test-model', 'ai.reasoning': 'off', 'ai.classify': true, 'ai.classifyMode': 'auto' } });
  const p = await preview('&includeDone=0');
  assert.deepEqual([p.rules, p.ai, p.skipped], [1, 2, 0]);
  sent.length = 0;
  const r = await admin('POST', '/api/admin/components/backfill', { project: project.id, mode: 'suggest', includeDone: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.rules, 1);
  assert.equal((await admin('POST', '/api/admin/components/backfill', { project: project.id })).status === 409 || r.body.run.total === 0, true);
  await finished();
  const st = (await admin('GET', '/api/admin/components/backfill/status')).body.run;
  assert.equal(st.running, false);
  assert.deepEqual([st.done, st.suggested, st.none, st.auto], [2, 1, 1, 0], 'suggest overrides the auto setting');

  const rule = raw(keys.rule);
  assert.equal(rule.component_id, vpn.id);
  assert.equal(rule.assignee_id, null, 'no lead assignment afterwards');
  assert.equal(rule.updated_at, '2025-01-01T00:00:00.000Z', 'updated time kept');
  const act = (await ticket(keys.rule)).activity.find((a) => a.action === 'classified');
  assert.equal(act.field, 'keywords');
  assert.equal(raw(keys.ai).component_id, null, 'only suggested');
  assert.equal(sent.length, 0, 'no mails');
  assert.equal(raw(keys.done).component_id, null, 'done tickets untouched');
});

test('review list: agents accept in bulk; accepting a backfill suggestion assigns nobody', async () => {
  assert.equal((await karl('GET', '/api/component-suggestions')).status, 403);
  const list = (await anna('GET', `/api/component-suggestions?project=${project.id}`)).body.suggestions;
  assert.deepEqual(list.map((s) => [s.key, s.component.name, s.backfill]), [[keys.ai, 'VPN', true]]);
  const r = await anna('POST', '/api/component-suggestions/decide', { keys: [keys.ai, 'IT-9999'], action: 'accept' });
  assert.equal(r.body.done, 1);
  assert.equal(r.body.failed.length, 1);
  const row = raw(keys.ai);
  assert.equal(row.component_id, vpn.id);
  assert.equal(row.assignee_id, null);
  assert.equal(row.updated_at, '2025-01-01T00:00:00.000Z');
  assert.equal((await anna('GET', `/api/component-suggestions?project=${project.id}`)).body.suggestions.length, 0);
  assert.equal((await anna('POST', '/api/component-suggestions/decide', { keys: [], action: 'delete' })).status, 400);
  const stats = (await admin('GET', '/api/admin/ai/stats')).body.classify;
  assert.equal(stats.accepted, 1);
});

test('already asked tickets are skipped unless retry; auto mode with done tickets', async () => {
  const p = await preview('&includeDone=1');
  assert.deepEqual([p.rules, p.ai, p.skipped], [0, 1, 1], '"none" is skipped, done ticket is new');
  calls.length = 0;
  await admin('POST', '/api/admin/components/backfill', { project: project.id, mode: 'auto' });
  await finished();
  assert.equal(calls.length, 1, 'only the done ticket went to the AI');
  const done = raw(keys.done);
  assert.equal(done.component_id, printer.id);
  assert.equal(done.assignee_id, null);
  assert.equal(done.status, 'done');
  assert.equal((await preview('&includeDone=1&retry=1')).ai, 1, 'retry asks the "none" ticket again');
});

test('cancel stops the AI part; a failing AI stops the run', async () => {
  const many = [];
  for (let i = 0; i < 8; i++) many.push((await karl('POST', '/api/tickets', { title: `Fehler ${i} -> fail` })).body.ticket.key);
  await finished();
  const r = await admin('POST', '/api/admin/components/backfill', { project: project.id });
  assert.ok(r.body.run.total >= 8);
  await finished();
  const st = (await admin('GET', '/api/admin/components/backfill/status')).body.run;
  assert.equal(st.cancelled, true);
  assert.equal(st.error, 'aiFailing');
  assert.ok(st.done < st.total, 'stopped early');
  // cancel
  S.db.prepare("UPDATE tickets SET title='x -> none' WHERE title LIKE 'Fehler %'").run();
  await admin('POST', '/api/admin/components/backfill', { project: project.id, retry: true });
  const c = (await admin('POST', '/api/admin/components/backfill/cancel')).body.run;
  assert.ok(c);
  await finished();
  const st2 = (await admin('GET', '/api/admin/components/backfill/status')).body.run;
  assert.equal(st2.cancelled, true);
  assert.ok(st2.done < st2.total);
});
