// "Possible duplicate" hint in the browser: close as duplicate with the original filled in,
// "Not a duplicate", and the phone banner. The AI itself is tested in ai-duplicates.test.js.
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
  S = await startServer('aidupui');
  await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

const mk = async (title) => (await karl('POST', '/api/tickets', { title })).body.ticket;
const suggest = (tk, orig) => S.db.prepare("INSERT INTO duplicate_suggestions(ticket_id, original_id, reason, model, state) VALUES (?,?,?,?,'pending')").run(tk.id, orig.id, 'gleicher Drucker', 'test-model');
async function page(mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1400, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'anna', password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Desktop: close as duplicate from the hint, dismiss another one', { skip }, async () => {
  const orig = await mk('Drucker 204 druckt nicht');
  const a = await mk('Drucker Raum 204 Papierstau');
  const b = await mk('Drucker 204 Toner leer');
  suggest(a, orig); suggest(b, orig);
  const { p, errors } = await page();
  await p.goto(`${S.base}/browse/${a.key}`);
  const hint = p.locator('.ai-duplicate');
  await hint.getByText(orig.key).waitFor();
  await hint.getByRole('button', { name: 'Als Duplikat schließen' }).click();
  assert.equal(await p.locator('.modal .link-target').inputValue(), orig.key, 'original filled in');
  await p.locator('.modal').getByRole('button', { name: 'Als Duplikat schließen' }).click();
  await p.locator('.status-btn.status-duplicate').waitFor();
  assert.equal(S.db.prepare('SELECT state FROM duplicate_suggestions WHERE ticket_id=?').get(a.id).state, 'accepted');
  assert.equal(await p.locator('.ai-duplicate').count(), 0);

  await p.goto(`${S.base}/browse/${b.key}`);
  await p.locator('.ai-duplicate').getByRole('button', { name: 'Kein Duplikat' }).click();
  await p.waitForFunction(() => !document.querySelector('.ai-duplicate'));
  assert.equal(S.db.prepare('SELECT state FROM duplicate_suggestions WHERE ticket_id=?').get(b.id).state, 'rejected');
  assert.deepEqual(errors, []);
});

test('Phone: banner opens the duplicate sheet with the original', { skip }, async () => {
  const orig = await mk('VPN bricht ab');
  const a = await mk('VPN trennt ständig');
  suggest(a, orig);
  const { p, errors } = await page(true);
  await p.goto(`${S.base}/m/t/${a.key}`);
  await p.locator('.m-ai-duplicate').getByRole('button', { name: 'Als Duplikat schließen' }).tap();
  const sheet = p.locator('.m-sheet-resolve');
  assert.equal(await sheet.locator('input').inputValue(), orig.key);
  await sheet.getByRole('button', { name: 'Als Duplikat schließen' }).tap();
  await p.waitForFunction(() => document.querySelector('.m-status-btn .lozenge-duplicate'));
  assert.deepEqual(errors, []);
});
