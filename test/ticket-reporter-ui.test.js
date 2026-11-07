// Reporter in the browser: create dialog (desktop), "Change reporter" in the details, phone form.
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
  S = await startServer('reporterui');
  await S.user('anna', 'agent');
  await S.user('karl', 'user');
  await S.user('lisa', 'user');
  S.db.prepare("UPDATE users SET display_name='Karl Kunde' WHERE username='karl'").run();
  S.db.prepare("UPDATE users SET display_name='Lisa Lager' WHERE username='lisa'").run();
  S.ctx.users?.reload?.();
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1400, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}
const ticket = async (key) => (await S.admin('GET', `/api/tickets/${key}`)).body.ticket;

test('Desktop: create a ticket for someone else, then change the reporter', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/my`);
  await p.locator('.topbar-create').click();
  const dlg = p.locator('.modal');
  await dlg.locator('.reporter-field').waitFor();
  assert.match(await dlg.locator('.reporter-field').textContent(), /Ich \(anna\)/);
  assert.equal(await dlg.locator('.reporter-notify').isVisible(), false);
  await dlg.getByRole('button', { name: 'Für jemand anderen erfassen' }).click();
  await p.keyboard.type('karl');
  await p.locator('.picker-menu .menu-item', { hasText: 'Karl Kunde' }).click();
  assert.match(await dlg.locator('.reporter-field').textContent(), /Karl Kunde/);
  assert.equal(await dlg.locator('.reporter-notify input').isChecked(), true);
  await dlg.locator('input[required]').first().fill('Drucker per Telefon');
  await p.locator('.modal-footer .btn-primary, .modal .btn-primary[form="create-form"]').first().click();
  await p.waitForURL(/\/browse\/IT-\d+/);
  const key = p.url().split('/').pop();
  assert.equal((await ticket(key)).reporter.displayName, 'Karl Kunde');
  await p.locator('.history, .activity').first().waitFor().catch(() => {});

  // change later
  await p.getByRole('button', { name: 'Melder ändern' }).click();
  await p.keyboard.type('lisa');
  await p.locator('.picker-menu .menu-item', { hasText: 'Lisa Lager' }).click();
  const confirm = p.locator('.modal', { hasText: 'wird Melder von' });
  await confirm.waitFor();
  await confirm.locator('input[type=checkbox]').uncheck();
  await confirm.getByRole('button', { name: 'Melder ändern' }).click();
  await p.waitForFunction(() => document.querySelector('.reporter-row')?.textContent.includes('Lisa Lager'));
  const tk = await ticket(key);
  assert.equal(tk.reporter.displayName, 'Lisa Lager');
  assert.ok(tk.participants.some((x) => x.displayName === 'Karl Kunde'), 'Karl keeps access');
  assert.deepEqual(errors, []);
});

test('Desktop: users see no reporter field', { skip }, async () => {
  const { p, errors } = await page('karl');
  await p.goto(`${S.base}/requests`);
  await p.locator('.topbar-create').click();
  await p.locator('.modal input[required]').first().waitFor();
  assert.equal(await p.locator('.modal .reporter-field').count(), 0);
  assert.deepEqual(errors, []);
});

test('Phone: new ticket for someone else', { skip }, async () => {
  const { p, errors } = await page('anna', true);
  await p.goto(`${S.base}/m/new/report`);
  await p.locator('.m-reporter').waitFor();
  assert.match(await p.locator('.m-reporter').textContent(), /Ich \(anna\)/);
  await p.locator('.m-reporter').tap();
  await p.locator('.m-sheet-search-input').fill('lisa');
  await p.locator('.m-person-hit', { hasText: 'Lisa Lager' }).tap();
  await p.waitForFunction(() => document.querySelector('.m-reporter')?.textContent.includes('Lisa Lager'));
  await p.fill('input[name=title]', 'Monitor per Telefon');
  await p.locator('.m-foot .m-btn-primary').tap();
  await p.waitForURL(/\/m\/t\/IT-\d+/);
  const key = decodeURIComponent(p.url().split('/').pop());
  assert.equal((await ticket(key)).reporter.displayName, 'Lisa Lager');
  assert.deepEqual(errors, []);
});
