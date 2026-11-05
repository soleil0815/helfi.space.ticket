// People picker when adding participants: focus stays in the field, keyboard, AD results arrive later.
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
// CI sets HELFI_REQUIRE_BROWSER: there a missing Playwright fails the run instead of skipping the tests
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

let S; let browser;
let adDelay = 0;
const AD = [
  { username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: 'a1'.repeat(16) },
  { username: 'e.beck', displayName: 'Emil Beck', email: 'e.beck@firma.local', externalId: 'b2'.repeat(16) },
];
before(async () => {
  if (!chromium) return;
  S = await startServer('picker');
  const s = S.ctx.settings;
  s.set('ldap.enabled', true);
  s.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  S.ctx.directory = {
    search: async (cfg, q) => { await new Promise((r) => setTimeout(r, adDelay)); return AD.filter((p) => `${p.displayName} ${p.email}`.toLowerCase().includes(q.toLowerCase())); },
    byGuid: async (cfg, id) => { const p = AD.find((x) => x.externalId === id); return p && { ...p, groups: { admin: false, agent: false, user: true } }; },
    byEmail: async () => null,
  };
  await S.user('anna', 'agent');
  const karl = await S.user('karl', 'user');
  await S.user('ebert', 'user');
  await karl('POST', '/api/tickets', { title: 'Drucker PR-0001 druckt nicht', description: 'Papierstau' });
  await karl('POST', '/api/tickets', { title: 'VPN', description: 'geht nicht' });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const r = await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } });
  assert.equal(r.status(), 200);
  return { p, errors };
}
const focused = (p) => p.evaluate(() => document.activeElement?.matches('.participants input') || false);
const items = (p) => p.$$eval('.picker-menu [role=option]', (x) => x.map((i) => i.textContent));

