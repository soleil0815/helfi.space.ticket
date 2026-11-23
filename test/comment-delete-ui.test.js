// Deleting a comment in the browser (desktop and phone): confirmation, placeholder in place,
// a reply being written stays. Needs Playwright with Chromium – skipped if missing.
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

let S; let browser; let key; let karl;
before(async () => {
  S = await startServer('cdelui');
  karl = await S.user('karl', 'user');
  key = (await karl('POST', '/api/tickets', { projectId: 1, title: 'Monitor flackert', description: 'Seit heute' })).body.ticket.key;
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

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

test('Desktop: author deletes own comment after confirming; the draft reply stays', { skip }, async () => {
  const c = (await karl('POST', `/api/tickets/${key}/comments`, { body: 'Versehentlich gepostet' })).body.comment;
  const other = (await S.admin('POST', `/api/tickets/${key}/comments`, { body: 'Antwort vom Support' })).body.comment;
  const { p, errors } = await page('karl');
  await p.goto(`${S.base}/browse/${key}`);
  await p.waitForSelector(`[data-comment="${c.id}"]`);
  assert.equal(await p.$(`[data-comment="${other.id}"] .comment-delete`), null, 'no button on someone else\'s comment');
  const ed = p.locator('.composer .kb-editable');
  await ed.click();
  await p.keyboard.type('Mein Entwurf');
  await p.locator(`[data-comment="${c.id}"] .comment-delete`).click({ force: true });
  await p.waitForSelector('.modal >> text=Kommentar löschen?');
  assert.match(await p.textContent('.modal'), /nicht zurückholen/);
  // cancel first: nothing happens
  await p.click('.modal-foot >> text=Abbrechen');
  assert.equal(S.db.prepare('SELECT deleted_at FROM comments WHERE id=?').get(c.id).deleted_at, null);
  await p.locator(`[data-comment="${c.id}"] .comment-delete`).click({ force: true });
  await p.click('.modal-foot .btn-danger');
  await p.waitForSelector(`[data-comment="${c.id}"] .comment-deleted`);
  assert.match(await p.textContent(`[data-comment="${c.id}"]`), /Kommentar gelöscht von karl am/);
  assert.doesNotMatch(await p.textContent(`[data-comment="${c.id}"]`), /Versehentlich/);
  assert.match(await ed.textContent(), /Mein Entwurf/, 'the reply being written stays');
  assert.ok(S.db.prepare('SELECT deleted_at FROM comments WHERE id=?').get(c.id).deleted_at);
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('Phone: agent deletes a comment in the sheet, placeholder shows in place', { skip }, async () => {
  const c = (await karl('POST', `/api/tickets/${key}/comments`, { body: 'Bitte löschen' })).body.comment;
  const { p, errors } = await page('admin', true);
  await p.goto(`${S.base}/m/t/${key}`);
  await p.waitForSelector(`.m-msg[data-id="${c.id}"] .m-msg-del`);
  await p.click(`.m-msg[data-id="${c.id}"] .m-msg-del`);
  await p.waitForSelector('.m-sheet >> text=Kommentar löschen?');
  await p.click('.m-sheet-foot .m-btn-danger');
  await p.waitForSelector(`.m-msg[data-id="${c.id}"] .m-msg-deleted`);
  assert.match(await p.textContent(`.m-msg[data-id="${c.id}"]`), /Kommentar gelöscht von admin am/);
  assert.equal(await p.$(`.m-msg[data-id="${c.id}"] .m-msg-del`), null);
  assert.ok(S.db.prepare('SELECT deleted_at FROM comments WHERE id=?').get(c.id).deleted_at);
  assert.deepEqual(errors, []);
  await p.context().close();
});
