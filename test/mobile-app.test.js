// App-like mobile UI under /m: automatic switching, sign-in, lists, ticket view with reply bar and actions.
// The browser tests need Playwright with Chromium (not part of the dependencies) – if missing, they are skipped:
//   npm install --no-save playwright && npx playwright install chromium   (CI installs it, see .github/workflows/ci.yml)
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

// Small valid PNG (2×2 pixels) for the attachment thumbnails
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

let S; let browser;
const who = {}; // API clients of the test accounts
let approvalKey;
before(async () => {
  S = await startServer('mobile-app');
  S.ctx.settings.set('sla.enabled', true);
  S.ctx.settings.set('general.allowSelfService', true);
  const anna = await S.user('anna', 'agent');
  const karl = await S.user('karl', 'user');
  await S.user('eva', 'user');
  await S.user('max', 'user');
  await S.user('tom', 'agent');
  Object.assign(who, { anna, karl });
  await karl('POST', '/api/tickets', { title: 'Drucker PR-0001 im 2. OG druckt nur leere Seiten', description: 'Seit heute früh, Drucker 10.0.10.40.\n\nhttps://firma.local/eine/sehr/lange/adresse/die/umbrechen/muss/damit/nichts/übersteht', type: 'incident', priority: 'high' });
  await karl('POST', '/api/tickets', { title: 'VPN bricht im Homeoffice ab', description: 'Notebook PC-0001', type: 'incident' });
  for (let i = 3; i <= 16; i++) await karl('POST', '/api/tickets', { title: `Monitor für Arbeitsplatz ${i} bestellen`, description: 'Bitte bestellen.', type: 'request' });
  await anna('PATCH', '/api/tickets/IT-1', { assigneeId: S.ids.anna, status: 'in_progress', labels: 'drucker' });
  await anna('PATCH', '/api/tickets/IT-2', { assigneeId: S.ids.anna });
  await anna('POST', '/api/tickets/IT-1/comments', { body: 'Ich schaue mir das gleich an.', internal: false });
  await anna('POST', '/api/tickets/IT-1/comments', { body: 'Trommel vermutlich defekt, Ersatzteil angefragt.', internal: true });
  await anna('POST', '/api/tickets/IT-1/participants', { userId: S.ids.eva });
  const login = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'karl', password: 'Sehrgeheim123' }) });
  const fd = new FormData();
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'testseite.png');
  fd.append('files', new Blob(['Protokoll\n'], { type: 'text/plain' }), 'protokoll.txt');
  const up = await fetch(`${S.base}/api/tickets/IT-1/attachments`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie: login.headers.get('set-cookie').split(';')[0] }, body: fd });
  assert.ok(up.ok, `upload ${up.status}`);
  await anna('POST', '/api/kb', { title: 'Drucker einrichten', body: '# Schritt 1\n\nTreiber von https://firma.local installieren.', visibility: 'public' });
  await anna('POST', '/api/canned', { title: 'Neustart', body: 'Hallo {melder}, bitte starte das Gerät einmal neu.' });
  await S.admin('POST', '/api/canned', { title: 'Problem behoben', body: 'Hallo {melder}, das Problem ist behoben.', shared: true });
  // Catalog request that waits for Anna's approval
  const item = (await S.admin('POST', '/api/catalog', { title: 'Zweiter Monitor', fields: [], approverIds: [S.ids.anna], approvalMode: 'any' })).body.item;
  approvalKey = (await karl('POST', `/api/catalog/${item.id}/order`, { answers: {} })).body.ticket.key;
  // No 2FA banner/prompts in the regular tests (the 2FA test switches this on itself)
  S.db.prepare("UPDATE users SET totp_enabled=1 WHERE username<>'max'").run();
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

// ---------- Server ----------
test('Server: /m and /m/… return the mobile entry page, the sprite is a static file', async () => {
  // "/m" forwards to "/m/" (the start page lies inside the service worker's scope /m/)
  const red = await fetch(`${S.base}/m?filter=done`, { redirect: 'manual' });
  assert.equal(red.status, 302);
  assert.equal(red.headers.get('location'), '/m/?filter=done');
  for (const url of ['/m', '/m/', '/m/t/IT-1', '/m/tickets', '/m/kb/3', '/m/new/c/1', '/m/me/2fa']) {
    const r = await fetch(S.base + url);
    assert.equal(r.status, 200, url);
    assert.match(r.headers.get('content-type'), /text\/html/, url);
    assert.equal(r.headers.get('cache-control'), 'no-cache', url);
    const html = await r.text();
    assert.match(html, /<script type="module" src="\/m\/js\/main\.js"><\/script>/, url);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/, url);
  }
  const css = await fetch(`${S.base}/m/m.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(`${S.base}/m/js/main.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  // Desktop entry page without the inline sprite; the sprite comes as its own file
  const desk = await (await fetch(`${S.base}/`)).text();
  assert.doesNotMatch(desk, /<symbol/);
  const sprite = await fetch(`${S.base}/icons/sprite.svg`);
  assert.equal(sprite.status, 200);
  assert.match(sprite.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await sprite.text();
  for (const id of ['i-plus', 'i-lock', 'i-type-incident', 'i-prio-high', 'i-arrow-left', 'i-book']) assert.match(svg, new RegExp(`id="${id}"`), id);
  // A path under /m with a file extension is not the app
  assert.doesNotMatch(await (await fetch(`${S.base}/m/js/gibt-es-nicht.js`)).text(), /m\/js\/main\.js/);
});

test('Address mapping desktop ↔ mobile', async () => {
  const { mobileUrlFor, desktopUrlFor } = await import('../public/js/uimode.js');
  assert.equal(mobileUrlFor('/browse/IT-12', ''), '/m/t/IT-12');
  assert.equal(mobileUrlFor('/', ''), '/m/');
  assert.equal(mobileUrlFor('/my', ''), '/m/');
  assert.equal(mobileUrlFor('/requests', '?participant=me'), '/m/');
  assert.equal(mobileUrlFor('/catalog', ''), '/m/new');
  assert.equal(mobileUrlFor('/catalog/5', ''), '/m/new/c/5');
  assert.equal(mobileUrlFor('/issues', '?status=open&q=Drucker%20PR'), '/m/tickets?q=Drucker%20PR');
  assert.equal(mobileUrlFor('/login', '?error=oidcFailed&mfa=code'), '/m/login?error=oidcFailed&mfa=code');
  assert.equal(mobileUrlFor('/kb', ''), '/m/kb');
  assert.equal(mobileUrlFor('/kb/7', ''), '/m/kb/7');
  assert.equal(mobileUrlFor('/news', ''), '/m/news');
  assert.equal(mobileUrlFor('/profile', ''), '/m/me');
  for (const p of ['/setup', '/rate/abc', '/admin', '/admin/users', '/reports', '/board', '/changes', '/cis', '/cis/3', '/summary', '/kb/7/edit']) assert.equal(mobileUrlFor(p, ''), null, p);
  assert.equal(desktopUrlFor('/m', ''), '/');
  assert.equal(desktopUrlFor('/m/new/c/5', ''), '/catalog/5');
  assert.equal(desktopUrlFor('/m/me/2fa', ''), '/profile');
  assert.equal(desktopUrlFor('/m/', ''), '/');
  assert.equal(desktopUrlFor('/m/t/IT-12', ''), '/browse/IT-12');
  assert.equal(desktopUrlFor('/m/tickets', '?q=VPN'), '/issues?q=VPN');
  assert.equal(desktopUrlFor('/m/login', '?error=x'), '/login?error=x');
  assert.equal(desktopUrlFor('/m/me', ''), '/profile');
  assert.equal(desktopUrlFor('/m/kb/4', ''), '/kb/4');
  assert.equal(desktopUrlFor('/m/new', ''), '/');
});

// ---------- Browser ----------
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1280, height: 900 } };

