// Audit 2026-11b (browser UI): per-account data in the desktop UI never reaches the next account on
// the same browser (KB drafts, module caches), lists of the same account survive a new tab, KB images
// are not cached, the formatted mail view is sandboxed and still works in the frame.
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const DESKTOP = { viewport: { width: 1400, height: 900 }, locale: 'de-DE' };
let S; let browser; let tk; let art;
const who = {};
before(async () => {
  S = await startServer('audit-ui');
  who.anna = await S.user('anna', 'agent');
  who.bert = await S.user('bert', 'agent');
  who.karl = await S.user('karl', 'user');
  await S.user('ida', 'admin');
  await S.user('otto', 'admin');
  tk = (await who.karl('POST', '/api/tickets', { title: 'Drucker druckt nicht' })).body.ticket;
  await who.anna('POST', '/api/canned', { title: 'ANNA-PRIVAT', body: 'Persönlich von Anna.', shared: false });
  art = (await who.anna('POST', '/api/kb', { title: 'Intern', body: 'Original', visibility: 'internal' })).body.article;
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function open() {
  const c = await browser.newContext(DESKTOP);
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  return { p, c, errors };
}
async function signIn(p, username) {
  if (!/\/login/.test(p.url())) await p.goto(`${S.base}/login`);
  await p.waitForSelector('input[name=username]');
  await p.fill('input[name=username]', username);
  await p.fill('input[name=password]', 'Sehrgeheim123');
  await p.click('button[type=submit]');
  await p.waitForSelector('.topbar-user');
}
async function signOut(p) {
  await p.click('.topbar-user');
  await p.locator('.menu-item', { hasText: 'Abmelden' }).click();
  await p.waitForSelector('input[name=username]');
}
// In-app navigation (no reload: module state of the page stays)
const nav = (p, url) => p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, url);
const kbKeys = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('helfi.kbdraft.') || k.startsWith('helfi.kbtpl.')));

test('U1: unsaved KB article draft is removed on sign-out and never offered to another account', { skip }, async () => {
  const { p, c, errors } = await open();
  await signIn(p, 'anna');
  await nav(p, `/kb/${art.id}/edit`);
  await p.waitForSelector('.kb-editable');
  await p.click('.kb-editable');
  await p.keyboard.type(' Annas ungespeicherter Entwurf');
  await p.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('helfi.kbdraft.')));
  assert.equal((await kbKeys(p)).length, 1, 'draft stored while editing');
  await nav(p, `/browse/${tk.key}`);
  await p.waitForSelector('.topbar-user');
  await signOut(p);
  assert.deepEqual(await kbKeys(p), [], 'sign-out removes KB drafts');
  // A draft of Anna that is still in the storage (e.g. written by another tab) is not offered to Bert
  await signIn(p, 'bert');
  await p.evaluate(([id, uid]) => localStorage.setItem(`helfi.kbdraft.${id}`, JSON.stringify({ uid, title: 'Intern', body: 'Fremder Entwurf', at: new Date().toISOString() })), [art.id, S.ids.anna]);
  await p.evaluate((id) => localStorage.setItem('helfi.kbtpl.new', JSON.stringify({ title: 'Ohne Besitzer', body: 'x', at: new Date().toISOString() })), art.id);
  await nav(p, `/kb/${art.id}/edit`);
  await p.waitForSelector('.kb-editable');
  await p.waitForTimeout(300);
  assert.equal(await p.locator('.kb-draft-banner').count(), 0, 'draft of another account ignored');
  await nav(p, '/kb/templates/new');
  await p.waitForSelector('.kb-editable');
  await p.waitForTimeout(300);
  assert.equal(await p.locator('.kb-draft-banner').count(), 0, 'template draft without owner ignored');
  // Bert's own draft survives a reload and is offered to him
  await nav(p, `/kb/${art.id}/edit`);
  await p.waitForSelector('.kb-editable');
  await p.click('.kb-editable');
  await p.keyboard.type(' Berts Entwurf');
  await p.waitForFunction((uid) => { try { return JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('helfi.kbdraft.')))).uid === uid; } catch { return false; } }, S.ids.bert);
  await p.reload();
  await p.waitForSelector('.kb-editable');
  await p.waitForSelector('.kb-draft-banner');
  assert.deepEqual(errors, []);
  await c.close();
});

test('U1b: an expired session keeps the own KB draft for the same account; another account clears it', { skip }, async () => {
  const { p, c, errors } = await open();
  await signIn(p, 'anna');
  await nav(p, `/kb/${art.id}/edit`);
  await p.waitForSelector('.kb-editable');
  await p.click('.kb-editable');
  await p.keyboard.type(' Langer Entwurf vor dem Ablauf');
  await p.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('helfi.kbdraft.')));
  // Session expires (e.g. overnight): the cookie is gone, the app starts without a session
  await c.clearCookies();
  await p.reload();
  await p.waitForSelector('input[name=username]');
  assert.equal((await kbKeys(p)).length, 1, 'draft kept while nobody is signed in');
  await signIn(p, 'anna');
  await nav(p, `/kb/${art.id}/edit`);
  await p.waitForSelector('.kb-draft-banner');
  // Expired again, then another account signs in: the draft goes
  await c.clearCookies();
  await p.reload();
  await p.waitForSelector('input[name=username]');
  await signIn(p, 'bert');
  assert.deepEqual(await kbKeys(p), [], 'another account removes the draft');
  assert.deepEqual(errors, []);
  await c.close();
});

