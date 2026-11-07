// Rejecting and closing as duplicate in the browser: ticket status menu, list (bulk), phone.
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

let S; let browser; let karl;
before(async () => {
  if (!chromium) return;
  S = await startServer('resolutionsui');
  await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1400, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}
const mk = async (title) => (await karl('POST', '/api/tickets', { title })).body.ticket.key;
const row = (key) => S.db.prepare("SELECT t.* FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number=?").get(key);

test('Desktop: reject from the status menu (reason required), then a duplicate with the picker', { skip }, async () => {
  const a = await mk('Bitte Spielekonsole');
  const orig = await mk('Drucker druckt nicht');
  const dup = await mk('Drucker kaputt');
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/${a}`);
  await p.locator('.status-btn').click();
  await p.getByRole('menuitem', { name: 'Ablehnen …' }).click();
  const dlg = p.locator('.modal');
  await dlg.getByRole('button', { name: 'Ablehnen' }).click();
  await dlg.locator('.form-error', { hasText: 'Begründung' }).waitFor();
  await dlg.locator('textarea').fill('Leider nicht vorgesehen.');
  await dlg.getByRole('button', { name: 'Ablehnen' }).click();
  await p.locator('.status-btn.status-rejected', { hasText: 'Abgelehnt' }).waitFor();
  assert.equal(row(a).resolution, 'rejected');

  await p.goto(`${S.base}/browse/${dup}`);
  await p.locator('.status-btn').click();
  await p.getByRole('menuitem', { name: 'Als Duplikat schließen …' }).click();
  await p.locator('.modal .link-target').fill(orig);
  await p.locator('.modal').getByRole('button', { name: 'Als Duplikat schließen' }).click();
  await p.locator('.status-btn.status-duplicate').waitFor();
  assert.equal(row(dup).duplicate_of, row(orig).id);
  await p.locator('.tabs').getByText('Verlauf').click();
  await p.locator('.history', { hasText: `Duplikat von ${orig}` }).first().waitFor();
  assert.deepEqual(errors, []);
});

test('List: reject several at once; status column shows the resolution', { skip }, async () => {
  const keys = [await mk('Wunsch eins'), await mk('Wunsch zwei')];
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/issues?status=open&q=Wunsch`);
  for (const k of keys) await p.locator('tr', { hasText: k }).locator('input[type=checkbox]').check();
  await p.locator('.bulk-bar').getByRole('button', { name: 'Status' }).click();
  await p.getByRole('menuitem', { name: 'Ablehnen …' }).click();
  await p.locator('.modal textarea').fill('Hallo {melder}, leider nein.');
  await p.locator('.modal').getByRole('button', { name: 'Ablehnen' }).click();
  await p.locator('.toast', { hasText: '2 Tickets abgelehnt' }).waitFor();
  for (const k of keys) assert.equal(row(k).resolution, 'rejected');
  await p.goto(`${S.base}/issues?status=done&resolution=rejected`);
  await p.locator('.lozenge-rejected').first().waitFor();
  assert.ok(await p.locator('tr', { hasText: keys[0] }).count());
  assert.deepEqual(errors, []);
});

test('Phone: reject from the status sheet', { skip }, async () => {
  const k = await mk('Neue Kaffeemaschine');
  const { p, errors } = await page('anna', true);
  await p.goto(`${S.base}/m/t/${k}`);
  await p.locator('.m-status-btn').tap();
  await p.locator('.m-choice-row[data-value=rejected]').tap();
  await p.locator('.m-sheet-resolve textarea').fill('Gibt es schon im 1. OG.');
  await p.locator('.m-sheet-resolve').getByRole('button', { name: 'Ablehnen' }).tap();
  await p.waitForFunction(() => document.querySelector('.m-status-btn .lozenge-rejected'));
  assert.equal(row(k).resolution, 'rejected');
  assert.deepEqual(errors, []);
});