async function open(username, opts = PHONE) {
  const c = await browser.newContext({ ...opts, locale: 'de-DE' });
  const p = await c.newPage();
  const errors = [];
  // CSP violations end up in the error list too
  await p.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (username) {
    const r = await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' }, headers: { 'X-Helfi-Request': '1' } });
    assert.equal(r.status(), 200);
  }
  return { p, errors, close: () => c.close() };
}
const ready = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(450); };
const path = (p) => { const u = new URL(p.url()); return u.pathname + u.search; };
const scrollTop = (p) => p.evaluate(() => document.querySelector('.m-page:not(.m-leaving) .m-scroll').scrollTop);

test('Phone: desktop addresses open the mobile UI', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/`);
  await p.waitForURL('**/m/');
  await p.goto(`${S.base}/browse/IT-1`);
  await p.waitForURL('**/m/t/IT-1');
  await ready(p);
  assert.match(await p.textContent('.m-ticket-h1'), /Drucker PR-0001/);
  await p.goto(`${S.base}/issues?status=open&q=VPN`);
  await p.waitForURL('**/m/tickets?q=VPN');
  // Pages that exist only on the desktop stay there
  await p.goto(`${S.base}/reports`);
  await ready(p);
  assert.equal(path(p), '/reports');
  assert.ok(await p.isVisible('.topbar'));
  // "?ui=desktop" shows one page in the desktop UI without changing the preference
  await p.goto(`${S.base}/browse/IT-1?ui=desktop`);
  await ready(p);
  assert.equal(path(p), '/browse/IT-1');
  assert.ok(await p.isVisible('.ticket-title'));
  assert.equal(await p.evaluate(() => localStorage.getItem('helfi.ui')), null);
  assert.deepEqual(errors, []);
  await close();
});

test('Desktop stays on the desktop UI, /m leads back to it, icons from the sprite', { skip }, async () => {
  const { p, errors, close } = await open('anna', DESKTOP);
  await p.goto(`${S.base}/`);
  await ready(p);
  assert.equal(path(p), '/board');
  // Icons: sprite loaded once, symbols are drawn
  assert.equal(await p.locator('svg.sprite').count(), 1);
  const iconBox = await p.evaluate(() => {
    const svg = document.querySelector('.topbar-create svg.icon');
    const ref = svg.querySelector('use').getAttribute('href');
    return { w: svg.getBoundingClientRect().width, symbol: !!document.querySelector(ref), bbox: svg.querySelector('use').getBBox().width };
  });
  assert.ok(iconBox.w > 0 && iconBox.symbol && iconBox.bbox > 0, JSON.stringify(iconBox));
  // No "phone view" in the user menu on a computer
  await p.click('.topbar-user');
  assert.equal(await p.locator('.menu-item', { hasText: 'Handy-Ansicht' }).count(), 0);
  await p.keyboard.press('Escape');
  await p.goto(`${S.base}/m/t/IT-1`);
  await p.waitForURL('**/browse/IT-1');
  await p.goto(`${S.base}/m`);
  await p.waitForURL((u) => ['/board', '/'].includes(u.pathname));
  assert.deepEqual(errors, []);
  await close();
});

test('Phone with preference "desktop" keeps the desktop UI; user menu offers the phone view', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/healthz`);
  await p.evaluate(() => localStorage.setItem('helfi.ui', 'desktop'));
  await p.goto(`${S.base}/browse/IT-1`);
  await ready(p);
  assert.equal(path(p), '/browse/IT-1');
  await p.goto(`${S.base}/m/me`);
  await p.waitForURL('**/profile');
  await ready(p);
  await p.tap('.topbar-user');
  const item = p.locator('.menu-item', { hasText: 'Handy-Ansicht' });
  assert.equal(await item.count(), 1);
  await item.tap();
  await p.waitForURL('**/m/me');
  assert.equal(await p.evaluate(() => localStorage.getItem('helfi.ui')), 'mobile');
  await ready(p);
  // ... and back: "Desktop view" in the "Me" tab
  await p.locator('.m-row', { hasText: 'Desktop-Ansicht' }).tap();
  await p.waitForURL('**/profile');
  assert.equal(await p.evaluate(() => localStorage.getItem('helfi.ui')), 'desktop');
  assert.deepEqual(errors, []);
  await close();
});

test('Sign-in on /m/login: error from the address, wrong password, continue to the requested page', { skip }, async () => {
  const { p, errors, close } = await open(null);
  await p.goto(`${S.base}/login?error=oidcFailed`);
  await p.waitForURL('**/m/login*');
  await ready(p);
  assert.match(await p.textContent('.m-alert-error'), /SSO-Anmeldung ist fehlgeschlagen/);
  await p.goto(`${S.base}/browse/IT-1`);
  await p.waitForURL('**/m/login');
  await ready(p);
  assert.equal(await p.isVisible('.m-tabbar .m-tab'), false, 'no tabs before sign-in');
  await p.fill('input[name=username]', 'anna');
  await p.fill('input[name=password]', 'falsch-falsch');
  await p.tap('button[type=submit]');
  await p.waitForSelector('.m-alert-error:not([hidden])');
  await p.fill('input[name=username]', 'anna');
  await p.fill('input[name=password]', 'Sehrgeheim123');
  await p.tap('button[type=submit]');
  await p.waitForURL('**/m/t/IT-1');
  await ready(p);
  assert.match(await p.textContent('.m-ticket-h1'), /Drucker/);
  // Sign out in the "Me" tab
  await p.goto(`${S.base}/m/me`);
  await ready(p);
  await p.locator('.m-row.danger').tap();
  await p.waitForURL('**/m/login');
  assert.equal((await p.request.get(`${S.base}/api/me`)).status(), 401);
  // 401 error from 4xx login attempts is expected in the console
  assert.deepEqual(errors.filter((e) => !/401/.test(e)), []);
  await close();
});

