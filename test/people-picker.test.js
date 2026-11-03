// Personenauswahl beim Hinzufügen von Teilnehmern: Fokus bleibt im Feld, Tastatur, AD-Treffer kommen nach.
// Braucht Playwright mit Chromium (nicht Teil der Abhängigkeiten) – fehlt es, wird der Test übersprungen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* nicht installiert */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* auch dort nicht */ }
}
const skip = !chromium && 'Playwright fehlt';

let S; let browser;
let adDelay = 0;
const AD = [
  { username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: 'a1'.repeat(16) },
  { username: 'e.beck', displayName: 'Emil Beck', email: 'e.beck@firma.local', externalId: 'b2'.repeat(16) },
];
before(async () => {
  if (!chromium) return;
  S = await startServer('picker');
  const s = S.ctx.settings;
  s.set('ldap.enabled', true);
  s.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  S.ctx.directory = {
    search: async (cfg, q) => { await new Promise((r) => setTimeout(r, adDelay)); return AD.filter((p) => `${p.displayName} ${p.email}`.toLowerCase().includes(q.toLowerCase())); },
    byGuid: async (cfg, id) => { const p = AD.find((x) => x.externalId === id); return p && { ...p, groups: { admin: false, agent: false, user: true } }; },
    byEmail: async () => null,
  };
  await S.user('anna', 'agent');
  const karl = await S.user('karl', 'user');
  await S.user('ebert', 'user');
  await karl('POST', '/api/tickets', { title: 'Drucker PR-0001 druckt nicht', description: 'Papierstau' });
  await karl('POST', '/api/tickets', { title: 'VPN', description: 'geht nicht' });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const r = await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } });
  assert.equal(r.status(), 200);
  return { p, errors };
}
const focused = (p) => p.evaluate(() => document.activeElement?.matches('.participants input') || false);
const items = (p) => p.$$eval('.picker-menu [role=option]', (x) => x.map((i) => i.textContent));

test('Tippen Buchstabe für Buchstabe: Fokus bleibt, AD-Treffer kommen nach', { skip }, async () => {
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/IT-1`);
  await p.click('.participants button.link');
  adDelay = 400;
  for (const ch of 'e.be') {
    await p.keyboard.type(ch);
    await p.waitForTimeout(350);
    assert.ok(await focused(p), `Fokus nach „${ch}“`);
  }
  // Lokale Treffer sofort, AD noch in Arbeit
  await p.waitForSelector('.picker-loading');
  await p.waitForSelector('.picker-menu .badge-ad');
  assert.ok(await focused(p), 'Fokus nach dem Nachladen');
  assert.ok(!(await p.$('.picker-loading')), 'Ladehinweis weg');
  const list = await items(p);
  assert.ok(list.some((x) => x.includes('Erika Beispiel')) && list.some((x) => x.includes('Emil Beck')), list.join('|'));
  // Tastatur: ↓ und Enter
  await p.keyboard.press('ArrowDown');
  const chosen = await p.$eval('.picker-menu .menu-item.active .person-name', (e) => e.textContent);
  await p.keyboard.press('Enter');
  await p.waitForFunction((n) => [...document.querySelectorAll('.participants .chip')].some((c) => c.textContent.includes(n)), chosen);
  assert.deepEqual(errors, []);
  adDelay = 0;
});

test('Zwei Zeichen: Hinweis auf AD ab 3 Zeichen; Esc schließt; veraltete Antwort überschreibt nichts', { skip }, async () => {
  const { p } = await page('anna');
  await p.goto(`${S.base}/browse/IT-2`);
  await p.click('.participants button.link');
  await p.keyboard.type('eb');
  await p.waitForSelector('.picker-menu');
  assert.ok(await focused(p));
  assert.match(await p.$eval('.picker-menu', (m) => m.textContent), /mindestens 3 Zeichen|at least 3 characters/);
  assert.ok((await items(p)).some((x) => x.includes('ebert')), 'lokale Person bei 2 Zeichen');

  // langsame AD-Antwort für „emi“, dann schnell weiter auf „erika“
  adDelay = 800;
  await p.fill('.participants input', 'emi');
  await p.waitForTimeout(300);
  adDelay = 0;
  await p.fill('.participants input', 'erika');
  await p.waitForSelector('.picker-menu .badge-ad');
  await p.waitForTimeout(900);
  const list = await items(p);
  assert.ok(list.every((x) => !x.includes('Emil')), `veraltete Treffer: ${list.join('|')}`);

  await p.keyboard.press('Escape');
  assert.equal(await p.$('.picker-menu'), null);
  assert.ok(await p.$('.participants button.link'), 'zurück zum Knopf');
});

test('Benutzer: keine AD-Suche, kein AD-Hinweis', { skip }, async () => {
  const { p } = await page('karl');
  await p.goto(`${S.base}/browse/IT-2`);
  await p.click('.participants button.link');
  await p.keyboard.type('ebe');
  await p.waitForSelector('.picker-menu');
  await p.waitForTimeout(300);
  const text = await p.$eval('.picker-menu', (m) => m.textContent);
  assert.doesNotMatch(text, /Active Directory/);
  assert.equal(await p.$('.picker-menu .badge-ad'), null);
  assert.ok(await focused(p));
});
