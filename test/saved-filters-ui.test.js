// Saved filters in the browser: save from the list, sidebar with count and title, manage, phone chips.
// Needs Playwright with Chromium (not part of the dependencies) – if missing, the test is skipped.
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
  S = await startServer('filtersui');
  await S.user('anna', 'agent');
  const karl = await S.user('karl', 'user');
  for (const [title, priority] of [['A', 'high'], ['B', 'high'], ['C', 'low']]) await karl('POST', '/api/tickets', { title, priority });
  await S.admin('POST', '/api/filters', { name: 'Team: niedrig', query: 'priority=low', shared: true });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1280, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Desktop: save the current filters, sidebar entry with count, title, rename and delete', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/issues?priority=high`);
  await p.waitForSelector('.save-filter-btn');
  // shared queue already in the sidebar, marked as shared
  await p.waitForSelector('.saved-filter:has(.saved-shared) >> text=Team: niedrig');
  await p.click('.save-filter-btn');
  await p.fill('#save-filter-form input', 'Hoch');
  assert.equal(await p.locator('#save-filter-form input[type=checkbox]').count(), 0, 'agents cannot share');
  await p.click('.modal .btn-primary');
  await p.waitForSelector('.page-head h1 >> text=Hoch');
  assert.equal(await p.locator('.save-filter-btn').count(), 0, 'no "save" for a saved filter');
  const entry = p.locator('.saved-filter', { hasText: 'Hoch' });
  await p.waitForFunction(() => [...document.querySelectorAll('.saved-filter')].some((a) => a.textContent.includes('Hoch') && a.querySelector('.nav-count').textContent === '2'));
  assert.match(await entry.getAttribute('class'), /active/);
  // manage: rename and delete
  await p.click('.saved-head .btn-icon');
  await p.waitForSelector('.manage-filters');
  await p.fill('.manage-list input', 'Hoch offen');
  await p.press('.manage-list input', 'Enter');
  await p.locator('.manage-list input').dispatchEvent('change');
  await p.waitForSelector('.saved-filter >> text=Hoch offen');
  await p.click('.manage-list [aria-label="Filter löschen"]');
  await p.waitForFunction(() => ![...document.querySelectorAll('.saved-filter')].some((a) => a.textContent.includes('Hoch offen')));
  assert.deepEqual(errors, []);
});

test('Phone: saved filters as chips with count', { skip }, async () => {
  const { p, errors } = await page('anna', true);
  await p.goto(`${S.base}/m/tickets`);
  await p.waitForSelector('.m-chip >> text=Team: niedrig');
  await p.tap('.m-chip >> text=Team: niedrig');
  await p.waitForURL(/priority=low/);
  await p.waitForSelector('.m-chip.active >> text=Team: niedrig');
  // the list reloads after the chip turns active – wait for it instead of reading it right away
  await p.waitForFunction(() => document.querySelectorAll('.m-list > *').length === 1);
  assert.equal(await p.locator('.m-list > *').count(), 1);
  assert.deepEqual(errors, []);
});