test('Sign-in with two-factor code; first-time setup happens on the phone', { skip }, async () => {
  const { totpAt, currentStep } = await import('../src/auth/totp.js');
  const max = await S.client().login('max');
  const setup = (await max('POST', '/api/me/mfa/setup')).body;
  assert.equal((await max('POST', '/api/me/mfa/enable', { code: totpAt(setup.secret, currentStep()) })).status, 200);
  S.db.prepare("UPDATE users SET totp_last_step=0 WHERE username='max'").run();
  S.ctx.settings.set('mfa.internal', 'all');
  try {
    const { p, errors, close } = await open(null);
    await p.goto(`${S.base}/m/login`);
    await ready(p);
    await p.fill('input[name=username]', 'max');
    await p.fill('input[name=password]', 'Sehrgeheim123');
    await p.tap('button[type=submit]');
    await p.waitForSelector('input.m-code');
    await p.fill('input.m-code', totpAt(setup.secret, currentStep()));
    await p.waitForURL((u) => u.pathname === '/m/');
    await ready(p);
    assert.equal(await p.textContent('.m-page:not(.m-leaving) .m-title'), 'Meine Anfragen');
    await close();
    assert.deepEqual(errors, []);

    // Account without 2FA where it is required: setup right here on the phone
    // (secret key with copy button, otpauth:// link, QR only for another device, then recovery codes)
    S.db.prepare("UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE username='eva'").run();
    const second = await open(null);
    await second.p.goto(`${S.base}/m/login`);
    await ready(second.p);
    await second.p.fill('input[name=username]', 'eva');
    await second.p.fill('input[name=password]', 'Sehrgeheim123');
    await second.p.tap('button[type=submit]');
    await second.p.waitForSelector('.m-secret');
    const secret = (await second.p.textContent('.m-secret')).replace(/\s+/g, '');
    assert.match(secret, /^[A-Z2-7]{16,}$/);
    const href = await second.p.getAttribute('a.m-otpauth', 'href');
    assert.match(href, /^otpauth:\/\/totp\//);
    assert.ok(href.includes(`secret=${secret}`), href);
    assert.equal(await second.p.isVisible('img.m-qr'), false, 'QR code folded away');
    await second.p.tap('.m-qr-details summary');
    assert.ok(await second.p.isVisible('img.m-qr'));
    assert.equal(await second.p.locator('a.m-btn', { hasText: 'Desktop' }).count(), 0, 'no detour via the desktop view');
    await second.p.fill('.m-mfa-setup input.m-code', '000000');
    await second.p.waitForSelector('.m-mfa-setup .m-alert-error:not([hidden])');
    await second.p.fill('.m-mfa-setup input.m-code', totpAt(secret, currentStep()));
    await second.p.waitForSelector('.m-recovery-codes li');
    assert.equal(await second.p.locator('.m-recovery-codes li').count(), 10);
    await second.p.tap('.m-recovery-done');
    await second.p.waitForURL((u) => u.pathname === '/m/');
    assert.equal(S.db.prepare("SELECT totp_enabled FROM users WHERE username='eva'").get().totp_enabled, 1);
    assert.deepEqual(second.errors.filter((e) => !/40[01]/.test(e)), []);
    await second.close();
  } finally {
    S.ctx.settings.set('mfa.internal', '');
    S.db.prepare("UPDATE users SET totp_enabled=1 WHERE username='eva'").run();
  }
});

test('Agent home: counter chips and assigned tickets', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m`);
  await ready(p);
  assert.equal(await p.textContent('.m-title'), 'Meine Arbeit');
  const stats = await p.$$eval('.m-stat', (x) => x.map((s) => [s.querySelector('.m-stat-n').textContent, s.querySelector('.m-stat-l').textContent]));
  assert.equal(stats.length, 5);
  assert.deepEqual(stats[0], ['2', 'Mir zugewiesen']);
  assert.deepEqual(stats.map((s) => s[1]), ['Mir zugewiesen', 'Nicht zugewiesen', 'Offen', 'In Arbeit', 'Wartet']);
  assert.deepEqual(await p.$$eval('.m-section .m-ticket', (x) => x.map((c) => c.dataset.key).sort()), ['IT-1', 'IT-2']);
  // Tab bar for agents: My work, Tickets, +, Knowledge, Me
  assert.deepEqual(await p.$$eval('.m-tabbar .m-tab', (x) => x.map((tb) => tb.textContent.trim() || tb.querySelector('button')?.getAttribute('aria-label'))), ['Meine Arbeit', 'Tickets', 'Neues Ticket', 'Wissen', 'Ich']);
  assert.equal(await p.getAttribute('.m-tab[data-tab=home]', 'aria-current'), 'page');
  await p.locator('.m-stat', { hasText: 'Nicht zugewiesen' }).tap();
  await p.waitForURL('**/m/tickets?assignee=none&status=unresolved');
  await ready(p);
  assert.match(await p.textContent('.m-chip.active'), /Nicht zugewiesen/);
  assert.equal(await p.getAttribute('.m-tab[data-tab=tickets]', 'aria-current'), 'page');
  assert.ok(await p.locator('.m-ticket').count() >= 10);
  assert.equal(await p.locator('.m-ticket[data-key="IT-1"]').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test('User home: own requests with filter chips, no agent counters', { skip }, async () => {
  const { p, errors, close } = await open('eva');
  await p.goto(`${S.base}/requests`);
  await p.waitForURL('**/m/');
  await ready(p);
  assert.equal(await p.textContent('.m-title'), 'Meine Anfragen');
  assert.equal(await p.locator('.m-stat').count(), 0);
  assert.deepEqual(await p.$$eval('.m-tabbar .m-tab', (x) => x.map((tb) => tb.textContent.trim() || tb.querySelector('button')?.getAttribute('aria-label'))), ['Anfragen', 'Neues Ticket', 'Wissen', 'Ich']);
  // Eva only takes part in IT-1
  assert.deepEqual(await p.$$eval('.m-ticket', (x) => x.map((c) => c.dataset.key)), ['IT-1']);
  await p.locator('.m-chip', { hasText: 'Erledigt' }).tap();
  await p.waitForSelector('.m-empty');
  assert.equal(path(p), '/m/?filter=done');
  await p.locator('.m-chip', { hasText: 'Ich bin Teilnehmer' }).tap();
  await p.waitForSelector('.m-ticket[data-key="IT-1"]');
  assert.deepEqual(errors, []);
  await close();
});

test('Tickets tab: full-text search, filter sheet, load more', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/tickets?status=unresolved`);
  await ready(p);
  await p.fill('.m-search-input', 'Trommel');
  await p.press('.m-search-input', 'Enter');
  await p.waitForSelector('.m-ticket[data-key="IT-1"]');
  await ready(p);
  assert.equal(await p.locator('.m-ticket').count(), 1);
  assert.match(path(p), /q=Trommel/);
  assert.ok(await p.isVisible('.m-ticket-match.internal'), 'hit in the internal note marked');
  // Filter sheet: type "incident"
  await p.fill('.m-search-input', '');
  await p.waitForFunction(() => document.querySelectorAll('.m-ticket').length > 2);
  await p.tap('.m-filter-btn');
  await p.waitForSelector('.m-sheet-layer.open');
  await p.locator('.m-choice', { hasText: 'Störung' }).tap();
  await p.locator('.m-sheet-foot .m-btn-primary').tap();
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  await ready(p);
  assert.deepEqual((await p.$$eval('.m-ticket', (x) => x.map((c) => c.dataset.key))).sort(), ['IT-1', 'IT-2']);
  assert.match(path(p), /type=incident/);
  assert.ok(await p.isVisible('.m-filter-btn.has-dot'));
  assert.equal(path(p).includes('sheet'), false);
  // Users never find internal notes
  const user = await open('karl');
  await user.p.goto(`${S.base}/m/tickets?q=Trommel`);
  await ready(user.p);
  assert.equal(await user.p.locator('.m-ticket').count(), 0);
  assert.ok(await user.p.isVisible('.m-empty'));
  await user.close();
  // More than one page: the list grows (limit 50 → the data set here is small, so check the request parameter)
  const sizes = [];
  p.on('request', (r) => { if (r.url().includes('/api/tickets?')) sizes.push(new URL(r.url()).searchParams.get('limit')); });
  await p.goto(`${S.base}/m/tickets`);
  await ready(p);
  assert.deepEqual(sizes, ['50']);
  assert.equal(await p.locator('.m-more button').count(), 0, 'no "load more" when everything is shown');
  assert.deepEqual(errors, []);
  await close();
});

