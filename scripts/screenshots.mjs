#!/usr/bin/env node
// Take every screenshot of the README and the manual from a demo instance with neutral sample data,
// so pictures and program version always match.
// Needs Playwright with Chromium (not part of the program dependencies), like scripts/build-manual.mjs:
//   npm install --no-save playwright && npx playwright install chromium
// Usage:
//   node scripts/screenshots.mjs                 all pictures, German and English
//   node scripts/screenshots.mjs --lang=de       one language
//   node scripts/screenshots.mjs --only=board,ticket
//   node scripts/screenshots.mjs --out=/tmp/shots   write somewhere else (for a look before committing)
// Then rebuild the PDFs: node scripts/build-manual.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHOTS, README_SHOTS } from './screenshots/list.mjs';
import { seed } from './screenshots/seed.mjs';
import { scenes } from './screenshots/scenes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const langs = (arg('lang') || 'de,en').split(',');
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const outRoot = arg('out');

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is missing: npm install --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

// Every language in its own process: the program reads its settings once per process
if (langs.length > 1) {
  const { execFileSync } = await import('node:child_process');
  for (const l of langs) execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter((a) => !a.startsWith('--lang=')), `--lang=${l}`], { stdio: 'inherit' });
  process.exit(0);
}
const lang = langs[0];
if (!['de', 'en'].includes(lang)) { console.error(`unknown language ${lang}`); process.exit(1); }

// Demo instance: own data folder, fixed address, Berlin time
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `helfi-shots-${lang}-`));
Object.assign(process.env, {
  HELFI_DATA_DIR: dataDir, HELFI_SETUP_TOKEN: 'demo-setup', HELFI_LOG_LEVEL: 'error', TZ: 'Europe/Berlin',
  HELFI_BASE_URL: 'https://helfi.firma.local', HELFI_SECURE_COOKIES: 'false', HELFI_TRUST_PROXY: 'loopback',
});
const { openDatabase } = await import(pathToFileURL(path.join(root, 'src/db.js')));
const { initMasterKey } = await import(pathToFileURL(path.join(root, 'src/lib/crypto.js')));
const { createApp } = await import(pathToFileURL(path.join(root, 'src/app.js')));
const { paths, config } = await import(pathToFileURL(path.join(root, 'src/config.js')));
initMasterKey();
// Version as in a release: highest tag (package.json does not count)
try { config.version = (await import('node:child_process')).execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' }).trim().replace(/^v/, ''); } catch { /* no git */ }
const db = await openDatabase(paths.db);
const { app, ctx } = createApp(db);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;
// "localhost" counts as a secure origin: passkeys work there without HTTPS (the passkey scene switches the address)
const B = `http://localhost:${port}`;
const { COMPOSE_VERSION } = await import(pathToFileURL(path.join(root, 'src/config.js')));
config.composeVersion = COMPOSE_VERSION;
// Mails are not sent, only kept (rating links, reminders)
const sent = [];
ctx.mailer.enabled = () => true;
ctx.mailer.send = async (m) => { sent.push(m); return true; };

const browser = await chromium.launch({ args: [lang === 'de' ? '--lang=de-DE' : '--lang=en-GB'], env: { ...process.env, LANG: lang === 'de' ? 'de_DE.UTF-8' : 'en_GB.UTF-8' } });
const errors = [];
const de = lang === 'de';
const T = (a, b) => (de ? a : b);
const PASSWORD = 'Demo-Kennwort-2026';

/** A browser page; signed in as `user` (or not signed in) */
async function page(user, { mobile = false, width = 1280, height = 800, scale, ip = '10.0.10.25', theme = 'light' } = {}) {
  const c = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width, height },
    deviceScaleFactor: scale || (mobile ? 2 : 1.25),
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    locale: de ? 'de-DE' : 'en-GB', timezoneId: 'Europe/Berlin', colorScheme: theme === 'dark' ? 'dark' : 'light',
    extraHTTPHeaders: { 'X-Forwarded-For': ip },
  });
  c.setDefaultTimeout(10000);
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`${user || 'anon'}: ${e.message}`));
  if (user) {
    const r = await p.request.post(`${B}/api/auth/login`, { data: { username: user, password: PASSWORD }, headers: { 'X-Helfi-Request': '1' } });
    if (r.status() !== 200) throw new Error(`login ${user}: ${r.status()} ${await r.text()}`);
    await p.request.patch(`${B}/api/me`, { data: { language: lang, theme }, headers: { 'X-Helfi-Request': '1' } });
  } else {
    await p.addInitScript((l) => { try { localStorage.setItem('helfi.lang', l); } catch { /* ignore */ } }, lang);
  }
  // No news pop-up or install banner in the pictures
  await p.addInitScript(() => {
    const css = '.news-popup,.install-banner,.pwa-banner{display:none!important}*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}';
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); });
  });
  return p;
}