test('U2: personal templates and import access data of the previous account are gone after sign-out and sign-in without reload', { skip }, async () => {
  const { p, c, errors } = await open();
  await signIn(p, 'anna');
  await nav(p, `/browse/${tk.key}`);
  await p.click('[data-shortcut=template]');
  // The templates load asynchronously ("Save as template" is there at once)
  await p.waitForSelector('.menu-templates .menu-template');
  assert.match(await p.textContent('.menu-templates'), /ANNA-PRIVAT/);
  await p.keyboard.press('Escape');
  await signOut(p);
  await signIn(p, 'bert');
  assert.equal(await p.evaluate(() => performance.getEntriesByType('navigation').length), 1, 'same page, no reload');
  await nav(p, `/browse/${tk.key}`);
  await p.waitForSelector('[data-shortcut=template]');
  await p.click('[data-shortcut=template]');
  await p.waitForSelector('.menu-templates .menu-empty, .menu-templates .menu-template');
  assert.doesNotMatch(await p.textContent('.menu-templates'), /ANNA-PRIVAT/);
  await p.keyboard.press('Escape');
  await signOut(p);

  // Import: source token typed by one admin is not prefilled for the next one
  await signIn(p, 'ida');
  await nav(p, '/admin/import');
  const url = 'input[placeholder="https://zammad.firma.local"]';
  await p.waitForSelector(url);
  await p.fill(url, 'https://zammad.firma.local');
  await p.locator('input[type=password]').first().fill('geheimes-token-von-ida');
  await signOut(p);
  await signIn(p, 'otto');
  await nav(p, '/admin/import');
  await p.waitForSelector(url);
  assert.equal(await p.inputValue(url), '');
  assert.deepEqual(await p.$$eval('input[type=password]', (els) => els.map((e) => e.value).filter(Boolean)), []);
  assert.deepEqual(errors, []);
  await c.close();
});

test('U3: recent tickets survive a new tab of the same account; another account clears them', { skip }, async () => {
  const c = await browser.newContext({ ...DESKTOP, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'anna', password: 'Sehrgeheim123' } });
  await p.goto(`${S.base}/browse/${tk.key}`);
  await p.waitForSelector('.topbar-user');
  await p.waitForFunction(() => localStorage.getItem('helfi.recentTickets'));
  await p.evaluate(() => localStorage.setItem('helfi.m.kbRecent', '[1]'));
  const p2 = await c.newPage();
  await p2.goto(`${S.base}/board`);
  await p2.waitForSelector('.topbar-user');
  assert.match(await p2.evaluate(() => localStorage.getItem('helfi.recentTickets') || ''), new RegExp(tk.key), 'new tab of the same account keeps the list');
  assert.equal(await p2.evaluate(() => localStorage.getItem('helfi.m.kbRecent')), '[1]');
  // Another account signs in on this browser (cookie of the whole profile) and opens a new tab
  await p2.request.post(`${S.base}/api/auth/login`, { data: { username: 'bert', password: 'Sehrgeheim123' } });
  const p3 = await c.newPage();
  await p3.goto(`${S.base}/board`);
  await p3.waitForSelector('.topbar-user');
  assert.equal(await p3.evaluate(() => localStorage.getItem('helfi.recentTickets')), null, 'another account: list removed');
  assert.equal(await p3.evaluate(() => localStorage.getItem('helfi.m.kbRecent')), null);
  await c.close();
});

test('U6: KB images are not stored in the browser cache', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'bild.png');
  const login = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'anna', password: 'Sehrgeheim123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const img = await (await fetch(`${S.base}/api/kb/images`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd })).json();
  const r = await fetch(S.base + img.url, { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});

test('U7: formatted mail view is sandboxed by its CSP and still shows in the frame (height, embedded image)', { skip }, async () => {
  const { p, c, errors } = await open();
  await signIn(p, 'anna');
  const key = (await who.karl('POST', '/api/tickets', { title: 'HTML-Mail' })).body.ticket.key;
  // Embedded image: a stored attachment of the ticket
  const login = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'karl', password: 'Sehrgeheim123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const fd = new FormData();
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  const up = await (await fetch(`${S.base}/api/tickets/${key}/attachments`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd })).json();
  const ticketId = S.db.prepare('SELECT ticket_id FROM attachments WHERE id=?').get(up.ids[0]).ticket_id;
  S.ctx.tickets.saveMailHtml(ticketId, null, `<p>Hallo</p><img src="/api/attachments/${up.ids[0]}" width="20" height="20"><div style="height:700px">Lang</div><p>Ende</p>`, 0);
  const r = await who.anna('GET', `/api/tickets/${key}/mail-html`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /;\s*sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox$/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /allow-scripts/);
  await nav(p, `/browse/${key}`);
  await p.waitForSelector('iframe.mail-frame');
  const frame = await (await p.$('iframe.mail-frame')).contentFrame();
  await frame.waitForSelector('img');
  await p.waitForFunction(() => {
    const f = document.querySelector('iframe.mail-frame');
    const img = f?.contentDocument?.querySelector('img');
    return img && img.complete && img.naturalWidth > 0 && f.offsetHeight >= 700;
  }, null, { timeout: 5000 });
  assert.ok(await frame.textContent('body').then((x) => x.includes('Ende')));
  assert.deepEqual(errors, []);
  await c.close();
});