test('Ticket view: internal note and history for the agent, never for the user', { skip }, async () => {
  const agent = await open('anna');
  await agent.p.goto(`${S.base}/m/t/IT-1`);
  await ready(agent.p);
  assert.match(await agent.p.textContent('.m-msg.internal'), /Trommel vermutlich defekt/);
  assert.ok(await agent.p.locator('.m-msg.internal .m-msg-internal').isVisible());
  assert.ok(await agent.p.locator('.m-event').count() >= 3, 'history lines');
  const img = await agent.p.$eval('.m-att-img img', (i) => { i.loading = 'eager'; return i.decode().then(() => i.naturalWidth).catch(() => 0); });
  assert.ok(img > 0, 'image thumbnail loads');
  assert.equal(await agent.p.getAttribute('.m-att-file', 'href'), `/api/attachments/${await agent.p.$eval('.m-att-file', (a) => a.getAttribute('href').match(/\d+/)[0])}?download=1`);
  assert.equal(await agent.p.isVisible('.m-tabbar'), false, 'no tab bar on the ticket page');
  assert.ok(await agent.p.locator('.m-reply').isVisible(), 'reply bar instead of the tab bar');
  assert.deepEqual(agent.errors, []);
  await agent.close();

  const user = await open('karl');
  await user.p.goto(`${S.base}/m/t/IT-1`);
  await ready(user.p);
  const text = await user.p.textContent('.m-page');
  assert.doesNotMatch(text, /Trommel/);
  assert.equal(await user.p.locator('.m-msg.internal').count(), 0);
  assert.equal(await user.p.locator('.m-event').count(), 0, 'no history for users');
  assert.match(text, /Ich schaue mir das gleich an/);
  assert.match(await user.p.textContent('.m-people'), /Ihr Ansprechpartner/);
  await user.p.tap('.m-details-btn');
  await user.p.waitForSelector('.m-sheet-layer.open');
  assert.doesNotMatch(await user.p.textContent('.m-sheet'), /Auswirkung|Verknüpfungen/);
  assert.deepEqual(user.errors, []);
  await user.close();
});

test('Details sheet: opens, closes with the button, Esc, back and swipe down', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  const isOpen = () => p.locator('.m-sheet-layer.open').count();
  await p.tap('.m-details-btn');
  await p.waitForSelector('.m-sheet-layer.open [role=dialog]');
  assert.match(await p.textContent('.m-sheet'), /Anfrage-Teilnehmer[\s\S]*eva/);
  assert.match(await p.textContent('.m-sheet'), /Erste Reaktion/);
  assert.equal(await p.evaluate(() => document.getElementById('m-app').inert), true, 'page behind the sheet is inert');
  await p.tap('.m-sheet-head .m-iconbtn');
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  assert.equal(path(p), '/m/t/IT-1');
  // Esc
  await p.tap('.m-topbar .m-actions .m-iconbtn');
  await p.waitForSelector('.m-sheet-layer.open');
  await p.keyboard.press('Escape');
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  // Back (Android back button) closes only the sheet
  await p.tap('.m-details-btn');
  await p.waitForSelector('.m-sheet-layer.open');
  await p.goBack();
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  assert.equal(path(p), '/m/t/IT-1');
  assert.ok(await p.isVisible('.m-ticket-h1'));
  // Swipe down on the handle
  await p.tap('.m-details-btn');
  await p.waitForSelector('.m-sheet-layer.open');
  await p.waitForTimeout(350);
  await touchDrag(p, '.m-sheet-head', 0, 400);
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  assert.equal(path(p), '/m/t/IT-1');
  assert.equal(await isOpen(), 0);
  assert.equal(await p.evaluate(() => document.getElementById('m-app').inert), false);
  assert.deepEqual(errors, []);
  await close();
});

/** Finger drag via touch events (Playwright only taps) */
function touchDrag(p, selector, dx, dy, { fromX = null } = {}) {
  return p.evaluate(async ({ selector, dx, dy, fromX }) => {
    const el = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    const x0 = fromX ?? r.left + r.width / 2; const y0 = r.top + Math.min(20, r.height / 2);
    const touch = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
    const fire = (type, x, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(x, y)], changedTouches: [touch(x, y)] }));
    fire('touchstart', x0, y0);
    for (let i = 1; i <= 10; i++) { fire('touchmove', x0 + (dx * i) / 10, y0 + (dy * i) / 10); await new Promise((res) => setTimeout(res, 16)); }
    fire('touchend', x0 + dx, y0 + dy);
  }, { selector, dx, dy, fromX });
}

