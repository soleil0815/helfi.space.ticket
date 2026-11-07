// Sorting existing tickets in the browser: preview and start on the components page (rules only),
// review list of AI suggestions with bulk accept. Needs Playwright with Chromium – skipped if missing.
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

let S; let browser; let project; let vpn;
const keys = [];
before(async () => {
  if (!chromium) return;
  S = await startServer('backfillui');
  const karl = await S.user('karl', 'user');
  for (const title of ['FortiClient startet nicht', 'Kein Zugang von zuhause', 'Monitor flackert']) keys.push((await karl('POST', '/api/tickets', { title })).body.ticket.key);
  project = (await S.admin('GET', '/api/projects')).body.projects[0];
  vpn = (await S.admin('POST', `/api/projects/${project.id}/components`, { name: 'VPN', keywords: 'forticlient' })).body.component;
  // an AI suggestion from an earlier run (the AI itself is tested in ai-backfill.test.js)
  const id = S.db.prepare('SELECT id FROM tickets WHERE title=?').get('Kein Zugang von zuhause').id;
  S.db.prepare("INSERT INTO component_suggestions(ticket_id, component_id, component_name, reason, model, state, backfill) VALUES (?,?,?,?,?,'pending',1)").run(id, vpn.id, 'VPN', 'Zugriff von außen', 'test-model');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

test('Components page: preview, start (rules), review list with bulk accept', { skip }, async () => {
  const c = await browser.newContext({ viewport: { width: 1400, height: 1000 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  await p.goto(`${S.base}/admin/components`);
  const panel = p.locator('.backfill');
  await panel.waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Einordnen starten' }).isDisabled(), true, 'only after the preview');
  await panel.getByRole('button', { name: 'Vorschau' }).click();
  await panel.locator('.backfill-result strong').waitFor();
  assert.match(await panel.locator('.backfill-result').textContent(), /3 Tickets ohne Komponente – 1 per Regel, 0 an die KI/);
  await panel.getByRole('button', { name: 'Einordnen starten' }).click();
  await p.locator('.toast', { hasText: '1 Tickets per Regel eingeordnet' }).waitFor();
  const forti = S.db.prepare('SELECT component_id, assignee_id FROM tickets WHERE title=?').get('FortiClient startet nicht');
  assert.deepEqual([forti.component_id, forti.assignee_id], [vpn.id, null]);

  await panel.locator('.backfill-review', { hasText: 'KI-Vorschläge prüfen (1)' }).click();
  await p.getByRole('heading', { name: /KI-Vorschläge prüfen/ }).waitFor();
  const accept = p.getByRole('button', { name: /übernehmen|Übernehmen/ }).first();
  assert.equal(await accept.isDisabled(), true);
  await p.getByLabel('Alle auswählen').check();
  await p.getByRole('button', { name: '1 übernehmen' }).click();
  await p.locator('.empty-state', { hasText: 'Keine offenen Vorschläge' }).waitFor();
  assert.equal(S.db.prepare('SELECT component_id FROM tickets WHERE title=?').get('Kein Zugang von zuhause').component_id, vpn.id);
  assert.deepEqual(errors, []);
});
