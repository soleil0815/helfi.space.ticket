// Privacy and storage of the mobile UI (review of the mobile UI): drafts and caches never reach the
// next account, unsent uploads are discarded/cleaned up, API answers are not stored by the browser,
// photos are uploaded without EXIF/GPS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

let S; let browser; let paths;
const who = {};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
before(async () => {
  S = await startServer('mobile-privacy');
  ({ paths } = await import('../src/config.js'));
  S.ctx.settings.set('general.allowSelfService', true);
  who.anna = await S.user('anna', 'agent');
  who.tom = await S.user('tom', 'agent');
  who.karl = await S.user('karl', 'user');
  who.eva = await S.user('eva', 'user');
  await who.karl('POST', '/api/tickets', { title: 'Drucker PR-0001 druckt nicht', description: 'Seit heute früh.', type: 'incident' }); // IT-1
  await who.eva('POST', '/api/tickets', { title: 'Evas eigene Anfrage', description: 'Nur für Eva.' }); // IT-2
  await who.anna('POST', '/api/canned', { title: 'Annas Vorlage', body: 'Persönlich von Anna.' });
  await who.tom('POST', '/api/canned', { title: 'Toms Vorlage', body: 'Persönlich von Tom.' });
  S.db.prepare('UPDATE users SET totp_enabled=1').run();
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'de-DE' };
async function open(username) {
  const c = await browser.newContext(PHONE);
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (username) assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' }, headers: { 'X-Helfi-Request': '1' } })).status(), 200);
  return { p, c, errors, close: () => c.close() };
}
const ready = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(450); };
async function signInForm(p, username) {
  await p.waitForSelector('input[name=username]');
  await p.fill('input[name=username]', username);
  await p.fill('input[name=password]', 'Sehrgeheim123');
  await p.tap('button[type=submit]');
}
/** Raw multipart upload with a session cookie (draft=file etc.) */
async function upload(username, key, { draft = 'file', name = 'datei.png', body = PNG, type = 'image/png' } = {}) {
  const login = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username, password: 'Sehrgeheim123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const fd = new FormData();
  if (draft) fd.append('draft', draft);
  fd.append('files', new Blob([body], { type }), name);
  const r = await fetch(`${S.base}/api/tickets/${key}/attachments`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd });
  return { status: r.status, body: await r.json(), cookie };
}
const attRow = (id) => S.db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
const attPath = (a) => nodePath.join(paths.attachments, String(a.ticket_id), a.storage_name);

// ---------- F1: drafts belong to one account ----------
test('Reply draft of an agent (internal note) never appears for the next account after the session expired', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  await p.locator('.m-reply-mode-note').tap();
  await p.fill('.m-reply-input', 'Intern: Passwort des Druckers ist geheim');
  await p.locator('.m-reply-input').blur();
  await p.waitForTimeout(400);
  assert.ok(await p.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('helfi.m.draft.'))), 'draft stored');
  // Session expires; the next API call gets 401 and leads to the sign-in
  S.db.prepare('DELETE FROM sessions WHERE user_id=?').run(S.ids.anna);
  await p.goto(`${S.base}/healthz`);
  await p.goBack();
  await p.waitForURL('**/m/login');
  assert.equal(await p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('helfi.m.draft.')).length), 0, 'drafts removed when the session is gone');
  // Karl signs in on the same phone and opens the same ticket
  await signInForm(p, 'karl');
  await p.waitForURL((u) => u.pathname.startsWith('/m/t/IT-1') || u.pathname === '/m/');
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  assert.equal(await p.inputValue('.m-reply-input'), '');
  assert.equal(await p.locator('.m-reply.internal').count(), 0);
  assert.deepEqual(errors.filter((e) => !/401/.test(e)), []);
  await close();
});

