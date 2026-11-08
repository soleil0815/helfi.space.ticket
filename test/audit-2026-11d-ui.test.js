// Audit 2026-11d (UI, proxies, examples): saved filters keep the resolution, status change drops
// the resolution, bulk resolve that fails completely keeps the dialog, backfill cancel errors are
// shown, phone list does not hammer the server on errors and never shows a ticket twice,
// HELFI_TRUST_PROXY with /32, examples route with prototype names.
// Browser parts need Playwright with Chromium – if missing, those tests are skipped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';
import { startServer } from './helpers/server.js';
import { createNetworkPolicy } from '../src/auth/network.js';
import { savedQuery, matchQueue, QUEUES } from '../public/js/queues.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

let S; let browser; let karl;
before(async () => {
  S = await startServer('audit-d-ui');
  await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1400, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { c, p, errors };
}
const mk = async (title) => (await karl('POST', '/api/tickets', { title })).body.ticket.key;

test('Saved filter keeps the resolution filter (same keys as the server)', () => {
  assert.equal(savedQuery('status=done&resolution=rejected'), 'status=done&resolution=rejected');
  // "Recently resolved" is no longer shown as active once a resolution is added
  const recent = QUEUES.find((q) => q.id === 'recent');
  const params = new URLSearchParams({ ...recent.params, resolution: 'rejected' });
  assert.notEqual(matchQueue(params)?.id, 'recent');
});

test('HELFI_TRUST_PROXY with a single address written as /32 or /128: request without X-Forwarded-For is external', () => {
  const v = { 'mfa.internalNetworks': '10.0.10.0/24, fd00::/8', 'mfa.external': 'all', 'mfa.internal': 'none', 'mfa.ownAddresses': '' };
  const p = createNetworkPolicy({ get: (k) => v[k] }, { gateway: null, resolver: async () => [] });
  try {
    const app = express();
    app.set('trust proxy', 'loopback, 10.0.10.5/32, fd00::5/128');
    assert.equal(p.classify({ app, ip: '10.0.10.5', socket: { remoteAddress: '10.0.10.5' }, headers: {} }).reason, 'proxyWithoutClient');
    assert.equal(p.classify({ app, ip: 'fd00::5', socket: { remoteAddress: 'fd00::5' }, headers: {} }).reason, 'proxyWithoutClient');
    // A range stays a range: devices in it that connect directly remain internal
    const range = express();
    range.set('trust proxy', 'loopback, 10.0.10.0/31');
    assert.equal(p.classify({ app: range, ip: '10.0.10.1', socket: { remoteAddress: '10.0.10.1' }, headers: {} }).internal, true);
  } finally { p.stop?.(); }
});

test('Examples route: prototype names are 404, not 500', async () => {
  for (const kind of ['__proto__', 'constructor', 'toString']) {
    assert.equal((await S.admin('GET', `/api/examples/${kind}`)).status, 404, `GET ${kind}`);
    assert.equal((await S.admin('POST', `/api/examples/${kind}`, { keys: [], lang: 'de' })).status, 404, `POST ${kind}`);
  }
});

test('List: switching the status away from "done" drops the resolution filter', { skip }, async () => {
  await mk('Erledigt und abgelehnt');
  const { c, p, errors } = await page('anna');
  await p.goto(`${S.base}/issues?status=done&resolution=rejected`);
  const status = p.locator('.filter-fields select').filter({ has: p.locator('option[value=unresolved]') });
  await status.waitFor();
  await status.selectOption('open');
  await p.waitForFunction(() => new URLSearchParams(location.search).get('status') === 'open');
  assert.equal(new URL(p.url()).searchParams.get('resolution'), null);
  assert.deepEqual(errors, []);
  await c.close();
});

test('Bulk reject where every ticket fails: dialog stays open with the error, selection is kept', { skip }, async () => {
  const keys = [await mk('Fehlschlag eins'), await mk('Fehlschlag zwei')];
  const { c, p, errors } = await page('anna');
  await p.route('**/api/tickets/bulk', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: [], failed: keys.map((key) => ({ key, error: 'Kaputt' })) }) }));
  await p.goto(`${S.base}/issues?status=open&q=Fehlschlag`);
  for (const k of keys) await p.locator('tr', { hasText: k }).locator('input[type=checkbox]').check();
  await p.locator('.bulk-bar').getByRole('button', { name: 'Status' }).click();
  await p.getByRole('menuitem', { name: 'Ablehnen …' }).click();
  await p.locator('.modal textarea').fill('Leider nein.');
  await p.locator('.modal').getByRole('button', { name: 'Ablehnen' }).click();
  await p.locator('.modal .form-error', { hasText: 'Kaputt' }).waitFor();
  assert.equal(await p.locator('.modal textarea').inputValue(), 'Leider nein.');
  await p.locator('.modal').getByRole('button', { name: 'Abbrechen' }).click();
  for (const k of keys) assert.equal(await p.locator('tr', { hasText: k }).locator('input[type=checkbox]').isChecked(), true);
  assert.deepEqual(errors, []);
  await c.close();
});

