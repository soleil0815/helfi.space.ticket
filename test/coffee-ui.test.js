// Support box for the developer: sentence + "Einen Kaffee spendieren", admins only (sidebar foot,
// Administration → System, phone "Me"). Needs Playwright with Chromium – skipped if missing.
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
  S = await startServer('coffee');
  await S.user('anna', 'agent');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Admins: box in the sidebar and on the system page, button opens Buy Me a Coffee in a new tab', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/system`);
  await p.waitForSelector('.sidebar-foot [data-coffee] >> text=Gefällt dir Helfi.Space? Über einen Kaffee freue ich mich.');
  const btn = p.locator('.admin-body [data-coffee] a.coffee-btn');
  assert.equal((await btn.textContent()).trim(), 'Einen Kaffee spendieren');
  assert.equal(await btn.getAttribute('href'), 'https://buymeacoffee.com/soleil0815');
  assert.equal(await btn.getAttribute('target'), '_blank');
  assert.equal(await btn.getAttribute('rel'), 'noopener noreferrer');
  assert.deepEqual(errors, []);
});

test('Agents do not see it', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/board`);
  await p.waitForSelector('.sidebar-foot');
  assert.equal(await p.locator('[data-coffee]').count(), 0);
  assert.deepEqual(errors, []);
});

test('Phone app, "Me": box for admins', { skip }, async () => {
  const { p, errors } = await page('admin', true);
  await p.goto(`${S.base}/m/me`);
  await p.waitForSelector('.m-coffee [data-coffee] >> text=Einen Kaffee spendieren');
  assert.deepEqual(errors, []);
});
