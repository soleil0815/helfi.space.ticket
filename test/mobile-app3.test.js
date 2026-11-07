// Mobile UI part 3: report a problem, service catalog, knowledge base, two-factor setup in "Me",
// title/description editing, installable app (manifest, service worker, offline page).
// Needs Playwright with Chromium (see mobile-app.test.js); CI sets HELFI_REQUIRE_BROWSER.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';
import { moduleGraph } from '../src/pwa.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

let S; let browser; let config; // config: imported after the test data folder is set
const who = {};
const ids = {};
before(async () => {
  S = await startServer('mobile-app3');
  ({ config } = await import('../src/config.js'));
  S.ctx.settings.set('general.allowSelfService', true);
  who.anna = await S.user('anna', 'agent');
  who.karl = await S.user('karl', 'user');
  await S.user('lena', 'user');
  await S.user('otto', 'user');
  await S.user('paul', 'user');
  // Second project: agents choose the project when reporting
  await S.admin('POST', '/api/projects', { key: 'HW', name: 'Hardware' });
  await who.karl('POST', '/api/tickets', { title: 'Drucker PR-0001 druckt nicht', description: 'Seit heute früh.', type: 'incident' });
  // Catalog: one item with required fields of every kind and an approval
  ids.item = (await S.admin('POST', '/api/catalog', {
    title: 'Software installieren', emoji: '💿', description: 'Programm auf deinem PC installieren lassen', approverIds: [S.ids.anna], approvalMode: 'any',
    fields: [
      { label: 'Programm', type: 'text', required: true },
      { label: 'Lizenz vorhanden', type: 'select', options: ['Ja', 'Nein'], required: true },
      { label: 'Benötigt ab', type: 'date' },
      { label: 'Begründung', type: 'textarea' },
      { label: 'Auch auf dem Notebook', type: 'checkbox' },
    ],
  })).body.item.id;
  await S.admin('POST', '/api/catalog', { title: 'Zweiter Monitor', emoji: '🖥️', fields: [], approverIds: [], approvalMode: 'any' });
  // Knowledge base: folder with subpages, long article with table/code/headings, internal article
  ids.folder = (await who.anna('POST', '/api/kb', { title: 'Drucker & Scanner', body: '', visibility: 'public' })).body.article.id;
  ids.child = (await who.anna('POST', '/api/kb', { title: 'Papierstau beheben', body: 'Klappe öffnen.', visibility: 'public', category: 'Drucker', parentId: ids.folder })).body.article.id;
  ids.vpn = (await who.anna('POST', '/api/kb', {
    title: 'VPN im Homeoffice einrichten', visibility: 'public', category: 'VPN',
    body: '# Voraussetzungen\n\nFirmen-Notebook.\n\n# Einrichtung\n\n| Einstellung | Wert | Hinweis | Noch eine Spalte | Und noch eine |\n| --- | --- | --- | --- | --- |\n| Server | vpn.firma.local | ohne https:// | sehr langer Inhalt der Zelle | 10.0.10.1 |\n\n```\nsudo systemctl restart ein-sehr-langer-dienstname-der-umbrechen-muss-weil-er-so-lang-ist\n```\n\n# Fehlersuche\n\nNeu starten.\n\n## Verbindung bricht ab\n\nWLAN-Energiesparmodus abschalten. Siehe [IT-1](/browse/IT-1).',
  })).body.article.id;
  ids.internal = (await who.anna('POST', '/api/kb', { title: 'Interne Notizen Serverraum', body: 'Nur intern.', visibility: 'internal' })).body.article.id;
  // No 2FA prompts except where a test switches them on
  S.db.prepare("UPDATE users SET totp_enabled=1 WHERE username NOT IN ('lena')").run();
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
async function open(username, opts = PHONE) {
  const c = await browser.newContext({ ...opts, locale: 'de-DE' });
  const p = await c.newPage();
  const errors = [];
  await p.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (username) {
    const r = await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' }, headers: { 'X-Helfi-Request': '1' } });
    assert.equal(r.status(), 200);
  }
  return { p, c, errors, close: () => c.close() };
}
const ready = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(450); };
const path = (p) => { const u = new URL(p.url()); return u.pathname + u.search; };
const ticketApi = async (client, key) => (await client('GET', `/api/tickets/${key}`)).body.ticket;
const pngOf = async (p, w, hgt) => Buffer.from(await p.evaluate(({ w, hgt }) => {
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  const g = c.getContext('2d'); g.fillStyle = '#5B8DEF'; g.fillRect(0, 0, w, hgt); g.fillStyle = '#fff'; g.fillRect(w / 4, hgt / 4, w / 2, hgt / 2);
  return c.toDataURL('image/png').split(',')[1];
}, { w, hgt }), 'base64');
const overflow = () => {
  const vw = window.innerWidth; const out = [];
  const inScroller = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll)/.test(s.overflowX) && !a.classList.contains('m-scroll')) return true; } return false; };
  for (const el of document.querySelectorAll('.m-page *, .m-tabbar *, .m-sheet *, .m-foot *')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > vw + 1 && !inScroller(el) && !el.closest('.m-leaving')) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
  }
  if (document.documentElement.scrollWidth > vw) out.push('document');
  return out.slice(0, 5);
};

