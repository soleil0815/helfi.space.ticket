// Dark mode: the choice (System / Light / Dark) is stored with the account and applied in the
// browser before the first paint – on the PC and in the phone app.
// The browser part needs Playwright with Chromium (not part of the dependencies) – skipped if missing.
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

let S; let karl; let browser;
before(async () => {
  S = await startServer('theme');
  await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

test('API: theme is stored with the account, system by default, invalid values are rejected', async () => {
  assert.equal((await karl('GET', '/api/me')).body.user.theme, 'system');
  assert.equal((await karl('PATCH', '/api/me', { theme: 'dark' })).status, 200);
  assert.equal((await karl('GET', '/api/me')).body.user.theme, 'dark');
  assert.equal((await karl('PATCH', '/api/me', { theme: 'pink' })).status, 400);
  assert.equal((await karl('GET', '/api/me')).body.user.theme, 'dark', 'unchanged after an invalid value');
  assert.equal((await karl('PATCH', '/api/me', { theme: 'system' })).status, 200);
  assert.equal((await karl('GET', '/api/me')).body.user.theme, 'system');
  // other settings do not touch the theme
  await karl('PATCH', '/api/me', { theme: 'light' });
  await karl('PATCH', '/api/me', { language: 'en' });
  assert.equal((await karl('GET', '/api/me')).body.user.theme, 'light');
});

async function page(username, { mobile = false, colorScheme = 'light' } = {}) {
  const c = await browser.newContext({ colorScheme, viewport: mobile ? { width: 390, height: 780 } : { width: 1400, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de', theme: 'system' } });
  return { p, c, errors };
}
const theme = (p) => p.evaluate(() => document.documentElement.dataset.theme);
const bg = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('Desktop: user menu switches the theme, it survives a reload and follows to another device', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/my`);
  await p.locator('.topbar-user, .topbar .avatar').first().waitFor();
  assert.equal(await theme(p), 'light');
  const lightBg = await bg(p);
  await p.locator('.topbar-user, .topbar .avatar').first().click();
  await p.getByRole('menuitem', { name: 'Dunkel' }).or(p.locator('.dropdown-item:has-text("Dunkel")')).first().click();
  assert.equal(await theme(p), 'dark');
  assert.notEqual(await bg(p), lightBg, 'colours change');
  await p.waitForFunction(async () => (await (await fetch('/api/me')).json()).user.theme === 'dark');
  await p.reload();
  assert.equal(await theme(p), 'dark', 'set before the first paint on reload');
  // another device (no local choice yet) takes it over from the account
  const other = await page('anna', { mobile: true });
  await other.p.request.patch(`${S.base}/api/me`, { data: { theme: 'dark' } });
  await other.p.goto(`${S.base}/m`);
  await other.p.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.deepEqual([...errors, ...other.errors], []);
});

test('System follows the device; phone: Design buttons on the Me page', { skip }, async () => {
  const { p, errors } = await page('karl', { mobile: true, colorScheme: 'dark' });
  await p.goto(`${S.base}/m/me`);
  await p.locator('[data-theme-choice="light"]').waitFor();
  assert.equal(await theme(p), 'dark', 'system = device in dark mode');
  await p.locator('[data-theme-choice="light"]').click();
  assert.equal(await theme(p), 'light');
  assert.equal(await p.locator('meta[name="theme-color"]').getAttribute('content'), '#ffffff');
  await p.locator('[data-theme-choice="dark"]').click();
  assert.equal(await theme(p), 'dark');
  assert.equal(await p.locator('meta[name="theme-color"]').getAttribute('content'), '#1D2125');
  await p.waitForFunction(async () => (await (await fetch('/api/me')).json()).user.theme === 'dark');
  await p.locator('[data-theme-choice="system"]').click();
  await p.waitForFunction(async () => (await (await fetch('/api/me')).json()).user.theme === 'system');
  assert.equal(await theme(p), 'dark', 'back to the device setting');
  assert.deepEqual(errors, []);
});
