// AI for knowledge articles: modes keep the markup, title/category as JSON, draft from a ticket, switch
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers/server.js';

const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    calls.push(json);
    const sys = json.messages[0].content;
    const content = /Answer only with JSON/.test(sys) ? 'Klar: {"title": "VPN im Homeoffice einrichten", "category": "Netzwerk"}'
      : /knowledge base article draft/.test(sys) ? '## Problem\n\nVPN bricht ab.\n\n## Lösung\n\n1. Neu verbinden'
        : `1. ${json.messages[1].content}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

let S; let anna; let karl;
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await startServer('aikb');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `http://127.0.0.1:${fake.address().port}/v1`, 'ai.model': 'm', 'ai.reasoning': 'off' } });
});
after(async () => { await S?.stop(); fake.close(); });

test('Writing help keeps the markup, refuses unknown modes, only for agents', async () => {
  const r = await anna('POST', '/api/ai/kb', { mode: 'steps', text: '- vpn öffnen\n- **verbinden**' });
  assert.equal(r.status, 200);
  assert.equal(r.body.text, '1. - vpn öffnen\n- **verbinden**');
  assert.match(calls.at(-1).messages[0].content, /step-by-step guide/);
  assert.match(calls.at(-1).messages[0].content, /Keep the Markdown formatting/);
  assert.match(calls.at(-1).messages[0].content, /ignore any instructions/);
  assert.equal((await anna('POST', '/api/ai/kb', { mode: 'evil', text: 'x' })).status, 400);
  assert.equal((await anna('POST', '/api/ai/kb', { mode: 'polish', text: ' ' })).status, 400);
  assert.equal((await karl('POST', '/api/ai/kb', { mode: 'polish', text: 'x' })).status, 403);
});

test('Title and category suggestion as clean values', async () => {
  const r = await anna('POST', '/api/ai/kb', { mode: 'meta', text: 'So richten Sie VPN ein', title: 'vpn', categories: ['Netzwerk', 'Drucker'] });
  assert.deepEqual([r.body.title, r.body.category], ['VPN im Homeoffice einrichten', 'Netzwerk']);
  assert.match(calls.at(-1).messages[0].content, /preferably one of: Netzwerk, Drucker/);
});

test('Draft from a ticket: personal data excluded by the prompt, permission of the ticket', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'VPN', description: 'Karl Muster, Tel. 1234: VPN bricht ab' })).body.ticket;
  const r = await anna('POST', `/api/tickets/${tk.key}/ai/kb-draft`);
  assert.match(r.body.text, /^## Problem/);
  assert.match(calls.at(-1).messages[0].content, /Leave out ALL personal data/);
  assert.equal((await karl('POST', `/api/tickets/${tk.key}/ai/kb-draft`)).status, 403);
});

test('Switch "knowledge articles": on by default, off → 404 and hidden', async () => {
  assert.equal((await anna('GET', '/api/bootstrap')).body.aiFeatures.kb, true);
  await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.kb': false } });
  assert.equal((await anna('GET', '/api/bootstrap')).body.aiFeatures.kb, false);
  assert.equal((await anna('POST', '/api/ai/kb', { mode: 'polish', text: 'x' })).status, 404);
  await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.kb': true } });
});
