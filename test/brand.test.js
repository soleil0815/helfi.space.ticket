// Erscheinungsbild: Farbe, Kontrast, Logo-Prüfung und öffentliche Auslieferung
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-brand-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { contrast, mix, brandCss, checkSvg, isHexColor } = await import('../src/brand.js');

const fake = (v) => ({ get: (k) => v[k] });

test('Farben: Kontrast und Ableitungen', () => {
  assert.ok(contrast('#FFFFFF', '#000000') > 20.9);
  assert.ok(contrast('#0C66E4', '#FFFFFF') >= 4.5);
  assert.ok(contrast('#FFD700', '#FFFFFF') < 3);
  assert.equal(mix('#000000', '#FFFFFF', 0.5), '#808080');
  assert.ok(isHexColor('#a1B2c3'));
  assert.ok(!isHexColor('red'));
  assert.ok(!isHexColor('#fff'));
});

test('brand.css: Standard leer, eigene Farbe und farbige Kopfzeile', () => {
  assert.equal(brandCss(fake({ 'brand.color': '', 'brand.header': 'light' })).trim(), '');
  const css = brandCss(fake({ 'brand.color': '#7A1F5C', 'brand.header': 'color' }));
  assert.match(css, /--blue: #7A1F5C/);
  assert.match(css, /\.topbar \{ background: var\(--blue\)/);
  assert.match(css, /color: #FFFFFF/);
  // sehr helle Farbe → dunkle Schrift in der Kopfzeile
  assert.match(brandCss(fake({ 'brand.color': '#FFD700', 'brand.header': 'color' })), /color: #172B4D/);
  // ungültige Farbe → Standard, kein eingeschleustes CSS
  const evil = brandCss(fake({ 'brand.color': 'red;} body{display:none', 'brand.header': 'light' }));
  assert.equal(evil.trim(), '');
});

test('SVG-Prüfung', () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/></svg>';
  assert.equal(checkSvg(Buffer.from(ok)), null);
  for (const bad of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><image href="https://example.com/x.png"/></svg>',
    '<svg><image xlink:href="http://example.com/x.png"/></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg><style>@import url(https://example.com/x.css);</style></svg>',
    '<svg><rect style="fill:url(https://example.com/a)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY a "x">]><svg/>',
  ]) assert.equal(checkSvg(Buffer.from(bad)), 'err.brandUnsafeSvg', bad);
  assert.equal(checkSvg(Buffer.from('<html></html>')), 'err.brandNotSvg');
});

test('Logo hochladen, ausliefern, entfernen; nur Admins', async () => {
  const { openDatabase } = await import('../src/db.js');
  const { initMasterKey } = await import('../src/lib/crypto.js');
  const { createApp } = await import('../src/app.js');
  const { paths } = await import('../src/config.js');
  initMasterKey();
  const db = await openDatabase(paths.db);
  const built = createApp(db);
  built.ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  const server = await new Promise((r) => { const s = built.app.listen(0, '127.0.0.1', () => r(s)); });
  after(async () => { await new Promise((r) => setTimeout(r, 100)); server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie }, body: body && JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const ct = r.headers.get('content-type') || '';
      return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
    };
  };
  const admin = client();
  const user = client();
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  await admin('POST', '/api/users', { username: 'karl', displayName: 'Karl', role: 'user', password: 'Sehrgeheim123' });
  await user('POST', '/api/auth/login', { username: 'karl', password: 'Sehrgeheim123' });

  // ohne eigenes Logo: Standardlogo, auch ohne Anmeldung
  let r = await fetch(`${base}/brand/logo`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /svg/);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await user('PUT', '/api/admin/brand/logo', { data: png })).status, 403);
  assert.equal((await admin('PUT', '/api/admin/brand/logo', { data: 'data:image/png;base64,AAAA' })).status, 400, 'kein echtes PNG');
  assert.equal((await admin('PUT', '/api/admin/brand/logo', { data: 'data:image/gif;base64,R0lGOD' })).status, 400);
  const evil = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
  assert.equal((await admin('PUT', '/api/admin/brand/logo', { data: evil })).body.error.code, 'err.brandUnsafeSvg');
  const big = `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(600 * 1024)]).toString('base64')}`;
  assert.equal((await admin('PUT', '/api/admin/brand/logo', { data: big })).status, 400);

  r = await admin('PUT', '/api/admin/brand/logo', { data: png });
  assert.equal(r.status, 200);
  assert.match(r.body.logo, /^png:[0-9a-f]{12}$/);
  const res = await fetch(`${base}/brand/logo`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal((await user('GET', '/api/bootstrap')).body.brand.logo, r.body.logo);
  // brand.logo lässt sich nicht über die Einstellungen setzen
  await admin('PUT', '/api/admin/settings', { settings: { 'brand.logo': 'svg:../../etc' } });
  assert.equal(built.ctx.settings.get('brand.logo'), r.body.logo);

  // Farbe prüfen und als CSS ausliefern
  assert.equal((await admin('PUT', '/api/admin/settings', { settings: { 'brand.color': 'red' } })).status, 400);
  assert.equal((await admin('PUT', '/api/admin/settings', { settings: { 'brand.header': 'bunt' } })).status, 400);
  assert.equal((await admin('PUT', '/api/admin/settings', { settings: { 'brand.color': '#7A1F5C', 'brand.header': 'color' } })).status, 200);
  const css = await fetch(`${base}/brand.css`);
  assert.match(await css.text(), /--blue: #7A1F5C/);
  assert.equal((await fetch(`${base}/brand.css`, { headers: { 'If-None-Match': css.headers.get('etag') } })).status, 304);

  assert.equal((await admin('DELETE', '/api/admin/brand/logo')).status, 200);
  assert.equal(built.ctx.settings.get('brand.logo'), '');
  assert.match((await fetch(`${base}/brand/logo`)).headers.get('content-type'), /svg/);
  assert.equal(fs.readdirSync(path.join(dataDir, 'brand')).length, 0);
});
