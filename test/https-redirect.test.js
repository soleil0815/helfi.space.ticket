// http:// → https:// behind a reverse proxy (X-Forwarded-Proto from a trusted proxy) and HSTS from one place only
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { startServer } from './helpers/server.js';

// startServer prepares the environment (data folder, secret) before the app modules are loaded
const S = await startServer('https-redirect');
const { httpsRedirectMiddleware, hstsOption, applyTrustProxy } = await import('../src/app.js');
after(() => S.stop());

async function serve(baseUrl, trust = 'loopback') {
  const app = express();
  applyTrustProxy(app, trust);
  const mw = httpsRedirectMiddleware(app, baseUrl);
  if (mw) app.use(mw);
  app.all('/{*rest}', (req, res) => res.json({ ok: true, path: req.originalUrl }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', headers = {} } = {}) => fetch(base + path, { method, headers, redirect: 'manual' });
  return { call, close: () => server.close(), mw };
}

test('Proxy says http → permanent redirect to the https:// address from HELFI_BASE_URL', async () => {
  const s = await serve('https://helfi.firma.local');
  let r = await s.call('/issues?q=Drucker&page=2', { headers: { 'X-Forwarded-Proto': 'http' } });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://helfi.firma.local/issues?q=Drucker&page=2');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await s.call('/m/', { method: 'HEAD', headers: { 'X-Forwarded-Proto': 'http' } });
  assert.equal(r.status, 301);
  // Other methods keep their method and body
  r = await s.call('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Proto': 'http' } });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), 'https://helfi.firma.local/api/auth/login');
  // several proxies: the first value counts
  r = await s.call('/', { headers: { 'X-Forwarded-Proto': 'HTTP, https' } });
  assert.equal(r.status, 301);
  s.close();
});

test('No redirect for https, without the header, for /healthz and from untrusted senders', async () => {
  const s = await serve('https://helfi.firma.local');
  assert.equal((await s.call('/', { headers: { 'X-Forwarded-Proto': 'https' } })).status, 200);
  assert.equal((await s.call('/')).status, 200, 'direct access to port 8080 as before');
  assert.equal((await s.call('/healthz', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 200, 'docker health check');
  s.close();
  // The request does not come from a trusted proxy → a spoofed header changes nothing
  const u = await serve('https://helfi.firma.local', '10.0.10.5');
  assert.equal((await u.call('/', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 200);
  u.close();
});

test('No open redirect: target never from the Host header or a "//" path', async () => {
  const s = await serve('https://helfi.firma.local');
  let r = await s.call('/login', { headers: { 'X-Forwarded-Proto': 'http', Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' } });
  assert.equal(r.headers.get('location'), 'https://helfi.firma.local/login');
  r = await s.call('//evil.example/x', { headers: { 'X-Forwarded-Proto': 'http' } });
  assert.equal(r.status, 301);
  assert.ok(r.headers.get('location').startsWith('https://helfi.firma.local/'), r.headers.get('location'));
  assert.ok(!r.headers.get('location').startsWith('https://helfi.firma.local//'));
  s.close();
});

test('Base address with a path and with a port; http:// base address → no redirect at all', async () => {
  const p = await serve('https://firma.example:8443/helfi');
  const r = await p.call('/issues', { headers: { 'X-Forwarded-Proto': 'http' } });
  assert.equal(r.headers.get('location'), 'https://firma.example:8443/helfi/issues');
  p.close();
  const h = await serve('http://helfi.firma.local');
  assert.equal(h.mw, null);
  assert.equal((await h.call('/', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 200);
  h.close();
});

test('HSTS: on by default with https://, off for the proxy, preload on request, never with http://', () => {
  assert.deepEqual(hstsOption('https://helfi.firma.local', 'on'), { maxAge: 31536000, includeSubDomains: true, preload: false });
  assert.deepEqual(hstsOption('https://helfi.firma.local', 'preload'), { maxAge: 31536000, includeSubDomains: true, preload: true });
  assert.equal(hstsOption('https://helfi.firma.local', 'off'), false);
  assert.equal(hstsOption('http://helfi.firma.local', 'on'), false);
  // HELFI_HSTS values
  const read = (v) => spawnSync(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./src/config.js'); process.stdout.write(config.hsts);"], { env: { ...process.env, HELFI_HSTS: v }, encoding: 'utf8' }).stdout;
  assert.equal(read(''), 'on');
  assert.equal(read('off'), 'off');
  assert.equal(read('nein'), 'off');
  assert.equal(read('PRELOAD'), 'preload');
  assert.equal(read('quatsch'), 'on', 'unknown value: safe default');
});

test('The real app: HSTS header present once (HELFI_BASE_URL https)', async () => {
  const r = await fetch(`${S.base}/login`);
  const sts = r.headers.get('strict-transport-security');
  // test server runs with an http:// address → no HSTS; with https:// exactly one value
  if (S.base && !process.env.HELFI_BASE_URL?.startsWith('https://')) assert.equal(sts, null);
  else assert.equal(sts.split(',').length, 1);
});
