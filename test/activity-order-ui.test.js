// Order of the ticket activity per person: newest first (default) or oldest first like a chat –
// switch in the ticket and in the profile, saved in the account; the reply box moves along and
// keeps a reply already being written.
// The browser part needs Playwright with Chromium (not part of the dependencies) – skipped if missing.
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

let S; let browser; let key; let anna;
before(async () => {
  S = await startServer('activityorder');
  anna = await S.user('anna', 'agent');
  const r = await S.admin('POST', '/api/tickets', { projectId: 1, type: 'task', title: 'Drucker', description: '' });
  key = r.body.ticket.key;
  await S.admin('POST', `/api/tickets/${key}/comments`, { body: 'Erster Kommentar', internal: false });
  // distinct timestamps
  await new Promise((res) => setTimeout(res, 20));
  await S.admin('POST', `/api/tickets/${key}/comments`, { body: 'Zweiter Kommentar', internal: false });
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

test('API: order saved per person, validated', async () => {
  assert.equal((await anna('GET', '/api/me')).body.user.activityOrder, 'newest');
  assert.equal((await anna('PATCH', '/api/me', { activityOrder: 'sideways' })).status, 400);
  const r = await anna('PATCH', '/api/me', { activityOrder: 'oldest' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.activityOrder, 'oldest');
  assert.equal(S.db.prepare('SELECT activity_order FROM users WHERE id=?').get(S.ids.anna).activity_order, 'oldest');
  await anna('PATCH', '/api/me', { activityOrder: 'newest' });
  assert.equal(S.db.prepare('SELECT activity_order FROM users WHERE id=?').get(S.ids.anna).activity_order, null);
});

async function page(username) {
  const c = await browser.newContext({ viewport: { width: 1360, height: 1000 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}
const order = (p) => p.$$eval('.ticket-section .activity .comment', (x) => x.map((c) => c.textContent.includes('Erster') ? 1 : 2));
// Is the reply box above (true) or below the list?
const boxFirst = (p) => p.$eval('.ticket-section .activity', (list) => !!list.previousElementSibling?.classList.contains('composer'));

test('Ticket: switch reverses the list, moves the reply box, keeps the draft; remembered', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/${key}`);
  await p.waitForSelector('[data-activity-order] >> text=Neueste oben');
  assert.deepEqual(await order(p), [2, 1]);
  assert.equal(await boxFirst(p), true);
  // Start a reply, then switch
  const ed = p.locator('.composer .kb-editable');
  await ed.click();
  await p.keyboard.type('Entwurf bleibt');
  await p.click('[data-activity-order]');
  await p.waitForSelector('[data-activity-order] >> text=Älteste oben');
  assert.deepEqual(await order(p), [1, 2]);
  assert.equal(await boxFirst(p), false, 'reply box below the list');
  assert.match(await ed.textContent(), /Entwurf bleibt/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(S.db.prepare('SELECT activity_order FROM users WHERE id=?').get(S.ids.anna).activity_order, 'oldest');
  // Other tabs too, and after reloading
  await p.goto(`${S.base}/browse/${key}`);
  await p.waitForSelector('[data-activity-order] >> text=Älteste oben');
  assert.deepEqual(await order(p), [1, 2]);
  await p.click('.tabs .tab >> text=Alle');
  await p.waitForSelector('[data-activity-order] >> text=Älteste oben');
  const times = await p.$$eval('.ticket-section .activity > *', (x) => x.length);
  assert.ok(times >= 2);
  assert.deepEqual(errors, []);
});

test('Profile: choosing the order there', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/profile`);
  const sel = p.locator('[data-activity-order-pref]');
  await sel.waitFor();
  assert.equal(await sel.inputValue(), 'oldest');
  await sel.selectOption('newest');
  await p.waitForSelector('.toast >> text=Gespeichert');
  assert.equal(S.db.prepare('SELECT activity_order FROM users WHERE id=?').get(S.ids.anna).activity_order, null);
  await p.goto(`${S.base}/browse/${key}`);
  await p.waitForSelector('[data-activity-order] >> text=Neueste oben');
  assert.deepEqual(await order(p), [2, 1]);
  assert.deepEqual(errors, []);
});
