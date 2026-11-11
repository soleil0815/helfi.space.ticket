// "Done" with an optional closing comment: desktop status menu (reply / internal note / nothing, Ctrl+Enter)
// and the phone sheet with the reply/note switch. Needs Playwright with Chromium – skipped if missing.
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
  S = await startServer('donecomment');
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
const comments = (key) => S.db.prepare('SELECT body, internal FROM comments WHERE ticket_id=? ORDER BY id').all(row(key).id);

async function openDone(p, key) {
  await p.goto(`${S.base}/browse/${key}`);
  await p.locator('.status-btn').click();
  await p.getByRole('menuitem', { name: 'Erledigt' }).click();
  const dlg = p.locator('.modal', { has: p.locator('#done-form') });
  await dlg.waitFor();
  return dlg;
}

test('Desktop: "Done" asks for a closing reply and closes in one step', { skip }, async () => {
  const k = await mk('Drucker druckt nicht');
  const { p, errors } = await page('anna');
  const dlg = await openDone(p, k);
  assert.equal(await dlg.locator('h2').textContent(), `${k} erledigen`);
  assert.equal(row(k).status, 'open', 'nothing happens before the dialog is confirmed');
  assert.equal(await dlg.locator('[data-done-kind=reply]').getAttribute('aria-pressed'), 'true', 'reply is the default');
  await dlg.locator('textarea').fill('Hallo {melder}, der Drucker läuft wieder.');
  await dlg.locator('[data-done-submit]').click();
  await p.locator('.status-btn.status-done').waitFor();
  assert.equal(row(k).status, 'done');
  const c = comments(k);
  assert.equal(c.length, 1);
  assert.equal(c[0].internal, 0);
  assert.match(c[0].body, /^Hallo .+, der Drucker läuft wieder\.$/);
  assert.doesNotMatch(c[0].body, /\{melder\}/, 'placeholder filled');
  await p.locator('.toast', { hasText: `${k} erledigt` }).waitFor();
  assert.deepEqual(errors, []);
});

test('Desktop: internal note with Ctrl+Enter; cancel changes nothing; without text simply done', { skip }, async () => {
  const a = await mk('Monitor flackert');
  const b = await mk('Maus kaputt');
  const c = await mk('Tastatur fehlt');
  const { p, errors } = await page('anna');
  // internal note
  let dlg = await openDone(p, a);
  await dlg.locator('[data-done-kind=note]').click();
  assert.match(await dlg.locator('label[for=done-comment]').textContent(), /Interne Notiz/);
  await dlg.locator('textarea').fill('Kabel getauscht, Seriennummer notiert.');
  await dlg.locator('textarea').press('Control+Enter');
  await p.locator('.status-btn.status-done').waitFor();
  assert.deepEqual(comments(a).map((x) => x.internal), [1]);
  // cancel
  dlg = await openDone(p, b);
  await dlg.getByRole('button', { name: 'Abbrechen' }).click();
  await dlg.waitFor({ state: 'detached' });
  assert.equal(row(b).status, 'open');
  // without text
  dlg = await openDone(p, c);
  await dlg.locator('[data-done-submit]').click();
  await p.locator('.status-btn.status-done').waitFor();
  assert.equal(comments(c).length, 0);
  assert.equal(row(c).status, 'done');
  // Other statuses still change right away
  await p.locator('.status-btn').click();
  await p.getByRole('menuitem', { name: 'In Arbeit' }).click();
  await p.locator('.status-btn.status-in_progress').waitFor();
  assert.equal(await p.locator('#done-form').count(), 0);
  assert.deepEqual(errors, []);
});

test('Phone: "Done" sheet with reply / internal note', { skip }, async () => {
  const k = await mk('WLAN im Besprechungsraum');
  const { p, errors } = await page('anna', true);
  await p.goto(`${S.base}/m/t/${k}`);
  await p.locator('.m-status-btn').tap();
  await p.locator('.m-choice-row[data-value=done]').tap();
  const sheet = p.locator('.m-sheet-resolve');
  await sheet.waitFor();
  assert.equal(await sheet.locator('[data-done-kind=reply]').getAttribute('aria-pressed'), 'true');
  await sheet.locator('[data-done-kind=note]').tap();
  assert.match(await sheet.locator('.m-field label').textContent(), /Interne Notiz/);
  await sheet.locator('textarea').fill('Access Point neu gestartet.');
  await sheet.getByRole('button', { name: 'Erledigen' }).tap();
  await p.waitForFunction(() => document.querySelector('.m-status-btn .lozenge')?.textContent === 'Erledigt');
  assert.deepEqual(comments(k).map((x) => x.internal), [1]);
  assert.equal(row(k).status, 'done');
  assert.deepEqual(errors, []);
});
