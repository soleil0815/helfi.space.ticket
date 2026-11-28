// Knowledge import in the browser: switch to "Knowledge articles", Confluence form, spaces with target
// project, start, progress with link to the knowledge base; ticket sources unchanged.
// Needs Playwright with Chromium (not part of the dependencies) – if missing, the test is skipped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';
import { startMockConfluence } from './fixtures/mock-knowledge.js';
import { zipStream } from '../src/zip.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

let S; let browser; let cf;
before(async () => {
  if (!chromium) return;
  process.env.HELFI_IMPORT_ALLOW_LOCAL = '1';
  S = await startServer('kbimportui');
  await S.admin('POST', '/api/projects', { key: 'HR', name: 'Personal' });
  cf = await startMockConfluence({ cloud: true });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); cf?.close(); await S?.stop(); });

test('Knowledge import from Confluence through the import page', { skip }, async () => {
  const c = await browser.newContext({ viewport: { width: 1360, height: 1200 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  await p.goto(`${S.base}/admin/import`);
  await p.waitForSelector('.import-sources');
  // tickets: no Confluence among the sources
  assert.equal(await p.locator('.import-source >> text=Confluence').count(), 0);
  await p.click('[data-imp-what="kb"]');
  await p.waitForSelector('[data-imp-what="kb"][aria-pressed="true"]');
  assert.deepEqual(await p.locator('.import-source-name').allTextContents(), ['Confluence', 'Zammad', 'Zendesk', 'Freshdesk', 'GLPI', 'Znuny / OTRS']);
  await p.locator('.import-source', { hasText: 'Confluence' }).click();
  await p.fill('input[placeholder="https://wiki.firma.local"]', cf.base);
  await p.fill('input[type=email]', 'admin@firma.local');
  await p.fill('input[type=password]', 'cf-token');
  await p.click('.form-actions .btn-primary');
  await p.waitForSelector('[data-imp-space="IT"]');
  await p.check('[data-imp-space="IT"] input[type=checkbox]');
  await p.selectOption('[data-imp-space="IT"] select', { label: 'Personal' });
  await p.click('.form-actions .btn-primary >> text=Wissensartikel importieren');
  await p.waitForSelector('text=Import abgeschlossen', { timeout: 20000 });
  assert.match(await p.textContent('.panel:has(.progress-row)'), /3 neu/);
  assert.equal(await p.getAttribute('.progress-row a', 'href'), '/kb?project=HR');
  await p.click('a.btn-primary >> text=Zur Wissensdatenbank');
  await p.waitForSelector('.kb-card-title >> text=VPN einrichten');
  // the page tree was kept
  const vpn = S.db.prepare("SELECT parent_id FROM kb_articles WHERE title='VPN einrichten'").get();
  assert.equal(vpn.parent_id, S.db.prepare("SELECT id FROM kb_articles WHERE title='Start'").get().id);
  assert.deepEqual(errors, []);
  await c.close();
});

test('Confluence export file: upload, spaces, import', { skip }, async () => {
  const chunks = [];
  for await (const ch of zipStream([
    { name: 'ONB/index.html', data: Buffer.from('<html><head><title>Onboarding : Home</title></head><body></body></html>') },
    { name: 'ONB/Erster-Tag_501.html', data: Buffer.from('<html><head><title>Onboarding : Erster Tag</title></head><body><ol id="breadcrumbs"><li><a href="index.html">Onboarding</a></li></ol><div id="main-content"><p>Ausweis abholen.</p></div></body></html>') },
  ])) chunks.push(ch);
  const c = await browser.newContext({ viewport: { width: 1360, height: 1200 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  await p.goto(`${S.base}/admin/import`);
  await p.click('[data-imp-what="kb"]');
  await p.locator('.import-source', { hasText: 'Confluence' }).click();
  await p.selectOption('[data-imp-confluence-type]', 'export');
  assert.ok(await p.locator('.form-actions .btn-primary').isHidden(), 'no "next" before a file is there');
  await p.setInputFiles('[data-imp-zip]', { name: 'onboarding.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks) });
  await p.waitForSelector('text=onboarding.zip');
  await p.click('.form-actions .btn-primary');
  await p.waitForSelector('[data-imp-space="ONB/"]');
  assert.match(await p.textContent('section.panel:has([data-imp-space])'), /Datei onboarding\.zip/);
  await p.check('[data-imp-space="ONB/"] input[type=checkbox]');
  await p.click('.form-actions .btn-primary >> text=Wissensartikel importieren');
  await p.waitForSelector('text=Import abgeschlossen', { timeout: 20000 });
  assert.ok(S.db.prepare("SELECT 1 FROM kb_articles WHERE title='Erster Tag'").get());
  assert.deepEqual(errors, []);
  await c.close();
});
