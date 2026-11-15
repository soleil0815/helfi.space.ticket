// Shipped fonts (Inter, IBM Plex Mono): served from the app itself, licence included, used by the styles,
// precached for the phone app – never loaded from the internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.js';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FONTS = ['inter-latin-wght-normal.woff2', 'ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono-latin-500-normal.woff2'];
let S;
before(async () => { S = await startServer('fonts'); });
after(() => S.stop());

test('Fonts are shipped as WOFF2 with the SIL Open Font License', () => {
  for (const f of FONTS) {
    const buf = fs.readFileSync(path.join(pub, 'fonts', f));
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${f} is WOFF2`);
  }
  assert.match(fs.readFileSync(path.join(pub, 'fonts', 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('Styles use only the shipped fonts (no internet) with Inter and Plex Mono in the stacks', () => {
  const css = fs.readFileSync(path.join(pub, 'css', 'app.css'), 'utf8');
  const urls = [...css.matchAll(/@font-face\s*{[^}]*url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), FONTS.map((f) => `/fonts/${f}`).sort());
  assert.doesNotMatch(css, /url\(['"]?https?:/, 'nothing from the internet');
  assert.match(css, /--font: -apple-system, BlinkMacSystemFont, 'Inter',/);
  assert.match(css, /--mono: 'Plex Mono',/);
});

test('Fonts are served by the app and allowed by the CSP', async () => {
  for (const f of FONTS) {
    const r = await fetch(`${S.base}/fonts/${f}`);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type') || '', /font\/woff2/);
    assert.match(r.headers.get('content-security-policy') || '', /font-src 'self'/);
  }
});

test('Phone app: the service worker precaches the fonts (works offline too)', async () => {
  const sw = await (await fetch(`${S.base}/m/sw.js`)).text();
  assert.match(sw, /\/fonts\/inter-latin-wght-normal\.woff2/);
});
