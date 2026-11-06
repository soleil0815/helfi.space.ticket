// Search field with results while typing (top bar and phone): keyboard, matches, recently opened, permissions.
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
  S = await startServer('quicksearch');
  const anna = await S.user('anna', 'agent');
  const karl = await S.user('karl', 'user');
  await S.user('otto', 'user');
  await karl('POST', '/api/tickets', { title: 'Drucker im 2. OG druckt nicht', description: 'Papierstau' });
  await karl('POST', '/api/tickets', { title: 'VPN', description: 'geht nicht' });
  await anna('POST', '/api/tickets/IT-2/comments', { body: 'Druckertreiber neu installiert', internal: true });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({
    viewport: mobile ? { width: 390, height: 780 } : { width: 1280, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    extraHTTPHeaders: { 'X-Helfi-Request': '1' },
  });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const r = await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } });
  assert.equal(r.status(), 200);
  return { p, errors };
}
const options = (p) => p.$$eval('.qs-pop [role=option]', (x) => x.map((i) => i.textContent.replace(/\s+/g, ' ').trim()));

test('Desktop: matches while typing with location, keyboard opens the ticket, Enter without choice shows all', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/issues`);
  const field = '.topbar-search input';
  await p.click(field);
  await p.keyboard.type('druck');
  await p.waitForSelector('.qs-pop .qs-item');
  const opts = await options(p);
  assert.ok(opts.some((o) => o.includes('IT-1') && o.includes('Drucker im 2. OG')), opts.join(' | '));
  assert.ok(opts.some((o) => o.includes('IT-2') && /Interne Notiz|Internal note/.test(o)), `match in an internal note is shown to agents: ${opts.join(' | ')}`);
  assert.match(opts.at(-1), /Alle Treffer|Show all results/);
  assert.equal(await p.$eval(field, (el) => el.getAttribute('aria-expanded')), 'true');
  assert.ok(await p.$eval(field, (el) => el === document.activeElement), 'focus stays in the field');
  await p.keyboard.press('ArrowDown');
  assert.match(await p.$eval(field, (el) => el.getAttribute('aria-activedescendant')), /^qs-/);
  await p.keyboard.press('Enter');
  await p.waitForURL(/\/browse\/IT-1$/);
  // Empty field: recently opened tickets
  await p.click(field);
  await p.waitForSelector('.qs-pop .qs-group');
  assert.match(await p.textContent('.qs-pop'), /(Zuletzt geöffnet|Recently opened).*IT-1/s);
  await p.keyboard.press('Escape');
  assert.equal(await p.$('.qs-pop'), null);
  // Enter without a choice → list with all results (as before)
  await p.keyboard.type('vpn');
  await p.waitForSelector('.qs-pop .qs-item');
  await p.keyboard.press('Enter');
  await p.waitForURL(/\/issues\?q=vpn/);
  // A ticket number offers "open directly"
  await p.click(field);
  await p.fill(field, 'it-2');
  await p.waitForSelector('.qs-pop .qs-direct');
  assert.match(await p.textContent('.qs-direct'), /IT-2 öffnen|Open IT-2/);
  assert.deepEqual(errors, []);
});

test('Users only find their own requests and never internal notes', { skip }, async () => {
  const otto = await page('otto');
  await otto.p.goto(`${S.base}/requests`);
  await otto.p.click('.topbar-search input');
  await otto.p.keyboard.type('druck');
  await otto.p.waitForSelector('.qs-pop .qs-empty, .qs-pop .qs-item');
  assert.ok(!(await otto.p.textContent('.qs-pop')).includes('IT-1'), 'not his ticket');
  const karl = await page('karl');
  await karl.p.goto(`${S.base}/requests`);
  await karl.p.click('.topbar-search input');
  await karl.p.keyboard.type('druckertreiber');
  await karl.p.waitForSelector('.qs-pop .qs-empty, .qs-pop .qs-item');
  assert.ok(!(await karl.p.textContent('.qs-pop')).includes('Druckertreiber neu'), 'internal note stays hidden');
});

test('Phone: results while typing in the Tickets tab, tap opens the ticket', { skip }, async () => {
  const { p, errors } = await page('anna', true);
  await p.goto(`${S.base}/m/tickets`);
  await p.click('.m-search-input');
  await p.keyboard.type('vpn');
  await p.waitForSelector('.qs-pop .qs-item');
  await p.tap('.qs-pop .qs-item:has-text("IT-2")');
  await p.waitForURL(/\/m\/t\/IT-2$/);
  assert.deepEqual(errors, []);
});
