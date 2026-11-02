// Smartphone-Ansicht: keine Seite darf seitlich überstehen, keine Fehler in der Konsole.
// Braucht Playwright mit Chromium (nicht Teil der Abhängigkeiten) – fehlt es, wird der Test übersprungen:
//   npm install --no-save playwright && npx playwright install chromium
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* nicht installiert */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* auch dort nicht */ }
}

let S; let browser;
before(async () => {
  if (!chromium) return;
  S = await startServer('mobile');
  S.ctx.settings.set('sla.enabled', true);
  const anna = await S.user('anna', 'agent');
  const karl = await S.user('karl', 'user');
  S.db.prepare('UPDATE users SET totp_enabled=1').run();
  for (let i = 0; i < 4; i++) await karl('POST', '/api/tickets', { title: `Drucker PR-0001 im 2. OG druckt seit heute früh nicht mehr ${i}`, description: 'https://firma.local/eine/sehr/lange/adresse/die/umbrechen/muss/damit/nichts/übersteht' });
  await anna('POST', '/api/tickets/IT-1/subtasks', { title: 'Sensor reinigen' });
  await anna('POST', '/api/kb', { title: 'VPN', visibility: 'public', body: '# A\n\n| Spalte A | Spalte B | Spalte C | Spalte D |\n| --- | --- | --- | --- |\n| sehr langer Inhalt | 10.0.10.40 | noch mehr | ende |\n\n```\nsudo systemctl restart ein-sehr-langer-dienstname-der-umbrechen-muss\n```' });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, width, height) {
  const c = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const r = await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } });
  assert.equal(r.status(), 200);
  return { p, errors };
}

/** Elemente, die rechts über den Bildschirm hinausragen (außer in Bereichen, die selbst scrollen) */
const overflow = () => {
  const vw = window.innerWidth; const out = [];
  const inScroller = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && !a.classList.contains('main')) return true; if (s.position === 'fixed') return true; } return false; };
  for (const el of document.querySelectorAll('.main *, .topbar *')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > vw + 1 && !inScroller(el) && getComputedStyle(el).position !== 'fixed') out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
  }
  return out.slice(0, 5);
};

const PAGES = {
  anna: ['/my', '/summary', '/issues', '/board', '/browse/IT-1', '/changes', '/cis', '/kb', '/kb/1', '/kb/1/edit', '/reports', '/profile'],
  karl: ['/requests', '/browse/IT-2', '/kb', '/kb/1', '/profile'],
  admin: ['/admin/general', '/admin/security', '/admin/mail', '/admin/users', '/admin/projects', '/admin/sla', '/admin/system'],
};

for (const [w, hgt] of [[390, 844], [360, 740]]) {
  test(`keine Seite steht über (${w} px)`, { skip: !chromium && 'Playwright fehlt' }, async () => {
    for (const [who, urls] of Object.entries(PAGES)) {
      const { p, errors } = await page(who, w, hgt);
      for (const url of urls) {
        await p.goto(S.base + url);
        await p.waitForLoadState('networkidle');
        await p.waitForTimeout(150);
        assert.deepEqual(await p.evaluate(overflow), [], `${who} ${url}`);
      }
      assert.deepEqual(errors, [], who);
      await p.context().close();
    }
  });
}

test('Menü, Suche und Details auf dem Smartphone', { skip: !chromium && 'Playwright fehlt' }, async () => {
  const { p, errors } = await page('anna', 390, 844);
  await p.goto(`${S.base}/my`);
  await p.waitForLoadState('networkidle');
  assert.ok(await p.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0), 'Seitenleiste zu');
  await p.tap('.nav-toggle');
  await p.waitForTimeout(300);
  assert.equal(await p.evaluate(() => document.querySelector('.shell').classList.contains('nav-open')), true);
  await p.tap('.sidebar a[href="/kb"]');
  await p.waitForURL('**/kb');
  await p.tap('.search-toggle');
  await p.keyboard.type('IT-1');
  await p.keyboard.press('Enter');
  await p.waitForURL('**/browse/IT-1');
  await p.waitForLoadState('networkidle');
  assert.equal(await p.isVisible('.detail-row'), false, 'Details zugeklappt');
  await p.tap('.details-head');
  assert.equal(await p.isVisible('.detail-row'), true);
  // Reihenfolge: Titel vor den Details
  const [title, details] = await p.evaluate(() => [document.querySelector('.ticket-title').getBoundingClientRect().top, document.querySelector('.details-box').getBoundingClientRect().top]);
  assert.ok(title < details);
  const inputSize = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.composer textarea')).fontSize));
  assert.ok(inputSize >= 16, 'kein Zoom beim Antippen (iPhone)');
  assert.deepEqual(errors, []);
});
