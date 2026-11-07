// Sidebar: entries keep their height when the sidebar is full (it scrolls instead of squeezing),
// long labels stay on one line with the full text as tooltip. Needs Playwright with Chromium – skipped if missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

let S; let browser;
before(async () => {
  if (!chromium) return;
  S = await startServer('sidebarui');
  await S.admin('POST', '/api/filters', { name: 'Ohne Komponente im Projekt IT mit langem Namen', query: { component: 'none' }, shared: false });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

test('Full sidebar: same height for every entry, one line each, scrolls', { skip }, async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 640 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  await p.goto(`${S.base}/summary`);
  await p.locator('.sidebar .saved-filter').waitFor();
  const m = await p.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    const items = [...sb.querySelectorAll('.nav-item:not(.nav-sub)')].filter((e) => e.offsetParent);
    const subs = [...sb.querySelectorAll('.nav-item.nav-sub')].filter((e) => e.offsetParent);
    const labels = [...sb.querySelectorAll('.nav-item > span:not(.nav-count)')].filter((e) => e.offsetParent);
    return {
      main: [...new Set(items.map((e) => Math.round(e.getBoundingClientRect().height)))],
      sub: [...new Set(subs.map((e) => Math.round(e.getBoundingClientRect().height)))],
      multiLine: labels.filter((e) => e.getBoundingClientRect().height > 24).map((e) => e.textContent),
      noTitle: labels.filter((e) => !e.title && !e.closest('.saved-filter')).map((e) => e.textContent),
      scrolls: sb.scrollHeight > sb.clientHeight,
    };
  });
  assert.ok(m.scrolls, 'small window: the sidebar scrolls');
  assert.deepEqual(m.main, [36], 'every main entry 36 px, nothing squeezed');
  assert.deepEqual(m.sub, [32], 'queue entries 32 px');
  assert.deepEqual(m.multiLine, [], 'no label wraps');
  assert.deepEqual(m.noTitle, [], 'full text as tooltip');
  // "Meine Genehmigungen" fits completely
  const cut = await p.getByRole('link', { name: /Meine Genehmigungen/ }).locator('span').first().evaluate((e) => e.scrollWidth > e.clientWidth);
  assert.equal(cut, false);
  assert.deepEqual(errors, []);
  await c.close();
});