// ---------- Report a problem ----------
test('User: "＋" offers "report a problem" and the catalog; report with knowledge suggestion, draft and photo', { skip }, async () => {
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/`);
  await ready(p);
  await p.tap('.m-tab-new');
  await p.waitForURL('**/m/new');
  await ready(p);
  const tiles = await p.$$eval('.m-tile', (x) => x.map((tl) => tl.querySelector('.m-tile-title').textContent));
  assert.deepEqual(tiles, ['Problem melden', 'Software installieren', 'Zweiter Monitor']);
  assert.match(await p.textContent('.m-tile:nth-of-type(2), .m-tiles a[href$="/c/' + ids.item + '"]'), /mit Genehmigung/);
  await p.tap('.m-tile-report');
  await p.waitForURL('**/m/new/report');
  await ready(p);
  // Users get what the desktop offers users: no problem/change types
  const types = await p.$$eval('.m-choice-group[aria-label="Typ"] .m-choice', (x) => x.map((c) => c.dataset.value));
  assert.deepEqual(types, ['incident', 'request', 'task', 'question']);
  assert.equal(await p.locator('select[name=project]').count(), 1, 'two projects: project choice');
  // Knowledge suggestion while typing the title; opens in a sheet, the form stays
  await p.fill('input[name=title]', 'VPN Homeoffice bricht ab');
  await p.waitForSelector('.m-suggest:not([hidden]) .m-suggest-item');
  await p.locator('.m-suggest-item', { hasText: 'VPN im Homeoffice' }).tap();
  await p.waitForSelector('.m-sheet-layer.open .m-kb-body');
  await p.locator('.m-sheet .m-btn', { hasText: 'Zurück zum Formular' }).tap();
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  assert.equal(await p.inputValue('input[name=title]'), 'VPN Homeoffice bricht ab');
  // Draft survives a reload (sessionStorage)
  await p.fill('textarea[name=description]', 'Seit dem Update auf PC-0001.');
  await p.locator('.m-choice[data-value=incident]').tap();
  await p.waitForTimeout(400);
  await p.reload();
  await ready(p);
  assert.equal(await p.inputValue('input[name=title]'), 'VPN Homeoffice bricht ab');
  assert.equal(await p.inputValue('textarea[name=description]'), 'Seit dem Update auf PC-0001.');
  assert.equal(await p.getAttribute('.m-choice[data-value=incident]', 'aria-checked'), 'true');
  // Photo (large: downscaled) and a file
  const big = await pngOf(p, 3200, 2400);
  let chooser = p.waitForEvent('filechooser');
  await p.locator('.m-attach-btn', { hasText: 'Foto aufnehmen' }).tap();
  await (await chooser).setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: big });
  chooser = p.waitForEvent('filechooser');
  await p.locator('.m-attach-btn', { hasText: 'Datei' }).tap();
  await (await chooser).setFiles({ name: 'log.txt', mimeType: 'text/plain', buffer: Buffer.from('Fehler 809\n') });
  await p.waitForFunction(() => document.querySelectorAll('.m-new-files .m-file.ready').length === 2);
  assert.match(await p.textContent('.m-file[data-name="foto.jpg"] .m-file-meta'), /verkleinert/);
  assert.deepEqual(await p.evaluate(overflow), []);
  await p.tap('.m-foot .m-btn-primary');
  await p.waitForURL(/\/m\/t\/[A-Z]+-\d+$/);
  const key = path(p).split('/').pop();
  await p.waitForSelector('.toast-success');
  assert.match(await p.textContent('.toast-success'), new RegExp(`${key} wurde erstellt`));
  const tk = await ticketApi(who.karl, key);
  assert.equal(tk.title, 'VPN Homeoffice bricht ab');
  assert.equal(tk.type, 'incident');
  assert.equal(tk.reporter.username, 'karl');
  assert.deepEqual(tk.attachments.map((a) => a.filename).sort(), ['foto.jpg', 'log.txt']);
  const img = tk.attachments.find((a) => a.filename === 'foto.jpg');
  assert.equal(img.mime, 'image/jpeg');
  // Draft gone after sending; back does not return to the filled form
  assert.equal(await p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('helfi.m.newTicket')).length), 0);
  await ready(p);
  assert.match(await p.textContent('.m-ticket-h1'), /VPN Homeoffice/);
  assert.equal(await p.locator('.m-att-img').count() + await p.locator('.m-att-file').count(), 2);
  assert.deepEqual(errors, []);
  await close();
});

test('Agent: report with project, type and priority; empty title is refused', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/new/report`);
  await ready(p);
  const types = await p.$$eval('.m-choice-group[aria-label="Typ"] .m-choice', (x) => x.map((c) => c.dataset.value));
  assert.deepEqual(types, ['incident', 'request', 'task', 'question', 'problem', 'change']);
  assert.equal(await p.getAttribute('.m-choice[data-value=task]', 'aria-checked'), 'true', 'agent default: task');
  assert.equal(await p.getAttribute('.m-choice[data-value=medium]', 'aria-checked'), 'true');
  await p.tap('.m-foot .m-btn-primary');
  await p.waitForSelector('.m-new-form .m-alert-error:not([hidden])');
  assert.equal(await p.evaluate(() => document.activeElement?.name), 'title');
  await p.fill('input[name=title]', 'Switch im Serverraum tauschen');
  const hw = (await who.anna('GET', '/api/projects')).body.projects.find((x) => x.key === 'HW');
  await p.selectOption('select[name=project]', String(hw.id));
  await p.locator('.m-choice[data-value=change]').tap();
  await p.locator('.m-choice[data-value=high]').tap();
  await p.tap('.m-foot .m-btn-primary');
  await p.waitForURL(/\/m\/t\/HW-\d+$/);
  const tk = await ticketApi(who.anna, path(p).split('/').pop());
  assert.equal(tk.projectKey, 'HW');
  assert.equal(tk.type, 'change');
  assert.equal(tk.priority, 'high');
  assert.deepEqual(errors.filter((e) => !/400/.test(e)), []);
  await close();
});

