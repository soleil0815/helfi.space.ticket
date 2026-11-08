// http:// → https:// and HSTS behind a reverse proxy – the same rules as in Catalytix and AssetLotse (src/https.js)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { startServer } from './helpers/server.js';

// startServer prepares the environment (data folder, secret) before the app modules are loaded
const S = await startServer('https-redirect');
const { applyTrustProxy } = await import('../src/app.js');
const { httpsMiddleware, createHttpsHosts, parseForceHttps } = await import('../src/https.js');
after(() => S.stop());

const BASE = 'https://helfi.firma.local';
const HTTP = { 'X-Forwarded-Proto': 'http' };
const HTTPS = { 'X-Forwarded-Proto': 'https' };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-https-')), 'https-hosts.txt');

async function serve(baseUrl = BASE, { mode = 'auto', hsts = 'on', trust = 'loopback', file = tmpFile() } = {}) {
  const app = express();
  applyTrustProxy(app, trust);
  const mw = httpsMiddleware(app, { baseUrl, mode, hsts, hosts: createHttpsHosts(file) });
  if (mw) app.use(mw);
  app.all('/{*rest}', (req, res) => res.json({ ok: true, path: req.originalUrl }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, { method = 'GET', headers = {} } = {}) => fetch(base + p, { method, headers, redirect: 'manual' });
  return { call, close: () => server.close(), mw, file };
}

test('auto: switches once HTTPS was seen through the proxy, HSTS only after redirecting itself (Synology)', async () => {
  const s = await serve();
  assert.equal((await s.call('/', { headers: HTTP })).status, 200, 'no HTTPS seen yet: never redirected into nothing');
  let r = await s.call('/', { headers: HTTPS });
  assert.equal(r.headers.get('strict-transport-security'), null, 'not redirected itself yet');
  r = await s.call('/issues?q=Drucker&page=2', { headers: HTTP });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://helfi.firma.local/issues?q=Drucker&page=2');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await s.call('/', { headers: HTTPS });
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000', 'one year, this host only');
  assert.equal(fs.readFileSync(s.file, 'utf8'), 'helfi.firma.local redirected\n');
  s.close();
  // after a restart (same data folder)
  const t = await serve(BASE, { file: s.file });
  assert.equal((await t.call('/', { headers: HTTP })).status, 301);
  assert.equal((await t.call('/', { headers: HTTPS })).headers.get('strict-transport-security'), 'max-age=31536000');
  t.close();
});

test('Proxy that redirects itself (NPM "Force SSL") keeps its own HSTS header', async () => {
  const s = await serve();
  for (let i = 0; i < 3; i++) {
    const r = await s.call('/', { headers: HTTPS });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('strict-transport-security'), null);
  }
  s.close();
});

test('HELFI_FORCE_HTTPS=1: redirect right away, 308 keeps the method, HSTS always; 0: nothing at all', async () => {
  const s = await serve(BASE, { mode: '1' });
  let r = await s.call('/m/', { method: 'HEAD', headers: HTTP });
  assert.equal(r.status, 301);
  r = await s.call('/api/auth/login', { method: 'POST', headers: HTTP });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), 'https://helfi.firma.local/api/auth/login');
  // several proxies: the first value counts
  assert.equal((await s.call('/', { headers: { 'X-Forwarded-Proto': 'HTTP, https' } })).status, 301);
  assert.equal((await s.call('/', { headers: HTTPS })).headers.get('strict-transport-security'), 'max-age=31536000');
  s.close();
  const n = await serve(BASE, { mode: '0' });
  assert.equal(n.mw, null);
  assert.equal((await n.call('/', { headers: HTTP })).status, 200);
  n.close();
});