test('Backfill: a failing cancel shows an error instead of an unhandled rejection', { skip }, async () => {
  await S.admin('POST', '/api/projects/IT/components', { name: 'Drucker' });
  const { c, p, errors } = await page('admin');
  const run = { running: true, project: 'IT', total: 10, done: 1, rules: 0, ai: 1, failed: 0, none: 0 };
  await p.route('**/api/admin/components/backfill/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run }) }));
  await p.route('**/api/admin/components/backfill/cancel', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Abbruch fehlgeschlagen' } }) }));
  await p.goto(`${S.base}/admin/components?project=IT`);
  await p.locator('.backfill button', { hasText: 'Abbrechen' }).click();
  await p.locator('.toast', { hasText: 'Abbruch fehlgeschlagen' }).waitFor();
  assert.deepEqual(errors, []);
  await c.close();
});

test('Phone list: a failing next page shows an error and does not retry in a loop; no ticket twice', { skip }, async () => {
  for (let i = 0; i < 55; i++) await mk(`Handy ${i}`);
  const { c, p, errors } = await page('anna', true);
  let page2 = 0;
  let fail = true;
  await p.route(/\/api\/tickets\?.*page=2/, async (r) => {
    page2 += 1;
    if (fail) return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'weg' } }) });
    // Simulate a ticket that moved between the pages: page 2 repeats the last card of page 1
    const res = await r.fetch();
    const body = await res.json();
    const first = await (await p.request.get(`${S.base}/api/tickets?sort=updated&page=1&pageSize=50`)).json();
    body.tickets.unshift(first.tickets[first.tickets.length - 1]);
    return r.fulfill({ response: res, json: body });
  });
  await p.goto(`${S.base}/m/tickets`);
  const pg = '.m-page:not(.m-leaving)';
  await p.locator(`${pg} .m-list > *`).nth(49).waitFor();
  await p.evaluate((sel) => { document.querySelector(`${sel} .m-scroll`).scrollTop = 1e9; }, pg);
  await p.locator(`${pg} .m-more-error`).waitFor();
  await p.waitForTimeout(1500);
  assert.ok(page2 <= 2, `no request storm (${page2} requests)`);
  fail = false;
  await p.locator(`${pg} .m-more button`).click();
  await p.waitForFunction((sel) => !document.querySelector(`${sel} .m-more-error`) && document.querySelectorAll(`${sel} .m-list > *`).length > 50, pg);
  const keys = await p.locator(`${pg} .m-list > *`).evaluateAll((els) => els.map((e) => e.dataset.key));
  assert.equal(new Set(keys).size, keys.length, 'no ticket twice');
  assert.deepEqual(errors, []);
  await c.close();
});
