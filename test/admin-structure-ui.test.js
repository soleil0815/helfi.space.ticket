// Administration grouped by topic: groups in the column and in the phone's select, old addresses
// lead to the new place, settings moved between pages still save.
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
  S = await startServer('adminstructure');
  await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(viewport = { width: 1360, height: 1000 }) {
  const c = await browser.newContext({ viewport, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}
const setting = async (key) => (await S.admin('GET', '/api/admin/settings')).body.settings[key];

test('Groups in the column; /admin opens the projects', { skip }, async () => {
  const { p, errors } = await page();
  await p.goto(`${S.base}/admin`);
  await p.waitForSelector('.admin-nav a.active >> text=Projekte');
  assert.deepEqual(await p.locator('.admin-nav-head').allTextContents(), ['Organisation', 'Tickets', 'E-Mail', 'Anmeldung & Sicherheit', 'Erscheinungsbild', 'System']);
  const items = await p.locator('.admin-nav-group').evaluateAll((gs) => gs.map((g) => [...g.querySelectorAll('a')].map((a) => a.getAttribute('href'))));
  assert.deepEqual(items, [
    ['/admin/projects', '/admin/components', '/admin/users'],
    ['/admin/tickets', '/admin/sla', '/admin/change', '/admin/catalog', '/admin/templates'],
    ['/admin/mail-in', '/admin/mail-out'],
    ['/admin/ldap', '/admin/sso', '/admin/mfa', '/admin/registration'],
    ['/admin/appearance'],
    ['/admin/ai', '/admin/import', '/admin/system'],
  ]);
  assert.deepEqual(errors, []);
});

test('Old addresses lead to the new place', { skip }, async () => {
  const { p, errors } = await page();
  for (const [from, to] of [['general', 'appearance'], ['security', 'mfa'], ['mail', 'mail-in']]) {
    await p.goto(`${S.base}/admin/${from}`);
    await p.waitForURL(new RegExp(`/admin/${to}$`));
    await p.waitForSelector(`.admin-nav a.active[href="/admin/${to}"]`);
  }
  assert.deepEqual(errors, []);
});

test('Moved settings: default project, self-service/reminder/survey, name; mail pages split', { skip }, async () => {
  const { p, errors } = await page();
  await p.goto(`${S.base}/admin/projects`);
  const def = p.locator('.default-project select');
  await def.waitFor();
  await def.selectOption('HM');
  await p.waitForSelector('.toast >> text=Gespeichert');
  assert.equal(await setting('general.defaultProject'), 'HM');

  await p.goto(`${S.base}/admin/tickets`);
  await p.waitForSelector('[data-reminder-run]');
  await p.fill('.reminder-settings input[type=number]', '3');
  await p.click('.reminder-settings .btn-primary');
  await p.waitForSelector('.toast >> text=Gespeichert');
  assert.equal(await setting('reminder.unassignedDays'), 3);

  await p.goto(`${S.base}/admin/appearance`);
  await p.locator('.admin-body input').first().fill('Helpdesk Institut');
  await p.locator('.admin-body .panel').first().locator('.btn-primary').click();
  await p.waitForSelector('.toast >> text=Gespeichert');
  assert.equal(await setting('general.title'), 'Helpdesk Institut');
  assert.equal(await setting('general.defaultProject'), 'HM', 'saving the name does not touch the default project');

  await p.goto(`${S.base}/admin/mail-out`);
  await p.waitForSelector('h2 >> text=E-Mail-Versand (SMTP)');
  assert.equal(await p.locator('[data-reminder-run]').count(), 0);
  await p.goto(`${S.base}/admin/mail-in`);
  await p.waitForSelector('.admin-body h2 >> nth=1');
  assert.equal(await p.locator('.admin-body h2').count(), 2, 'incoming + loop protection');
  await p.goto(`${S.base}/admin/registration`);
  await p.waitForSelector('.admin-body h2');
  assert.equal(await p.locator('.admin-body h2').count(), 1);
  assert.deepEqual(errors, []);
});

test('Phone: select with the same groups', { skip }, async () => {
  const { p, errors } = await page({ width: 390, height: 844 });
  await p.goto(`${S.base}/admin/mfa`);
  const sel = p.locator('.admin-nav-select');
  await sel.waitFor();
  assert.equal(await sel.inputValue(), 'mfa');
  assert.equal(await sel.locator('optgroup').count(), 6);
  await sel.selectOption('mail-out');
  await p.waitForURL(/\/admin\/mail-out$/);
  assert.deepEqual(errors, []);
});
