// Audit 2026-11f (UI): shared template and KB article of an archived project keep their project,
// project dialog (retry after a partly failed create, lead typed but not picked, linked portal
// checkbox), portal counters open the matching list (desktop and phone), oldest-first reply comes
// into view, system counts in singular, emergency panel lists all commands, translated Ctrl key.
// Needs Playwright with Chromium – if missing, the browser tests are skipped.
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

let S; let browser; let karl; let anna;
before(async () => {
  S = await startServer('audit-f-ui');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

async function page(username, { mobile = false, lang = 'de' } = {}) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1400, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: lang } });
  return { c, p, errors };
}

test('Shared template of an archived project keeps its project when edited', { skip }, async () => {
  const pr = (await S.admin('POST', '/api/projects', { key: 'ARC', name: 'Archivprojekt' })).body.project;
  const tpl = (await S.admin('POST', '/api/canned', { title: 'ARC-Vorlage', body: 'Hallo', shared: true, projectId: pr.id })).body.response;
  assert.equal(tpl.project.id, pr.id);
  await S.admin('PATCH', `/api/projects/${pr.id}`, { archived: true });
  const { c, p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/templates`);
  await p.locator('.template-row', { hasText: 'ARC-Vorlage' }).locator('.template-actions .btn').first().click();
  const title = p.locator('#template-form input').first();
  await title.waitFor();
  await title.fill('ARC-Vorlage neu');
  await p.locator('.modal button[type=submit]').click();
  await p.waitForSelector('.toast >> text=Gespeichert');
  const row = S.db.prepare('SELECT title, project_id FROM canned_responses WHERE id=?').get(tpl.id);
  assert.equal(row.title, 'ARC-Vorlage neu');
  assert.equal(row.project_id, pr.id, 'still restricted to its project');
  assert.deepEqual(errors, []);
  await c.close();
});

test('KB: saving a top-level article of an archived project does not move it to another project', { skip }, async () => {
  const pr = (await S.admin('POST', '/api/projects', { key: 'KBA', name: 'Wissen alt' })).body.project;
  const art = (await S.admin('POST', '/api/kb', { title: 'Alter Artikel', body: 'Text', visibility: 'internal', projectId: pr.id })).body.article;
  await S.admin('PATCH', `/api/projects/${pr.id}`, { archived: true });
  const { c, p, errors } = await page('admin');
  await p.goto(`${S.base}/kb/${art.id}/edit`);
  const title = p.locator('.kb-title-input');
  await title.waitFor();
  assert.equal(await p.locator('#kb-project').inputValue(), String(pr.id), 'own project preselected');
  await title.fill('Alter Artikel, korrigiert');
  await p.locator('.btn-primary', { hasText: 'Aktualisieren' }).click();
  await p.waitForSelector('.toast >> text=Gespeichert');
  const row = S.db.prepare('SELECT title, project_id FROM kb_articles WHERE id=?').get(art.id);
  assert.equal(row.title, 'Alter Artikel, korrigiert');
  assert.equal(row.project_id, pr.id);
  assert.deepEqual(errors, []);
  await c.close();
});

test('Project dialog: after a partly failed create, saving again updates the new project', { skip }, async () => {
  const { c, p, errors } = await page('admin');
  let fail = true;
  await p.route('**/api/projects/*/agents', (r) => {
    if (r.request().method() === 'PUT' && fail) { fail = false; return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Verzeichnis nicht erreichbar' } }) }); }
    return r.continue();
  });
  await p.goto(`${S.base}/admin/projects`);
  await p.getByRole('button', { name: 'Neues Projekt' }).click();
  await p.locator('#proj-form input').first().fill('NEU');
  await p.locator('#proj-form input').nth(1).fill('Neues Team');
  await p.locator('.modal button[type=submit]').click();
  await p.locator('.modal .form-error', { hasText: 'Verzeichnis nicht erreichbar' }).waitFor();
  await p.locator('.modal button[type=submit]').click();
  await p.waitForSelector('.toast >> text=Gespeichert');
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM projects WHERE key='NEU'").get().n, 1);
  assert.deepEqual(errors, []);
  await c.close();
});

test('Project dialog: a lead typed but not picked is refused with a hint; the portal checkbox has a label', { skip }, async () => {
  const pr = (await S.admin('POST', '/api/projects', { key: 'LD', name: 'Leitungstest' })).body.project;
  await S.admin('PUT', `/api/projects/${pr.id}/agents`, { lead: { userId: S.ids.anna }, agentGroup: '', members: [] });
  const { c, p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/projects`);
  await p.click('[data-edit-project="LD"]');
  await p.waitForSelector('[data-portal-show]');
  // Clicking the label text toggles the checkbox
  const before = await p.locator('[data-portal-show]').isChecked();
  await p.locator('label', { hasText: 'Im Portal' }).first().click();
  assert.equal(await p.locator('[data-portal-show]').isChecked(), !before);
  assert.ok(await p.locator('.portal-choice').first().getAttribute('aria-labelledby'));
  await p.locator('[data-lead]').fill('karl');
  await p.locator('#proj-form textarea').first().click(); // leave the field without picking
  await p.locator('.modal button[type=submit]').click();
  await p.locator('.modal .form-error', { hasText: 'aus der Liste' }).waitFor();
  assert.equal(await p.locator('[data-lead]').getAttribute('aria-invalid'), 'true');
  assert.equal(await p.locator('.modal').count(), 1, 'dialog stays open');
  assert.equal((await S.admin('GET', `/api/projects/${pr.id}/agents`)).body.lead.id, S.ids.anna, 'lead unchanged');
  assert.deepEqual(errors, []);
  await c.close();
});