test('Back navigation: history, back button, edge swipe, scroll position kept', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/tickets`);
  await ready(p);
  await p.evaluate(() => { document.querySelector('.m-page .m-scroll').scrollTop = 700; });
  const before = await scrollTop(p);
  assert.ok(before > 300, `list scrolls (${before})`);
  const key = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.m-ticket')];
    const sc = document.querySelector('.m-page .m-scroll').getBoundingClientRect();
    return cards.find((c) => c.getBoundingClientRect().top > sc.top + 60).dataset.key;
  });
  await p.locator(`.m-ticket[data-key="${key}"]`).tap();
  await p.waitForURL(`**/m/t/${key}`);
  await ready(p);
  assert.equal(await p.locator('.m-page').count(), 1, 'old page removed after the transition');
  // Browser back: list again at the same position
  await p.goBack();
  await p.waitForURL('**/m/tickets');
  await p.waitForTimeout(450);
  assert.equal(await scrollTop(p), before);
  // Back button in the top bar
  await p.locator(`.m-ticket[data-key="${key}"]`).tap();
  await p.waitForURL(`**/m/t/${key}`);
  await ready(p);
  await p.tap('.m-back');
  await p.waitForURL('**/m/tickets');
  await p.waitForTimeout(450);
  assert.equal(await scrollTop(p), before);
  // Edge swipe from the left screen edge
  await p.locator(`.m-ticket[data-key="${key}"]`).tap();
  await p.waitForURL(`**/m/t/${key}`);
  await ready(p);
  await touchDrag(p, '.m-page .m-scroll', 300, 10, { fromX: 6 });
  await p.waitForURL('**/m/tickets');
  await p.waitForTimeout(450);
  assert.equal(await scrollTop(p), before);
  assert.equal(await p.locator('.m-page').count(), 1);
  // A swipe that does not start at the edge does nothing
  await p.locator(`.m-ticket[data-key="${key}"]`).tap();
  await p.waitForURL(`**/m/t/${key}`);
  await ready(p);
  await touchDrag(p, '.m-page .m-scroll', 300, 10, { fromX: 120 });
  await p.waitForTimeout(400);
  assert.equal(path(p), `/m/t/${key}`);
  // Deep link without history: back goes to the start page
  await p.goto(`${S.base}/m/t/IT-2`);
  await ready(p);
  await p.tap('.m-back');
  await p.waitForURL((u) => u.pathname === '/m/');
  assert.deepEqual(errors, []);
  await close();
});

test('Pull to refresh reloads the list', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m`);
  await ready(p);
  let calls = 0;
  p.on('request', (r) => { if (r.url().includes('/api/stats')) calls++; });
  await touchDrag(p, '.m-page .m-scroll', 0, 300);
  await p.waitForTimeout(800);
  assert.equal(calls, 1);
  assert.deepEqual(errors, []);
  await close();
});

