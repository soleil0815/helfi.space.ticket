// Audit 2026-11, Oberfläche: Enter auf Links/Knöpfen, Ticket-Kürzel nach Seitenwechsel,
// lineare Laufzeit beim Verlinken, „/\…“ ist kein interner Pfad, Übersetzungen in der richtigen Sprache.
// Die Browser-Tests brauchen Playwright mit Chromium (nicht Teil der Abhängigkeiten) – fehlt es, werden sie übersprungen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* nicht installiert */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* auch dort nicht */ }
}
if (!chromium) {
  try { ({ chromium } = createRequire(import.meta.url)('/opt/npm-tools/node_modules/playwright')); } catch { /* auch dort nicht */ }
}
const skip = !chromium && 'Playwright fehlt';

let S; let browser; let anna;
before(async () => {
  S = await startServer('audit-ui');
  anna = await S.user('anna', 'agent');
  const karl = await S.user('karl', 'user');
  await karl('POST', '/api/tickets', { title: 'Drucker PR-0001 druckt nicht', description: 'Papierstau' });
  await karl('POST', '/api/tickets', { title: 'VPN', description: 'geht nicht' });
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username = 'anna') {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const r = await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } });
  assert.equal(r.status(), 200);
  return { p, errors };
}
// Link wie ein App-Link anklicken (ohne ihn sichtbar in die Seite zu setzen)
const go = (p, href) => p.evaluate((u) => { const a = document.createElement('a'); a.href = u; a.dataset.link = ''; document.body.append(a); a.click(); a.remove(); }, href);

