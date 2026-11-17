// Shared reply templates of a project in the browser: the project lead maintains them in the profile
// ("Reply templates of my projects") and can save a comment as a shared template of the ticket's project.
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

let S; let browser; let IT; let ticket;
before(async () => {
  if (!chromium) return;
  S = await startServer('canned-leads-ui');
  await S.user('lena', 'user');
  await S.user('anton', 'user');
  IT = (await S.admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'IT');
  await S.admin('PUT', `/api/projects/${IT.id}/agents`, { lead: { userId: S.ids.lena }, members: [{ userId: S.ids.anton }] });
  ticket = (await S.admin('POST', '/api/tickets', { title: 'Drucker druckt nicht', description: 'Seit heute früh.' })).body.ticket;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username) {
  const c = await browser.newContext({ viewport: { width: 1360, height: 1000 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Project lead: "Antwortvorlagen meiner Projekte" in the profile, only own projects to choose', { skip }, async () => {
  const { p, errors } = await page('lena');
  await p.goto(`${S.base}/profile`);
  const panel = p.locator('[data-project-templates]');
  await panel.locator('h2 >> text=Antwortvorlagen meiner Projekte').waitFor();
  assert.match(await panel.locator('p.muted').first().textContent(), new RegExp(IT.name));
  await panel.getByRole('button', { name: 'Neue Vorlage' }).click();
  const form = p.locator('#template-form');
  await form.waitFor();
  // Shared is preselected, project = IT, no "All projects"
  assert.equal(await form.locator('input[type=checkbox]').isChecked(), true);
  assert.deepEqual(await form.locator('select option').allTextContents(), [IT.name]);
  await form.locator('input').first().fill('Toner bestellt');
  await form.locator('textarea').fill('Hallo {melder}, neuer Toner ist bestellt.');
  await p.locator('.modal button[type=submit]').click();
  await panel.locator('.template-row >> text=Toner bestellt').waitFor();
  const row = S.db.prepare("SELECT owner_id, project_id FROM canned_responses WHERE title='Toner bestellt'").get();
  assert.deepEqual({ ...row }, { owner_id: null, project_id: IT.id });
  assert.deepEqual(errors, []);
});

test('Ordinary agent: no project panel, only personal templates', { skip }, async () => {
  const { p, errors } = await page('anton');
  await p.goto(`${S.base}/profile`);
  await p.locator('#templates h2').waitFor();
  await p.waitForTimeout(300);
  assert.equal(await p.locator('[data-project-templates]:visible').count(), 0);
  assert.deepEqual(errors, []);
});

test('Project lead in a ticket: "save as template" can store it for the ticket\'s project', { skip }, async () => {
  const { p, errors } = await page('lena');
  await p.goto(`${S.base}/browse/${ticket.key}`);
  const editor = p.locator('.composer .kb-editable');
  await editor.click();
  await p.keyboard.type('Bitte einmal neu starten.');
  await p.click('.composer [data-shortcut=template]');
  await p.locator('.menu-templates .menu-foot .menu-item').click();
  const form = p.locator('#template-form');
  await form.waitFor();
  await p.waitForFunction(() => document.activeElement?.matches('#template-form input'));
  await form.locator('input').first().fill('Neustart');
  await form.locator('input[type=checkbox]').check();
  assert.equal(await form.locator('select').inputValue(), String(IT.id), 'ticket\'s project preselected');
  await p.locator('.modal button[type=submit]').click();
  await p.locator('.toast').first().waitFor();
  const row = S.db.prepare("SELECT owner_id, project_id FROM canned_responses WHERE title='Neustart'").get();
  assert.deepEqual({ ...row }, { owner_id: null, project_id: IT.id });
  assert.deepEqual(errors, []);
});