test('Proxy that only reports the port: 80 = HTTP, 443 = HTTPS, the protocol header wins', async () => {
  const s = await serve();
  await s.call('/', { headers: { 'X-Forwarded-Port': '443' } });
  assert.equal((await s.call('/', { headers: { 'X-Forwarded-Port': '80' } })).status, 301);
  assert.equal((await s.call('/', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Port': '80' } })).status, 200);
  s.close();
});

test('No redirect without the header, for /healthz and from untrusted senders', async () => {
  const s = await serve(BASE, { mode: '1' });
  const r = await s.call('/');
  assert.equal(r.status, 200, 'direct access to port 8080 as before');
  assert.equal(r.headers.get('strict-transport-security'), null);
  assert.equal((await s.call('/healthz', { headers: HTTP })).status, 200, 'docker health check');
  s.close();
  // The request does not come from a trusted proxy → a spoofed header changes nothing
  const u = await serve(BASE, { mode: '1', trust: '10.0.10.5' });
  assert.equal((await u.call('/', { headers: HTTP })).status, 200);
  assert.equal((await u.call('/', { headers: HTTPS })).headers.get('strict-transport-security'), null);
  u.close();
});

test('No open redirect: target never from the Host header or a "//" path', async () => {
  const s = await serve(BASE, { mode: '1' });
  let r = await s.call('/login', { headers: { ...HTTP, Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' } });
  assert.equal(r.headers.get('location'), 'https://helfi.firma.local/login');
  r = await s.call('//evil.example/x', { headers: HTTP });
  assert.equal(r.status, 301);
  assert.ok(r.headers.get('location').startsWith('https://helfi.firma.local/'), r.headers.get('location'));
  assert.ok(!r.headers.get('location').startsWith('https://helfi.firma.local//'));
  s.close();
});

test('Base address with path and port; http://, IP address or localhost → no redirect at all', async () => {
  const p = await serve('https://firma.example:8443/helfi', { mode: '1' });
  const r = await p.call('/issues', { headers: HTTP });
  assert.equal(r.headers.get('location'), 'https://firma.example:8443/helfi/issues');
  p.close();
  for (const base of ['http://helfi.firma.local', 'https://192.168.2.10', 'https://[fd00::5]', 'https://localhost']) {
    const h = await serve(base, { mode: '1' });
    assert.equal(h.mw, null, base);
    assert.equal((await h.call('/', { headers: HTTP })).status, 200, base);
    h.close();
  }
});

test('HELFI_HSTS: off never, preload always (with includeSubDomains; preload)', async () => {
  const off = await serve(BASE, { mode: '1', hsts: 'off' });
  assert.equal((await off.call('/', { headers: HTTPS })).headers.get('strict-transport-security'), null);
  assert.equal((await off.call('/', { headers: HTTP })).status, 301, 'the redirect stays');
  off.close();
  const pre = await serve(BASE, { hsts: 'preload' });
  assert.equal((await pre.call('/', { headers: HTTPS })).headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains; preload');
  pre.close();
});

test('Configuration values', () => {
  const read = (name, v, key) => spawnSync(process.execPath, ['--input-type=module', '-e', `const { config } = await import('./src/config.js'); process.stdout.write(config.${key});`], { env: { ...process.env, [name]: v }, encoding: 'utf8' }).stdout;
  assert.equal(read('HELFI_HSTS', '', 'hsts'), 'on');
  assert.equal(read('HELFI_HSTS', 'off', 'hsts'), 'off');
  assert.equal(read('HELFI_HSTS', 'nein', 'hsts'), 'off');
  assert.equal(read('HELFI_HSTS', 'PRELOAD', 'hsts'), 'preload');
  assert.equal(read('HELFI_HSTS', 'quatsch', 'hsts'), 'on', 'unknown value: safe default');
  assert.equal(read('HELFI_FORCE_HTTPS', '', 'forceHttps'), 'auto');
  for (const v of ['1', 'true', 'ja']) assert.equal(parseForceHttps(v), '1');
  for (const v of ['0', 'off', 'nein']) assert.equal(parseForceHttps(v), '0');
  assert.equal(parseForceHttps('quatsch'), 'auto');
});

test('Bad host names are never learned', () => {
  const file = tmpFile();
  const h = createHttpsHosts(file);
  for (const bad of ['a b<script>', '192.168.2.10', 'localhost']) h.learn(bad);
  assert.equal(fs.existsSync(file), false);
});

test('The real app: no HSTS on direct requests', async () => {
  const r = await fetch(`${S.base}/login`);
  assert.equal(r.headers.get('strict-transport-security'), null);
});
