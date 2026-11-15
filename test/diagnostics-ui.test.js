// Diagnosis package in Administration → System: preview and download (browser).
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
  S = await startServer('diagnostics-ui');
  await S.user('erika.muster', 'user');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

test('Administration → System: preview shows the anonymous package, download saves it as a file', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const hdr = { 'X-Helfi-Request': '1' };
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' }, headers: hdr })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' }, headers: hdr });
  await p.goto(`${S.base}/admin/system`);
  await p.waitForSelector('[data-diagnostics] >> text=Diagnosepaket');
  await p.click('[data-diag-preview]');
  await p.waitForSelector('.diagnostics-preview:not([hidden])');
  const text = await p.textContent('.diagnostics-preview');
  assert.match(text, /^# Helfi\.Space – diagnosis package/);
  assert.ok(!text.includes('erika'), 'anonymous');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-diag-download]')]);
  assert.match(dl.suggestedFilename(), /^helfi-diagnose-\d{4}-\d{2}-\d{2}\.md$/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