const outDir = (readme) => (outRoot ? path.join(outRoot, readme ? 'images' : lang) : readme ? path.join(root, 'docs/images') : path.join(root, 'docs/manual/img', lang));
fs.mkdirSync(outDir(false), { recursive: true });
fs.mkdirSync(outDir(true), { recursive: true });
const done = new Set();
const fileOf = (name) => (README_SHOTS.includes(name) ? path.join(outDir(true), `${name.replace(/^readme-/, '')}-${lang}.png`) : path.join(outDir(false), `${name}.jpg`));
const want = (name) => !only || only.has(name);
const opts = (name) => (README_SHOTS.includes(name) ? { type: 'png' } : { type: 'jpeg', quality: 85 });

const settle = async (p, ms = 350) => { await p.waitForLoadState('networkidle').catch(() => {}); await p.evaluate(() => document.fonts?.ready).catch(() => {}); await p.waitForTimeout(ms); };
const go = async (p, url, ms) => { await p.goto(B + url); await settle(p, ms); };
const bbox = async (loc) => {
  // To the top of the window, so that what follows below fits in as well
  await loc.first().evaluate((e) => e.scrollIntoView({ block: 'start' })).catch(() => {});
  await loc.first().page().waitForTimeout(100);
  const b = await loc.first().boundingBox(); if (!b) throw new Error('element not visible'); return b;
};

const shot = {
  /** The visible window */
  async full(p, name) { if (!want(name)) return; await settle(p, 250); await p.screenshot({ path: fileOf(name), ...opts(name) }); done.add(name); },
  /** One element (with a margin), `sel` a selector or locator; `to` optional second element for the bottom edge */
  async el(p, name, sel, { pad = 12, to, padBottom, maxHeight } = {}) {
    if (!want(name)) return;
    await settle(p, 250);
    const loc = typeof sel === 'string' ? p.locator(sel) : sel;
    const a = await bbox(loc);
    let bottom = a.y + a.height; let left = a.x; let right = a.x + a.width;
    // `to`: the picture reaches down to (and around) this element as well
    if (to) { const b = await (typeof to === 'string' ? p.locator(to) : to).first().boundingBox(); if (!b) throw new Error('second element not visible'); bottom = Math.max(bottom, b.y + b.height); left = Math.min(left, b.x); right = Math.max(right, b.x + b.width); }
    const vp = p.viewportSize();
    const x = Math.max(0, left - pad); const y = Math.max(0, a.y - pad);
    const width = Math.min(vp.width - x, right - left + 2 * pad);
    let height = bottom - y + (padBottom ?? pad);
    if (maxHeight) height = Math.min(height, maxHeight);
    await p.screenshot({ path: fileOf(name), clip: { x, y, width, height: Math.min(height, vp.height - y) }, ...opts(name) });
    done.add(name);
  },
  /** A rectangle of the window */
  async clip(p, name, clip) { if (!want(name)) return; await settle(p, 250); await p.screenshot({ path: fileOf(name), clip, ...opts(name) }); done.add(name); },
  /** Several phone screens side by side */
  async phones(name, pages, { height } = {}) {
    if (!want(name)) return;
    const imgs = [];
    for (const p of pages) { await settle(p, 300); imgs.push((await p.screenshot({ type: 'png' })).toString('base64')); }
    const h = height || 844;
    const w = 390 * pages.length + 24 * (pages.length - 1);
    const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const cp = await c.newPage();
    await cp.setContent(`<html><body style="margin:0;background:#fff;display:flex;gap:24px">${imgs.map((b) => `<img style="width:390px;height:${h}px;object-fit:cover;object-position:top;border:1px solid #DCDFE4;box-sizing:border-box;border-radius:8px" src="data:image/png;base64,${b}">`).join('')}</body></html>`);
    await cp.waitForTimeout(200);
    await cp.screenshot({ path: fileOf(name), ...opts(name) });
    await c.close();
    done.add(name);
  },
};

/** One step of a scene: a failure is reported, the scene goes on with the next picture */
const step = async (label, fn) => {
  try { await fn(); } catch (e) { console.error(`[${lang}] ${label}: ${String(e.message || e).split('\n')[0]}`); process.exitCode = 1; }
};
const S = { step, B, db, ctx, lang, de, T, page, go, settle, shot, sent, PASSWORD, browser, want, errors };
const t0 = Date.now();
await seed(S);
console.log(`[${lang}] demo data ready (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
// --debug=<file.mjs>: run its run(S) after the demo data (for working on a new picture)
if (arg('debug')) await (await import(pathToFileURL(path.resolve(arg('debug'))))).run(S);
for (const [sceneName, scene] of Object.entries(scenes)) {
  if (only && !scene.shots.some((n) => only.has(n))) continue;
  const t1 = Date.now();
  try {
    await scene.run(S);
  } catch (e) {
    console.error(`[${lang}] scene ${sceneName} failed: ${e.stack || e.message}`);
    process.exitCode = 1;
  }
  console.log(`[${lang}] ${sceneName} (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
}

const expected = [...SHOTS, ...README_SHOTS].filter(want);
const missing = expected.filter((n) => !done.has(n));
if (missing.length) { console.error(`[${lang}] missing: ${missing.join(', ')}`); process.exitCode = 1; }
if (errors.length) { console.error(`[${lang}] page errors:\n  ${[...new Set(errors)].join('\n  ')}`); process.exitCode = 1; }
console.log(`[${lang}] ${done.size} pictures`);
await browser.close();
server.close();
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(process.exitCode || 0);
