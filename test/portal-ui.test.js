// Portal in the browser: where users land, department page with "report something else" fixed to the
// project, search, phone app (portal tab first), project dialog settings.
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

let S; let browser; let HM; let karlTicket;
before(async () => {
  if (!chromium) return;
  S = await startServer('portalui');
  const karl = await S.user('karl', 'user');
  await S.user('anna', 'agent');
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  await S.admin('PATCH', `/api/projects/${HM.id}`, { portal: { show: true, icon: 'home', color: 'orange', description: 'Heizung, Wasser, Schlüssel', intro: 'Notfall: Durchwahl 1234' } });
  await S.admin('POST', '/api/catalog', { title: 'Raum zu kalt', emoji: '🌡️', description: 'Heizung einstellen lassen', projectKey: 'HM', fields: [] });
  await S.admin('POST', '/api/kb', { title: 'Heizkörper einstellen', body: 'x', visibility: 'public', projectId: HM.id });
  karlTicket = (await karl('POST', '/api/tickets', { projectId: HM.id, type: 'request', title: 'Büro zu kalt', description: '' })).body.ticket;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, { mobile = false } = {}) {
  const c = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' },
  });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Users land in the portal, agents at the tickets; links go straight to their target', { skip }, async () => {
  const { p, errors } = await page('karl');
  await p.goto(`${S.base}/`);
  await p.waitForURL(/\/portal$/);
  await p.waitForSelector('.portal-dept[data-dept="HM"] >> text=Heizung, Wasser, Schlüssel');
  await p.waitForSelector(`.portal-recent-row >> text=${karlTicket.key}`);
  assert.equal(await p.locator('.portal-count').first().locator('.portal-count-n').textContent(), '1');
  // Link from a mail: straight to the ticket
  await p.goto(`${S.base}/browse/${karlTicket.key}`);
  await p.waitForSelector('h1 >> text=Büro zu kalt');
  assert.match(p.url(), /\/browse\//);
  // Search: offerings and public articles
  await p.goto(`${S.base}/portal`);
  await p.fill('#portal-q', 'Heiz');
  await p.waitForSelector('.portal-result >> text=Raum zu kalt');
  await p.waitForSelector('.portal-result >> text=Heizkörper einstellen');

  const agent = await page('anna');
  await agent.p.goto(`${S.base}/`);
  await agent.p.waitForURL(/\/board$/);
  // Setting "my requests": users land on the list
  await S.admin('PUT', '/api/admin/settings', { settings: { 'general.userStart': 'requests' } });
  const { p: p2 } = await page('karl');
  await p2.goto(`${S.base}/`);
  await p2.waitForURL(/\/requests$/);
  await S.admin('PUT', '/api/admin/settings', { settings: { 'general.userStart': 'portal' } });
  assert.deepEqual([...errors, ...agent.errors], []);
});

test('Department page: offerings, notice, FAQ; "report something else" goes to the department', { skip }, async () => {
  const { p, errors } = await page('karl');
  await p.goto(`${S.base}/portal`);
  await p.click('.portal-dept[data-dept="HM"]');
  await p.waitForURL(/\/portal\/hm$/);
  await p.waitForSelector('.portal-dept-intro >> text=Notfall: Durchwahl 1234');
  await p.waitForSelector('.portal-offer >> text=Raum zu kalt');
  await p.waitForSelector('.portal-faq >> text=Heizkörper einstellen');
  await p.click('[data-report]');
  await p.waitForSelector('[data-locked-project] >> text=Haustechnik');
  await p.waitForFunction(() => document.activeElement?.closest('.modal'));
  await p.locator('.modal input[required]').first().fill('Fenster klemmt');
  await p.locator('.modal button[type=submit]').click();
  await p.waitForSelector('h1 >> text=Fenster klemmt');
  const row = S.db.prepare("SELECT p.key FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.title='Fenster klemmt'").get();
  assert.equal(row.key, 'HM');
  assert.deepEqual(errors, []);
});

test('Phone app: portal is the first tab, department, report with the project preselected', { skip }, async () => {
  const { p, errors } = await page('karl', { mobile: true });
  await p.goto(`${S.base}/m/`);
  await p.waitForSelector('.m-portal-depts [data-dept="HM"]');
  const tabs = await p.locator('.m-tab[data-tab]').evaluateAll((xs) => xs.map((x) => x.dataset.tab));
  assert.deepEqual(tabs.slice(0, 2), ['home', 'requests']);
  await p.click('.m-portal-depts [data-dept="HM"]');
  await p.waitForURL(/\/m\/portal\/hm$/);
  await p.waitForSelector('[data-report]');
  assert.match(await p.locator('[data-report]').getAttribute('href'), /project=HM/);
  // Requests tab: the list
  await p.goto(`${S.base}/m/requests`);
  await p.waitForSelector(`text=Büro zu kalt`);
  // Desktop address of the department opens the phone page
  await p.goto(`${S.base}/portal/hm`);
  await p.waitForURL(/\/m\/portal\/hm$/);
  assert.deepEqual(errors, []);
});

test('Admin: portal settings in the project dialog', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/projects`);
  await p.click('[data-edit-project="HM"]');
  await p.waitForSelector('[data-portal-show]');
  await p.fill('[data-portal-desc]', 'Heizung und Wasser');
  await p.click('.portal-choice [data-icon="key"]');
  await p.click('.portal-choice [data-color="green"]');
  assert.equal(await p.locator('.portal-choice [data-icon="key"]').getAttribute('aria-pressed'), 'true');
  await p.click('#proj-form ~ * button[type=submit], .modal button[type=submit]');
  await p.waitForSelector('.toast >> text=Gespeichert');
  const r = S.db.prepare("SELECT portal_desc, portal_icon, portal_color FROM projects WHERE key='HM'").get();
  assert.deepEqual({ ...r }, { portal_desc: 'Heizung und Wasser', portal_icon: 'key', portal_color: 'green' });
  // Start page setting
  await p.goto(`${S.base}/admin/tickets`);
  await p.locator('.user-start select').selectOption('requests');
  await p.locator('.user-start .btn-primary').click();
  await p.waitForSelector('.toast >> text=Gespeichert');
  assert.equal((await S.admin('GET', '/api/admin/settings')).body.settings['general.userStart'], 'requests');
  await S.admin('PUT', '/api/admin/settings', { settings: { 'general.userStart': 'portal' } });
  assert.deepEqual(errors, []);
});
