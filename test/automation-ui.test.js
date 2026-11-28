// Automation in the browser: page for admins and for a deputy (sidebar), example rules, editor with
// preview, switching on, history entry "Automation: <rule>" and the badge on automatic comments.
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
  S = await startServer('autoui');
  karl = await S.user('karl', 'user');
  await S.user('otto', 'user');
  S.db.prepare('UPDATE projects SET deputy_id=? WHERE id=1').run(S.ids.otto);
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

test('Admin: take over an example, edit with preview, switch on – it acts, the history names it', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/automation`);
  await p.waitForSelector('text=Noch keine Regeln');
  await p.click('[data-auto-examples]');
  await p.click('[data-template="account-priority"] >> text=Übernehmen');
  await p.waitForSelector('[data-rule] >> text=Konto gesperrt oder Kennwort: Priorität hoch');
  assert.equal(await p.locator('[data-rule-toggle]').isChecked(), false, 'arrives switched off');
  // A matching ticket exists → the preview shows it, nothing changes
  const k = (await karl('POST', '/api/tickets', { projectId: 1, title: 'Kennwort vergessen' })).body.ticket.key;
  await p.click('[data-rule] button[title="Regel bearbeiten"]');
  await p.click('[data-auto-preview]');
  await p.waitForSelector(`.auto-preview >> text=${k}`);
  assert.equal((await S.admin('GET', `/api/tickets/${k}`)).body.ticket.priority, 'medium');
  await p.check('text=Regel einschalten');
  await p.click('.modal-foot >> text=Speichern');
  await p.waitForSelector('.toast >> text=Gespeichert');
  assert.equal(await p.locator('[data-rule-toggle]').isChecked(), true);
  // It acts on a new ticket; the history says who did it
  const k2 = (await karl('POST', '/api/tickets', { projectId: 1, title: 'Konto gesperrt' })).body.ticket.key;
  await new Promise((r) => setTimeout(r, 100));
  await p.goto(`${S.base}/browse/${k2}`);
  await p.click('.activity-bar >> text=Verlauf');
  await p.waitForSelector('.history >> text=Automatisierung: Konto gesperrt oder Kennwort: Priorität hoch');
  // Switch off from the list
  await p.goto(`${S.base}/admin/automation`);
  await p.click('.switch');
  await p.waitForSelector('.toast >> text=Regel ausgeschaltet');
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('New rule in the editor: reply + note on customer reply; the badge shows on the automatic comment', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/automation`);
  await p.click('[data-auto-new]');
  await p.fill('[data-auto-name]', 'Danke sagen');
  await p.selectOption('[data-auto-trigger]', 'customerReplied');
  await p.selectOption('[data-auto-action-type]', 'reply');
  await p.fill('[data-auto-text]', 'Danke {kunde}, wir schauen es uns an.');
  await p.check('text=Regel einschalten');
  await p.click('.modal-foot >> text=Erstellen');
  await p.waitForSelector('[data-rule] >> text=Danke sagen');
  const k = (await karl('POST', '/api/tickets', { projectId: 1, title: 'Bildschirm schwarz' })).body.ticket.key;
  await karl('POST', `/api/tickets/${k}/comments`, { body: 'Immer noch schwarz' });
  await new Promise((r) => setTimeout(r, 150));
  await p.goto(`${S.base}/browse/${k}`);
  await p.waitForSelector('.comment >> text=Danke karl, wir schauen es uns an.');
  await p.waitForSelector('[data-automation-badge]');
  // The customer sees it from the ticket system, without the rule's name
  const { p: kp } = await page('karl');
  await kp.goto(`${S.base}/browse/${k}`);
  await kp.waitForSelector('.comment >> text=Danke karl');
  assert.equal(await kp.locator('.comment >> text=Danke sagen').count(), 0);
  assert.equal(await kp.locator('[data-automation-badge]').count(), 0);
  await kp.context().close();
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('Deputy (no admin): sidebar entry and own project; phone history names the rule', { skip }, async () => {
  const { p, errors } = await page('otto');
  await p.goto(`${S.base}/board`);
  await p.click('.nav-item >> text=Automatisierung');
  await p.waitForSelector('h1 >> text=Automatisierung');
  await p.waitForSelector('[data-rule] >> text=Danke sagen');
  assert.equal(await p.locator('option >> text=Alle Projekte').count(), 0, 'no "all projects" for a deputy');
  assert.deepEqual(errors, []);
  await p.context().close();
  const k = S.db.prepare("SELECT p.key || '-' || t.number k FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.title='Konto gesperrt'").get().k;
  const { p: m, errors: e2 } = await page('admin', true);
  await m.goto(`${S.base}/m/t/${k}`);
  await m.click('.m-activity-head button:nth-child(2)');
  await m.waitForSelector('text=Automatisierung: Konto gesperrt oder Kennwort: Priorität hoch');
  assert.deepEqual(e2, []);
  await m.context().close();
});
