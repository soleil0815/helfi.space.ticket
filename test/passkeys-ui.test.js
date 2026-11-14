// Passkeys in the browser: add in the profile (desktop and phone app), sign in with the button,
// administration panel and user list. Chromium's virtual authenticator plays the phone with Face ID.
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

let S; let browser; let base; let config; let oldBase;
before(async () => {
  if (!chromium) return;
  S = await startServer('passkeys-ui');
  await S.user('karl', 'user');
  // WebAuthn does not accept IP addresses: serve the app as "localhost" and let HELFI_BASE_URL match
  base = S.base.replace('127.0.0.1', 'localhost');
  ({ config } = await import('../src/config.js'));
  oldBase = config.baseUrl;
  config.baseUrl = base;
  browser = await chromium.launch();
});
after(async () => { if (config) config.baseUrl = oldBase; await browser?.close(); await S?.stop(); });

async function open(username, { mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  // Virtual platform authenticator with Face ID/Touch ID (user verification) that confirms automatically
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const hdr = { 'X-Helfi-Request': '1' };
  if (username) {
    assert.equal((await p.request.post(`${base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' }, headers: hdr })).status(), 200);
    await p.request.patch(`${base}/api/me`, { data: { language: 'de' }, headers: hdr });
  }
  const logout = () => p.request.post(`${base}/api/auth/logout`, { headers: hdr });
  return { p, ctx, cdp, authenticatorId, errors, logout };
}

test('Desktop: add a passkey in the profile, sign out, sign in with "Mit Passkey anmelden"', { skip }, async () => {
  const { p, ctx, cdp, authenticatorId, errors, logout } = await open('karl');
  await p.goto(`${base}/profile`);
  await p.waitForSelector('[data-passkeys-panel] >> text=Du hast noch keinen Passkey.');
  await p.fill('[data-passkeys-panel] input[name="passkey-name"]', 'Büro-Mac');
  await p.click('[data-passkey-add]');
  await p.waitForSelector('[data-passkeys-panel] .passkey-item >> text=Büro-Mac');
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true, 'discoverable passkey (no user name needed)');
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM user_passkeys WHERE user_id=?').get(S.ids.karl).n, 1);

  await logout();
  // This time without the suggestion in the user name field (older browsers): only the button signs in
  await p.addInitScript(() => { window.PublicKeyCredential.isConditionalMediationAvailable = async () => false; });
  await p.goto(`${base}/login`);
  await p.waitForSelector('[data-passkey-login]');
  assert.equal(await p.getAttribute('input[name="username"]', 'autocomplete'), 'username webauthn');
  await p.click('[data-passkey-login]');
  await p.waitForFunction(() => !location.pathname.startsWith('/login'));
  const me = await (await p.request.get(`${base}/api/me`)).json();
  assert.equal(me.user.username, 'karl');
  assert.equal(S.db.prepare("SELECT auth_method FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(S.ids.karl).auth_method, 'passkey');

  // Remove it again in the profile
  await p.goto(`${base}/profile`);
  await p.click('[data-passkeys-panel] [data-passkey-remove]');
  await p.waitForSelector('[data-passkeys-panel] >> text=Du hast noch keinen Passkey.');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Phone app: add under "Ich" → Passkeys, sign in on /m/login', { skip }, async () => {
  const { p, ctx, errors, logout } = await open('karl', { mobile: true });
  await p.goto(`${base}/m/me`);
  await p.click('a[href="/m/me/passkeys"]');
  await p.waitForSelector('[data-passkey-add]');
  await p.click('[data-passkey-add]');
  await p.waitForSelector('.m-row >> text=Noch nicht benutzt');
  await logout();
  // The phone offers the passkey in the user name field (conditional mediation): the virtual
  // authenticator picks it at once, so the app signs in without a tap on the button
  await p.goto(`${base}/m/login`);
  await p.waitForFunction(() => !location.pathname.startsWith('/m/login'));
  assert.equal((await (await p.request.get(`${base}/api/me`)).json()).user.username, 'karl');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Without passkey support in the setting: no button on the sign-in page', { skip }, async () => {
  S.ctx.settings.set('passkeys.enabled', false);
  try {
    const { p, ctx, errors } = await open(null);
    await p.goto(`${base}/login`);
    await p.waitForSelector('input[name="username"]');
    assert.equal(await p.locator('[data-passkey-login]').count(), 0);
    assert.equal(await p.getAttribute('input[name="username"]', 'autocomplete'), 'username');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { S.ctx.settings.set('passkeys.enabled', true); }
});

test('Opened under another address (IP): no passkey button and no error, password sign-in as usual', { skip }, async () => {
  const { p, ctx, errors } = await open(null);
  await p.goto(`${S.base}/login`); // 127.0.0.1 instead of localhost
  await p.waitForSelector('input[name="username"]');
  await p.waitForTimeout(300);
  assert.equal(await p.locator('[data-passkey-login]').count(), 0);
  assert.equal(await p.locator('.form-error:not([hidden])').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Administration: passkey panel with host; user list shows the count and can remove them', { skip }, async () => {
  const { p, ctx, errors } = await open('admin');
  await p.goto(`${base}/admin/mfa`);
  await p.waitForSelector('[data-passkey-admin] >> text=Passkeys gelten für die Adresse localhost.');
  await p.goto(`${base}/admin/users`);
  const row = p.locator('tr', { hasText: 'karl' });
  await row.locator('[data-passkeys]').waitFor();
  await row.locator('[data-remove-passkeys]').click();
  await row.locator('[data-passkeys]').waitFor({ state: 'detached' });
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM user_passkeys WHERE user_id=?').get(S.ids.karl).n, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Start page hint: "Passkey einrichten" adds one directly, then the hint is gone', { skip }, async () => {
  await S.user('lisa', 'user');
  const { p, ctx, cdp, authenticatorId, errors } = await open('lisa');
  await p.goto(`${base}/portal`);
  await p.waitForSelector('[data-passkey-hint] >> text=Schneller anmelden – mit Passkey');
  assert.equal(await p.locator('.banner-mfa').count(), 0, 'the hint replaces the "set up 2FA" banner');
  await p.click('[data-passkey-hint-add]');
  await p.waitForSelector('[data-passkey-hint]', { state: 'detached' });
  assert.equal((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length, 1);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM user_passkeys WHERE user_id=?').get(S.ids.lisa).n, 1);
  // Not again on the next start page
  await p.goto(`${base}/requests`);
  await p.waitForSelector('.content');
  await p.waitForTimeout(400);
  assert.equal(await p.locator('[data-passkey-hint]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Start page hint: "Später" hides it (also after reloading); agents see it on the board', { skip }, async () => {
  await S.user('moritz', 'agent');
  const { p, ctx, errors } = await open('moritz');
  await p.goto(`${base}/board`);
  await p.waitForSelector('[data-passkey-hint]');
  await p.click('[data-passkey-hint-later]');
  await p.waitForSelector('[data-passkey-hint]', { state: 'detached' });
  await p.reload();
  await p.waitForSelector('.content');
  await p.waitForTimeout(400);
  assert.equal(await p.locator('[data-passkey-hint]').count(), 0);
  assert.ok(S.db.prepare('SELECT passkey_prompt_until v FROM users WHERE id=?').get(S.ids.moritz).v > Date.now());
  // Not on other pages (only start pages)
  S.db.prepare('UPDATE users SET passkey_prompt_until=NULL WHERE id=?').run(S.ids.moritz);
  await p.goto(`${base}/profile`);
  await p.waitForSelector('[data-passkeys-panel]');
  await p.waitForTimeout(400);
  assert.equal(await p.locator('[data-passkey-hint]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Phone app: hint on the first tab, "Nicht mehr fragen" for good', { skip }, async () => {
  await S.user('nina', 'user');
  const { p, ctx, errors } = await open('nina', { mobile: true });
  await p.goto(`${base}/m`);
  await p.waitForSelector('[data-passkey-hint]');
  await p.click('[data-passkey-hint-never]');
  await p.waitForSelector('[data-passkey-hint]', { state: 'detached' });
  assert.equal(S.db.prepare('SELECT passkey_prompt_until v FROM users WHERE id=?').get(S.ids.nina).v, -1);
  await p.reload();
  await p.waitForSelector('.m-page');
  await p.waitForTimeout(400);
  assert.equal(await p.locator('[data-passkey-hint]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Start page hint: not under another address (passkeys would not work there)', { skip }, async () => {
  await S.user('olaf', 'user');
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'olaf', password: 'Sehrgeheim123' }, headers: { 'X-Helfi-Request': '1' } });
  let asked = false;
  p.on('request', (r) => { if (r.url().includes('/api/me/passkeys')) asked = true; });
  await p.goto(`${S.base}/portal`); // 127.0.0.1 instead of localhost
  await p.waitForSelector('.content');
  await p.waitForTimeout(400);
  assert.equal(await p.locator('[data-passkey-hint]').count(), 0);
  assert.equal(asked, false, 'no check at all');
  await ctx.close();
});