test('Reply draft is not restored for another account even if it is still in the tab (in-app expiry, foreign key)', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  await p.locator('.m-reply-mode-note').tap();
  await p.fill('.m-reply-input', 'Interne Notiz im Entwurf');
  await p.locator('.m-reply-input').blur();
  await p.waitForTimeout(400);
  // Expiry noticed inside the app (401 on an API call) – no page reload
  S.db.prepare('DELETE FROM sessions WHERE user_id=?').run(S.ids.anna);
  await p.evaluate(() => fetch('/api/me', { headers: { 'X-Helfi-Request': '1' } }).then((r) => { if (r.status === 401) window.dispatchEvent(new CustomEvent('helfi:unauthorized')); }));
  await p.waitForURL('**/m/login');
  await signInForm(p, 'karl');
  await p.waitForURL((u) => u.pathname.startsWith('/m/'));
  await ready(p);
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  assert.equal(await p.inputValue('.m-reply-input'), '');
  // A draft stored for another account id is ignored as well
  await p.evaluate((id) => sessionStorage.setItem(`helfi.m.draft.${id}.IT-1`, JSON.stringify({ uid: id, text: 'fremd', internal: true })), S.ids.anna);
  // … and a tab that was last used by that other account clears everything when Karl's session starts
  await p.evaluate((id) => sessionStorage.setItem('helfi.m.uid', String(id)), S.ids.anna);
  await p.reload();
  await ready(p);
  assert.equal(await p.inputValue('.m-reply-input'), '');
  assert.equal(await p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('helfi.m.draft.')).length), 0, 'another account in the tab: old drafts removed');
  assert.deepEqual(errors.filter((e) => !/401/.test(e)), []);
  await close();
});

