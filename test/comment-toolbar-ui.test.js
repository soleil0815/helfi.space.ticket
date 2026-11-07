// Comment toolbar in the browser: formatting while typing, @-mention, emoji, canned responses,
// rendering; comments on articles; phone reply bar; AI in the article editor.
// Needs Playwright with Chromium (not part of the dependencies) – if missing, the test is skipped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const content = /step-by-step/.test(j.messages[0].content) ? '1. VPN öffnen\n2. **Verbinden** klicken' : 'Geglättet.';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

let S; let browser; let karl; let tk;
before(async () => {
  if (!chromium) return;
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await startServer('cmtoolbarui');
  await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  tk = (await karl('POST', '/api/tickets', { title: 'Drucker' })).body.ticket;
  await S.admin('POST', '/api/canned', { title: 'Neustart', body: 'Hallo {melder},\n\n- Gerät **aus**\n- wieder an', shared: true });
  await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `http://127.0.0.1:${fake.address().port}/v1`, 'ai.model': 'm', 'ai.reasoning': 'off' } });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); fake.close(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1400, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}
const last = async () => (await S.admin('GET', `/api/tickets/${tk.key}`)).body.ticket.comments.at(-1);

test('Desktop: one toolbar, formatting while typing, @-mention, smiley, Ctrl+Enter', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/${tk.key}`);
  const ed = p.locator('.composer .cm-editor .kb-editable');
  await ed.waitFor();
  const labels = await p.$$eval('.composer .cm-toolbar .kb-tb-btn', (x) => x.map((b) => b.getAttribute('aria-label') || b.textContent.trim()));
  for (const want of ['Fett', 'Kursiv', 'Aufzählung', 'Nummerierte Liste', 'Zitat', 'Codeblock', 'Link einfügen', 'Bild einfügen', 'Person erwähnen (@)']) assert.ok(labels.includes(want), `${want} in ${labels}`);
  assert.equal(await p.locator('.composer .cm-toolbar .ai-btn').count(), 1, 'AI in the toolbar');
  assert.equal(await p.locator('.composer .cm-toolbar [data-shortcut=template]').count(), 1, 'canned responses in the toolbar');
  await ed.click();
  await p.keyboard.type('Bitte ');
  await p.click('.composer .kb-tb-btn[aria-label="Fett"]');
  await p.keyboard.type('neu starten');
  await p.click('.composer .kb-tb-btn[aria-label="Fett"]');
  await p.keyboard.type(' :) ');
  await p.keyboard.press('Enter');
  await p.keyboard.type('- eins');
  await p.keyboard.press('Enter');
  await p.keyboard.type('zwei');
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  await p.click('.composer .kb-tb-btn[aria-label="Person erwähnen (@)"]');
  await p.keyboard.type('kar');
  await p.waitForSelector('.mention-pop .mention-item');
  await p.keyboard.press('Enter');
  assert.equal(await p.locator('.composer .kb-editable .mention').textContent(), '@karl');
  await p.keyboard.press('Control+Enter');
  await p.waitForSelector('.cm-doc strong');
  const c = await last();
  assert.equal(c.format, 'md');
  assert.equal(c.body, `Bitte **neu starten** 🙂 \n\n- eins\n- zwei\n\n@[karl](user:${S.ids.karl})`);
  assert.equal(await p.locator('.cm-doc ul li').count(), 2);
  assert.equal(await p.locator('.cm-doc .mention').textContent(), '@karl');
  assert.equal(await ed.textContent(), '', 'field emptied');
  assert.deepEqual(errors, []);
});

test('Desktop: canned response inserted formatted, "save as" in the same menu, AI menu', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/${tk.key}`);
  await p.locator('.composer .kb-editable').click();
  await p.click('.composer [data-shortcut=template]');
  await p.waitForSelector('.menu-templates .menu-foot');
  await p.click('.menu-template >> text=Neustart');
  await p.waitForSelector('.composer .kb-editable li strong');
  assert.match(await p.locator('.composer .kb-editable').textContent(), /Hallo karl/);
  await p.click('.composer .ai-btn');
  await p.click('.menu-item >> text=Text glätten');
  await p.waitForFunction(() => document.querySelector('.composer .kb-editable').textContent.includes('Geglättet.'));
  await p.click('.ai-note button');
  await p.waitForFunction(() => document.querySelector('.composer .kb-editable').textContent.includes('Hallo karl'));
  assert.deepEqual(errors, []);
});