test('Catalog item: all field types, required fields, approval note, sent with the same API', { skip }, async () => {
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/new`);
  await ready(p);
  await p.locator('.m-tile', { hasText: 'Software installieren' }).tap();
  await p.waitForURL(`**/m/new/c/${ids.item}`);
  await ready(p);
  assert.match(await p.textContent('.m-approval-note'), /genehmigt/);
  assert.equal(await p.locator('.m-new-form input[type=date]').count(), 1);
  assert.equal(await p.locator('.m-new-form select').count(), 1);
  assert.equal(await p.locator('.m-new-form textarea').count(), 1);
  assert.equal(await p.locator('.m-new-form input[type=checkbox]').count(), 1);
  assert.equal(await p.locator('.m-req').count(), 2);
  await p.tap('.m-foot .m-btn-primary');
  await p.waitForSelector('.m-new-form .m-alert-error:not([hidden])');
  assert.equal(await p.locator('.m-field.invalid').count(), 1);
  await p.fill('.m-new-form input:not([type])', 'Visio');
  await p.selectOption('.m-new-form select', 'Ja');
  await p.fill('.m-new-form input[type=date]', '2026-12-01');
  await p.fill('.m-new-form textarea', 'Für Netzpläne');
  await p.tap('.m-check');
  assert.equal(await p.isChecked('.m-check input'), true);
  assert.deepEqual(await p.evaluate(overflow), []);
  await p.tap('.m-foot .m-btn-primary');
  await p.waitForURL(/\/m\/t\/IT-\d+$/);
  await ready(p);
  const tk = await ticketApi(who.karl, path(p).split('/').pop());
  assert.match(tk.title, /Software installieren/);
  assert.match(tk.description, /Visio/);
  assert.match(tk.description, /Netzpläne/);
  assert.equal(tk.approval.state, 'pending');
  assert.ok(await p.isVisible('.m-approval-info'));
  assert.deepEqual(errors, []);
  await close();
});

test('Self-service switched off: users cannot report, agents still can', { skip }, async () => {
  S.ctx.settings.set('general.allowSelfService', false);
  try {
    const { p, errors, close } = await open('karl');
    await p.goto(`${S.base}/m/new/report`);
    await ready(p);
    assert.match(await p.textContent('.m-empty-title'), /Nicht freigeschaltet/);
    assert.equal(await p.locator('.m-tab-new').count(), 0);
    assert.deepEqual(errors, []);
    await close();
  } finally { S.ctx.settings.set('general.allowSelfService', true); }
});

// ---------- Knowledge base ----------
test('Knowledge base: start page, search, folder drill-down, article with table, contents sheet and comment', { skip }, async () => {
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/kb`);
  await ready(p);
  assert.equal(await p.textContent('.m-page:not(.m-leaving) .m-title'), 'Hilfe & Wissen');
  const tree = await p.$$eval('.m-group', (gs) => gs.find((g) => /Seitenbaum/.test(g.textContent))?.querySelectorAll('.m-kb-row').length);
  assert.equal(tree, 2, 'folder and VPN article at the top level; the internal article is not there');
  assert.equal(await p.locator('.m-kb-row', { hasText: 'Interne Notizen' }).count(), 0);
  // Search
  await p.fill('.m-search-input', 'Papierstau');
  await p.waitForURL('**/m/kb?q=Papierstau');
  await p.waitForSelector('.m-kb-row[data-id="' + ids.child + '"]');
  await p.fill('.m-search-input', 'Serverraum');
  await p.waitForSelector('.m-empty');
  await p.fill('.m-search-input', '');
  await p.waitForURL((u) => u.pathname === '/m/kb' && !u.search);
  // Folder → subpage → breadcrumb back
  await p.locator('.m-kb-row', { hasText: 'Drucker & Scanner' }).first().tap();
  await p.waitForURL(`**/m/kb/${ids.folder}`);
  await ready(p);
  assert.match(await p.textContent('.m-section'), /Unterseiten/);
  await p.locator('.m-kb-row', { hasText: 'Papierstau beheben' }).tap();
  await p.waitForURL(`**/m/kb/${ids.child}`);
  await ready(p);
  assert.match(await p.textContent('.m-kb-crumbs'), /Drucker & Scanner/);
  await p.locator('.m-kb-crumbs a', { hasText: 'Drucker & Scanner' }).tap();
  await p.waitForURL(`**/m/kb/${ids.folder}`);
  // Long article: table scrolls inside its box, code wraps, no page overflow
  await p.goto(`${S.base}/m/kb/${ids.vpn}`);
  await ready(p);
  assert.deepEqual(await p.evaluate(overflow), []);
  const table = await p.evaluate(() => { const b = document.querySelector('.m-kb-body .kb-table'); return { scroll: b.scrollWidth > b.clientWidth, ox: getComputedStyle(b).overflowX, fits: b.getBoundingClientRect().right <= innerWidth }; });
  assert.deepEqual(table, { scroll: true, ox: 'auto', fits: true });
  const pre = await p.evaluate(() => { const b = document.querySelector('.m-kb-body pre'); return b.getBoundingClientRect().right <= innerWidth; });
  assert.ok(pre);
  // Contents sheet scrolls to the heading
  await p.tap('.m-toc-btn');
  await p.waitForSelector('.m-sheet-layer.open .m-toc-item');
  assert.deepEqual(await p.$$eval('.m-toc-item', (x) => x.map((i) => i.textContent)), ['Voraussetzungen', 'Einrichtung', 'Fehlersuche', 'Verbindung bricht ab']);
  await p.locator('.m-toc-item', { hasText: 'Verbindung bricht ab' }).tap();
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  await p.waitForTimeout(700);
  assert.ok(await p.evaluate(() => document.querySelector('.m-page:not(.m-leaving) .m-scroll').scrollTop) > 100);
  // Ticket link inside the article stays in the mobile UI
  await p.locator('.m-kb-body a', { hasText: 'IT-1' }).tap();
  await p.waitForURL('**/m/t/IT-1');
  await p.goBack();
  await p.waitForURL(`**/m/kb/${ids.vpn}`);
  await ready(p);
  // Comment (users may comment, as in the desktop UI); users get no "edit" link
  assert.equal(await p.locator('.m-kb-edit').count(), 0);
  await p.fill('.m-kb-cm-compose .kb-editable', 'Bei mir half ein Neustart.');
  await p.locator('.m-kb-cm-compose .m-btn-primary').tap();
  await p.waitForSelector('.m-kb-cm:has-text("Bei mir half ein Neustart.")');
  const cms = (await who.karl('GET', `/api/kb/${ids.vpn}/comments`)).body.comments;
  assert.equal(cms.at(-1).body, 'Bei mir half ein Neustart.');
  // "Report a problem" from the article, title prefilled
  await p.locator('.m-kb-help a').tap();
  await p.waitForURL('**/m/new/report?title=*');
  await ready(p);
  assert.equal(await p.inputValue('input[name=title]'), 'VPN im Homeoffice einrichten');
  // Recently viewed on the start page
  await p.goto(`${S.base}/m/kb`);
  await ready(p);
  assert.match(await p.textContent('.m-kb-results'), /Zuletzt angesehen/);
  // Internal article: not found for users (API decides)
  await p.goto(`${S.base}/m/kb/${ids.internal}`);
  await ready(p);
  assert.match(await p.textContent('.m-empty-title'), /Nicht gefunden/);
  assert.deepEqual(errors.filter((e) => !/404/.test(e)), []);
  await close();
});

