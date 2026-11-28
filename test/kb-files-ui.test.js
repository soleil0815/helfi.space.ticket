// Files attached to knowledge articles in the browser: attach in the editor, remove, the list below the
// article (desktop and phone), the paperclip in the overview, cancelling discards new uploads.
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

let S; let browser;
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
before(async () => {
  if (!chromium) return;
  S = await startServer('kbfilesui');
  await S.user('anna', 'agent');
  await S.user('karl', 'user');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Attach in the editor, save, list below the article, remove again', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/kb/new?template=builtin:blank`);
  await p.fill('.kb-title-input', 'VPN einrichten');
  await p.click('.seg[data-v="public"]');
  await p.setInputFiles('[data-kb-file-input]', [
    { name: 'VPN-Anleitung.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'Profile.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK') },
  ]);
  await p.waitForSelector('[data-kb-files-edit] li.kb-file >> nth=1');
  assert.deepEqual(await p.locator('[data-kb-files-edit] .kb-file-kind').allTextContents(), ['PDF', 'XLS']);
  await p.click('.kb-edit-head .btn-primary');
  await p.waitForSelector('.kb-page h1 >> text=VPN einrichten');
  assert.deepEqual(await p.locator('[data-kb-files] .kb-file-name').allTextContents(), ['VPN-Anleitung.pdf', 'Profile.xlsx']);
  const href = await p.locator('[data-kb-files] a.kb-file-name >> nth=0').getAttribute('href');
  const dl = await p.request.get(`${S.base}${href}`);
  assert.equal(dl.status(), 200);
  assert.equal((await dl.body()).toString(), PDF.toString());
  // Overview: paperclip with the number
  await p.goto(`${S.base}/kb`);
  await p.waitForSelector('.kb-file-count >> text=2');
  // Remove one in the editor
  const id = (await p.request.get(`${S.base}/api/kb`).then((r) => r.json())).articles[0].id;
  await p.goto(`${S.base}/kb/${id}/edit`);
  await p.click('[aria-label="Profile.xlsx entfernen"]');
  await p.click('.kb-edit-head .btn-primary');
  await p.waitForSelector('.kb-page h1');
  assert.deepEqual(await p.locator('[data-kb-files] .kb-file-name').allTextContents(), ['VPN-Anleitung.pdf']);
  assert.deepEqual(errors, []);
});

test('Cancelling the editor discards new uploads', { skip }, async () => {
  const { p, errors } = await page('anna');
  const before2 = S.db.prepare('SELECT COUNT(*) n FROM kb_files').get().n;
  await p.goto(`${S.base}/kb/new?template=builtin:blank`);
  await p.fill('.kb-title-input', 'Verworfen');
  await p.setInputFiles('[data-kb-file-input]', [{ name: 'weg.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  await p.waitForSelector('[data-kb-files-edit] li.kb-file');
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM kb_files').get().n, before2 + 1);
  p.once('dialog', (d) => d.accept()); // leave guard
  await p.click('.kb-edit-head .btn-subtle >> text=Abbrechen');
  await p.waitForFunction(() => location.pathname === '/kb');
  for (let i = 0; i < 20 && S.db.prepare('SELECT COUNT(*) n FROM kb_files').get().n !== before2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM kb_files').get().n, before2);
  assert.deepEqual(errors, []);
});

test('Users and the phone see the files of a public article', { skip }, async () => {
  const id = S.db.prepare("SELECT id FROM kb_articles WHERE title='VPN einrichten'").get().id;
  const desk = await page('karl');
  await desk.p.goto(`${S.base}/kb/${id}`);
  await desk.p.waitForSelector('[data-kb-files] .kb-file-name >> text=VPN-Anleitung.pdf');
  assert.equal(await desk.p.locator('[data-kb-files-edit]').count(), 0);
  const { p, errors } = await page('karl', true);
  await p.goto(`${S.base}/m/kb/${id}`);
  await p.waitForSelector('.m-kb-files .kb-file-name >> text=VPN-Anleitung.pdf');
  assert.deepEqual(errors, []);
});
