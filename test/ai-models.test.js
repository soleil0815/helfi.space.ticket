// AI settings: installed models of the server (Ollama with details, OpenAI-compatible lists, errors)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers/server.js';

let isEmbeddingModel; let listModels;

let S; let admin; let anna;
const calls = [];
const servers = [];
async function fake(handler) {
  const srv = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization || '' });
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    handler(req, send);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

let ollama; let openai; let locked; let broken;
before(async () => {
  S = await startServer('aimodels'); // sets the data folder before src/ is loaded
  ({ isEmbeddingModel, listModels } = await import('../src/ai.js'));
  admin = S.admin;
  anna = await S.user('anna', 'agent');
  ollama = await fake((req, send) => {
    if (req.url === '/api/tags') {
      return send(200, { models: [
        { name: 'qwen3:14b', size: 9_276_198_565, details: { parameter_size: '14.8B', quantization_level: 'Q4_K_M', family: 'qwen3', families: ['qwen3'] } },
        { name: 'gpt-oss:120b-cloud', size: 384, remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b', details: { parameter_size: '116.8B', quantization_level: 'MXFP4' } },
        { name: 'nomic-embed-text:latest', size: 274_302_450, details: { parameter_size: '137M', family: 'nomic-bert', families: ['nomic-bert'] } },
        { name: 'gemma3:4b', size: 3_338_801_804, details: { parameter_size: '4.3B', quantization_level: 'Q4_K_M' } },
      ] });
    }
    if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'qwen3:14b' }, { id: 'gpt-oss:120b-cloud' }, { id: 'nomic-embed-text:latest' }, { id: 'gemma3:4b' }] });
    return send(404, '404 page not found');
  });
  openai = await fake((req, send) => {
    if (req.url === '/v1/models') return req.headers.authorization === 'Bearer sk-test' ? send(200, { data: [{ id: 'mistral-small-3.2' }, { id: 'text-embedding-3-small' }, { id: 'llama-3.3-70b' }] }) : send(401, { error: { message: 'invalid api key' } });
    return send(404, { error: 'not found' });
  });
  locked = await fake((req, send) => send(401, { error: 'unauthorized' }));
  broken = await fake((req, send) => send(500, 'oops'));
});
after(async () => { for (const s of servers) s.close(); await S?.stop(); });

test('Embedding models are recognised', () => {
  for (const n of ['nomic-embed-text:latest', 'mxbai-embed-large', 'text-embedding-3-small', 'bge-m3', 'all-minilm', 'snowflake-arctic-embed2', 'jina-reranker-v2']) assert.equal(isEmbeddingModel(n), true, n);
  for (const n of ['qwen3:14b', 'gpt-oss:20b', 'llama3.1:8b', 'mistral-small-3.2', 'deepseek-r1:14b', 'gemma3:4b']) assert.equal(isEmbeddingModel(n), false, n);
  assert.equal(isEmbeddingModel('my-model', ['nomic-bert']), true, 'by family');
});

test('Ollama: details, cloud models last and marked, embeddings hidden', async () => {
  const r = await listModels({ baseUrl: `${ollama}/v1/` });
  assert.equal(r.source, 'ollama');
  assert.equal(r.hidden, 1);
  assert.deepEqual(r.models.map((m) => [m.id, m.cloud]), [['gemma3:4b', false], ['qwen3:14b', false], ['gpt-oss:120b-cloud', true]]);
  assert.deepEqual(r.models[1], { id: 'qwen3:14b', params: '14.8B', quant: 'Q4_K_M', size: '9.3 GB', cloud: false });
  assert.equal(r.models[2].size, '', 'no local size for cloud models');
});

test('OpenAI-compatible server: names only, key is sent', async () => {
  const r = await listModels({ baseUrl: `${openai}/v1`, apiKey: 'sk-test' });
  assert.equal(r.source, 'openai');
  assert.deepEqual(r.models.map((m) => m.id), ['llama-3.3-70b', 'mistral-small-3.2']);
  assert.equal(r.hidden, 1);
  assert.equal(calls.filter((c) => c.url === '/v1/models').at(-1).auth, 'Bearer sk-test');
});

test('Admin endpoint: form values, understandable errors, stored key only for its own address, agents not allowed', async () => {
  let r = await admin('POST', '/api/admin/ai/models', { settings: { 'ai.baseUrl': `${ollama}/v1` } });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.models.length, 3);
  r = await admin('POST', '/api/admin/ai/models', { settings: { 'ai.baseUrl': `${locked}/v1` } });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /API key|API-Schlüssel/);
  r = await admin('POST', '/api/admin/ai/models', { settings: { 'ai.baseUrl': `${broken}/v1` } });
  assert.match(r.body.error, /model list|Modellliste/);
  r = await admin('POST', '/api/admin/ai/models', { settings: { 'ai.baseUrl': 'http://127.0.0.1:1/v1' } });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /cannot be reached|nicht erreichbar/);
  r = await admin('POST', '/api/admin/ai/models', { settings: { 'ai.baseUrl': 'file:///etc/passwd' } });
  assert.equal(r.body.ok, false);

  // Stored key: used for its own address, never for another one
  assert.equal((await admin('PUT', '/api/admin/settings', { settings: { 'ai.baseUrl': `${openai}/v1`, 'ai.apiKey': 'sk-test' } })).status, 200);
  r = await admin('POST', '/api/admin/ai/models', { settings: {} });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  await admin('POST', '/api/admin/ai/models', { settings: { 'ai.baseUrl': `${ollama}/v1` } });
  assert.equal(calls.at(-1).auth, '', 'stored key not sent to another server');

  assert.equal((await anna('POST', '/api/admin/ai/models', { settings: {} })).status, 403);
});