test('Knowledge base for agents: internal articles marked, "edit on desktop" link', { skip }, async () => {
  const { p, errors, close } = await open('anna');
  await p.goto(`${S.base}/m/kb/${ids.internal}`);
  await ready(p);
  assert.match(await p.textContent('.m-kb-vis'), /Intern/);
  assert.equal(await p.getAttribute('.m-kb-edit', 'href'), `/kb/${ids.internal}/edit?ui=desktop`);
  assert.equal(await p.locator('.m-kb-help').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

// ---------- Me: two-factor, profile ----------
test('"Me": set up two-factor sign-in on the phone, new recovery codes, switch it off', { skip }, async () => {
  const { totpAt, currentStep } = await import('../src/auth/totp.js');
  const { p, errors, close } = await open('lena');
  await p.goto(`${S.base}/m/me`);
  await ready(p);
  assert.match(await p.textContent('.m-row[href="/m/me/2fa"]'), /Nicht eingerichtet/);
  await p.tap('.m-row[href="/m/me/2fa"]');
  await p.waitForURL('**/m/me/2fa');
  await ready(p);
  await p.tap('.m-mfa-start');
  await p.waitForSelector('.m-secret');
  const secret = (await p.textContent('.m-secret')).replace(/\s+/g, '');
  const href = await p.getAttribute('a.m-otpauth', 'href');
  assert.match(href, /^otpauth:\/\/totp\/.*secret=/);
  assert.ok(href.includes(secret));
  assert.equal(await p.locator('.m-copy-btn').count(), 1);
  assert.equal(await p.locator('img.m-qr').count(), 1);
  assert.deepEqual(await p.evaluate(overflow), []);
  await p.fill('.m-mfa-setup input.m-code', totpAt(secret, currentStep()));
  await p.waitForSelector('.m-recovery-codes li');
  assert.equal(await p.locator('.m-recovery-codes li').count(), 10);
  assert.equal(await p.locator('.m-recovery-actions .m-btn').count(), 2);
  await p.tap('.m-recovery-done');
  await p.waitForSelector('.m-mfa-status .m-status-chip.on');
  assert.equal(S.db.prepare("SELECT totp_enabled FROM users WHERE username='lena'").get().totp_enabled, 1);
  // Back on "Me": status updated
  await p.tap('.m-back');
  await p.waitForURL('**/m/me');
  await p.waitForFunction(() => /Aktiv/.test(document.querySelector('.m-row[href="/m/me/2fa"]')?.textContent));
  // New recovery codes (confirmed with the next code: each code is accepted only once)
  await p.tap('.m-row[href="/m/me/2fa"]');
  const fresh = p.locator('.m-row', { hasText: 'Neue Wiederherstellungscodes' });
  await fresh.waitFor();
  await fresh.tap();
  await p.waitForSelector('.m-sheet-layer.open input.m-code');
  await p.fill('.m-sheet input.m-code', totpAt(secret, currentStep() + 1));
  await p.locator('.m-sheet-foot .m-btn-primary').tap();
  await p.waitForSelector('.m-recovery-codes li');
  assert.equal(await p.locator('.m-recovery-codes li').count(), 10);
  await p.tap('.m-recovery-done');
  await p.waitForSelector('.m-mfa-status');
  // Switch off with a code
  S.db.prepare("UPDATE users SET totp_last_step=0 WHERE username='lena'").run();
  const off = p.locator('.m-row.danger', { hasText: 'abschalten' });
  await off.waitFor();
  await off.tap();
  await p.waitForSelector('.m-sheet-layer.open input.m-code');
  await p.fill('.m-sheet input.m-code', totpAt(secret, currentStep()));
  await p.locator('.m-sheet-foot .m-btn-primary').tap();
  await p.waitForSelector('.m-mfa-start');
  assert.equal(S.db.prepare("SELECT totp_enabled FROM users WHERE username='lena'").get().totp_enabled, 0);
  assert.deepEqual(errors, []);
  await close();
});

test('"Me": name and password for local accounts, install instructions', { skip }, async () => {
  const { p, errors, close } = await open('otto');
  await p.goto(`${S.base}/m/me`);
  await ready(p);
  await p.locator('.m-row', { hasText: 'Name und E-Mail-Adresse' }).tap();
  await p.waitForSelector('.m-sheet-layer.open #m-personal');
  await p.fill('#m-personal input[autocomplete=name]', 'Otto Beispiel');
  await p.locator('.m-sheet-foot .m-btn-primary').tap();
  await p.waitForSelector('.m-sheet-layer', { state: 'detached' });
  await p.waitForFunction(() => document.querySelector('.m-profile-name')?.textContent === 'Otto Beispiel');
  await p.locator('.m-row', { hasText: 'Kennwort ändern' }).tap();
  await p.waitForSelector('.m-sheet-layer.open #m-password');
  const pw = p.locator('#m-password input[type=password]');
  await pw.nth(0).fill('Sehrgeheim123');
  await pw.nth(1).fill('NochGeheimer456');
  await pw.nth(2).fill('NochGeheimer456');
  await p.locator('.m-sheet-foot .m-btn-primary').tap();
  await p.waitForSelector('.toast-success');
  const login = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'otto', password: 'NochGeheimer456' }) });
  assert.equal(login.status, 200);
  // Install instructions for iPhone and Android
  await p.locator('.m-row', { hasText: 'App installieren' }).tap();
  await p.waitForSelector('.m-sheet-layer.open .m-install');
  assert.deepEqual(await p.$$eval('.m-install-os', (x) => x.map((s) => s.dataset.os).sort()), ['android', 'ios']);
  assert.match(await p.textContent('.m-install'), /Zum Home-Bildschirm/);
  assert.match(await p.textContent('.m-install'), /App installieren/);
  assert.deepEqual(await p.evaluate(overflow), []);
  assert.deepEqual(errors, []);
  await close();
});