test('Language switch in the "Me" tab, news page, 401 leads to sign-in', { skip }, async () => {
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/me`);
  await ready(p);
  await p.locator('.m-segmented button', { hasText: 'English' }).tap();
  await p.waitForFunction(() => document.querySelector('.m-page .m-title')?.textContent === 'Me');
  assert.match(await p.textContent('.m-tabbar'), /Requests/);
  await p.locator('.m-row', { hasText: "What's new" }).tap();
  await p.waitForURL('**/m/news');
  await ready(p);
  assert.equal(await p.textContent('.m-page:not(.m-leaving) .m-title'), "What's new");
  await p.locator('.m-segmented button').count();
  await p.tap('.m-back');
  await p.waitForURL('**/m/me');
  await ready(p);
  await p.locator('.m-segmented button', { hasText: 'Deutsch' }).tap();
  await p.waitForFunction(() => document.querySelector('.m-page .m-title')?.textContent === 'Ich');
  // Session gone → sign-in page
  await p.request.post(`${S.base}/api/auth/logout`, { headers: { 'X-Helfi-Request': '1' } });
  await p.tap('.m-tab[data-tab=home]');
  await p.waitForURL('**/m/login');
  assert.deepEqual(errors.filter((e) => !/401/.test(e)), []);
  await close();
});

/** Elements that stick out past the right edge of the screen (except in areas that scroll sideways themselves) */
const overflow = () => {
  const vw = window.innerWidth; const out = [];
  const inScroller = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll)/.test(s.overflowX) && !a.classList.contains('m-scroll')) return true; } return false; };
  for (const el of document.querySelectorAll('.m-page *, .m-tabbar *, .m-sheet *')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > vw + 1 && !inScroller(el) && !el.closest('.m-leaving')) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
  }
  if (document.documentElement.scrollWidth > vw) out.push('document');
  return out.slice(0, 5);
};

const PAGES = {
  anna: ['/m', '/m/tickets', '/m/tickets?q=Drucker', '/m/t/IT-1', '/m/t/IT-1#details', '/m/new', '/m/kb', '/m/kb/1', '/m/me', '/m/news', '/m/gibt-es-nicht'],
  karl: ['/m', '/m/t/IT-1', '/m/tickets?q=VPN', '/m/me', '/m/kb'],
  '': ['/m/login'],
};
for (const [w, hgt] of [[390, 844], [360, 740]]) {
  test(`No mobile page overflows sideways (${w} px)`, { skip }, async () => {
    for (const [who, urls] of Object.entries(PAGES)) {
      const { p, errors, close } = await open(who || null, { ...PHONE, viewport: { width: w, height: hgt } });
      for (const url of urls) {
        await p.goto(S.base + url.replace('#details', ''));
        await ready(p);
        if (url.endsWith('#details')) { await p.tap('.m-details-btn'); await p.waitForTimeout(400); }
        assert.deepEqual(await p.evaluate(overflow), [], `${who} ${url}`);
        // Touch targets: buttons and tabs at least 44 px high
        const small = await p.evaluate(() => [...document.querySelectorAll('.m-iconbtn, .m-tab, .m-btn, .m-chip, .m-choice, .m-row')]
          .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.className));
        assert.deepEqual(small, [], `${who} ${url}: touch targets`);
      }
      assert.deepEqual(errors, [], who);
      await close();
    }
  });
}

// ---------- Part 2: reply bar, photos, actions ----------
const newTicket = async (title, type = 'request') => (await who.karl('POST', '/api/tickets', { title, description: 'Bitte prüfen.', type })).body.ticket.key;
const ticketApi = async (client, key) => (await client('GET', `/api/tickets/${key}`)).body.ticket;
/** PNG of any size, drawn in the page (no image library needed in the tests) */
const pngOf = async (p, w, hgt) => Buffer.from(await p.evaluate(({ w, hgt }) => {
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  const g = c.getContext('2d');
  g.fillStyle = '#5B8DEF'; g.fillRect(0, 0, w, hgt);
  g.fillStyle = '#fff'; g.fillRect(w / 4, hgt / 4, w / 2, hgt / 2);
  return c.toDataURL('image/png').split(',')[1];
}, { w, hgt }), 'base64');
/** Pick a file through the attach sheet ("Foto aufnehmen" or "Datei") */
async function attach(p, which, file) {
  const chooser = p.waitForEvent('filechooser');
  await p.tap('.m-reply-attach');
  await p.waitForSelector('.m-sheet-layer.open .m-action');
  await p.locator('.m-sheet .m-action', { hasText: which }).tap();
  await (await chooser).setFiles(file);
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  await p.waitForFunction((name) => [...document.querySelectorAll('.m-file')].some((f) => f.dataset.name.startsWith(name) && !f.classList.contains('processing')), file.name.replace(/\.[^.]+$/, ''));
}
const sendAndWait = async (p, text) => {
  await p.tap('.m-reply-send');
  await p.waitForFunction((x) => [...document.querySelectorAll('.m-msg')].some((m) => m.textContent.includes(x)), text);
  await p.waitForFunction(() => !document.querySelector('.m-reply.busy'));
};

test('Reply bar: agent reply and internal note with photo and file; the user sees neither the note nor its files', { skip }, async () => {
  const key = await newTicket('Notebook PC-0001 startet nicht');
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/${key}`);
  await ready(p);
  assert.ok(await p.isVisible('.m-reply'));
  assert.equal(await p.isDisabled('.m-reply-send'), true, 'send disabled while empty');
  assert.equal(await p.getAttribute('.m-reply-mode:not(.m-reply-mode-note)', 'aria-pressed'), 'true');
  // Public reply
  await p.fill('.m-reply-input', 'Ich komme gleich vorbei.');
  assert.equal(await p.isDisabled('.m-reply-send'), false);
  await sendAndWait(p, 'Ich komme gleich vorbei.');
  assert.equal(await p.inputValue('.m-reply-input'), '');
  assert.equal(await p.isDisabled('.m-reply-send'), true);
  assert.ok(await p.locator('.m-msg.mine:not(.internal)', { hasText: 'Ich komme gleich vorbei.' }).isVisible());
  // Internal note: yellow bar, a large photo (downscaled) and a text file
  await p.tap('.m-reply-mode-note');
  assert.ok(await p.isVisible('.m-reply.internal'));
  assert.equal(await p.getAttribute('.m-reply-mode-note', 'aria-pressed'), 'true');
  assert.ok(await p.locator('.m-reply-hint').isVisible());
  await p.fill('.m-reply-input', 'Netzteil defekt, Ersatz ist bestellt.');
  await attach(p, 'Foto aufnehmen', { name: 'typenschild.png', mimeType: 'image/png', buffer: await pngOf(p, 3200, 1800) });
  await attach(p, 'Datei', { name: 'protokoll.txt', mimeType: 'text/plain', buffer: Buffer.from('Fehler 49\n') });
  assert.equal(await p.locator('.m-file').count(), 2);
  assert.match(await p.textContent('.m-file[data-name="typenschild.jpg"]'), /verkleinert/);
  assert.ok(await p.$eval('.m-file[data-name="typenschild.jpg"] img', (i) => i.decode().then(() => i.naturalWidth)) > 0, 'thumbnail');
  // Removing a chip works (and does not upload it)
  await attach(p, 'Datei', { name: 'falsch.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await p.tap('.m-file[data-name="falsch.txt"] .m-file-x');
  assert.equal(await p.locator('.m-file').count(), 2);
  await sendAndWait(p, 'Netzteil defekt');
  assert.equal(await p.locator('.m-file').count(), 0, 'chips gone after sending');
  const note = p.locator('.m-msg.internal', { hasText: 'Netzteil defekt' });
  assert.ok(await note.locator('.inline-image img').count(), 'photo in the note');
  assert.ok(await note.locator('.m-att-file', { hasText: 'protokoll.txt' }).count(), 'file in the note');
  // Server: both files belong to the internal note, the photo is a 2560 px JPEG
  const tk = await ticketApi(who.anna, key);
  const c = tk.comments.find((x) => x.body.startsWith('Netzteil defekt'));
  assert.equal(c.internal, true);
  const files = tk.attachments.filter((a) => a.commentId === c.id);
  assert.deepEqual(files.map((a) => a.filename).sort(), ['protokoll.txt', 'typenschild.jpg']);
  assert.ok(!tk.attachments.some((a) => a.filename === 'falsch.txt'));
  const photo = files.find((a) => a.mime === 'image/jpeg');
  assert.ok(photo, 'photo stored as JPEG');
  assert.deepEqual(await p.evaluate((id) => fetch(`/api/attachments/${id}`).then((r) => r.blob()).then(createImageBitmap).then((b) => [b.width, b.height]), photo.id), [2560, 1440]);
  assert.deepEqual(errors, []);
  await close();

  // The user: no internal note, no files of it, no agent controls
  const user = await open('karl');
  await user.p.goto(`${S.base}/m/t/${key}`);
  await ready(user.p);
  const text = await user.p.textContent('.m-page');
  assert.match(text, /Ich komme gleich vorbei/);
  assert.doesNotMatch(text, /Netzteil|protokoll\.txt|typenschild/);
  assert.equal(await user.p.locator('.m-msg.internal').count(), 0);
  for (const a of files) assert.equal((await user.p.request.get(`${S.base}/api/attachments/${a.id}`)).status(), 404, a.filename);
  const kt = await ticketApi(who.karl, key);
  assert.ok(!kt.attachments.some((a) => files.some((f) => f.id === a.id)));
  for (const sel of ['.m-reply-tools', '.m-reply-mode', '.m-reply-tpl', '.m-status-btn', '.m-pill-btn', '.m-person-btn', '.m-assign-me']) {
    assert.equal(await user.p.locator(sel).count(), 0, sel);
  }
  await user.p.tap('.m-more-btn');
  await user.p.waitForSelector('.m-sheet-layer.open .m-action');
  for (const a of ['status', 'assign-me', 'assignee', 'priority', 'type']) assert.equal(await user.p.locator(`.m-action[data-action="${a}"]`).count(), 0, a);
  assert.deepEqual(user.errors, []);
  await user.close();
});

test('User: reply with an attachment, no internal notes', { skip }, async () => {
  const key = await newTicket('Monitor flackert an PC-0001');
  await who.anna('POST', `/api/tickets/${key}/comments`, { body: 'Kabel geprüft, intern notiert.', internal: true });
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/t/${key}`);
  await ready(p);
  assert.doesNotMatch(await p.textContent('.m-page'), /intern notiert/);
  assert.equal(await p.locator('.m-reply-mode').count(), 0, 'users never see the mode toggle');
  await p.fill('.m-reply-input', 'Hier ein Foto vom Bildschirm.');
  await attach(p, 'Datei', { name: 'bildschirm.png', mimeType: 'image/png', buffer: await pngOf(p, 640, 480) });
  assert.doesNotMatch(await p.textContent('.m-file'), /verkleinert/, 'small pictures stay as they are');
  await sendAndWait(p, 'Hier ein Foto vom Bildschirm.');
  const tk = await ticketApi(who.anna, key);
  const c = tk.comments.find((x) => x.body.startsWith('Hier ein Foto'));
  assert.equal(c.internal, false);
  const a = tk.attachments.find((x) => x.commentId === c.id);
  assert.equal(a.filename, 'bildschirm.png');
  assert.equal(a.mime, 'image/png');
  assert.equal((await who.anna('GET', `/api/attachments/${a.id}`)).status, 200);
  assert.ok(await p.locator('.m-msg.mine .inline-image img').count());
  assert.deepEqual(errors, []);
  await close();
});

test('Canned response, status change and resolve with a closing reply', { skip }, async () => {
  const key = await newTicket('Drucker im Besprechungsraum offline');
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/${key}`);
  await ready(p);
  // Template: inserted at the cursor, placeholders filled
  await p.fill('.m-reply-input', 'Vorab: ');
  await p.tap('.m-reply-tpl');
  await p.waitForSelector('.m-sheet-layer.open .m-canned-item');
  await p.fill('.m-sheet-search-input', 'neust');
  assert.equal(await p.locator('.m-canned-item').count(), 1);
  await p.locator('.m-canned-item').tap();
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  assert.equal(await p.inputValue('.m-reply-input'), 'Vorab: Hallo karl, bitte starte das Gerät einmal neu.');
  assert.equal(await p.evaluate(() => document.activeElement?.classList.contains('m-reply-input')), true, 'focus back in the text field');
  await p.fill('.m-reply-input', '');
  // Status "waiting"
  await p.tap('.m-status-btn');
  await p.waitForSelector('.m-sheet-layer.open .m-choice-row');
  await p.locator('.m-choice-row', { hasText: 'Wartet' }).tap();
  await p.waitForFunction(() => document.querySelector('.m-status-btn .lozenge')?.textContent === 'Wartet');
  await p.waitForLoadState('networkidle');
  assert.equal((await ticketApi(who.anna, key)).status, 'waiting');
  // Resolve with a closing reply from a template
  await p.tap('.m-status-btn');
  await p.waitForSelector('.m-sheet-layer.open .m-choice-row');
  await p.locator('.m-choice-row', { hasText: 'Erledigt' }).tap();
  await p.waitForSelector('.m-sheet-resolve textarea');
  await p.locator('.m-sheet-resolve .m-btn-ghost').tap();
  await p.waitForSelector('.m-sheet-canned .m-canned-item');
  await p.locator('.m-canned-item', { hasText: 'Problem behoben' }).tap();
  await p.waitForSelector('.m-sheet-resolve textarea');
  assert.equal(await p.inputValue('.m-sheet-resolve textarea'), 'Hallo {melder}, das Problem ist behoben.', 'the server fills in the placeholders');
  await p.locator('.m-sheet-resolve .m-btn-primary').tap();
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  await p.waitForFunction(() => document.querySelector('.m-status-btn .lozenge')?.textContent === 'Erledigt');
  const tk = await ticketApi(who.anna, key);
  assert.equal(tk.status, 'done');
  const last = tk.comments.at(-1);
  assert.equal(last.body, 'Hallo karl, das Problem ist behoben.');
  assert.equal(last.internal, false);
  assert.ok(await p.locator('.m-msg', { hasText: 'das Problem ist behoben' }).count(), 'closing reply in the timeline');
  assert.deepEqual(errors, []);
  await close();
});

