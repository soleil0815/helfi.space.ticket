// Bulk action "Component": set or remove the component of several tickets at once (API and list).
// The browser part needs Playwright with Chromium (not part of the dependencies) – skipped if missing.
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

let S; let anna; let karl; let it; let ops; let vpn; let printer; let opsComp; let browser;
before(async () => {
  S = await startServer('bulkcomp');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  it = (await S.admin('GET', '/api/projects')).body.projects[0];
  ops = (await S.admin('POST', '/api/projects', { key: 'OPS', name: 'Betrieb' })).body.project;
  vpn = (await S.admin('POST', `/api/projects/${it.id}/components`, { name: 'VPN', leadId: S.ids.anna })).body.component;
  printer = (await S.admin('POST', `/api/projects/${it.id}/components`, { name: 'Drucker' })).body.component;
  opsComp = (await S.admin('POST', `/api/projects/${ops.id}/components`, { name: 'Server' })).body.component;
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });
const mk = async (title, projectId) => (await karl('POST', '/api/tickets', { title, ...(projectId ? { projectId } : {}) })).body.ticket.key;
const get = async (key) => (await S.admin('GET', `/api/tickets/${key}`)).body.ticket;

test('API: set and remove the component of several tickets; wrong project fails per ticket; users may not', async () => {
  const a = await mk('Zugang von zuhause'); const b = await mk('Homeoffice geht nicht');
  const r = await anna('POST', '/api/tickets/bulk', { keys: [a, b], changes: { componentId: vpn.id } });
  assert.deepEqual(r.body.ok.sort(), [a, b].sort());
  const ta = await get(a);
  assert.equal(ta.component.id, vpn.id);
  assert.equal(ta.assignee, null, 'nobody assigned – like a manual change');
  assert.ok(ta.activity.some((x) => x.action === 'changed' && x.field === 'component' && x.newValue === 'VPN'));
  const o = await mk('Server down', ops.id);
  const r2 = await anna('POST', '/api/tickets/bulk', { keys: [a, o], changes: { componentId: printer.id } });
  assert.deepEqual(r2.body.ok, [a]);
  assert.equal(r2.body.failed[0].key, o, 'component of another project');
  assert.equal((await anna('POST', '/api/tickets/bulk', { keys: [a, b], changes: { componentId: null } })).status, 200);
  assert.equal((await get(b)).component, null);
  assert.equal((await karl('POST', '/api/tickets/bulk', { keys: [a], changes: { componentId: vpn.id } })).status, 403);
  assert.equal((await get(o)).component, null);
  void opsComp;
});

test('List: component menu for a selection from one project, disabled across projects', { skip }, async () => {
  const keys = [await mk('Drucker 1 streift'), await mk('Drucker 2 streift')];
  const other = await mk('Backup Server meldet Fehler', ops.id);
  const c = await browser.newContext({ viewport: { width: 1600, height: 900 }, extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'anna', password: 'Sehrgeheim123' } });
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  await p.goto(`${S.base}/issues?q=streift`);
  for (const k of keys) await p.locator('tr', { hasText: k }).locator('input[type=checkbox]').check();
  await p.locator('.bulk-bar [data-bulk=component]').click();
  await p.getByRole('menuitem', { name: 'Drucker' }).click();
  await p.locator('.toast', { hasText: '2' }).first().waitFor();
  for (const k of keys) assert.equal((await get(k)).component.id, printer.id);
  // across projects: disabled
  await p.goto(`${S.base}/issues`);
  await p.locator('tr', { hasText: keys[0] }).locator('input[type=checkbox]').check();
  await p.locator('tr', { hasText: other }).locator('input[type=checkbox]').check();
  assert.equal(await p.locator('.bulk-bar [data-bulk=component]').isDisabled(), true);
  assert.deepEqual(errors, []);
});
