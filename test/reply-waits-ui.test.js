// "Then wait for the customer" in the browser (desktop and phone): ticked by default → "Waiting",
// unticked → status stays; hidden for internal notes and for tickets not open/in progress.
// Needs Playwright with Chromium – skipped if missing.
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
  S = await startServer('replywaitui');
  karl = await S.user('karl', 'user');
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

const mk = async (title) => (await karl('POST', '/api/tickets', { projectId: 1, title })).body.ticket.key;
const status = async (key) => (await S.admin('GET', `/api/tickets/${key}`)).body.ticket.status;

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1360, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => { errors.push(`native dialog: ${d.message()}`); d.dismiss(); });
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Desktop: reply waits for the customer by default, unticked it does not; hidden for notes', { skip }, async () => {
  const a = await mk('Monitor flackert');
  const b = await mk('Maus hakt');
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/browse/${a}`);
  const toggle = p.locator('.composer-wait');
  await toggle.waitFor();
  assert.match(await toggle.textContent(), /Danach auf Kunden warten/);
  assert.equal(await toggle.locator('input').isChecked(), true);
  // internal note: no switch (a note never changes the status)
  await p.click('.composer-modes >> text=Interne Notiz');
  assert.equal(await toggle.isVisible(), false);
  await p.click('.composer-modes >> text=Antworten');
  assert.equal(await toggle.isVisible(), true);
  await p.locator('.composer .kb-editable').click();
  await p.keyboard.type('Ist das Kabel fest?');
  await p.click('.composer .btn-primary');
  await p.waitForSelector('.comment >> text=Ist das Kabel fest?');
  assert.equal(await status(a), 'waiting');
  // Now waiting: the switch is gone (it would change nothing)
  await p.waitForSelector('.status-btn.status-waiting');
  assert.equal(await p.locator('.composer-wait').count(), 0);

  await p.goto(`${S.base}/browse/${b}`);
  await p.locator('.composer-wait input').uncheck();
  await p.locator('.composer .kb-editable').click();
  await p.keyboard.type('Ich melde mich morgen.');
  await p.click('.composer .btn-primary');
  await p.waitForSelector('.comment >> text=Ich melde mich morgen.');
  assert.equal(await status(b), 'open');
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('Phone: switch below the reply bar, big enough to tap, works both ways', { skip }, async () => {
  const a = await mk('Drucker offline');
  const b = await mk('Kein WLAN');
  const { p, errors } = await page('admin', true);
  await p.goto(`${S.base}/m/t/${b}`);
  const toggle = p.locator('.m-reply-wait');
  await toggle.waitFor();
  const box = await toggle.boundingBox();
  assert.ok(box.height >= 44, `touch target ${box.height}px`);
  await toggle.tap(); // unticked
  await p.locator('.m-reply-input').click();
  await p.keyboard.type('Schaue ich mir an.');
  await p.click('.m-reply-send');
  await p.waitForSelector('.m-msg >> text=Schaue ich mir an.');
  assert.equal(await status(b), 'open');

  await p.goto(`${S.base}/m/t/${a}`);
  await p.locator('.m-reply-wait').waitFor();
  assert.equal(await p.locator('.m-reply-wait input').isChecked(), true);
  await p.click('.m-reply-mode-note');
  assert.equal(await p.locator('.m-reply-wait').isVisible(), false);
  await p.click('.m-reply-mode:not(.m-reply-mode-note)');
  await p.locator('.m-reply-input').click();
  await p.keyboard.type('Ist er eingeschaltet?');
  await p.click('.m-reply-send');
  await p.waitForSelector('.m-msg >> text=Ist er eingeschaltet?');
  assert.equal(await status(a), 'waiting');
  // Reloaded as waiting: the switch is hidden
  await p.waitForFunction(() => document.querySelector('.m-reply-wait')?.hidden === true);
  assert.deepEqual(errors, []);
  await p.context().close();
});
