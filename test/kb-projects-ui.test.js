// Knowledge base per project in the browser: project filter, project in the editor (inherited for
// subpages), no edit buttons on other projects' articles, project for shared canned responses.
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

let S; let browser; let HM; let IT; let pub;
before(async () => {
  if (!chromium) return;
  S = await startServer('kbprojui');
  const it = await S.user('itagent', 'user');
  const hm = await S.user('hmagent', 'user');
  await S.user('both', 'user');
  IT = (await S.admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'IT');
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  await S.admin('PUT', `/api/projects/${IT.id}/agents`, { members: [{ userId: S.ids.itagent }, { userId: S.ids.both }] });
  await S.admin('PUT', `/api/projects/${HM.id}/agents`, { members: [{ userId: S.ids.hmagent }, { userId: S.ids.both }] });
  pub = (await hm('POST', '/api/kb', { title: 'Raum zu kalt?', body: 'Thermostat auf 3 stellen.', visibility: 'public', projectId: HM.id })).body.article;
  await it('POST', '/api/kb', { title: 'VPN einrichten', body: 'Client starten.', visibility: 'public' });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username) {
  const c = await browser.newContext({ viewport: { width: 1360, height: 1000 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Other project\'s public article: readable, no edit/delete/subpage/history', { skip }, async () => {
  const { p, errors } = await page('itagent');
  await p.goto(`${S.base}/kb/${pub.id}`);
  await p.waitForSelector('h1 >> text=Raum zu kalt?');
  await p.waitForSelector('.kb-meta .kb-project >> text=Haustechnik');
  assert.equal(await p.locator('.page-head a.btn >> text=Bearbeiten').count(), 0);
  assert.equal(await p.locator(`a[href="/kb/new?parent=${pub.id}"]`).count(), 0);
  assert.equal(await p.locator('.page-head [aria-label="Löschen"]').count(), 0);
  assert.equal(await p.locator(`a[href="/kb/${pub.id}/history"]`).count(), 0);
  // the tree does not let this article be dragged
  assert.equal(await p.locator(`.kb-tree a[href="/kb/${pub.id}"]`).getAttribute('draggable'), 'false');
  assert.deepEqual(errors, []);
});

test('Agent of two projects: project filter, project select, subpage inherits', { skip }, async () => {
  const { p, errors } = await page('both');
  await p.goto(`${S.base}/kb`);
  await p.waitForSelector('.kb-projects [data-project="HM"]');
  await p.click('.kb-projects [data-project="HM"]');
  await p.waitForURL(/project=HM/);
  await p.waitForSelector('.kb-card >> text=Raum zu kalt?');
  assert.equal(await p.locator('.kb-card >> text=VPN einrichten').count(), 0);

  await p.goto(`${S.base}/kb/new?template=blank`);
  await p.waitForSelector('#kb-project');
  // Only the two projects the person works on
  assert.deepEqual(await p.locator('#kb-project option').evaluateAll((o) => o.map((x) => Number(x.value)).sort()), [IT.id, HM.id].sort());
  await p.selectOption('#kb-project', String(HM.id));
  await p.fill('.kb-title-input', 'Heizung entlüften');
  await p.locator('.kb-editable').click();
  await p.keyboard.type('Schlüssel ansetzen.');
  await p.click('.kb-edit-head .btn-primary');
  await p.waitForSelector('h1 >> text=Heizung entlüften');
  assert.equal(S.db.prepare("SELECT p.key FROM kb_articles a JOIN projects p ON p.id=a.project_id WHERE a.title='Heizung entlüften'").get().key, 'HM');

  // Subpage: project select hidden, inherited project shown
  await p.goto(`${S.base}/kb/new?template=blank&parent=${pub.id}`);
  await p.waitForSelector('.kb-project-inherit >> text=Projekt: Haustechnik');
  assert.equal(await p.locator('#kb-project').isHidden(), true);
  assert.deepEqual(errors, []);
});

test('Admin: shared canned response for one project', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/templates`);
  await p.click('.section-head .btn-primary');
  // The dialog focuses the name field shortly after opening – wait for it, else typing can land there
  await p.waitForFunction(() => document.activeElement?.matches('#template-form input'));
  await p.fill('#template-form input', 'Heizung');
  await p.fill('#template-form textarea', 'Bitte Thermostat prüfen.');
  await p.check('#template-form input[type=checkbox]');
  const sel = p.locator('#template-form select[aria-label="Projekt"]');
  await p.waitForFunction(() => document.querySelectorAll('#template-form select option').length > 1);
  await sel.selectOption(String(HM.id));
  await p.click('.modal button[type=submit]');
  await p.waitForSelector('.toast >> text=Gespeichert');
  await p.waitForSelector('#template-form', { state: 'detached' });
  assert.equal(S.db.prepare("SELECT project_id FROM canned_responses WHERE title='Heizung'").get().project_id, HM.id);
  // Freshly loaded list shows the project (independent of a re-render while the dialog was open)
  await p.goto(`${S.base}/admin/templates`);
  await p.waitForSelector('.template-row >> text=Heizung');
  await p.waitForSelector('.template-row .template-project >> text=Haustechnik');
  assert.deepEqual(errors, []);
});
