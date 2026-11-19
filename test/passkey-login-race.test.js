// Passkey and password at the same time (phone: password manager fills and submits the form while the
// passkey is confirmed with Face ID/PIN): the passkey counts as two factors, so no code step may appear
// on top – and the code step itself offers "Stattdessen mit Passkey bestätigen".
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

const hdr = { 'X-Helfi-Request': '1' };
let S; let browser; let base; let config; let oldBase;
const pages = {}; // phone and desktop, each with its own virtual authenticator and passkey
let p; let errors;

async function device(mobile) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  // Virtual platform authenticator (Face ID/PIN confirms automatically)
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  assert.equal((await page.request.post(`${base}/api/auth/login`, { data: { username: 'karl', password: 'Sehrgeheim123' }, headers: hdr })).status(), 200);
  await page.request.patch(`${base}/api/me`, { data: { language: 'de' }, headers: hdr });
  if (mobile) {
    await page.goto(`${base}/m/me/passkeys`);
    await page.click('[data-passkey-add]');
    await page.waitForSelector('.m-row >> text=Noch nicht benutzt');
  } else {
    await page.goto(`${base}/profile`);
    await page.click('[data-passkeys-panel] [data-passkey-add]');
    await page.waitForSelector('[data-passkeys-panel] .passkey-item');
  }
  await page.request.post(`${base}/api/auth/logout`, { headers: hdr });
  // Test switches (read on every page load): device answers late / no suggestion in the user name field
  await page.addInitScript(() => {
    const delay = Number(localStorage.getItem('test.pkDelay') || 0);
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (o) => { const c = await get(o); await new Promise((r) => setTimeout(r, delay)); return c; };
    if (localStorage.getItem('test.noConditional') === '1') window.PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  });
  return { page, errs, ctx };
}

before(async () => {
  if (!chromium) return;
  S = await startServer('passkey-race');
  await S.user('karl', 'user');
  base = S.base.replace('127.0.0.1', 'localhost');
  ({ config } = await import('../src/config.js'));
  oldBase = config.baseUrl;
  config.baseUrl = base;
  browser = await chromium.launch();
  pages.phone = await device(true);
  pages.desktop = await device(false);
  // From now on karl needs a code from the app after the password
  S.db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(S.ids.karl);
  S.ctx.settings.set('mfa.internal', 'all');
  S.ctx.settings.set('mfa.external', 'all');
});
after(async () => { if (config) config.baseUrl = oldBase; await browser?.close(); await S?.stop(); });

const use = (which) => { ({ page: p, errs: errors } = pages[which]); };
const mode = (delay, noConditional) => p.evaluate(([d, n]) => { localStorage.setItem('test.pkDelay', String(d)); localStorage.setItem('test.noConditional', n ? '1' : '0'); }, [delay, noConditional]);
// Wait until the sign-in page is left; on failure say what the page shows (helps on CI)
async function leave(path) {
  try { await p.waitForFunction((pp) => !location.pathname.startsWith(pp), path, { timeout: 15000 }); }
  catch (e) {
    const text = await p.evaluate(() => document.body.innerText).catch(() => '?');
    throw new Error(`still on ${p.url()}: ${text.slice(0, 400)} | page errors: ${errors.join('; ')}`);
  }
}
const me = async () => (await (await p.request.get(`${base}/api/me`)).json()).user?.username;
const signOut = async () => { await p.request.post(`${base}/api/auth/logout`, { headers: hdr }); await p.unrouteAll(); };

for (const [name, which, path, code] of [['Phone app', 'phone', '/m/login', 'input.m-code'], ['Desktop', 'desktop', '/login', 'input.code-input']]) {
  test(`${name}: password answer arriving after the passkey sign-in does not bring up the code step`, { skip }, async () => {
    use(which);
    await signOut();
    // The device answers a little later (Face ID/PIN), the password check takes longer still
    await mode(800, false);
    await p.route('**/api/auth/login', async (route) => { await new Promise((r) => setTimeout(r, 2000)); await route.continue(); });
    await p.goto(`${base}${path}`);
    await p.fill('input[name="username"]', 'karl');
    await p.fill('input[name="password"]', 'Sehrgeheim123');
    await p.click('button[type="submit"]');
    await leave(path);
    await p.waitForTimeout(2500); // the password answer has arrived by now
    assert.equal(await p.locator(code).count(), 0, 'no code step after the passkey sign-in');
    assert.ok(!new URL(p.url()).pathname.startsWith(path));
    assert.equal(await me(), 'karl');
    assert.equal(S.db.prepare('SELECT auth_method FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(S.ids.karl).auth_method, 'passkey');
    // Opening the app again keeps the passkey sign-in (the late password answer changes nothing)
    await p.reload();
    await p.waitForTimeout(500);
    assert.ok(!new URL(p.url()).pathname.startsWith(path));
    assert.equal(await me(), 'karl');
    assert.deepEqual(errors, []);
  });

  test(`${name}: the code step offers "Stattdessen mit Passkey bestätigen"`, { skip }, async () => {
    use(which);
    await signOut();
    // Older browser without the suggestion in the user name field: only the password is used
    await mode(0, true);
    await p.goto(`${base}${path}`);
    await p.fill('input[name="username"]', 'karl');
    await p.fill('input[name="password"]', 'Sehrgeheim123');
    await p.click('button[type="submit"]');
    await p.waitForSelector(code);
    assert.equal(await me(), undefined, 'not signed in yet');
    await p.click('[data-mfa-passkey]');
    await leave(path);
    assert.equal(await me(), 'karl');
    assert.deepEqual(errors, []);
  });
}
