// Audit 2026-11 (sign-in, browser): profile shows the code step before adding a passkey to an account
// with TOTP (desktop and phone), a new address waits for its link, the confirmation page.
// Needs Playwright with Chromium – skipped if missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';
import { totpAt, currentStep } from '../src/auth/totp.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

let S; let browser; let secret; let base; const sent = [];
before(async () => {
  S = await startServer('audit-signin-ui');
  base = S.base.replace('127.0.0.1', 'localhost'); // passkeys belong to "localhost"
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  const tina = await S.user('tina', 'user');
  const s = await tina('POST', '/api/me/mfa/setup');
  secret = s.body.secret;
  assert.equal((await tina('POST', '/api/me/mfa/enable', { code: totpAt(secret, currentStep()) })).status, 200);
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1360, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  // A (software) authenticator is not needed: the page only has to know passkeys are supported
  await c.addInitScript(() => { window.PublicKeyCredential ||= function PublicKeyCredential() {}; });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Desktop: TOTP account confirms with the code, then the passkey button appears', { skip }, async () => {
  const { p, errors } = await page('tina');
  await p.goto(`${base}/profile`);
  await p.waitForSelector('[data-passkeys-panel] [data-passkey-confirm]');
  assert.equal(await p.$('[data-passkey-add]'), null);
  assert.match(await p.textContent('[data-passkeys-panel]'), /Authenticator-App/);
  await p.fill('[data-passkeys-panel] .code-input', '000000');
  await p.click('[data-passkey-confirm]');
  await p.waitForSelector('[data-passkeys-panel] .form-error:not([hidden])');
  await p.fill('[data-passkeys-panel] .code-input', totpAt(secret, currentStep() + 1));
  await p.click('[data-passkey-confirm]');
  await p.waitForSelector('[data-passkey-add]');
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('Phone: the same step under Me → Passkeys', { skip }, async () => {
  const { p, errors } = await page('tina', true);
  await p.goto(`${base}/m/me/passkeys`);
  await p.waitForSelector('[data-passkey-confirm], [data-passkey-add]');
  // the desktop test confirmed a different session: this one still needs the code
  assert.ok(await p.$('[data-passkey-confirm]'));
  // a code is only accepted once: as if half a minute had passed since the desktop test
  S.db.prepare("UPDATE users SET totp_last_step=0 WHERE username='tina'").run();
  await p.fill('.m-code', totpAt(secret, currentStep()));
  await p.click('[data-passkey-confirm]');
  await p.waitForSelector('[data-passkey-add]');
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('Desktop: a new address waits for the link; the link page confirms it', { skip }, async () => {
  await S.user('karl', 'user');
  const { p, errors } = await page('karl');
  await p.goto(`${base}/profile`);
  const email = p.locator('form.panel input[type=email]');
  await email.fill('karl.neu@firma.local');
  await p.fill('form.panel input[type=password]', 'Sehrgeheim123');
  await p.click('form.panel button[type=submit]');
  await p.waitForSelector('[data-email-pending]:not([hidden])');
  assert.match(await p.textContent('[data-email-pending]'), /karl\.neu@firma\.local/);
  assert.equal(await email.inputValue(), 'karl@firma.local', 'the field shows the address that applies');
  assert.equal(S.ctx.users.byName('karl').email, 'karl@firma.local');
  await new Promise((r) => setTimeout(r, 50));
  const mail = sent.find((m) => m.to === 'karl.neu@firma.local');
  const link = /(\/email\/confirm#[A-Za-z0-9_-]+)/.exec(mail.text)[1];
  await p.goto(`${base}${link}`);
  await p.waitForSelector('text=Adresse bestätigt');
  assert.equal(S.ctx.users.byName('karl').email, 'karl.neu@firma.local');
  assert.equal(new URL(p.url()).hash, '', 'token removed from the address bar');
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('Administration → SSO: note when the AD identifier is used without AD service account', { skip }, async () => {
  S.ctx.settings.set('ldap.enabled', false);
  S.ctx.settings.set('oidc.adIdClaim', '');
  const c = await browser.newContext({ viewport: { width: 1360, height: 1000 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${base}/api/me`, { data: { language: 'de' } });
  await p.goto(`${base}/admin/sso`);
  const note = p.locator('[data-sso-groups-note]');
  await note.waitFor({ state: 'attached' });
  assert.equal(await note.isVisible(), false, 'no AD identifier: no note');
  await p.fill('input[placeholder="onprem_sid"]', 'onprem_sid');
  await note.waitFor({ state: 'visible' });
  assert.match(await note.textContent(), /Gruppen-Claim/);
  assert.deepEqual(errors, []);
  await c.close();
});
