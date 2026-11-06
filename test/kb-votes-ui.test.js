// "Was this article helpful?" in the browser: thumbs, note after "not helpful", phone.
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

let S; let browser; let art;
before(async () => {
  if (!chromium) return;
  S = await startServer('kbvotesui');
  const anna = await S.user('anna', 'agent');
  await S.user('karl', 'user');
  art = (await anna('POST', '/api/kb', { title: 'VPN', body: 'Schritt 1', visibility: 'public' })).body.article;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1280, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  return { p, errors };
}
const counts = (p) => p.$$eval('.kb-rate-btn', (b) => b.map((x) => `${x.getAttribute('aria-pressed')}:${x.querySelector('.kb-rate-n').textContent}`));

test('Desktop: vote, note after "not helpful", agents see it', { skip }, async () => {
  const { p, errors } = await page('karl');
  await p.goto(`${S.base}/kb/${art.id}`);
  await p.waitForSelector('.kb-rating');
  assert.equal(await p.$('.kb-rate-note'), null, 'no note field before a click');
  await p.click('.kb-rate-btn >> nth=0');
  await p.waitForSelector('.kb-rate-btn[aria-pressed=true]');
  assert.deepEqual(await counts(p), ['true:1', 'false:0']);
  await p.click('.kb-rate-btn >> nth=1');
  await p.waitForSelector('.kb-rate-note textarea');
  assert.deepEqual(await counts(p), ['false:0', 'true:1']);
  await p.fill('.kb-rate-note textarea', 'Mac fehlt');
  await p.click('.kb-rate-note .btn-primary');
  await p.waitForFunction(() => !document.querySelector('.kb-rate-note'));
  await p.reload();
  await p.waitForSelector('.kb-rating');
  assert.equal(await p.$('.kb-rate-note'), null, 'not asked again on the next visit');
  assert.deepEqual(errors, []);
  const agent = await page('anna');
  await agent.p.goto(`${S.base}/kb/${art.id}`);
  await agent.p.click('.kb-rating .btn-subtle');
  await agent.p.waitForSelector('.modal .kb-fb');
  assert.match(await agent.p.textContent('.modal'), /Mac fehlt/);
});

test('Phone: thumbs on the article page', { skip }, async () => {
  const { p, errors } = await page('karl', true);
  await p.goto(`${S.base}/m/kb/${art.id}`);
  await p.waitForSelector('.kb-rating');
  await p.tap('.kb-rate-btn >> nth=1'); // withdraws the earlier "not helpful"
  await p.waitForSelector('.kb-rate-btn[aria-pressed=false] >> nth=1');
  assert.deepEqual(await counts(p), ['false:0', 'false:0']);
  assert.deepEqual(errors, []);
});