test('Assign to me, assignee and priority pickers, add and remove participants', { skip }, async () => {
  const key = await newTicket('Zugang zum Laufwerk S: fehlt');
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/${key}`);
  await ready(p);
  await p.tap('.m-assign-me');
  await p.waitForSelector('.m-assign-me', { state: 'detached' });
  await p.waitForLoadState('networkidle');
  assert.equal((await ticketApi(who.anna, key)).assignee.id, S.ids.anna);
  assert.match(await p.textContent('.m-person-btn'), /anna/);
  // Assignee sheet: me first, search
  await p.tap('.m-person-btn');
  await p.waitForSelector('.m-sheet-layer.open .m-choice-row');
  assert.match(await p.textContent('.m-choice-row >> nth=0'), /anna.*Ich/s);
  await p.fill('.m-sheet-search-input', 'tom');
  assert.equal(await p.locator('.m-choice-row').count(), 1);
  await p.locator('.m-choice-row').tap();
  await p.waitForFunction(() => /tom/.test(document.querySelector('.m-person-btn')?.textContent));
  await p.waitForLoadState('networkidle');
  assert.equal((await ticketApi(who.anna, key)).assignee.id, S.ids.tom);
  assert.ok(await p.isVisible('.m-assign-me'), '"assign to me" again');
  // Priority
  await p.tap('.m-pill-btn');
  await p.waitForSelector('.m-sheet-layer.open .m-choice-row');
  await p.locator('.m-choice-row', { hasText: 'Sehr hoch' }).tap();
  await p.waitForFunction(() => /Sehr hoch/.test(document.querySelector('.m-pill-btn')?.textContent));
  await p.waitForLoadState('networkidle');
  assert.equal((await ticketApi(who.anna, key)).priority, 'highest');
  // Participants: search keeps the focus in the field, add, then remove
  await p.tap('.m-more-btn');
  await p.waitForSelector('.m-sheet-layer.open .m-action');
  await p.locator('.m-action[data-action="participants"]').tap();
  await p.waitForSelector('.m-sheet-people .m-sheet-search-input');
  await p.locator('.m-sheet-search-input').focus();
  await p.keyboard.type('ev');
  await p.waitForSelector('.m-person-hit');
  assert.match(await p.textContent('.m-person-hit'), /eva/);
  await p.locator('.m-person-hit', { hasText: 'eva' }).tap();
  await p.waitForSelector('.m-people-current .m-person-row[data-id]');
  assert.equal(await p.evaluate(() => document.activeElement?.classList.contains('m-sheet-search-input')), true, 'focus stays in the field');
  assert.deepEqual((await ticketApi(who.anna, key)).participants.map((x) => x.username), ['eva']);
  // An email address can be added by agents
  await p.keyboard.type('extern@firma.local');
  await p.waitForSelector('.m-person-hit', { hasText: 'extern@firma.local' });
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelectorAll('.m-people-current .m-person-row[data-id]').length === 2);
  await p.locator('.m-people-current .m-person-row', { hasText: 'eva' }).locator('.m-person-x').tap();
  await p.waitForFunction(() => document.querySelectorAll('.m-people-current .m-person-row[data-id]').length === 1);
  assert.deepEqual((await ticketApi(who.anna, key)).participants.map((x) => x.email), ['extern@firma.local']);
  assert.deepEqual(errors, []);
  await close();
});

test('Approval card: approve a pending request', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/${approvalKey}`);
  await ready(p);
  assert.match(await p.textContent('.m-approval'), /Genehmigung erforderlich/);
  await p.fill('.m-approval textarea', 'Passt, bitte bestellen.');
  await p.locator('.m-approval .m-btn-success').tap();
  await p.waitForSelector('.m-approval.m-approval-info');
  assert.match(await p.textContent('.m-approval'), /genehmigt/);
  const tk = await ticketApi(who.anna, approvalKey);
  assert.equal(tk.approval.state, 'approved');
  assert.equal(tk.approval.items[0].comment, 'Passt, bitte bestellen.');
  assert.deepEqual(errors, []);
  await close();
  // The requester sees the state, but cannot decide
  const user = await open('karl');
  await user.p.goto(`${S.base}/m/t/${approvalKey}`);
  await ready(user.p);
  assert.equal(await user.p.locator('.m-approval .m-btn').count(), 0);
  assert.match(await user.p.textContent('.m-approval'), /genehmigt/);
  await user.close();
});

