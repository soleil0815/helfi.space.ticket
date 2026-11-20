// New version available: notice in the administration and under "Me" on the phone, dot in the sidebar,
// "Skip this version", panel in Administration → System. Needs Playwright with Chromium (else skipped).
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

let S; let browser; let U; let latest = 'v2.4.0';
before(async () => {
  if (!chromium) return;
  S = await startServer('updatecheckui');
  await S.user('ulla', 'agent');
  U = await import('../src/update-check.js');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

const fakeGithub = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: latest }) });
async function useUpdates(env = {}) {
  S.ctx.settings.set('update.skip', '');
  S.ctx.updates = U.createUpdateCheck({ settings: S.ctx.settings, version: '2.3.1', fetchImpl: fakeGithub, env });
  await S.ctx.updates.check();
}

async function page(user = 'admin', { mobile = false } = {}) {
  const c = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    extraHTTPHeaders: { 'X-Helfi-Request': '1' },
  });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username: user, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, c, errors };
}

test('Desktop: notice in the administration, dot in the sidebar, skip hides both', { skip }, async () => {
  await useUpdates();
  const { p, c, errors } = await page();
  await p.goto(`${S.base}/issues`);
  await p.waitForSelector('[data-update-dot]');
  assert.equal(await p.locator('[data-update-notice]').count(), 0, 'no notice outside the administration');
  await p.goto(`${S.base}/admin/users`);
  const n = p.locator('[data-update-notice]');
  await n.waitFor();
  assert.match(await n.textContent(), /Version 2\.4\.0 ist verfügbar/);
  assert.match(await n.textContent(), /Installiert: 2\.3\.1/);
  assert.deepEqual(await n.locator('code').allTextContents(), ['./update.sh', 'docker compose pull && docker compose up -d']);
  assert.equal(await n.locator('a').getAttribute('href'), 'https://github.com/soleil0815/helfi.space.ticket/releases/tag/v2.4.0');
  await n.locator('[data-update-skip]').click();
  await p.waitForSelector('[data-update-notice]', { state: 'detached' });
  assert.equal(await p.locator('[data-update-dot]').count(), 0);
  assert.equal(S.ctx.settings.get('update.skip'), '2.4.0');
  // Next version: back again
  latest = 'v2.5.0';
  await S.ctx.updates.check();
  await p.goto(`${S.base}/admin/system`);
  await p.waitForSelector('[data-update-notice] >> text=Version 2.5.0 ist verfügbar');
  assert.match(await p.locator('[data-update-state]').textContent(), /Version 2\.5\.0 ist verfügbar/);
  assert.deepEqual(errors, []);
  await c.close();
  latest = 'v2.4.0';
});

test('Desktop: version pinned in .env – the notice says how; System panel: check now, switch off', { skip }, async () => {
  await useUpdates({ HELFI_VERSION: '2.3.1' });
  const { p, c, errors } = await page();
  await p.goto(`${S.base}/admin/system`);
  const n = p.locator('[data-update-notice]');
  await n.waitFor();
  assert.match(await n.textContent(), /Version 2\.3\.1 fest eingetragen/);
  assert.deepEqual(await n.locator('code').allTextContents(), ['./update.sh', 'HELFI_VERSION=2.4.0', 'docker compose pull && docker compose up -d']);
  // Check now: toast and state line
  await p.click('[data-update-check]');
  await p.waitForSelector('.toast >> text=Version 2.4.0 ist verfügbar');
  // Switch off: notice and dot gone
  await p.locator('[data-update-switch]').uncheck();
  await p.waitForSelector('[data-update-notice]', { state: 'detached' });
  await p.waitForSelector('[data-update-state] >> text=Ausgeschaltet');
  assert.equal(await p.locator('[data-update-dot]').count(), 0);
  assert.equal(S.ctx.settings.get('update.check'), false);
  assert.ok(await p.locator('[data-update-check]').isDisabled());
  S.ctx.settings.set('update.check', true);
  assert.deepEqual(errors, []);
  await c.close();
});

test('Phone: notice under "Me" for admins only', { skip }, async () => {
  await useUpdates();
  const a = await page('admin', { mobile: true });
  await a.p.goto(`${S.base}/m/me`);
  await a.p.waitForSelector('[data-update-notice] >> text=Version 2.4.0 ist verfügbar');
  const u = await page('ulla', { mobile: true });
  await u.p.goto(`${S.base}/m/me`);
  await u.p.waitForSelector('.m-profile');
  assert.equal(await u.p.locator('[data-update-notice]').count(), 0);
  assert.deepEqual([...a.errors, ...u.errors], []);
  await a.c.close(); await u.c.close();
});
