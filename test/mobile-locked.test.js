// Installed app on a phone never leaves the mobile UI: the original email opens in a sheet, no
// "open in desktop view", no desktop switch, and every desktop address leads back into /m.
// In the normal phone browser the desktop switch stays. Needs Playwright with Chromium – skipped if missing.
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

const htmlMail = (id, subject, html, extra = []) => Buffer.from([
  'From: Erika Muster <erika@firma.local>', 'To: helpdesk@firma.local', `Subject: ${subject}`, `Message-ID: <${id}@firma.local>`, ...extra,
  'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="A"', '',
  '--A', 'Content-Type: text/plain; charset=utf-8', '', 'Drucker PR-0001 druckt nicht.', '',
  '--A', 'Content-Type: text/html; charset=utf-8', '', html, '',
  '--A--', '',
].join('\r\n'));

let S; let browser; let key;
before(async () => {
  S = await startServer('mobile-locked');
  const p = S.ctx.processor;
  key = p.process(await p.parse(htmlMail('l1', 'Drucker', '<p>Drucker <b>PR-0001</b> druckt <i>nicht</i>.</p><script>parent.document.title="x"</script>'))).key;
  p.process(await p.parse(htmlMail('l2', `Re: [${key}] Drucker`, '<p>Geht <b>wieder</b>, danke!</p>', ['In-Reply-To: <l1@firma.local>'])));
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

/** Phone; installed = started from the home screen (display-mode standalone) */
async function phone({ installed, pref } = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'de-DE' });
  await c.addInitScript(({ installed: inst, pref: pr }) => {
    if (inst) {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q));
    }
    if (pr) { try { localStorage.setItem('helfi.ui', pr); } catch { /* ignore */ } }
  }, { installed: !!installed, pref: pref || null });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' }, headers: { 'X-Helfi-Request': '1' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' }, headers: { 'X-Helfi-Request': '1' } });
  return { c, p, errors };
}
const ready = (p) => p.locator('.m-page:not(.m-leaving) .m-scroll').first().waitFor();

test('Original email opens in a sheet inside the app, sandboxed, with formatted/text switch', { skip }, async () => {
  const { c, p, errors } = await phone({ installed: true });
  await p.goto(`${S.base}/m/t/${key}`);
  await ready(p);
  const notes = p.locator('.m-page:not(.m-leaving) [data-mail-original]');
  await p.waitForFunction(() => document.querySelectorAll('.m-page:not(.m-leaving) [data-mail-original]').length === 2); // description and reply comment
  assert.equal(await p.locator('.m-page:not(.m-leaving) .m-mail-note a').count(), 0, 'no link out of the app');
  await notes.first().tap();
  const sheet = p.locator('.m-sheet-mail');
  await sheet.waitFor();
  assert.equal(await sheet.locator('h2').textContent(), 'Original-Mail');
  const frame = sheet.locator('iframe.mail-frame');
  assert.equal(await frame.getAttribute('sandbox'), 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  assert.equal(await frame.getAttribute('src'), `/api/tickets/${key}/mail-html`);
  const body = p.frameLocator('.m-sheet-mail iframe.mail-frame').locator('body');
  await body.locator('b', { hasText: 'PR-0001' }).waitFor();
  assert.equal(await p.title() === 'x', false, 'no script from the mail');
  // Text version
  await sheet.getByRole('button', { name: 'Text' }).tap();
  await sheet.locator('.mail-view-body', { hasText: 'Drucker PR-0001 druckt nicht.' }).waitFor();
  await sheet.getByRole('button', { name: 'Formatiert' }).tap();
  // Back gesture closes the sheet and stays on the ticket in the app
  await p.goBack();
  await sheet.waitFor({ state: 'detached' });
  assert.match(new URL(p.url()).pathname, new RegExp(`^/m/t/${key}$`));
  // Reply comment: its own mail
  await notes.nth(1).tap();
  await p.locator('.m-sheet-mail iframe.mail-frame').waitFor();
  assert.equal(await p.getAttribute('.m-sheet-mail iframe.mail-frame', 'src'), `/api/tickets/${key}/mail-html?comment=${(await S.admin('GET', `/api/tickets/${key}`)).body.ticket.comments.at(-1).id}`);
  await p.frameLocator('.m-sheet-mail iframe.mail-frame').locator('b', { hasText: 'wieder' }).waitFor();
  assert.ok(new URL(p.url()).pathname.startsWith('/m/'));
  assert.deepEqual(errors, []);
  await c.close();
});

test('Installed app: no way into the desktop UI (ticket menu, knowledge base, Me page)', { skip }, async () => {
  const { c, p, errors } = await phone({ installed: true });
  await p.goto(`${S.base}/m/t/${key}`);
  await ready(p);
  assert.equal(await p.locator('a[href*="ui=desktop"], a[href^="/browse"], a[href^="/admin"]').count(), 0);
  await p.goto(`${S.base}/m/me`);
  await ready(p);
  assert.equal(await p.locator('.m-row', { hasText: 'Desktop-Ansicht' }).count(), 0, 'no desktop switch in the installed app');
  assert.deepEqual(errors, []);
  await c.close();
});

test('Installed app: desktop addresses, "?ui=desktop" and an old "desktop" preference lead back into the app', { skip }, async () => {
  const { c, p, errors } = await phone({ installed: true, pref: 'desktop' });
  for (const [from, to] of [
    [`/browse/${key}?ui=desktop`, `/m/t/${key}`],
    ['/issues', '/m/'],
    ['/admin/system', '/m/'],
    ['/reports', '/m/'],
    ['/kb', '/m/kb'],
  ]) {
    await p.goto(`${S.base}${from}`);
    await p.waitForURL((u) => u.pathname.startsWith('/m'));
    await ready(p);
    assert.equal(new URL(p.url()).pathname, to, from);
    assert.equal(await p.locator('.sidebar').count(), 0, `no desktop UI for ${from}`);
  }
  // No back-and-forth between the two UIs despite the old preference
  await p.goto(`${S.base}/m/tickets`);
  await ready(p);
  await p.waitForTimeout(500);
  assert.equal(new URL(p.url()).pathname, '/m/tickets');
  assert.deepEqual(errors, []);
  await c.close();
});

test('Phone browser (not installed): the desktop switch stays, "?ui=desktop" still opens one desktop page', { skip }, async () => {
  const { c, p, errors } = await phone({ installed: false });
  await p.goto(`${S.base}/m/me`);
  await ready(p);
  assert.equal(await p.locator('.m-row', { hasText: 'Desktop-Ansicht' }).count(), 1);
  await p.goto(`${S.base}/browse/${key}?ui=desktop`);
  await p.locator('.sidebar').waitFor();
  assert.equal(new URL(p.url()).pathname, `/browse/${key}`);
  assert.deepEqual(errors, []);
  await c.close();
});
