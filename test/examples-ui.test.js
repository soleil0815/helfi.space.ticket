// Examples dialog in the browser: reply templates (admin), knowledge articles (agent), language switch.
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
  S = await startServer('examplesui');
  await S.user('anna', 'agent');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username) {
  const c = await browser.newContext({ viewport: { width: 1400, height: 1000 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Admin: example reply templates in English', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/templates`);
  await p.locator('[data-examples=canned]').click();
  const dlg = p.locator('.modal');
  await dlg.getByText('Eingang bestätigen').waitFor();
  await dlg.getByRole('button', { name: 'English' }).click();
  await dlg.getByText('Confirm receipt').waitFor();
  await dlg.getByRole('button', { name: 'Alle auswählen' }).click(); // all were ticked → untick all
  await dlg.locator('input[value=solved]').check();
  await dlg.getByRole('button', { name: 'Übernehmen' }).click();
  await p.locator('.toast', { hasText: '1 Beispiele übernommen' }).waitFor();
  await p.locator('.template-row', { hasText: 'Solved – please confirm' }).waitFor();
  assert.deepEqual(errors, []);
});

test('Agent: example articles; no examples button for shared templates or the catalog', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/kb`);
  await p.locator('[data-examples=kb]').click();
  await p.locator('.modal').getByRole('button', { name: 'Übernehmen' }).click();
  await p.locator('.toast', { hasText: '5 Beispiele übernommen' }).waitFor();
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM kb_articles WHERE visibility='internal'").get().n, 5);
  await p.goto(`${S.base}/profile`);
  assert.equal(await p.locator('[data-examples]').count(), 0);
  assert.deepEqual(errors, []);
});