test('Keyboard: the reply bar stays visible when the visual viewport shrinks; the field grows up to 40 %', { skip }, async () => {
  const key = await newTicket('Tastatur am Empfang klemmt');
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/t/${key}`);
  await ready(p);
  await p.tap('.m-reply-input');
  for (const hgt of [844, 480, 360]) {
    await p.setViewportSize({ width: 390, height: hgt });
    await p.waitForTimeout(250);
    const box = await p.evaluate(() => {
      const r = document.querySelector('.m-reply').getBoundingClientRect();
      const vh = window.visualViewport.height + window.visualViewport.offsetTop;
      const input = document.querySelector('.m-reply-input').getBoundingClientRect();
      const hit = document.elementFromPoint(input.left + input.width / 2, input.top + input.height / 2);
      return { bottom: r.bottom, top: r.top, vh, hit: !!hit?.closest('.m-reply'), topbar: document.querySelector('.m-page .m-topbar').getBoundingClientRect().bottom };
    });
    assert.ok(box.bottom <= box.vh + 1 && box.top > box.topbar && box.hit, `${hgt}: ${JSON.stringify(box)}`);
  }
  // Long text: grows, but at most 40 % of the visible height
  await p.fill('.m-reply-input', Array.from({ length: 20 }, (_, i) => `Zeile ${i + 1}`).join('\n'));
  const grow = await p.evaluate(() => ({ h: document.querySelector('.m-reply-input').offsetHeight, vh: window.visualViewport.height }));
  assert.ok(grow.h > 60 && grow.h <= grow.vh * 0.4 + 2, JSON.stringify(grow));
  // Ctrl+Enter sends
  await p.fill('.m-reply-input', 'Mit Tastenkürzel gesendet');
  await p.press('.m-reply-input', 'Control+Enter');
  await p.waitForFunction(() => [...document.querySelectorAll('.m-msg')].some((m) => m.textContent.includes('Mit Tastenkürzel gesendet')));
  assert.deepEqual(errors, []);
  await close();
});

test('Draft is kept per ticket when navigating away and back', { skip }, async () => {
  const key = await newTicket('Headset knackt');
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/tickets?status=unresolved`);
  await ready(p);
  await p.locator(`.m-ticket[data-key="${key}"]`).tap();
  await p.waitForURL(`**/m/t/${key}`);
  await ready(p);
  await p.tap('.m-reply-mode-note');
  await p.fill('.m-reply-input', 'Entwurf: Ersatz-Headset liegt bereit');
  await p.tap('.m-back');
  await p.waitForURL('**/m/tickets?status=unresolved');
  await ready(p);
  await p.locator(`.m-ticket[data-key="${key}"]`).tap();
  await p.waitForURL(`**/m/t/${key}`);
  await ready(p);
  assert.equal(await p.inputValue('.m-reply-input'), 'Entwurf: Ersatz-Headset liegt bereit');
  assert.ok(await p.isVisible('.m-reply.internal'), 'mode kept');
  await p.reload();
  await ready(p);
  assert.equal(await p.inputValue('.m-reply-input'), 'Entwurf: Ersatz-Headset liegt bereit', 'kept after reloading the page');
  // Other tickets have their own (empty) draft
  await p.goto(`${S.base}/m/t/IT-2`);
  await ready(p);
  assert.equal(await p.inputValue('.m-reply-input'), '');
  assert.deepEqual(errors, []);
  await close();
});

test('Going back to the list after a change shows the change; pull to refresh on the ticket', { skip }, async () => {
  const key = await newTicket('Beamer im Raum 1.04 ohne Bild');
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/tickets?status=unresolved`);
  await ready(p);
  assert.match(await p.textContent(`.m-ticket[data-key="${key}"] .m-ticket-prio`), /Mittel/);
  await p.locator(`.m-ticket[data-key="${key}"]`).tap();
  await p.waitForURL(`**/m/t/${key}`);
  await ready(p);
  await p.tap('.m-pill-btn');
  await p.waitForSelector('.m-sheet-layer.open .m-choice-row');
  // The change reloads the ticket once (PATCH, then GET): wait for it before counting below
  const reloaded = p.waitForResponse((r) => r.url().endsWith(`/api/tickets/${key}`) && r.request().method() === 'GET');
  await p.locator('.m-choice-row', { hasText: 'Niedrig' }).tap();
  await p.waitForFunction(() => /Niedrig/.test(document.querySelector('.m-pill-btn')?.textContent));
  await reloaded;
  await p.waitForLoadState('networkidle');
  // Pull to refresh reloads the ticket
  let calls = 0;
  p.on('request', (r) => { if (r.url().endsWith(`/api/tickets/${key}`)) calls++; });
  await touchDrag(p, '.m-page .m-scroll', 0, 300);
  await p.waitForTimeout(800);
  assert.equal(calls, 1);
  await p.tap('.m-back');
  await p.waitForURL('**/m/tickets?status=unresolved');
  await p.waitForFunction((k) => /Niedrig/.test(document.querySelector(`.m-ticket[data-key="${k}"] .m-ticket-prio`)?.textContent), key);
  assert.deepEqual(errors, []);
  await close();
});

for (const [w, hgt] of [[390, 844], [360, 740]]) {
  test(`Ticket view with reply bar, chips and sheets does not overflow sideways (${w} px)`, { skip }, async () => {
    const { p, errors, close } = await open('anna', { ...PHONE, viewport: { width: w, height: hgt } });
    await p.goto(`${S.base}/m/t/IT-1`);
    await ready(p);
    await p.tap('.m-reply-mode-note');
    await p.fill('.m-reply-input', 'Eine längere interne Notiz mit https://firma.local/eine/sehr/lange/adresse/ohne/umbruch/bis/zum/ende');
    await attach(p, 'Datei', { name: 'ein-sehr-langer-dateiname-fuer-das-protokoll-von-PC-0001.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await attach(p, 'Datei', { name: 'foto.png', mimeType: 'image/png', buffer: await pngOf(p, 300, 200) });
    assert.deepEqual(await p.evaluate(overflow), [], 'reply bar');
    const sheets = [
      ['.m-more-btn', null],
      ['.m-status-btn', null],
      ['.m-person-btn', null],
      ['.m-reply-tpl', null],
      ['.m-more-btn', '.m-action[data-action="participants"]'],
      ['.m-details-btn', null],
    ];
    for (const [opener, then] of sheets) {
      await p.tap(opener);
      await p.waitForSelector('.m-sheet-layer.open');
      if (then) { await p.tap(then); await p.waitForTimeout(450); await p.waitForSelector('.m-sheet-layer.open'); }
      await p.waitForTimeout(350);
      assert.deepEqual(await p.evaluate(overflow), [], opener);
      await p.keyboard.press('Escape');
      await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
    }
    // Touch targets in the reply bar and sheets
    const small = await p.evaluate(() => [...document.querySelectorAll('.m-reply-send, .m-reply-attach, .m-reply-mode, .m-reply-tpl')]
      .filter((b) => b.getBoundingClientRect().height < 36).map((b) => b.className));
    assert.deepEqual(small, []);
    assert.deepEqual(errors, []);
    await close();
  });
}
