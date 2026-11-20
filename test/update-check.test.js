// Check for new versions (src/update-check.js): asks GitHub (here a stand-in) for the latest release, compares,
// knows the version pinned in .env, "Skip this version", errors only noted. API: notice only for admins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers/server.js';

let S; let U; let gh; let ghUrl; let answer; let calls = 0; let agent;
before(async () => {
  S = await startServer('updatecheck');
  U = await import('../src/update-check.js');
  agent = await S.user('ulla', 'agent');
  // Stand-in for api.github.com/…/releases/latest
  gh = http.createServer((req, res) => {
    calls++;
    const [status, body] = answer();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  ghUrl = `http://127.0.0.1:${gh.address().port}/repos/x/y/releases/latest`;
});
after(() => { gh.close(); S.stop(); });

/** Fake settings store */
function store(init = {}) {
  const m = { 'update.check': true, 'update.skip': '', ...init };
  return { get: (k) => m[k], set: (k, v) => { m[k] = v; } };
}

test('Versions: parse and compare; only plain release numbers count', () => {
  assert.deepEqual(U.parseVersion('v1.52.0'), [1, 52, 0]);
  assert.deepEqual(U.parseVersion('1.52.0'), [1, 52, 0]);
  for (const bad of ['', 'latest', '1.52', '1.52.0-rc1', '1.52.0-dirty', 'v1.52.0.1', null, '1.52.0; rm -rf /']) assert.equal(U.parseVersion(bad), null, String(bad));
  assert.ok(U.newer('1.53.0', '1.52.0'));
  assert.ok(U.newer('1.52.10', '1.52.9'));
  assert.ok(U.newer('2.0.0', '1.99.99'));
  assert.ok(!U.newer('1.52.0', '1.52.0'));
  assert.ok(!U.newer('1.51.9', '1.52.0'));
  assert.ok(!U.newer('1.53.0', 'dev'));
  assert.equal(U.pinnedVersion({ HELFI_VERSION: '1.51.1' }), '1.51.1');
  assert.equal(U.pinnedVersion({ HELFI_VERSION: 'v1.51.1' }), '1.51.1');
  assert.equal(U.pinnedVersion({ HELFI_VERSION: 'latest' }), null);
  assert.equal(U.pinnedVersion({}), null);
});

test('Check: newer version → notice; same or older → none; skip hides only that version', async () => {
  const settings = store();
  const u = U.createUpdateCheck({ settings, version: '1.52.0', url: ghUrl, env: {} });
  answer = () => [200, { tag_name: 'v1.53.0', html_url: 'https://evil.example/x', body: 'notes' }];
  assert.equal(u.available(), null, 'nothing before the first check');
  await u.check();
  assert.deepEqual(u.available(), { version: '1.53.0', installed: '1.52.0', notes: 'https://github.com/soleil0815/helfi.space.ticket/releases/tag/v1.53.0', pinned: null });
  // Skipped: hidden – the next version shows again
  settings.set('update.skip', '1.53.0');
  assert.equal(u.available(), null);
  assert.equal(u.status().skipped, '1.53.0');
  answer = () => [200, { tag_name: 'v1.54.0' }];
  await u.check();
  assert.equal(u.available().version, '1.54.0');
  // Same version or older (e.g. a release withdrawn): nothing
  answer = () => [200, { tag_name: 'v1.52.0' }];
  await u.check();
  assert.equal(u.available(), null);
  assert.equal(u.status().latest, '1.52.0');
  // Switched off: no notice, even with a newer one known
  answer = () => [200, { tag_name: 'v1.60.0' }];
  await u.check();
  settings.set('update.check', false);
  assert.equal(u.available(), null);
  assert.equal(u.status().enabled, false);
});

test('Check: pinned version in .env, dev builds without notice', async () => {
  answer = () => [200, { tag_name: 'v1.53.0' }];
  const pinned = U.createUpdateCheck({ settings: store(), version: '1.51.1', url: ghUrl, env: { HELFI_VERSION: '1.51.1' } });
  await pinned.check();
  assert.equal(pinned.available().pinned, '1.51.1');
  const dev = U.createUpdateCheck({ settings: store(), version: '1.0.0-dev', url: ghUrl, env: {} });
  await dev.check();
  assert.equal(dev.available(), null);
});

test('Check: errors are only noted – no notice, the last good answer stays, nothing thrown', async () => {
  const u = U.createUpdateCheck({ settings: store(), version: '1.52.0', url: ghUrl, env: {} });
  answer = () => [200, { tag_name: 'v1.53.0' }];
  await u.check();
  for (const bad of [() => [500, 'oops'], () => [200, 'not json'], () => [200, { tag_name: 'nightly' }], () => [404, { message: 'Not Found' }]]) {
    answer = bad;
    await u.check();
    assert.equal(u.status().failed, true);
    assert.equal(u.available().version, '1.53.0');
  }
  // Not reachable at all
  const off = U.createUpdateCheck({ settings: store(), version: '1.52.0', url: 'http://127.0.0.1:9/x', env: {} });
  await off.check();
  assert.equal(off.status().failed, true);
  assert.equal(off.available(), null);
  assert.match(off.diagnostics()['last check failed'], /^yes/);
  // Only http(s) addresses are asked
  let asked = null;
  const odd = U.createUpdateCheck({ settings: store(), version: '1.52.0', url: 'file:///etc/passwd', env: {}, fetchImpl: async (x) => { asked = x; throw new Error('no'); } });
  await odd.check();
  assert.match(asked, /^https:\/\/api\.github\.com\//);
});

test('Check: no data about the installation is sent; parallel checks ask once', async () => {
  let seen = null;
  const u = U.createUpdateCheck({
    settings: store(), version: '1.52.0', url: ghUrl, env: {},
    fetchImpl: async (x, opt) => { seen = { x, opt }; await new Promise((r) => setTimeout(r, 30)); return { ok: true, status: 200, text: async () => JSON.stringify({ tag_name: 'v1.53.0' }) }; },
  });
  const before1 = calls;
  await Promise.all([u.check(), u.check(), u.check()]);
  assert.equal(calls, before1);
  assert.equal(seen.x, ghUrl);
  assert.equal(seen.opt.method, undefined); // GET
  assert.equal(seen.opt.body, undefined);
  assert.deepEqual(Object.keys(seen.opt.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(seen.opt.headers['User-Agent'], 'Helfi.Space');
});

test('API: notice only for admins; check now, skip and show again', async () => {
  answer = () => [200, { tag_name: 'v9.1.0' }];
  S.ctx.updates = U.createUpdateCheck({ settings: S.ctx.settings, version: '9.0.0', url: ghUrl, env: {} });
  let r = await S.admin('GET', '/api/bootstrap');
  assert.equal(r.body.update, null, 'not checked yet');
  r = await S.admin('POST', '/api/admin/updates/check');
  assert.equal(r.status, 200);
  assert.equal(r.body.available.version, '9.1.0');
  assert.equal((await S.admin('GET', '/api/bootstrap')).body.update.version, '9.1.0');
  assert.equal((await agent('GET', '/api/bootstrap')).body.update, null, 'agents see nothing');
  assert.equal((await agent('POST', '/api/admin/updates/check')).status, 403);
  assert.equal((await agent('POST', '/api/admin/updates/skip', { version: '9.1.0' })).status, 403);
  // Administration → System shows the state
  r = await S.admin('GET', '/api/admin/system');
  assert.equal(r.body.updates.latest, '9.1.0');
  assert.equal(r.body.updates.installed, '9.0.0');
  // Skip: hidden, saved – and shown again
  assert.equal((await S.admin('POST', '/api/admin/updates/skip', { version: 'v9.1.0; drop' })).status, 400);
  r = await S.admin('POST', '/api/admin/updates/skip', { version: 'v9.1.0' });
  assert.equal(r.status, 200);
  assert.equal(S.ctx.settings.get('update.skip'), '9.1.0');
  assert.equal((await S.admin('GET', '/api/bootstrap')).body.update, null);
  await S.admin('POST', '/api/admin/updates/skip', { version: '' });
  assert.equal((await S.admin('GET', '/api/bootstrap')).body.update.version, '9.1.0');
  // Switched off in the settings: no notice
  await S.admin('PUT', '/api/admin/settings', { settings: { 'update.check': false } });
  assert.equal((await S.admin('GET', '/api/bootstrap')).body.update, null);
  await S.admin('PUT', '/api/admin/settings', { settings: { 'update.check': true } });
  // Diagnosis package: section present, no URL of the stand-in
  const text = (await S.admin('GET', '/api/admin/diagnostics')).body.text;
  assert.match(text, /Update check/);
  assert.match(text, /latest.*9\.1\.0/);
});