// The list (once rendered) shows the open ticket and not the waiting one
const onlyOpen = (p) => p.waitForFunction(() => document.body.textContent.includes('Zaehler offen') && !document.body.textContent.includes('Zaehler wartet'), null, { timeout: 5000 });

test('Portal counters: desktop and phone open exactly the counted tickets', { skip }, async () => {
  const mk = async (title, status) => {
    const k = (await karl('POST', '/api/tickets', { title })).body.ticket.key;
    if (status) assert.equal((await S.admin('PATCH', `/api/tickets/${k}`, { status })).status, 200);
    return k;
  };
  await mk('Zaehler offen');
  await mk('Zaehler wartet', 'waiting');
  // Desktop: the list shows the applied status and "reported by me"
  let { c, p, errors } = await page('karl');
  await p.goto(`${S.base}/portal`);
  const active = p.locator('.portal-count').first();
  await active.waitFor();
  assert.equal(await active.locator('.portal-count-n').textContent(), '1');
  await active.click();
  await p.waitForURL(/\/requests\?/);
  const u = new URL(p.url());
  assert.equal(u.searchParams.get('status'), 'open,in_progress');
  assert.equal(u.searchParams.get('reporter'), 'me');
  const status = p.locator('.filter-fields select').filter({ has: p.locator('option[value=unresolved]') });
  await status.waitFor();
  assert.equal(await status.inputValue(), 'open,in_progress');
  await onlyOpen(p);
  assert.deepEqual(errors, []);
  await c.close();
  // Phone: "Active" does not list waiting tickets
  ({ c, p, errors } = await page('karl', { mobile: true }));
  await p.goto(`${S.base}/m/portal`);
  const stat = p.locator('.m-portal-stats .m-stat').first();
  await stat.waitFor();
  assert.equal(await stat.locator('.m-stat-n').textContent(), '1');
  await stat.click();
  await p.waitForURL(/filter=active/);
  await onlyOpen(p);
  assert.deepEqual(errors, []);
  await c.close();
});

test('Oldest first: a posted reply is scrolled into view', { skip }, async () => {
  const key = (await S.admin('POST', '/api/tickets', { projectId: 1, type: 'task', title: 'Viele Antworten', description: '' })).body.ticket.key;
  for (let i = 0; i < 12; i++) await S.admin('POST', `/api/tickets/${key}/comments`, { body: `Kommentar ${i}\n\n${'Zeile\n\n'.repeat(6)}`, internal: false });
  await anna('PATCH', '/api/me', { activityOrder: 'oldest' });
  const { c, p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/${key}`);
  await p.waitForSelector('[data-activity-order] >> text=Älteste oben');
  assert.match(await p.locator('[data-activity-order]').getAttribute('aria-label'), /Älteste oben – Reihenfolge umdrehen/);
  await p.locator('.composer .kb-editable').click();
  await p.keyboard.type('Neue Antwort ganz unten');
  await p.keyboard.press('Control+Enter');
  const added = p.locator('.comment', { hasText: 'Neue Antwort ganz unten' });
  await added.waitFor();
  await p.waitForFunction(() => {
    const el = [...document.querySelectorAll('.comment')].find((x) => x.textContent.includes('Neue Antwort ganz unten'));
    const r = el?.getBoundingClientRect();
    return r && r.top < innerHeight && r.bottom > 0;
  }, null, { timeout: 3000 });
  await anna('PATCH', '/api/me', { activityOrder: 'newest' });
  assert.deepEqual(errors, []);
  await c.close();
});

test('System page: singular counts and all emergency commands; English UI shows Ctrl, not Strg', { skip }, async () => {
  const { c, p, errors } = await page('admin', { lang: 'en' });
  await p.route('**/api/admin/system', async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.counts = { users: 1, contacts: 2, tickets: 1 };
    await r.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await p.goto(`${S.base}/admin/system`);
  await p.waitForSelector('text=1 user, 2 email contacts, 1 ticket');
  assert.match(await p.locator('.emergency-cmd').textContent(), /helfi-admin create <name>/);
  await p.goto(`${S.base}/kb/new?template=builtin:blank`);
  await p.locator('.kb-title-input').waitFor();
  const titles = await p.$$eval('[title]', (els) => els.map((e) => e.getAttribute('title')).join(' | '));
  assert.doesNotMatch(titles, /Strg/);
  assert.match(titles, /Ctrl\+/);
  assert.deepEqual(errors, []);
  await c.close();
});