test('Comments on articles: same toolbar, formatted', { skip }, async () => {
  const a = (await S.admin('POST', '/api/kb', { title: 'VPN', body: 'Text', visibility: 'public' })).body.article;
  const { p, errors } = await page('karl');
  await p.goto(`${S.base}/kb/${a.id}`);
  const ed = p.locator('.kb-comments .kb-editable');
  await ed.waitFor();
  assert.equal(await p.locator('.kb-comments .kb-tb-btn[aria-label="Bild einfügen"]').count(), 0, 'no image upload for users');
  assert.equal(await p.locator('.kb-comments .ai-btn').count(), 0, 'no AI for users');
  await ed.click();
  await p.keyboard.type('Schritt 3 ');
  await p.keyboard.press('Control+i');
  await p.keyboard.type('fehlt');
  await p.click('.kb-comments .btn-primary');
  await p.waitForSelector('.kb-cm .cm-doc em');
  const { comments } = (await S.admin('GET', `/api/kb/${a.id}/comments`)).body;
  assert.deepEqual([comments[0].format, comments[0].body], ['md', 'Schritt 3 *fehlt*']);
  assert.deepEqual(errors, []);
});

test('Phone: format bar while writing, sent as md', { skip }, async () => {
  const { p, errors } = await page('anna', true);
  await p.goto(`${S.base}/m/t/${tk.key}`);
  const ed = p.locator('.m-reply .kb-editable');
  await ed.waitFor();
  assert.equal(await p.locator('.m-reply .cm-toolbar').isVisible(), false, 'bar hidden until writing');
  await ed.tap();
  await p.waitForSelector('.m-reply .cm-toolbar', { state: 'visible' });
  await p.keyboard.type('Mobil ');
  await p.tap('.m-reply .kb-tb-btn[aria-label="Fett"]');
  await p.keyboard.type('stark');
  await p.tap('.m-reply-send');
  for (let i = 0; i < 40 && (await last()).body !== 'Mobil **stark**'; i++) await new Promise((r) => setTimeout(r, 100));
  const c = await last();
  assert.deepEqual([c.body, c.format], ['Mobil **stark**', 'md']);
  assert.deepEqual(errors, []);
});

test('Article editor: AI as first toolbar button, guide from notes, undo', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/kb/new?template=blank`);
  await p.waitForSelector('.kb-toolbar .ai-btn');
  await p.fill('.kb-title-input', 'VPN');
  await p.locator('.kb-editable').click();
  await p.keyboard.type('vpn öffnen, verbinden');
  await p.click('.kb-toolbar .ai-btn');
  await p.click('.menu-item >> text=Als Schritt-für-Schritt-Anleitung');
  await p.waitForSelector('.kb-editable ol li strong');
  await p.click('.kb-ai-note button');
  await p.waitForFunction(() => document.querySelector('.kb-editable').textContent.includes('vpn öffnen, verbinden'));
  assert.deepEqual(errors, []);
});

test('Desktop: emoji suggestions while typing ":dau" in the formatted field', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/${tk.key}`);
  await p.locator('.composer .kb-editable').click();
  await p.keyboard.type('Super :dau');
  await p.waitForSelector('.emoji-suggest .menu-item');
  await p.keyboard.press('Enter');
  assert.match(await p.locator('.composer .kb-editable').textContent(), /Super 👍/);
  assert.deepEqual(errors, []);
});