test('New-ticket draft: kept for the same account, gone after a desktop sign-out', { skip }, async () => {
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/new/report`);
  await ready(p);
  await p.fill('input[name=title]', 'Entwurf von Karl');
  await p.waitForTimeout(400);
  await p.reload();
  await ready(p);
  assert.equal(await p.inputValue('input[name=title]'), 'Entwurf von Karl');
  // Sign-out in the desktop view of the same tab
  await p.goto(`${S.base}/requests?ui=desktop`);
  await ready(p);
  await p.click('.topbar-user');
  await p.locator('.menu-item', { hasText: 'Abmelden' }).click();
  await p.waitForURL('**/login');
  assert.equal(await p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('helfi.m.newTicket')).length), 0);
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'eva', password: 'Sehrgeheim123' }, headers: { 'X-Helfi-Request': '1' } })).status(), 200);
  await p.goto(`${S.base}/m/new/report`);
  await ready(p);
  assert.equal(await p.inputValue('input[name=title]'), '');
  assert.deepEqual(errors, []);
  await close();
});

// ---------- F2: module caches are per account ----------
test('Personal templates of agent A are not shown to agent B after sign-out and sign-in without reload', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  await p.tap('.m-reply-tpl');
  await p.waitForSelector('.m-canned-item');
  assert.match(await p.textContent('.m-canned'), /Annas Vorlage/);
  await p.keyboard.press('Escape');
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  await p.tap('.m-back');
  await p.waitForURL((u) => u.pathname === '/m/');
  await p.waitForTimeout(400);
  await p.tap('.m-tab[data-tab=me]');
  await p.waitForURL('**/m/me');
  await ready(p);
  await p.locator('.m-row.danger', { hasText: 'Abmelden' }).tap();
  await signInForm(p, 'tom');
  await p.waitForURL((u) => u.pathname.startsWith('/m/') && u.pathname !== '/m/login');
  assert.equal(await p.evaluate(() => performance.getEntriesByType('navigation').length), 1, 'same page, no reload');
  await ready(p);
  await p.locator('.m-tab', { hasText: 'Tickets' }).tap();
  await p.waitForSelector(`.m-ticket[data-key="IT-1"]`);
  await p.locator('.m-ticket[data-key="IT-1"]').tap();
  await p.waitForSelector('.m-reply-tpl');
  await p.tap('.m-reply-tpl');
  await p.waitForSelector('.m-canned-item');
  const text = await p.textContent('.m-canned');
  assert.match(text, /Toms Vorlage/);
  assert.doesNotMatch(text, /Annas Vorlage/);
  assert.deepEqual(errors.filter((e) => !/401/.test(e)), []);
  await close();
});

// ---------- F3: unsent uploads ----------
test('Unclaimed drafts older than a day are purged (row and file); fresh and claimed ones stay', async () => {
  const old = await upload('karl', 'IT-1');
  const fresh = await upload('karl', 'IT-1');
  const claimedUp = await upload('karl', 'IT-1');
  assert.equal(old.status, 201);
  await who.karl('POST', '/api/tickets/IT-1/comments', { body: 'mit Datei', attachmentIds: [claimedUp.body.ids[0]] });
  const [oldId, freshId, claimedId] = [old.body.ids[0], fresh.body.ids[0], claimedUp.body.ids[0]];
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  S.db.prepare('UPDATE attachments SET created_at=? WHERE id IN (?, ?)').run(twoDaysAgo, oldId, claimedId);
  const oldFile = attPath(attRow(oldId));
  assert.ok(fs.existsSync(oldFile));
  assert.equal(S.ctx.tickets.purgeDrafts(), 1);
  assert.equal(attRow(oldId), undefined);
  assert.equal(fs.existsSync(oldFile), false);
  assert.ok(attRow(freshId), 'fresh draft stays');
  assert.ok(attRow(claimedId), 'claimed file stays');
  // Injectable "now": two days later the fresh draft goes too
  assert.equal(S.ctx.tickets.purgeDrafts(Date.now() + 48 * 3600 * 1000), 1);
  assert.equal(attRow(freshId), undefined);
});

test('Discarding a draft: only one\'s own unclaimed draft on a visible ticket', async () => {
  who.anna = await S.client().login('anna'); // earlier tests ended Anna's sessions
  const mine = (await upload('karl', 'IT-1')).body.ids[0];
  const evas = (await upload('eva', 'IT-2')).body.ids[0];
  const annas = (await upload('anna', 'IT-1')).body.ids[0];
  const regular = (await upload('karl', 'IT-1', { draft: null })).body.ids[0];
  // Agent may not discard someone else's draft, a user not another one's, nobody a regular attachment
  assert.equal((await who.anna('DELETE', `/api/attachments/${mine}/draft`)).status, 403);
  assert.equal((await who.karl('DELETE', `/api/attachments/${annas}/draft`)).status, 403);
  assert.equal((await who.karl('DELETE', `/api/attachments/${regular}/draft`)).status, 403);
  assert.equal((await who.karl('DELETE', `/api/attachments/${evas}/draft`)).status, 404, 'ticket not visible');
  assert.ok(attRow(mine) && attRow(annas) && attRow(regular) && attRow(evas));
  const file = attPath(attRow(mine));
  assert.equal((await who.karl('DELETE', `/api/attachments/${mine}/draft`)).status, 200);
  assert.equal(attRow(mine), undefined);
  assert.equal(fs.existsSync(file), false);
  // No history entry for something that was never visible
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM activity WHERE action='detached'").get().n, 0);
});

test('At most 20 unsent uploads per person and ticket', async () => {
  const key = (await who.karl('POST', '/api/tickets', { title: 'Viele Fotos' })).body.ticket.key;
  for (let i = 0; i < 20; i++) assert.equal((await upload('karl', key)).status, 201);
  const r = await upload('karl', key);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.tooManyDrafts');
  assert.match(r.body.error.message, /20/);
  // Regular attachments are not limited by this
  assert.equal((await upload('karl', key, { draft: null })).status, 201);
});

test('Removing the chip of an already uploaded file (failed send) deletes the draft on the server', { skip }, async () => {
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  // The comment fails after the upload
  await p.route('**/api/tickets/IT-1/comments', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Testfehler' } }) }));
  const chooser = p.waitForEvent('filechooser');
  await p.tap('.m-reply-attach');
  await p.locator('.m-sheet .m-action', { hasText: 'Datei' }).tap();
  await (await chooser).setFiles({ name: 'protokoll.txt', mimeType: 'text/plain', buffer: Buffer.from('Fehler\n') });
  await p.waitForSelector('.m-file.ready');
  const before = S.db.prepare("SELECT COUNT(*) n FROM attachments WHERE draft=1 AND filename='protokoll.txt'").get().n;
  await p.tap('.m-reply-send');
  await p.waitForSelector('.toast-error');
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM attachments WHERE draft=1 AND filename='protokoll.txt'").get().n, before + 1);
  const discarded = p.waitForResponse((r) => /\/api\/attachments\/\d+\/draft$/.test(r.url()) && r.request().method() === 'DELETE');
  await p.tap('.m-file-x');
  assert.equal((await discarded).status(), 200);
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM attachments WHERE draft=1 AND filename='protokoll.txt'").get().n, before);
  assert.deepEqual(errors.filter((e) => !/500/.test(e)), []);
  await close();
});

// ---------- F4: no storage in the browser cache ----------
test('API answers are no-store, ticket attachments private no-store; static files and KB images unchanged', async () => {
  const login = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'karl', password: 'Sehrgeheim123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const get = (u) => fetch(S.base + u, { headers: { cookie } });
  for (const u of ['/api/bootstrap', '/api/me', '/api/tickets/IT-1', '/api/tickets', '/api/kb', '/api/gibt-es-nicht']) assert.equal((await get(u)).headers.get('cache-control'), 'no-store', u);
  const id = (await upload('karl', 'IT-1', { draft: null })).body.ids[0];
  const att = await get(`/api/attachments/${id}`);
  assert.equal(att.status, 200);
  assert.equal(att.headers.get('cache-control'), 'private, no-store');
  assert.equal((await get(`/api/attachments/${id}?download=1`)).headers.get('cache-control'), 'private, no-store');
  // Knowledge images may stay in the private cache (not ticket data)
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'bild.png');
  const annaLogin = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'anna', password: 'Sehrgeheim123' }) });
  const annaCookie = annaLogin.headers.get('set-cookie').split(';')[0];
  const img = await (await fetch(`${S.base}/api/kb/images`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie: annaCookie }, body: fd })).json();
  const kbImg = await fetch(S.base + img.url, { headers: { cookie: annaCookie } });
  assert.equal(kbImg.status, 200);
  assert.match(kbImg.headers.get('cache-control'), /^private/);
  // Static files keep revalidation (ETag)
  const css = await fetch(`${S.base}/m/m.css`);
  assert.equal(css.headers.get('cache-control'), 'no-cache');
  assert.ok(css.headers.get('etag'));
});

// ---------- F5: photos without location ----------
/** Insert an EXIF APP1 segment (TIFF header with a GPS IFD pointer) right after the JPEG SOI marker */
function withExif(jpeg) {
  const tiff = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, // little endian, IFD0 at 8
    0x01, 0x00, // one entry
    0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1A, 0x00, 0x00, 0x00, // GPSInfo IFD pointer → 26
    0x00, 0x00, 0x00, 0x00, // next IFD
    0x01, 0x00, // GPS IFD: one entry
    0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x4E, 0x00, 0x00, 0x00, // GPSLatitudeRef "N"
    0x00, 0x00, 0x00, 0x00,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xFF, 0xE1]), len, payload, jpeg.subarray(2)]);
}

test('A small JPEG with EXIF/GPS from the phone arrives without EXIF', { skip }, async () => {
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  const jpeg = Buffer.from(await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const g = c.getContext('2d'); g.fillStyle = '#5B8DEF'; g.fillRect(0, 0, 64, 48);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }), 'base64');
  const photo = withExif(jpeg);
  assert.ok(photo.includes(Buffer.from('Exif')), 'test photo carries EXIF');
  const chooser = p.waitForEvent('filechooser');
  await p.tap('.m-reply-attach');
  await p.locator('.m-sheet .m-action', { hasText: 'Datei' }).tap();
  await (await chooser).setFiles({ name: 'standort.jpg', mimeType: 'image/jpeg', buffer: photo });
  await p.waitForSelector('.m-file.ready');
  assert.doesNotMatch(await p.textContent('.m-file-meta'), /verkleinert/, 'same size, not reported as downscaled');
  await p.fill('.m-reply-input', 'Foto vom Drucker');
  await p.tap('.m-reply-send');
  await p.waitForFunction(() => [...document.querySelectorAll('.m-msg')].some((m) => m.textContent.includes('Foto vom Drucker')));
  const a = S.db.prepare("SELECT * FROM attachments WHERE filename='standort.jpg' ORDER BY id DESC").get();
  assert.ok(a, 'uploaded');
  assert.equal(a.mime, 'image/jpeg');
  const stored = fs.readFileSync(attPath(a));
  assert.equal(stored[0], 0xFF);
  assert.equal(stored[1], 0xD8);
  assert.equal(stored.includes(Buffer.from('Exif')), false, 'no EXIF APP1 segment');
  assert.equal(stored.includes(Buffer.from([0x25, 0x88])) && stored.includes(Buffer.from('Exif')), false);
  assert.deepEqual(errors, []);
  await close();
});