test('Typing letter by letter: focus stays, AD results arrive later', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/IT-1`);
  await p.click('.participants button.link');
  adDelay = 400;
  for (const ch of 'e.be') {
    await p.keyboard.type(ch);
    await p.waitForTimeout(350);
    assert.ok(await focused(p), `focus after "${ch}"`);
  }
  // Local results immediately, AD still in progress
  await p.waitForSelector('.picker-loading');
  await p.waitForSelector('.picker-menu .badge-ad');
  assert.ok(await focused(p), 'focus after loading more');
  assert.ok(!(await p.$('.picker-loading')), 'loading indicator gone');
  const list = await items(p);
  assert.ok(list.some((x) => x.includes('Erika Beispiel')) && list.some((x) => x.includes('Emil Beck')), list.join('|'));
  // Keyboard: ↓ and Enter
  await p.keyboard.press('ArrowDown');
  const chosen = await p.$eval('.picker-menu .menu-item.active .person-name', (e) => e.textContent);
  await p.keyboard.press('Enter');
  await p.waitForFunction((n) => [...document.querySelectorAll('.participants .chip')].some((c) => c.textContent.includes(n)), chosen);
  assert.deepEqual(errors, []);
  adDelay = 0;
});

test('Two characters: hint that AD needs 3 characters; Esc closes; stale response overwrites nothing', { skip }, async () => {
  const { p } = await page('anna');
  await p.goto(`${S.base}/browse/IT-2`);
  await p.click('.participants button.link');
  await p.keyboard.type('eb');
  await p.waitForSelector('.picker-menu');
  assert.ok(await focused(p));
  assert.match(await p.$eval('.picker-menu', (m) => m.textContent), /mindestens 3 Zeichen|at least 3 characters/);
  assert.ok((await items(p)).some((x) => x.includes('ebert')), 'local person at 2 characters');

  // slow AD response for "emi", then quickly on to "erika"
  adDelay = 800;
  await p.fill('.participants input', 'emi');
  await p.waitForTimeout(300);
  adDelay = 0;
  await p.fill('.participants input', 'erika');
  await p.waitForSelector('.picker-menu .badge-ad');
  await p.waitForTimeout(900);
  const list = await items(p);
  assert.ok(list.every((x) => !x.includes('Emil')), `stale results: ${list.join('|')}`);

  await p.keyboard.press('Escape');
  assert.equal(await p.$('.picker-menu'), null);
  assert.ok(await p.$('.participants button.link'), 'back to the button');
});

test('Users: no AD search, no AD hint', { skip }, async () => {
  const { p } = await page('karl');
  await p.goto(`${S.base}/browse/IT-2`);
  await p.click('.participants button.link');
  await p.keyboard.type('ebe');
  await p.waitForSelector('.picker-menu');
  await p.waitForTimeout(300);
  const text = await p.$eval('.picker-menu', (m) => m.textContent);
  assert.doesNotMatch(text, /Active Directory/);
  assert.equal(await p.$('.picker-menu .badge-ad'), null);
  assert.ok(await focused(p));
});

// Mobile UI (/m): the same behaviour in the participants sheet
async function phone(username) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'de-DE' });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const r = await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' }, headers: { 'X-Helfi-Request': '1' } });
  assert.equal(r.status(), 200);
  return { p, errors, close: () => c.close() };
}
const sheetFocused = (p) => p.evaluate(() => document.activeElement?.matches('.m-sheet-people .m-sheet-search-input') || false);
async function openPeopleSheet(p, key) {
  await p.goto(`${S.base}/m/t/${key}`);
  await p.waitForSelector('.m-more-btn');
  await p.tap('.m-more-btn');
  await p.waitForSelector('.m-action[data-action="participants"]');
  await p.tap('.m-action[data-action="participants"]');
  await p.waitForSelector('.m-sheet-people .m-sheet-search-input');
  await p.locator('.m-sheet-people .m-sheet-search-input').focus();
}

test('Mobile: participants sheet keeps the focus, AD results arrive later, tap picks', { skip }, async () => {
  const { p, errors, close } = await phone('anna');
  // Desktop preference must not interfere: the phone context opens /m directly
  await openPeopleSheet(p, 'IT-2');
  adDelay = 400;
  for (const ch of 'e.be') {
    await p.keyboard.type(ch);
    await p.waitForTimeout(350);
    assert.ok(await sheetFocused(p), `focus after "${ch}"`);
  }
  await p.waitForSelector('.m-sheet-people .m-badge-ad');
  assert.ok(await sheetFocused(p), 'focus after the AD results');
  const names = await p.$$eval('.m-person-hit', (x) => x.map((i) => i.textContent));
  assert.ok(names.some((x) => x.includes('Erika Beispiel')) && names.some((x) => x.includes('Emil Beck')), names.join('|'));
  await p.locator('.m-person-hit', { hasText: 'Erika Beispiel' }).tap();
  await p.waitForSelector('.m-people-current .m-person-row[data-id]');
  assert.ok(await sheetFocused(p), 'focus stays for the next person');
  assert.match(await p.textContent('.m-people-current'), /Erika Beispiel/);
  adDelay = 0;
  assert.deepEqual(errors, []);
  await close();
});

test('Mobile: users get no AD search and no email entry', { skip }, async () => {
  const { p, errors, close } = await phone('karl');
  await openPeopleSheet(p, 'IT-1');
  await p.keyboard.type('ebe');
  await p.waitForSelector('.m-sheet-people .m-people-results .m-person-hit, .m-sheet-people .m-people-results .m-sheet-empty');
  await p.waitForTimeout(300);
  const text = await p.textContent('.m-people-results');
  assert.doesNotMatch(text, /Active Directory/);
  assert.equal(await p.$('.m-badge-ad'), null);
  await p.fill('.m-sheet-people .m-sheet-search-input', 'jemand@firma.local');
  await p.waitForTimeout(500);
  assert.doesNotMatch(await p.textContent('.m-people-results'), /hinzufügen/);
  assert.deepEqual(errors, []);
  await close();
});