test('Enter auf einem fokussierten Link folgt dem Link (Listen-Kürzel fangen ihn nicht ab)', { skip }, async () => {
  const { p, errors } = await page();
  await p.goto(`${S.base}/issues`);
  await p.waitForSelector('table.issues tbody tr[data-key]');
  // Ohne markierte Zeile bleibt Enter beim Browser
  const prevented = await p.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.equal(prevented, false);
  // Fokus auf einem Link + Enter → Link wird geöffnet, auch wenn eine Zeile markiert ist
  await p.keyboard.press('j');
  await p.waitForSelector('tr.kbd-focus');
  await p.focus('a.nav-item[href="/board"]');
  await p.keyboard.press('Enter');
  await p.waitForURL(/\/board$/, { timeout: 5000 });
  // Enter ohne Fokus auf einem Bedienelement öffnet weiter die markierte Zeile
  await go(p, '/issues');
  await p.waitForSelector('table.issues tbody tr[data-key]');
  await p.evaluate(() => document.activeElement?.blur());
  await p.keyboard.press('j');
  const key = await p.$eval('tr.kbd-focus', (r) => r.dataset.key);
  await p.keyboard.press('Enter');
  await p.waitForURL(new RegExp(`/browse/${key}$`), { timeout: 5000 });
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('Ticket verlassen, bevor es geladen ist: keine Ticket-Kürzel, kein Titel in der Liste', { skip }, async () => {
  const { p, errors } = await page();
  await p.goto(`${S.base}/issues`);
  await p.waitForSelector('table.issues tbody tr[data-key]');
  let patched = 0;
  await p.route('**/api/tickets/IT-1', async (r) => {
    if (r.request().method() === 'GET') { await new Promise((ok) => setTimeout(ok, 1200)); return r.continue(); }
    patched += 1; return r.continue();
  });
  await go(p, '/browse/IT-1');
  await p.waitForTimeout(150);
  await go(p, '/issues');
  await p.waitForSelector('table.issues tbody tr[data-key]');
  await p.waitForTimeout(1800); // die verspätete Ticketantwort ist jetzt da
  await p.keyboard.press('i'); // in der Ticketansicht „mir zuweisen“
  await p.waitForTimeout(500);
  assert.equal(patched, 0);
  assert.equal((await anna('GET', '/api/tickets/IT-1')).body.ticket.assignee, null);
  assert.ok(!(await p.title()).includes('IT-1'), await p.title());
  assert.equal(new URL(p.url()).pathname, '/issues');
  assert.deepEqual(errors, []);
  await p.context().close();
});

test('richText: lange Wörter ohne Hänger, Links und Mailadressen werden weiter erkannt', { skip }, async () => {
  const { p } = await page();
  await p.goto(`${S.base}/issues`);
  await p.waitForSelector('table.issues');
  const r = await p.evaluate(async () => {
    const { richText } = await import('/js/dom.js');
    const ms = (s) => { const t0 = performance.now(); richText(s); return performance.now() - t0; };
    const el = richText('Bitte an e.beispiel@firma.local oder https://helfi.dyndns.example/hilfe?x=1 wenden.\n**fett a.b@firma.local**');
    return {
      long: ms('x'.repeat(60000)),
      longAt: ms(`${'x'.repeat(60000)}@`),
      longDom: ms(`a@${'x'.repeat(60000)}`),
      many: ms('a.'.repeat(30000)),
      links: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      strong: el.querySelector('strong a')?.getAttribute('href'),
      text: el.textContent,
    };
  });
  for (const k of ['long', 'longAt', 'longDom', 'many']) assert.ok(r[k] < 1500, `${k}: ${r[k]} ms`);
  assert.deepEqual(r.links, ['mailto:e.beispiel@firma.local', 'https://helfi.dyndns.example/hilfe?x=1', 'mailto:a.b@firma.local']);
  assert.equal(r.strong, 'mailto:a.b@firma.local');
  assert.ok(r.text.startsWith('Bitte an e.beispiel@firma.local oder https://helfi.dyndns.example/hilfe?x=1 wenden.'));
  await p.context().close();
});

test('Wissensartikel: „/\\…“ ist kein interner Pfad, normale Pfade und Mails bleiben', { skip }, async () => {
  const { p } = await page();
  await p.goto(`${S.base}/issues`);
  await p.waitForSelector('table.issues');
  const r = await p.evaluate(async () => {
    const { safeHref, linkTarget, renderDoc } = await import('/js/kbdoc.js');
    const doc = renderDoc('[Böse](/\\evil.example/pfad) [Auch](/pfad\\x) [Ticket](/browse/IT-1) [Extern](https://helfi.dyndns.example/a) mail e.beispiel@firma.local');
    const t0 = performance.now(); renderDoc(`${'x'.repeat(60000)}@`); const ms = performance.now() - t0;
    // Überschrift mit vielen Leerzeichen: das alte Muster brauchte hierfür Minuten
    const t1 = performance.now(); const hd = renderDoc(`# a${' '.repeat(3000)}x`); const msHead = performance.now() - t1;
    // Backtick-Folge ohne Ende: früher an jeder Stelle neu gesucht (kubisch)
    const t2 = performance.now(); const bt = renderDoc(`a ${'`'.repeat(4000)}`); const msTick = performance.now() - t2;
    const codes = [...renderDoc('x `code` y ``a`b`` z').querySelectorAll('code')].map((c) => c.textContent);
    const heads = [...renderDoc('## Titel ##  \n\n# C#\n\n### Mit #  Raute ###').querySelectorAll('h1,h2,h3')].map((x) => [x.tagName, x.textContent]);
    return {
      msTick, tickText: bt.textContent.length, codes, msHead, headText: hd.querySelector('h1')?.textContent.length, heads,
      bs: safeHref('/\\evil.example/pfad'),
      bs2: safeHref('/\\/evil.example'),
      inner: safeHref('/pfad\\x'),
      target: linkTarget('/\\evil.example'),
      ok: [safeHref('/browse/IT-1'), safeHref('/kb/3'), safeHref('https://helfi.dyndns.example/a'), safeHref('//evil.example')],
      links: [...doc.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.hasAttribute('data-link')]),
      ms,
    };
  });
  assert.equal(r.bs, null);
  assert.equal(r.bs2, null);
  assert.equal(r.inner, null);
  assert.equal(r.target, null);
  assert.deepEqual(r.ok, ['/browse/IT-1', '/kb/3', 'https://helfi.dyndns.example/a', null]);
  assert.deepEqual(r.links, [['/browse/IT-1', true], ['https://helfi.dyndns.example/a', false], ['mailto:e.beispiel@firma.local', false]]);
  assert.ok(r.ms < 1500, `${r.ms} ms`);
  assert.ok(r.msTick < 1500, `Backticks: ${r.msTick} ms`);
  assert.equal(r.tickText, 4002);
  assert.deepEqual(r.codes, ['code', 'a`b']);
  assert.ok(r.msHead < 1500, `Überschrift: ${r.msHead} ms`);
  assert.equal(r.headText, 3002);
  assert.deepEqual(r.heads, [['H2', 'Titel'], ['H1', 'C'], ['H3', 'Mit #  Raute']]);
  await p.context().close();
});

test('Übersetzungen: gleiche Schlüssel, Texte in der richtigen Sprache, kein Produktname', async () => {
  globalThis.document ??= { documentElement: {} };
  const { _dicts: { de, en } } = await import('../public/js/i18n.js');
  assert.deepEqual(Object.keys(de).filter((k) => !(k in en)), []);
  assert.deepEqual(Object.keys(en).filter((k) => !(k in de)), []);
  assert.equal(de['imp.jiraStatus'], 'Status im Quellsystem');
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of ['warn.ldapCertFailed', 'warn.ldapCertExpiring']) assert.equal(ph(en[k]), ph(de[k]), k);
  // Stichprobe: deutsche Wörter im englischen Text, englische im deutschen
  const ger = /[äöüßÄÖÜ]|\b(der|die|das|und|nicht|mit|ist|wird|werden|oder|für|bitte|Zertifikat|Benutzer)\b/;
  const eng = /\b(the|is|with|and|not|please|of|to|in source|for|this|you|your)\b/i;
  assert.deepEqual(Object.keys(en).filter((k) => ger.test(en[k])), []);
  assert.deepEqual(Object.keys(de).filter((k) => eng.test(de[k]) && !/[äöüß]/.test(de[k])), []);
  assert.deepEqual(Object.keys(de).filter((k) => /jira/i.test(`${de[k]} ${en[k]}`)), []);
});
