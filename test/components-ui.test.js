// Components in the browser: admin page (examples, test field, order), ticket field, list filter, phone.
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

let S; let browser; let project; let karl;
before(async () => {
  if (!chromium) return;
  S = await startServer('componentsui');
  await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  project = (await S.admin('GET', '/api/projects')).body.projects[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1360, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Admin: take over examples, set the lead, test the rules, reorder', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/components`);
  await p.waitForSelector('.empty-state');
  await p.click('text=Beispiele übernehmen');
  await p.waitForSelector('.modal .comp-examples');
  await p.check('.modal input[value="it.vpn"]');
  await p.check('.modal input[value="it.printer"]');
  await p.click('.modal .btn-primary');
  await p.waitForSelector('.comp-table');
  assert.deepEqual(await p.$$eval('.comp-table tbody strong', (x) => x.map((e) => e.textContent)), ['Drucker & Scanner', 'VPN & Fernzugriff']);
  // Edit: lead
  await p.click('.comp-table tbody tr:nth-child(2) [aria-label="Komponente bearbeiten"]');
  await p.waitForSelector('#comp-form');
  await p.selectOption('#comp-form select >> nth=0', String(S.ids.anna));
  await p.click('.modal button[type=submit]');
  await p.waitForSelector('.comp-table tbody tr:nth-child(2) >> text=anna');
  // Test field
  await p.fill('.comp-test input:not([type=email])', 'FortiClient verbindet nicht');
  await p.click('.comp-test button[type=submit]');
  await p.waitForSelector('.comp-test-result strong');
  const res = await p.$eval('.comp-test-result', (e) => e.textContent);
  assert.match(res, /VPN & Fernzugriff \(Schlagwörter: forticlient\)/);
  assert.match(res, /geht an anna/);
  // Order: VPN up
  await p.click('.comp-table tbody tr:nth-child(2) [aria-label="Nach oben"]');
  await p.waitForFunction(() => document.querySelector('.comp-table tbody tr strong')?.textContent === 'VPN & Fernzugriff');
  assert.deepEqual(errors, []);
});

test('Agent: component in the ticket, changeable; history, list filter and column', { skip }, async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'VPN bricht ab' })).body.ticket;
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/${tk.key}`);
  await p.waitForSelector('.ticket-side');
  const row = p.locator('.detail-row', { hasText: 'Komponente' });
  assert.equal((await row.locator('.detail-value').textContent()).trim(), 'VPN & Fernzugriff');
  await p.click('.tabs .tab >> nth=1');
  await p.waitForSelector('.history >> text=Schlagwörter: vpn');
  // Nobody is assigned automatically – the component's person is information only
  assert.equal((await p.$$eval('.history', (x) => x.map((e) => e.textContent).join(' '))).includes('verantwortlich für'), false);
  // change via the dropdown
  await row.locator('.detail-pick').click();
  await p.click('.menu >> text=Drucker & Scanner');
  await p.waitForFunction(() => [...document.querySelectorAll('.detail-row')].some((r) => r.textContent.includes('Komponente') && r.textContent.includes('Drucker & Scanner')));
  // list: filter and column
  await p.goto(`${S.base}/issues?project=${project.key}`);
  await p.waitForSelector('table.issues');
  assert.ok((await p.$$eval('table.issues th', (x) => x.map((e) => e.textContent))).includes('Komponente'));
  await p.selectOption('select[aria-label="Komponente"]', 'none');
  await p.waitForURL(/component=none/);
  assert.deepEqual(errors, []);
});

test('Phone: component under details, choose from a sheet', { skip }, async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'Toner leer' })).body.ticket;
  const { p, errors } = await page('anna', true);
  await p.goto(`${S.base}/m/t/${tk.key}`);
  await p.waitForSelector('.m-details-btn');
  await p.tap('.m-details-btn');
  await p.waitForSelector('.m-details');
  const dts = await p.$$eval('.m-details dt', (x) => x.map((e) => e.textContent));
  assert.ok(dts.includes('Komponente'));
  await p.tap('.m-drow-edit >> text=Drucker & Scanner');
  await p.waitForSelector('.m-choices');
  await p.tap('.m-choice-row >> text=Keine');
  for (let i = 0; i < 40; i++) {
    const r = await S.admin('GET', `/api/tickets/${tk.key}`);
    if (r.body.ticket.component === null) break;
    await new Promise((x) => setTimeout(x, 100));
  }
  assert.equal((await S.admin('GET', `/api/tickets/${tk.key}`)).body.ticket.component, null);
  assert.deepEqual(errors, []);
});
