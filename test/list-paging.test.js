// Ticket list in pages: API (?page/&pageSize → total, page, pageSize), pager in the desktop list,
// "load more" page by page on the phone without the old upper limit.
// The browser part needs Playwright with Chromium – skipped if missing.
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

const N = 130;
const ALL = N + 1; // plus the user's own ticket from the API test
let S; let browser;
before(async () => {
  S = await startServer('list-paging');
  for (let i = 1; i <= N; i++) {
    const r = await S.admin('POST', '/api/tickets', { title: `${i % 10 === 0 ? 'Drucker' : 'Anfrage'} Nummer ${i}`, type: 'incident', priority: 'medium' });
    assert.equal(r.status, 201);
  }
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

const keys = (r) => r.body.tickets.map((tk) => tk.key);

test('API: pages with total, no overlap, every ticket reachable', async () => {
  const seen = new Set();
  for (let page = 1; page <= 3; page++) {
    const r = await S.admin('GET', `/api/tickets?sort=created&page=${page}&pageSize=50`);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, N);
    assert.equal(r.body.page, page);
    assert.equal(r.body.pageSize, 50);
    assert.equal(r.body.tickets.length, page < 3 ? 50 : 30);
    for (const k of keys(r)) { assert.ok(!seen.has(k), `twice: ${k}`); seen.add(k); }
  }
  assert.equal(seen.size, N);
  // newest first: page 1 starts with the last one created
  const first = await S.admin('GET', '/api/tickets?sort=created&page=1&pageSize=1');
  assert.equal(first.body.tickets[0].title, `Drucker Nummer ${N}`);
});

test('API: limits – page size at most 500, default 100, page past the end gives the last page', async () => {
  let r = await S.admin('GET', '/api/tickets?page=1&pageSize=99999');
  assert.equal(r.body.pageSize, 500);
  r = await S.admin('GET', '/api/tickets?page=1');
  assert.equal(r.body.pageSize, 100);
  assert.equal(r.body.tickets.length, 100);
  r = await S.admin('GET', '/api/tickets?page=999&pageSize=100');
  assert.equal(r.body.page, 2);
  assert.equal(r.body.tickets.length, N - 100);
  r = await S.admin('GET', '/api/tickets?page=-3&pageSize=abc');
  assert.equal(r.body.page, 1);
  assert.equal(r.body.pageSize, 100);
  // nothing found: page 1, total 0
  r = await S.admin('GET', '/api/tickets?page=4&q=gibtesnichtxyz');
  assert.equal(r.body.total, 0);
  assert.equal(r.body.page, 1);
  assert.deepEqual(r.body.tickets, []);
});

test('API: without page as before (limit, no total)', async () => {
  const r = await S.admin('GET', '/api/tickets?limit=20');
  assert.equal(r.body.tickets.length, 20);
  assert.equal(r.body.total, undefined);
  const all = await S.admin('GET', '/api/tickets');
  assert.equal(all.body.tickets.length, N);
});

test('API: search pages keep the relevance order; filters count before paging', async () => {
  const all = await S.admin('GET', '/api/tickets?q=Drucker&sort=relevance&limit=100');
  assert.equal(all.body.tickets.length, N / 10);
  const p1 = await S.admin('GET', '/api/tickets?q=Drucker&sort=relevance&page=1&pageSize=5');
  const p2 = await S.admin('GET', '/api/tickets?q=Drucker&sort=relevance&page=2&pageSize=5');
  assert.equal(p1.body.total, N / 10);
  assert.deepEqual([...keys(p1), ...keys(p2)], keys(all).slice(0, 10));
  assert.deepEqual(p1.body.searchTerms, ['Drucker']);
  // "My open approvals": part of the query → total 0 instead of a page full of foreign tickets
  const ap = await S.admin('GET', '/api/tickets?approval=mine&page=1');
  assert.equal(ap.body.total, 0);
  assert.deepEqual(ap.body.tickets, []);
  // users only count their own tickets
  const karl = await S.user('karl-paging', 'user');
  await karl('POST', '/api/tickets', { title: 'Mein eigenes Ticket' });
  const own = await karl('GET', '/api/tickets?page=1');
  assert.equal(own.body.total, 1);
});

async function desktop() {
  const c = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'de-DE', extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { c, p, errors };
}

test('Desktop: pager under "All tickets" – range, pages in the address, reset on filter change, page size', { skip }, async () => {
  const { c, p, errors } = await desktop();
  await p.goto(`${S.base}/issues`);
  await p.locator('nav.pager').waitFor();
  assert.equal(await p.locator('table.issues tbody tr').count(), 100);
  assert.equal(await p.locator('.table-count').textContent(), `Tickets 1–100 von ${ALL}`);
  assert.equal(await p.locator('.pager [aria-current="page"]').textContent(), '1');
  assert.equal(await p.getByRole('button', { name: 'Vorherige Seite' }).isDisabled(), true);
  await p.getByRole('button', { name: 'Seite 2' }).click();
  await p.waitForURL(/[?&]page=2/);
  await p.waitForFunction(() => document.querySelector('.table-count')?.textContent.startsWith('Tickets 101'));
  assert.equal(await p.locator('table.issues tbody tr').count(), ALL - 100);
  assert.equal(await p.getByRole('button', { name: 'Nächste Seite' }).isDisabled(), true);
  // Back button: page 1 again
  await p.goBack();
  await p.waitForFunction(() => document.querySelector('.table-count')?.textContent.startsWith('Tickets 1–'));
  // Select all = this page only
  await p.getByRole('button', { name: 'Letzte Seite' }).click();
  await p.waitForURL(/[?&]page=2/);
  await p.waitForFunction(() => document.querySelector('.table-count')?.textContent.startsWith('Tickets 101'));
  await p.locator('thead input.row-check').check();
  assert.match(await p.locator('.bulk-bar').textContent(), new RegExp(`${ALL - 100}`));
  // Changing a filter goes back to page 1
  await p.locator('.list-toolbar select').filter({ hasText: 'Alle Prioritäten' }).selectOption('medium');
  await p.waitForFunction(() => !location.search.includes('page='));
  await p.waitForFunction(() => document.querySelector('.table-count')?.textContent.startsWith('Tickets 1–'));
  // 50 per page → 3 pages, remembered
  await p.locator('.pager select').selectOption('50');
  await p.waitForFunction(() => document.querySelector('.table-count')?.textContent === 'Tickets 1–50 von 131');
  assert.deepEqual(await p.locator('.pager-pages .pager-btn:not([aria-label$="Seite"])').allTextContents(), ['1', '2', '3']);
  await p.reload();
  await p.waitForFunction(() => document.querySelector('.table-count')?.textContent === 'Tickets 1–50 von 131');
  // A page in the address that no longer exists → last page, address corrected
  await p.goto(`${S.base}/issues?page=99`);
  await p.waitForFunction(() => document.querySelector('.table-count')?.textContent === 'Tickets 101–131 von 131');
  assert.match(new URL(p.url()).search, /page=3/);
  // Short list: no pager buttons, plain count
  await p.goto(`${S.base}/issues?q=Drucker`);
  await p.locator('.table-count').waitFor();
  await p.waitForFunction(() => document.querySelector('.table-count')?.textContent === '13 Tickets');
  assert.equal(await p.locator('.pager-pages').count(), 0);
  assert.deepEqual(errors, []);
  await c.close();
});

test('Desktop: the queue stays highlighted on page 2', { skip }, async () => {
  const { c, p, errors } = await desktop();
  await p.goto(`${S.base}/issues?status=unresolved&page=2`);
  await p.locator('nav.pager').waitFor();
  assert.equal(await p.locator('.sidebar .nav-sub.active').count(), 1);
  assert.equal(await p.locator('h1').textContent(), 'Alle offenen Tickets');
  assert.deepEqual(errors, []);
  await c.close();
});

test('Phone: "load more" fetches page by page up to the end', { skip }, async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'de-DE' });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' }, headers: { 'X-Helfi-Request': '1' } });
  await p.goto(`${S.base}/m/tickets`);
  const info = p.locator('.m-page:not(.m-leaving) .m-list-info');
  await p.waitForFunction(() => document.querySelector('.m-page:not(.m-leaving) .m-list-info')?.textContent === '50 von 131 Tickets');
  // Scroll to the end (loads automatically) or press the button – until everything is there
  await p.waitForFunction((all) => {
    const pg = document.querySelector('.m-page:not(.m-leaving)');
    const n = pg.querySelectorAll('.m-list > *').length;
    if (n < all) { pg.querySelector('.m-scroll').scrollTop = 1e9; pg.querySelector('.m-more button')?.click(); }
    return n === all;
  }, ALL, { polling: 400, timeout: 20000 });
  assert.equal(await info.textContent(), '131 Tickets');
  assert.equal(await p.locator('.m-page:not(.m-leaving) .m-more button').count(), 0);
  const ids = await p.locator('.m-page:not(.m-leaving) .m-list > *').evaluateAll((els) => els.map((e) => e.getAttribute('href') || e.textContent));
  assert.equal(new Set(ids).size, ALL, 'no ticket twice');
  assert.deepEqual(errors, []);
  await c.close();
});
