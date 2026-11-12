// Service catalog per project in the browser: grouped overview, management by the project lead,
// approvers via people search, admin sees "not yet assigned to a project".
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
before(async () => {
  if (!chromium) return;
  S = await startServer('catalogprojui');
  await S.user('hmlead', 'user');
  await S.user('hmagent', 'user');
  await S.user('chefin', 'user');
  await S.user('karl', 'user');
  const hm = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  await S.admin('PUT', `/api/projects/${hm.id}/agents`, { lead: { userId: S.ids.hmlead }, members: [{ userId: S.ids.hmagent }] });
  await S.admin('POST', '/api/catalog', { title: 'Laptop', emoji: '💻', projectKey: 'IT', fields: [] });
  S.db.prepare("INSERT INTO catalog_items(title, description, emoji, project_key, fields, approver_ids, approval_mode, active, sort) VALUES('Altes Angebot', '', '', '', '[]', '', 'any', 1, 0)").run();
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
const groups = (p) => p.$$eval('.catalog-group-title', (x) => x.map((e) => e.textContent));

test('Project lead: manage button, new offering only in the own project, approver via people search', { skip }, async () => {
  const { p, errors } = await page('hmlead');
  await p.goto(`${S.base}/catalog`);
  await p.waitForSelector('.catalog-group');
  assert.deepEqual(await groups(p), ['IT', 'Weitere Angebote']);
  await p.click('[data-catalog-manage]');
  await p.waitForURL(/\/catalog\/manage$/);
  await p.waitForSelector('text=Du siehst die Angebote der Projekte');
  assert.equal(await p.locator('[data-examples]').count(), 0, 'examples stay with admins');
  await p.click('text=Neues Angebot');
  const proj = p.locator('select[aria-label="Projekt"]');
  assert.deepEqual(await proj.locator('option').allTextContents(), ['Haustechnik (HM)']);
  await p.fill('.grid-3 input >> nth=0', 'Raum zu kalt');
  await p.fill('input[aria-label="Person suchen und hinzufügen …"]', 'chef');
  await p.click('.picker-menu [role=option] >> text=chefin');
  await p.waitForSelector('[data-approver] >> text=chefin');
  await p.click('.form-actions .btn-primary');
  await p.waitForSelector('.catalog-admin-group[data-project="HM"] >> text=Raum zu kalt');
  const row = S.db.prepare("SELECT project_key, approver_ids FROM catalog_items WHERE title='Raum zu kalt'").get();
  assert.deepEqual({ ...row }, { project_key: 'HM', approver_ids: String(S.ids.chefin) });
  // Overview: now three groups, sorted by project name, unassigned last
  await p.goto(`${S.base}/catalog`);
  await p.waitForSelector('.catalog-group[data-project="HM"]');
  assert.deepEqual(await groups(p), ['Haustechnik', 'IT', 'Weitere Angebote']);
  assert.deepEqual(errors, []);
});

test('Other agents of the project and users: no manage button', { skip }, async () => {
  for (const u of ['hmagent', 'karl']) {
    const { p, errors } = await page(u);
    await p.goto(`${S.base}/catalog`);
    await p.waitForSelector('.catalog-group');
    assert.equal(await p.locator('[data-catalog-manage]').count(), 0, u);
    assert.deepEqual(errors, []);
  }
});

test('Admin: "not yet assigned" group, assign a project there', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/catalog`);
  await p.waitForSelector('.catalog-admin-group[data-project=""] >> text=Noch keinem Projekt zugeordnet');
  await p.click('.catalog-admin-group[data-project=""] >> text=Altes Angebot');
  const proj = p.locator('select[aria-label="Projekt"]');
  assert.equal(await proj.inputValue(), '');
  // Saving without a project is refused in the form
  await p.click('.form-actions .btn-primary');
  await p.waitForSelector('.toast >> text=Bitte ein Projekt wählen');
  await proj.selectOption('IT');
  await p.click('.form-actions .btn-primary');
  await p.waitForSelector('.catalog-admin-group[data-project="IT"] >> text=Altes Angebot');
  assert.equal(await p.locator('.catalog-admin-group[data-project=""]').count(), 0);
  assert.deepEqual(errors, []);
});