// ---------- Editing title and description ----------
test('Edit title and description: reporter and agent via the sheet, other users get no edit', { skip }, async () => {
  const key = (await who.karl('POST', '/api/tickets', { title: 'Mous defekt', description: 'Linke Taste', type: 'incident' })).body.ticket.key;
  const { p, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/t/${key}`);
  await ready(p);
  await p.locator('.m-section-action').tap();
  await p.waitForSelector('.m-sheet-layer.open #m-edit-form');
  await p.fill('#m-edit-title', 'Maus defekt');
  await p.fill('#m-edit-desc', 'Linke Taste klemmt (PC-0001)');
  await p.locator('.m-sheet-foot .m-btn-primary').tap();
  await p.waitForFunction(() => document.querySelector('.m-ticket-h1')?.textContent === 'Maus defekt');
  let tk = await ticketApi(who.karl, key);
  assert.equal(tk.description, 'Linke Taste klemmt (PC-0001)');
  await close();
  const agent = await open('anna');
  await agent.p.goto(`${S.base}/m/t/${key}`);
  await ready(agent.p);
  await agent.p.tap('.m-more-btn');
  await agent.p.locator('.m-action[data-action=edit]').tap();
  await agent.p.waitForSelector('.m-sheet-layer.open #m-edit-form');
  await agent.p.fill('#m-edit-title', 'Maus am Empfang defekt');
  await agent.p.locator('.m-sheet-foot .m-btn-primary').tap();
  await agent.p.waitForFunction(() => /Empfang/.test(document.querySelector('.m-ticket-h1')?.textContent));
  tk = await ticketApi(who.anna, key);
  assert.equal(tk.title, 'Maus am Empfang defekt');
  await agent.close();
  // A participant (not the reporter) may not edit
  await who.anna('POST', `/api/tickets/${key}/participants`, { userId: S.ids.paul });
  const other = await open('paul');
  await other.p.goto(`${S.base}/m/t/${key}`);
  await ready(other.p);
  assert.equal(await other.p.locator('.m-section-action').count(), 0);
  await other.p.tap('.m-more-btn');
  assert.equal(await other.p.locator('.m-action[data-action=edit]').count(), 0);
  assert.deepEqual([...errors, ...agent.errors, ...other.errors], []);
  await other.close();
});

// ---------- Installable app ----------
test('Manifest: valid, starts in the mobile UI inside the service worker scope, icons reachable', async () => {
  const r = await fetch(`${S.base}/manifest.webmanifest`);
  assert.match(r.headers.get('content-type'), /application\/manifest\+json/);
  const m = await r.json();
  assert.equal(m.id, '/');
  assert.equal(m.start_url, '/m/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.match(m.theme_color, /^#[0-9A-F]{6}$/);
  assert.match(m.background_color, /^#[0-9A-F]{6}$/);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && !i.purpose));
  for (const i of m.icons) assert.equal((await fetch(S.base + i.src)).status, 200, i.src);
  // Coloured header in the brand settings: window bar in the brand colour
  S.ctx.settings.set('brand.color', '#123456');
  S.ctx.settings.set('brand.header', 'color');
  try {
    assert.equal((await (await fetch(`${S.base}/manifest.webmanifest`)).json()).theme_color, '#123456');
  } finally { S.ctx.settings.set('brand.header', 'light'); S.ctx.settings.set('brand.color', ''); }
  // Apple tags on the mobile entry page
  const html = await (await fetch(`${S.base}/m/`)).text();
  for (const re of [/apple-mobile-web-app-capable/, /apple-touch-icon/, /apple-mobile-web-app-title/, /rel="manifest"/]) assert.match(html, re);
});

test('Service worker script: generated shell list and version, no-cache, worker-src in the CSP', async () => {
  const r = await fetch(`${S.base}/m/sw.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/javascript/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.match(r.headers.get('content-security-policy') || (await fetch(`${S.base}/m/`)).headers.get('content-security-policy'), /worker-src 'self'/);
  const js = await r.text();
  const version = /const VERSION = "([^"]+)"/.exec(js)?.[1];
  assert.match(version, new RegExp(`^${config.version.replace(/\./g, '\\.')}-[0-9a-f]{12}$`));
  const shell = JSON.parse(/const SHELL = (\[[^\n]*\]);/.exec(js)[1]);
  for (const u of ['/m/index.html', '/m/offline.html', '/m/m.css', '/m/js/main.js', '/m/js/offline.js', '/m/js/views/kb.js', '/js/i18n.js', '/js/kbdoc.js', '/css/app.css', '/icons/sprite.svg']) assert.ok(shell.includes(u), u);
  // Only own static files – never data, sign-in or the desktop UI
  for (const u of shell) {
    assert.doesNotMatch(u, /^\/(api|auth)\//, u);
    assert.notEqual(u, '/js/app.js');
    assert.equal((await fetch(S.base + u)).status, 200, u);
  }
  assert.deepEqual(moduleGraph(config.publicDir, ['/m/js/main.js']).filter((u) => u.startsWith('/js/views/') && !['/js/views/sla.js', '/js/views/links.js'].includes(u)), [], 'the mobile UI loads no desktop views');
  // Version changes with the app version
  const before = config.version;
  config.version = '99.0.0';
  try { assert.match(await (await fetch(`${S.base}/m/sw.js`)).text(), /const VERSION = "99\.0\.0-/); } finally { config.version = before; }
});

test('Service worker: precaches the shell only, never /api; offline page; new version replaces the old cache', { skip }, async () => {
  const { p, c, errors, close } = await open('karl');
  await p.goto(`${S.base}/m/`);
  await ready(p);
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  // Use the app a bit: ticket, knowledge, attachments
  await p.goto(`${S.base}/m/t/IT-1`);
  await ready(p);
  await p.goto(`${S.base}/m/kb/${ids.vpn}`);
  await ready(p);
  const cached = await p.evaluate(async () => {
    const keys = await caches.keys();
    const urls = [];
    for (const k of keys) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
    return { keys, urls };
  });
  assert.equal(cached.keys.length, 1);
  assert.match(cached.keys[0], /^helfi-m-/);
  for (const u of ['/m/index.html', '/m/offline.html', '/m/js/main.js', '/js/api.js', '/m/m.css']) assert.ok(cached.urls.includes(u), u);
  assert.deepEqual(cached.urls.filter((u) => u.startsWith('/api/') || u.startsWith('/auth/') || u.startsWith('/m/t/') || u.startsWith('/m/kb')), [], 'no ticket or article data on the device');
  // Offline: navigation shows the offline page with a retry button
  await c.setOffline(true);
  await p.goto(`${S.base}/m/t/IT-1`).catch(() => {});
  await p.waitForSelector('.m-offline-retry');
  assert.equal(await p.textContent('.m-offline-title'), 'Keine Verbindung');
  assert.match(await p.textContent('.m-offline-text'), /Helfi\.Space ist gerade nicht erreichbar/);
  assert.deepEqual(await p.evaluate(() => [document.documentElement.scrollWidth <= innerWidth]), [true]);
  // "Try again" while still offline: the offline page again
  await p.tap('.m-offline-retry');
  await p.waitForSelector('.m-offline-retry:not([disabled])');
  // Connection back: the page reloads by itself (or with "Try again")
  await c.setOffline(false);
  try { await p.waitForSelector('.m-ticket-h1', { timeout: 5000 }); } catch {
    await p.tap('.m-offline-retry');
    await p.waitForSelector('.m-ticket-h1');
  }
  await ready(p);
  // New release: the worker changes, installs at once, deletes the old cache and offers a reload
  const oldKey = cached.keys[0];
  const before = config.version;
  config.version = '99.1.0';
  try {
    await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/m/'); await r.update(); });
    await p.waitForSelector('.m-update', { timeout: 15000 });
    assert.match(await p.textContent('.m-update'), /Neue Version/);
    await p.waitForFunction(async (old) => { const k = await caches.keys(); return k.length === 1 && k[0] !== old && k[0].startsWith('helfi-m-99.1.0-'); }, oldKey, { timeout: 15000 });
    await p.tap('.m-update-btn');
    await p.waitForSelector('.m-ticket-h1');
    assert.equal(await p.locator('.m-update').count(), 0);
  } finally { config.version = before; }
  assert.deepEqual(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)), []);
  await close();
});

test('Tablet or computer: the installed app\'s start address leads to the desktop UI', { skip }, async () => {
  const { p, errors, close } = await open('anna', { viewport: { width: 1280, height: 900 } });
  await p.goto(`${S.base}/m/`);
  await p.waitForURL((u) => ['/board', '/'].includes(u.pathname));
  assert.equal(await p.evaluate(async () => (await navigator.serviceWorker?.getRegistrations())?.length || 0), 0, 'no service worker for the desktop UI');
  assert.deepEqual(errors, []);
  await close();
});

// ---------- Layout ----------
for (const [w, hgt] of [[390, 844], [360, 740]]) {
  test(`New pages do not overflow sideways (${w} px)`, { skip }, async () => {
    const pages = {
      karl: ['/m/new', '/m/new/report', `/m/new/c/${ids.item}`, '/m/kb', '/m/kb?q=VPN', `/m/kb/${ids.folder}`, `/m/kb/${ids.vpn}`, '/m/me', '/m/me/2fa', '/m/offline.html'],
      anna: ['/m/new/report', `/m/kb/${ids.internal}`, `/m/kb/${ids.vpn}`],
    };
    for (const [u, urls] of Object.entries(pages)) {
      const { p, errors, close } = await open(u, { ...PHONE, viewport: { width: w, height: hgt } });
      for (const url of urls) {
        await p.goto(S.base + url);
        await ready(p);
        assert.deepEqual(await p.evaluate(overflow), [], `${u} ${url}`);
        const small = await p.evaluate(() => [...document.querySelectorAll('.m-iconbtn, .m-tab, .m-btn, .m-chip, .m-choice, .m-row, .m-tile, .m-toc-item')]
          .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.className));
        assert.deepEqual(small, [], `${u} ${url}: touch targets`);
      }
      assert.deepEqual(errors, [], u);
      await close();
    }
  });
}
