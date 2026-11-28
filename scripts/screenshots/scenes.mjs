// The pictures, grouped by scene. Each scene names its pictures (for --only) and takes them.
export const scenes = {};
/** Text of the program in the page's language */
const tr = (p, key) => p.evaluate((k) => import('/js/i18n.js').then((m) => m.t(k)), key);
/** The panel with this heading (i18n key) */
const panel = async (p, key) => p.locator('section.panel, div.panel, form.panel').filter({ has: p.locator('h2, h3', { hasText: await tr(p, key) }) }).last();
const scene = (name, shots, run) => { scenes[name] = { shots, run }; };

// ---------- Agents: overview, board, list, ticket ----------
scene('agent', ['summary', 'board', 'list', 'list-pager', 'bulk', 'ticket', 'readme-board', 'readme-ticket', 'create', 'templates', 'emoji', 'comment-toolbar', 'html-mail', 'reports', 'quick-search'], async (S) => {
  const { page, go, settle, shot, d, T } = S;
  const p = await page('a.berger');
  await go(p, '/summary'); await shot.full(p, 'summary');
  await go(p, '/board'); await shot.full(p, 'board');
  await go(p, '/issues'); await shot.full(p, 'list');
  // 50 per page: then the pages show below the list
  await p.locator('nav.pager select:visible').first().selectOption('50');
  await settle(p);
  await shot.el(p, 'list-pager', p.locator('nav.pager:visible').last(), { pad: 16 });
  await go(p, '/issues?type=incident&status=open,in_progress,waiting');
  const boxes = p.locator('table.issues tbody input[type=checkbox]');
  for (const i of [0, 1, 2]) await boxes.nth(i).check();
  await shot.clip(p, 'bulk', { x: 230, y: 50, width: 1040, height: 450 });
  await go(p, `/browse/${d.keys.printer}`); await shot.full(p, 'ticket');
  await p.click('.composer .kb-editable');
  await shot.el(p, 'comment-toolbar', '.composer');
  await p.click('.composer [data-shortcut="template"]');
  await shot.full(p, 'templates');
  await p.keyboard.press('Escape');
  await p.click(`.composer .kb-tb-btn[aria-label="${T('Emoji einfügen', 'Insert emoji')}"]`); await p.waitForSelector('.menu-emoji');
  await shot.full(p, 'emoji');
  await p.keyboard.press('Escape');
  await go(p, `/browse/${d.keys.mail}`, 1200); await shot.full(p, 'html-mail');
  await go(p, '/issues'); await p.keyboard.press('c'); await p.waitForTimeout(400); await shot.full(p, 'create');
  await p.keyboard.press('Escape');
  await go(p, '/reports', 1000); await shot.full(p, 'reports');
  await go(p, '/board');
  await p.click('input[type=search]');
  await p.keyboard.type(T('drucker', 'printer'), { delay: 30 }); await p.waitForSelector('.qs-pop .qs-line'); await p.waitForTimeout(300);
  await shot.el(p, 'quick-search', 'input[type=search]', { to: '.qs-pop', pad: 8 });

  // README: a little wider, without scaling
  const r = await page('a.berger', { width: 1440, height: 860, scale: 1 });
  await go(r, '/board'); await shot.full(r, 'readme-board');
  await go(r, `/browse/${d.keys.printer}`); await shot.full(r, 'readme-ticket');
});

// ---------- Users: portal, requests, catalog, profile, sign-in ----------
scene('user', ['requests', 'ticket-user', 'profile', 'login', 'portal-start', 'portal-dept', 'itil-catalog', 'itil-catalog-form', 'itil-kb-suggest', 'kb-rating', 'itil-rating', 'theme-switch', 'dark-mode', 'idle'], async (S) => {
  const { page, go, shot, d, T, step, B } = S;
  const p = await page('e.muster');
  await step('portal', async () => {
    await go(p, '/portal'); await shot.el(p, 'portal-start', 'main, .content', { pad: 0 });
    await go(p, '/portal/HT'); await shot.el(p, 'portal-dept', 'main, .content', { pad: 0, maxHeight: 640 });
  });
  await step('requests', async () => { await go(p, '/requests'); await shot.full(p, 'requests'); });
  await step('ticket-user', async () => { await go(p, `/browse/${d.keys.printer}`); await shot.full(p, 'ticket-user'); });
  await step('catalog', async () => {
    await go(p, '/catalog'); await shot.full(p, 'itil-catalog');
    await go(p, `/catalog/${d.catalog.onboarding.id}`); await shot.full(p, 'itil-catalog-form');
  });
  await step('kb-suggest', async () => {
    await go(p, '/requests'); await p.keyboard.press('c'); await p.waitForTimeout(400);
    await p.locator('.modal input').first().fill(T('Drucker Papierstau', 'Printer paper jam')); await p.waitForTimeout(1000);
    await shot.full(p, 'itil-kb-suggest');
    await p.keyboard.press('Escape');
  });
  await step('kb-rating', async () => {
    const p = await page('c.chefin');
    await go(p, `/kb/${d.kb.pw.id}`);
    await p.click('.kb-rate-btn >> nth=1'); await p.waitForSelector('.kb-rate-note textarea');
    await p.fill('.kb-rate-note textarea', T('Wo finde ich das am Mac?', 'Where do I find this on a Mac?'));
    await shot.el(p, 'kb-rating', '.kb-rate-row', { to: '.kb-rate-note', pad: 16 });
  });
  await step('profile', async () => { await go(p, '/profile'); await shot.full(p, 'profile'); });
  await step('theme', async () => {
    await go(p, '/portal');
    const sb = await p.locator('.sidebar').boundingBox();
    const ts = await p.locator('.sidebar .theme-switch').boundingBox();
    await shot.clip(p, 'theme-switch', { x: sb.x, y: ts.y - 12, width: sb.width, height: ts.height + 24 });
    const dk = await page('e.muster', { theme: 'dark' });
    await go(dk, '/portal'); await shot.full(dk, 'dark-mode');
  });
  await step('idle', async () => {
    const ip = await page('e.muster');
    await ip.route('**/api/session/status', (r) => r.fulfill({ json: { idleMs: 1800000, remainingMs: 105000, warnMs: 120000 } }));
    await go(ip, '/requests');
    await ip.evaluate(() => window.dispatchEvent(new CustomEvent('helfi:session', { detail: { idleMs: 1800000, remainingMs: 105000, warnMs: 120000 } })));
    await ip.waitForSelector('.idle-box', { timeout: 5000 });
    await shot.el(ip, 'idle', '.idle-box', { pad: 16 });
  });
  await step('rating', async () => {
    const a = await page(null, { width: 900, height: 820 });
    await go(a, `/rate/${d.rateToken}?r=4`); await shot.el(a, 'itil-rating', '.auth-card, .rate-card, main', { pad: 24, padBottom: 12 });
  });
  await step('login', async () => {
    const a = await page(null, { ip: '203.0.113.50' });
    await go(a, '/login'); await shot.el(a, 'login', '.auth-card', { pad: 40 });
  });
  void B;
});

// ---------- ITIL ----------
scene('itil', ['itil-major', 'itil-links', 'itil-sla-list', 'itil-problem', 'itil-change', 'itil-change-calendar', 'itil-kb', 'itil-catalog-approval', 'itil-cis', 'itil-ci', 'itil-reports', 'itil-reports-survey'], async (S) => {
  const { page, go, shot, d, step } = S;
  const anna = await page('a.berger'); const lena = await page('l.wagner'); const clara = await page('c.chefin');
  await step('major', async () => {
    await d.set(d.anna, d.keys.major, { major: true });
    await go(anna, `/browse/${d.keys.major}`); await shot.full(anna, 'itil-major');
    await shot.el(anna, 'itil-links', '.links-section');
    await d.set(d.anna, d.keys.major, { major: false });
  });
  await step('sla', async () => { await go(anna, '/issues?sla=risk'); await shot.full(anna, 'itil-sla-list'); });
  await step('problem', async () => { await go(lena, `/browse/${d.keys.problem}`); await shot.full(lena, 'itil-problem'); });
  await step('change', async () => {
    await go(lena, `/browse/${d.keys.change}`); await shot.full(lena, 'itil-change');
    await go(lena, '/changes'); await shot.full(lena, 'itil-change-calendar');
  });
  await step('kb', async () => { await go(anna, '/kb'); await shot.el(anna, 'itil-kb', 'main, .content', { pad: 0, maxHeight: 700 }); });
  await step('approval', async () => { await go(clara, `/browse/${d.keys.order}`); await shot.full(clara, 'itil-catalog-approval'); });
  await step('cis', async () => {
    await go(anna, '/cis'); await shot.full(anna, 'itil-cis');
    await go(anna, `/cis/${d.ci['PC-0002']}`); await shot.full(anna, 'itil-ci');
  });
  await step('reports', async () => {
    const r = await page('a.berger', { height: 800 });
    await go(r, '/reports', 1000);
    await r.evaluate(() => document.querySelector('.itil-report')?.scrollIntoView()); await shot.full(r, 'itil-reports');
    await r.evaluate(() => document.querySelector('.survey-panel')?.scrollIntoView()); await shot.full(r, 'itil-reports-survey');
  });
});

// ---------- Agents: closing, linking, mentions, filters, templates ----------
scene('actions', ['done-comment', 'reject', 'reporter-create', 'bulk-link', 'resolutions-list', 'link-suggest', 'ticket-activity-order', 'mention-compose', 'mention-list', 'mention-comment', 'saved-filters', 'saved-filters-save', 'saved-filters-manage', 'templates-lead', 'catalog-manage-lead'], async (S) => {
  const { page, go, shot, d, T, step } = S;
  const p = await page('a.berger');
  const statusMenu = async (label) => { await p.click('.status-btn'); await p.click(`.menu >> text=${label}`); await p.waitForSelector('.modal'); await p.waitForTimeout(300); };
  await step('done', async () => {
    await go(p, `/browse/${d.keys.printer}`);
    await statusMenu(T('Erledigt', 'Done'));
    await p.locator('.modal textarea').first().fill(T('Hallo {melder},\n\nder Drucker druckt wieder – der Sensor war verschmutzt. Bitte einmal testen und kurz Bescheid geben, falls noch etwas hakt.', 'Hello {reporter},\n\nthe printer works again – the sensor was dirty. Please give it a try and let us know if anything is still wrong.'));
    await shot.el(p, 'done-comment', '.modal', { pad: 0 });
    await p.keyboard.press('Escape');
  });
  await step('reject', async () => {
    await go(p, `/browse/${d.keys.toReject}`);
    await statusMenu(T('Ablehnen …', 'Reject …'));
    await p.locator('.modal textarea').first().fill(T('Hallo {melder},\n\neinen Kaffeevollautomaten können wir leider nicht über die IT anschaffen – bitte wende dich dafür an die Verwaltung.', 'Hello {reporter},\n\nunfortunately IT cannot purchase a coffee machine – please contact the administration for this.'));
    await shot.el(p, 'reject', '.modal', { pad: 0 });
    await p.keyboard.press('Escape');
  });
  await step('reporter', async () => {
    await go(p, '/issues'); await p.keyboard.press('c'); await p.waitForSelector('.modal');
    await p.click('.modal >> text=' + T('Für jemand anderen erfassen', 'Enter for someone else'));
    await p.keyboard.type('Erika'); await p.waitForTimeout(600); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    await p.locator('.modal input[type=text], .modal input:not([type])').filter({ hasNot: p.locator('[readonly]') }).nth(0).fill(T('Drucker im 2. OG druckt nicht', 'Printer on 2nd floor not printing')).catch(() => {});
    await shot.el(p, 'reporter-create', '.modal', { pad: 0 });
    await p.keyboard.press('Escape');
  });
  const lena = await page('l.wagner');
  await step('bulk-link', async () => {
    const p = lena;
    await go(p, '/issues?type=incident&q=VPN');
    const boxes = p.locator('table.issues tbody input[type=checkbox]');
    for (const i of [0, 1, 2]) await boxes.nth(i).check();
    await p.click('.bulk-bar >> text=' + T('Verknüpfen', 'Link'));
    await p.waitForSelector('.modal'); await p.locator('.modal select').first().selectOption('caused_by').catch(() => {});
    await p.locator('.modal input').first().click(); await p.waitForTimeout(800);
    await shot.el(p, 'bulk-link', '.modal', { pad: 0 });
    await p.keyboard.press('Escape');
  });
  await step('resolutions', async () => {
    await go(p, '/issues?status=done');
    await shot.el(p, 'resolutions-list', 'main h1', { to: 'table.issues tbody tr:nth-child(4)', pad: 16 });
  });
  await step('link-suggest', async () => {
    const p = lena;
    await go(p, `/browse/${d.keys.vpn2}`);
    await p.locator('.links-section button', { hasText: T('Verknüpfen', 'Link') }).first().click();
    await p.locator('.links-section input.link-target').click(); await p.waitForSelector('.tp-pop:not([hidden])'); await p.waitForTimeout(400);
    await shot.el(p, 'link-suggest', '.links-section', { to: '.tp-pop', pad: 12 });
  });
  await step('activity-order', async () => {
    await d.anna('PATCH', '/api/me', { activityOrder: 'oldest' }).catch(() => {});
    const q = await page('a.berger');
    await go(q, `/browse/${d.keys.printer}`);
    await shot.el(q, 'ticket-activity-order', q.locator('section.ticket-section h3', { hasText: T('Aktivität', 'Activity') }), { to: q.locator('.comment').nth(1), padBottom: 16 });
    await d.anna('PATCH', '/api/me', { activityOrder: 'newest' }).catch(() => {});
  });
  await step('mention', async () => {
    const t = await page('t.schulz');
    await go(t, `/browse/${d.keys.printer}`);
    await t.click('.composer button.mode >> nth=1');
    await t.click('.composer .kb-editable');
    await t.keyboard.type(T('Kannst du das Ersatzteil am Donnerstag einbauen? @be', 'Could you fit the spare part on Thursday? @be'));
    await t.waitForSelector('.mention-pop .mention-item'); await t.waitForTimeout(300);
    await shot.el(t, 'mention-compose', '.composer', { to: '.mention-pop' });
    await t.keyboard.press('Enter');
    await t.click('.composer .btn-primary'); await t.waitForTimeout(800);
    await go(p, '/issues?mentioned=me');
    await shot.clip(p, 'mention-list', { x: 0, y: 56, width: 1000, height: 700 });
    await go(p, `/browse/${d.keys.printer}`);
    await shot.el(p, 'mention-comment', '.comment.mentions-me');
  });
  await step('filters', async () => {
    await go(p, '/issues?status=unresolved&priority=highest,high');
    await shot.clip(p, 'saved-filters', { x: 0, y: 0, width: 1280, height: 640 });
    await p.click('.save-filter-btn'); await p.waitForSelector('#save-filter-form');
    await p.fill('#save-filter-form input', T('Dringend offen', 'Urgent open'));
    await shot.el(p, 'saved-filters-save', '.modal', { pad: 0 });
    await p.click('.modal .btn-primary'); await p.waitForTimeout(500);
    await p.click('.saved-head .btn-icon'); await p.waitForSelector('.manage-filters');
    await shot.el(p, 'saved-filters-manage', '.modal', { pad: 0 });
    await p.keyboard.press('Escape');
  });
  await step('templates-lead', async () => {
    await go(p, '/profile');
    await shot.el(p, 'templates-lead', '[data-project-templates]');
  });
  await step('catalog-lead', async () => {
    const b = await page('b.bauer');
    await go(b, '/catalog/manage');
    await b.click('.catalog-manage .section-head .btn-primary'); await b.waitForSelector('.catalog-manage section.panel h2');
    const f = b.locator('.catalog-manage section.panel');
    await f.locator('input').nth(0).fill(T('Wasserspender auffüllen', 'Refill the water dispenser'));
    await f.locator('input').nth(1).fill('💧');
    await f.locator('textarea').first().fill(T('Neue Flasche für den Wasserspender im Flur', 'New bottle for the water dispenser in the hallway'));
    await shot.el(b, 'catalog-manage-lead', f, { pad: 0, maxHeight: 760 });
  });
});

// ---------- Administration ----------
scene('admin', ['admin-overview', 'admin-projects', 'admin-project-agents', 'admin-project-portal', 'admin-user-start', 'admin-survey', 'mail-reminder', 'admin-users', 'admin-users-sees', 'admin-ldap', 'admin-security-full', 'admin-passkeys', 'readme-2fa', 'admin-mail-1', 'admin-mail-3', 'admin-brand', 'admin-login', 'admin-system', 'admin-emergency', 'admin-diagnostics', 'admin-coffee', 'admin-sla', 'admin-change', 'admin-catalog'], async (S) => {
  const { page, go, shot, step, db } = S;
  const a = await page('admin');
  // Shown as accounts from the Active Directory (only here: AD accounts cannot sign in with the local password)
  const AD = "('a.berger','l.wagner','b.bauer','c.chefin','j.klein')";
  db.prepare(`UPDATE users SET source='ldap' WHERE username IN ${AD}`).run();
  const tall = await page('admin', { height: 1800 });
  await step('overview', async () => { await go(a, '/admin/tickets'); await shot.el(a, 'admin-overview', 'main, .content', { pad: 0, maxHeight: 720 }); });
  await step('projects', async () => {
    await go(a, '/admin/projects'); await shot.el(a, 'admin-projects', await panel(a, 'admin.projects'), { pad: 0 });
    await a.click('[data-edit-project="IT"]'); await a.waitForSelector('.modal');
    await shot.el(a, 'admin-project-agents', '.modal', { pad: 0 });
    await a.keyboard.press('Escape');
    const t = await page('admin', { height: 1600 });
    await go(t, '/admin/projects');
    await t.click('[data-edit-project="HT"]'); await t.waitForSelector('.modal');
    const head = t.locator('.modal h3', { hasText: await tr(t, 'portal.inPortal') });
    await shot.el(t, 'admin-project-portal', head, { to: t.locator('.modal [data-portal-sort], .modal input[type=number]').last(), padBottom: 40 });
  });
  await step('tickets', async () => {
    await go(tall, '/admin/tickets');
    await shot.el(tall, 'admin-user-start', await panel(tall, 'portal.startTitle'), { pad: 0 });
    await shot.el(tall, 'admin-survey', await panel(tall, 'survey.adminTitle'), { pad: 0 });
    await shot.el(tall, 'mail-reminder', await panel(tall, 'reminder.title'), { pad: 0 });
  });
  await step('users', async () => {
    await go(a, '/admin/users'); await shot.full(a, 'admin-users');
    await shot.el(a, 'admin-users-sees', 'table.data, table', { pad: 0, maxHeight: 520 });
  });
  await step('ldap', async () => { await go(a, '/admin/ldap'); await shot.full(a, 'admin-ldap'); });
  await step('mfa', async () => {
    await go(tall, '/admin/mfa');
    await shot.el(tall, 'admin-security-full', await panel(tall, 'mfa.title'), { pad: 0 });
    await shot.el(tall, 'admin-passkeys', '[data-passkey-admin]', { pad: 0 });
    const r = await page('admin', { width: 1440, height: 900, scale: 1 });
    await go(r, '/admin/mfa'); await shot.full(r, 'readme-2fa');
  });
  await step('mail', async () => {
    await go(tall, '/admin/mail-in');
    await shot.el(tall, 'admin-mail-1', tall.locator('section.panel').first(), { pad: 0 });
    await shot.el(tall, 'admin-mail-3', await panel(tall, 'mail.rules.title'), { pad: 0, to: await panel(tall, 'mail.supp.title') });
  });
  await step('appearance', async () => {
    await go(tall, '/admin/appearance');
    await shot.el(tall, 'admin-brand', await panel(tall, 'brand.title'), { pad: 0 });
    await shot.el(tall, 'admin-login', await panel(tall, 'loginPage.title'), { pad: 0 });
  });
  await step('system', async () => {
    await go(a, '/admin/system'); await shot.full(a, 'admin-system');
    await go(tall, '/admin/system');
    await shot.el(tall, 'admin-emergency', await panel(tall, 'system.emergency'), { pad: 0 });
    await shot.el(tall, 'admin-coffee', '.coffee-box, [data-coffee]', { pad: 0 });
    const dp = await panel(tall, 'diag.title');
    await dp.locator('button', { hasText: await tr(tall, 'diag.preview') }).click().catch(() => {});
    await tall.waitForTimeout(800);
    await shot.el(tall, 'admin-diagnostics', dp, { pad: 0, maxHeight: 990 });
  });
  await step('itil-admin', async () => {
    await go(tall, '/admin/sla'); await shot.el(tall, 'admin-sla', tall.locator('section.panel').first(), { pad: 0 });
    await go(tall, '/admin/change'); await shot.el(tall, 'admin-change', tall.locator('section.panel').first(), { pad: 0 });
    await go(tall, '/admin/catalog'); await shot.el(tall, 'admin-catalog', tall.locator('section.panel').first(), { pad: 0, maxHeight: 700 });
  });
  db.prepare(`UPDATE users SET source='local' WHERE username IN ${AD}`).run();
});

// ---------- Knowledge base ----------
scene('kb', ['kb-tree', 'kb-history', 'kb-compare', 'kb-picker', 'kb-project-editor', 'kb-editor', 'kb-files', 'kb-feedback', 'examples-kb', 'examples-catalog'], async (S) => {
  const { page, go, shot, step, d, T } = S;
  const p = await page('a.berger');
  await step('tree', async () => { await go(p, `/kb/${d.kb.acc.id}`); await shot.full(p, 'kb-tree'); });
  await step('history', async () => {
    await go(p, `/kb/${d.kb.acc.id}/history`); await shot.el(p, 'kb-history', 'main, .content', { pad: 0, maxHeight: 300 });
    await go(p, `/kb/${d.kb.acc.id}/compare?a=1&b=2`); await shot.el(p, 'kb-compare', 'main, .content', { pad: 0, maxHeight: 760 });
  });
  await step('picker', async () => { await go(p, '/kb/new'); await shot.el(p, 'kb-picker', 'main, .content', { pad: 0, maxHeight: 400 }); });
  await step('project-editor', async () => {
    const b = await page('admin');
    await go(b, '/kb/new?template=blank');
    await b.locator('main input').first().fill(T('Wasserschaden – was tun?', 'Water damage – what to do?'));
    await b.locator('main select').nth(1).selectOption({ label: T('Haustechnik', 'Facilities') }).catch(() => {});
    await b.click('main .kb-editable');
    await b.keyboard.type(T('Hauptwasserhahn im Keller schließen, dann die Haustechnik anrufen.', 'Close the main water tap in the basement, then call facilities.'));
    await shot.el(b, 'kb-project-editor', 'main, .content', { pad: 0, maxHeight: 420 });
  });
  await step('editor', async () => {
    await go(p, `/kb/${d.kb.printer.id}/edit`);
    await shot.el(p, 'kb-editor', 'main, .content', { pad: 0, maxHeight: 760 });
  });
  await step('files', async () => {
    // Attachments in the editor: a manual and a list, saved with the article
    await go(p, `/kb/${d.kb.printer.id}/edit`);
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n'.padEnd(184320, ' '));
    await p.setInputFiles('[data-kb-file-input]', [
      { name: T('Druckerhandbuch-Fach2.pdf', 'Printer-manual-tray2.pdf'), mimeType: 'application/pdf', buffer: pdf },
      { name: T('Druckerstandorte.xlsx', 'Printer-locations.xlsx'), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.alloc(24576, 1) },
    ]);
    await p.waitForSelector('[data-kb-files-edit] li.kb-file >> nth=1');
    await p.locator('[data-kb-files-edit]').scrollIntoViewIfNeeded();
    await shot.el(p, 'kb-files', '[data-kb-files-edit]', { pad: 12 });
    await p.click('.kb-edit-head .btn-primary');
    await p.waitForSelector('.kb-page h1');
  });
  await step('feedback', async () => {
    await go(p, `/kb/${d.kb.pw.id}`);
    await p.locator('.kb-rate-row button', { hasText: T('Rückmeldungen', 'Feedback') }).first().click().catch(async () => { await p.locator('.kb-rate-row a, .kb-rate-row .btn').last().click(); });
    await p.waitForSelector('.modal'); await shot.el(p, 'kb-feedback', '.modal', { pad: 0 });
    await p.keyboard.press('Escape');
  });
  await step('examples', async () => {
    await d.anna('POST', '/api/examples/kb', { keys: ['vpn'], lang: S.lang });
    const list = (await d.anna('GET', '/api/kb')).articles || (await d.anna('GET', '/api/kb')).items || [];
    const ex = list.find((x) => /VPN.*(Homeoffice|home)/i.test(x.title) && x.id !== d.kb.vpn.id);
    if (ex) { await go(p, `/kb/${ex.id}`); await shot.full(p, 'examples-kb'); }
    const a = await page('admin', { height: 1100 });
    await go(a, '/admin/catalog');
    await a.locator('section.panel button', { hasText: T('Beispiele', 'Examples') }).first().click(); await a.waitForSelector('.modal');
    await shot.el(a, 'examples-catalog', '.modal', { pad: 0 });
  });
});

// ---------- Components ----------
scene('components', ['admin-components', 'admin-components-examples', 'admin-components-test', 'ticket-component', 'report-components'], async (S) => {
  const { page, go, shot, step, d, T } = S;
  const a = await page('admin', { height: 1300 });
  await step('admin', async () => {
    await go(a, '/admin/components?project=IT');
    await shot.el(a, 'admin-components', a.locator('section.panel').first(), { pad: 0 });
    await a.fill('.comp-test input:not([type=email])', T('Outlook startet nicht', 'Outlook does not start'));
    await a.fill('.comp-test textarea', T('Seit dem Update öffnet sich mein Postfach nicht mehr', 'Since the update my mailbox no longer opens'));
    await a.click('.comp-test button[type=submit]'); await a.waitForSelector('.comp-test-result strong');
    await shot.el(a, 'admin-components-test', '.comp-test', { pad: 12 });
    await a.locator('button', { hasText: T('Beispiele übernehmen', 'Take over examples') }).first().click(); await a.waitForSelector('.modal .comp-examples');
    await shot.el(a, 'admin-components-examples', '.modal', { pad: 0 });
    await a.keyboard.press('Escape');
  });
  await step('ticket', async () => {
    const tk = await d.mk(d.max, { title: T('Outlook zeigt keine neuen Mails', 'Outlook shows no new mails'), description: T('Seit dem Mittag kommen keine Mails mehr im Postfach an.', 'Since noon no mails arrive in the mailbox.'), projectId: d.it.id });
    const p = await page('a.berger', { height: 900 });
    await go(p, `/browse/${tk.key}`);
    await p.locator('.activity-bar button, .tabs .tab').filter({ hasText: T('Alle', 'All') }).first().click(); await S.settle(p);
    await shot.full(p, 'ticket-component');
  });
  await step('report', async () => {
    const p = await page('a.berger', { height: 1600 });
    await go(p, '/reports', 1000);
    const sec = p.locator('section.panel').filter({ has: p.locator('h2', { hasText: T('Nach Komponente', 'By component') }) });
    await shot.el(p, 'report-components', sec, { pad: 0 });
  });
});

// ---------- AI (with a stand-in model server) ----------
scene('ai', ['ai', 'ai-suggestion', 'ai-duplicate', 'kb-ai', 'ai-functions', 'ai-models', 'backfill', 'backfill-review'], async (S) => {
  const { page, go, shot, step, d, T, ctx, db } = S;
  const { startFakeAi } = await import('./fake-ai.mjs');
  const fake = await startFakeAi(S.lang);
  try {
    ctx.settings.setMany({ 'ai.enabled': true, 'ai.baseUrl': fake.url, 'ai.model': 'qwen3:14b', 'ai.reasoning': 'off', 'ai.summary': true, 'ai.reply': true, 'ai.rewrite': true, 'ai.kb': true, 'ai.classify': true, 'ai.duplicates': true });
    const idle = async () => { await new Promise((r) => setTimeout(r, 100)); await ctx.aiClassifier.idle(); await ctx.aiDuplicates.idle(); };
    // Some decided suggestions, so that the hit rate shows
    for (let i = 0; i < 6; i++) {
      const tk = await d.mk(d.jonas, { title: T(`Kein Zugang von zuhause (${i + 1})`, `No access from home (${i + 1})`), projectId: d.net.id });
      await idle();
      await d.lena('POST', `/api/tickets/${tk.key}/component-suggestion/${i < 5 ? 'accept' : 'dismiss'}`).catch(() => {});
    }
    const p = await page('a.berger', { height: 1000 });
    await step('summary-reply', async () => {
      await go(p, `/browse/${d.keys.printer}`);
      await p.click('.ai-summary .btn'); await p.waitForSelector('.ai-summary-body'); await S.settle(p);
      await p.click('.composer .kb-editable'); await p.keyboard.type(T('ersatzteil donnerstag, bis dahin fach 1', 'spare part thursday, until then tray 1'));
      await p.click('.composer .ai-btn'); await p.click(`.menu >> text=${await p.evaluate(() => import('/js/i18n.js').then((m) => m.t('ai.replyFromNotes')))}`);
      await p.waitForSelector('.composer .ai-note'); await S.settle(p);
      await shot.el(p, 'ai', '.ai-summary', { to: '.composer .ai-note', maxHeight: 1200 });
    });
    await step('suggestion', async () => {
      const tk = await d.mk(d.jonas, { title: T('Komme von zu Hause nicht an die Firmendaten', 'Cannot reach company files from home'), description: T('Seit heute Morgen bricht die Verbindung direkt nach dem Einloggen ab.', 'Since this morning the connection drops right after I log on.'), projectId: d.net.id });
      await idle();
      const l = await page('l.wagner', { height: 1000 });
      await go(l, `/browse/${tk.key}`); await l.waitForSelector('.ai-suggest');
      await shot.el(l, 'ai-suggestion', '.ticket-side', { pad: 8 });
    });
    await step('duplicate', async () => {
      const tk = await d.mk(d.max, { title: T('Drucker PR-0001 meldet Papierstau', 'Printer PR-0001 reports a paper jam'), description: T('Der Drucker im 2. OG zeigt Papierstau, es klemmt aber nichts.', 'The printer on the 2nd floor shows a paper jam, but nothing is stuck.'), projectId: d.it.id });
      await idle();
      await go(p, `/browse/${tk.key}`); await p.waitForSelector('.ai-duplicate');
      await shot.el(p, 'ai-duplicate', 'main h1', { to: '.ai-duplicate', pad: 6 });
    });
    await step('kb-ai', async () => {
      await go(p, '/kb/new?template=blank');
      await p.locator('main input').first().fill(T('VPN im Homeoffice', 'VPN when working from home'));
      await p.click('main .kb-editable'); await p.keyboard.type(T('client aus softwarecenter installieren, server vpn.firma.local, mit windows-konto anmelden', 'install client from software center, server vpn.firma.local, sign in with windows account'));
      await p.click('main .ai-btn'); await p.waitForSelector('.menu');
      await shot.el(p, 'kb-ai', 'main h1, main .kb-title, main input', { to: '.menu', pad: 12 });
      await p.keyboard.press('Escape');
    });
    await step('admin-ai', async () => {
      const a = await page('admin', { height: 2200 });
      await go(a, '/admin/ai');
      const fnHead = a.locator('h3', { hasText: T('Funktionen', 'Functions') });
      await shot.el(a, 'ai-functions', fnHead, { to: a.locator('.ai-stats').last(), pad: 16 });
      await a.waitForSelector('.ai-model-row select:not([hidden])');
      await a.evaluate(() => { const sel = document.querySelector('.ai-model-row select'); sel.size = sel.options.length + 1; sel.style.height = 'auto'; sel.style.width = 'auto'; sel.style.maxWidth = 'none'; sel.style.backgroundImage = 'none'; });
      const url = a.locator('input[placeholder="http://ollama:11434/v1"]');
      await url.evaluate((i, v) => { i.value = v; }, 'http://ollama:11434/v1');
      await url.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      const box = await a.evaluate(() => {
        const u = document.querySelector('input[placeholder="http://ollama:11434/v1"]').getBoundingClientRect();
        const m = document.querySelector('.ai-model-picker').getBoundingClientRect();
        const x = Math.min(u.left, m.left) - 16; const y = u.top - 40;
        return { x, y, width: Math.max(u.right, m.right) - x + 16, height: m.bottom - y + 70 };
      });
      await shot.clip(a, 'ai-models', box);
    });
    await step('backfill', async () => {
      // Tickets without a component: the rules place some, the AI suggests the rest
      for (const title of T(['Gerät wird beim Arbeiten sehr heiß', 'Ausdrucke kommen verschmiert heraus', 'Termine verschwinden aus der Übersicht', 'Neue Kollegin kann sich nicht einloggen', 'Toner fast leer', 'Outlook hängt beim Start', 'Kaffeemaschine leckt'],
        ['Device gets very hot while working', 'Copies come out smudged', 'Appointments disappear from the overview', 'New colleague cannot log on', 'Toner almost empty', 'Outlook hangs on start', 'Coffee machine leaks'])) {
        const tk = await d.mk(d.max, { title, projectId: d.it.id });
        db.prepare('UPDATE tickets SET component_id=NULL WHERE id=?').run(d.keyRow(tk.key).id);
      }
      db.prepare("DELETE FROM component_suggestions WHERE ticket_id IN (SELECT id FROM tickets WHERE component_id IS NULL)").run();
      const a = await page('admin', { height: 1400 });
      await go(a, '/admin/components?project=IT');
      await a.locator('.backfill button', { hasText: T('Vorschau', 'Preview') }).click(); await a.waitForTimeout(500);
      await a.locator('.backfill .btn-primary').click(); await a.waitForSelector('.modal');
      await a.locator('.modal .btn-primary').click();
      await a.waitForSelector('.backfill-review:not([hidden])', { timeout: 30000 }); await S.settle(a);
      await a.evaluate(() => { const r = document.querySelector('.backfill-result'); if (r) r.replaceChildren(); });
      await shot.el(a, 'backfill', '.backfill', { pad: 0 });
      await a.locator('.backfill-review').click(); await S.settle(a, 600);
      await a.locator('tbody input[type=checkbox]').first().check(); await a.locator('tbody input[type=checkbox]').nth(1).check();
      await shot.el(a, 'backfill-review', 'main section.panel, main .panel', { pad: 0, maxHeight: 860 });
    });
  } finally {
    ctx.settings.setMany({ 'ai.enabled': false });
    fake.close();
  }
});

// ---------- Import ----------
scene('import', ['import-source', 'import-csv', 'import-kb'], async (S) => {
  const { page, go, shot, step } = S;
  const a = await page('admin', { height: 1500 });
  await step('source', async () => {
    await go(a, '/admin/import');
    await a.click('.import-source:nth-child(1)');
    await a.fill('input[placeholder="https://zammad.firma.local"]', 'https://zammad.firma.local');
    await a.fill('input[type=password]', 'demo-zugriffstoken');
    await shot.el(a, 'import-source', a.locator('section.panel:has(.import-sources)'), { pad: 0, maxHeight: 820 });
  });
  await step('csv', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-shots-')), S.T('altsystem-export.csv', 'legacy-export.csv'));
    fs.writeFileSync(file, S.T('Ticket-ID;Betreff;Beschreibung;Status;Priorität;E-Mail;Name\n1001;Monitor flackert;Seit gestern;Offen;Hoch;e.muster@firma.local;Erika Muster\n1002;Zugang Wiki;Bitte freischalten;Geschlossen;Niedrig;m.mustermann@firma.local;Max Mustermann\n1003;Drucker offline;;Offen;Mittel;j.klein@firma.local;Jonas Klein\n',
      'Ticket ID;Subject;Description;Status;Priority;Email;Name\n1001;Monitor flickers;Since yesterday;Open;High;e.muster@firma.local;Erika Muster\n1002;Wiki access;Please unlock;Closed;Low;m.mustermann@firma.local;Max Mustermann\n1003;Printer offline;;Open;Medium;j.klein@firma.local;Jonas Klein\n'));
    await go(a, '/admin/import');
    await a.click('.import-source:nth-child(7)'); await a.setInputFiles('input[type=file]', file); await a.waitForSelector('select.select-sm'); await S.settle(a);
    const head = a.locator('section.panel:has(.import-sources) strong, section.panel:has(.import-sources) .import-csv-info').first();
    await shot.el(a, 'import-csv', head, { to: a.locator('section.panel:has(.import-sources) table').last(), pad: 16, maxHeight: 900 });
  });
  await step('kb', async () => {
    // Knowledge import: a mock Confluence on this machine (allowed for the screenshot only)
    const { startMockConfluence } = await import('../../test/fixtures/mock-knowledge.js');
    const cf = await startMockConfluence({ cloud: false, spaces: [
      { key: 'IT', name: S.T('IT-Anleitungen', 'IT how-tos'), count: 86 }, { key: 'HT', name: S.T('Haustechnik', 'Facilities'), count: 23 }, { key: 'ONB', name: S.T('Onboarding', 'Onboarding'), count: 14 },
    ] });
    const before = process.env.HELFI_IMPORT_ALLOW_LOCAL;
    process.env.HELFI_IMPORT_ALLOW_LOCAL = '1';
    try {
      await go(a, '/admin/import');
      await a.click('[data-imp-what="kb"]');
      await a.locator('.import-source', { hasText: 'Confluence' }).click();
      await a.selectOption('section.panel select', 'server');
      await a.fill('input[placeholder="https://wiki.firma.local"]', cf.base);
      await a.fill('input[type=password]', 'dc-token');
      await a.click('.form-actions .btn-primary');
      await a.waitForSelector('[data-imp-space="IT"]');
      await a.check('[data-imp-space="IT"] input[type=checkbox]');
      await a.check('[data-imp-space="HT"] input[type=checkbox]');
      await a.selectOption('[data-imp-space="HT"] select', { label: S.T('Haustechnik', 'Facilities') }).catch(() => {});
      await S.settle(a);
      // shown with the connection hidden: the address of the mock is not meant for the manual
      await a.evaluate(() => { const p = document.querySelector('section.panel:has([data-imp-space]) > p'); if (p) p.textContent = p.textContent.replace(/https?:\/\/[^\s.]+[^\s]*/g, 'https://wiki.firma.local'); });
      await shot.el(a, 'import-kb', a.locator('section.panel:has([data-imp-space])'), { pad: 0, maxHeight: 900 });
    } finally {
      if (before === undefined) delete process.env.HELFI_IMPORT_ALLOW_LOCAL; else process.env.HELFI_IMPORT_ALLOW_LOCAL = before;
      cf.close();
    }
  });
});

// ---------- Mail with pictures ----------
scene('mail', ['mail-images'], async (S) => {
  const { page, shot, step, d, T, browser, ctx, db, lang } = S;
  await step('mail-images', async () => {
    const fs = await import('node:fs');
    const { commentMail } = await import('../../src/mail/smtp.js');
    const { t } = await import('../../src/i18n.js');
    const key = d.keys.printer;
    const p = await page('a.berger', { width: 1100, height: 700 });
    await S.go(p, `/browse/${key}`);
    const png = await p.screenshot({ clip: { x: 270, y: 70, width: 640, height: 215 } });
    const tk = d.keyRow(key);
    const name = T('einstellung.png', 'setting.png');
    const att = ctx.tickets.addAttachment(tk.id, { filename: name, mime: 'image/png', buffer: png }, 1, null, { silent: true, inline: true });
    const body = T(`Hallo Frau Muster, bitte im Druckmenü dieses Fach auswählen:\n\n![${name}](/api/attachments/${att})\n\nDann sollte es wieder gehen.`,
      `Hello Ms Muster, please choose this tray in the print menu:\n\n![${name}](/api/attachments/${att})\n\nThen it should work again.`);
    const app = ctx.settings.get('general.title') || 'Helfi.Space';
    const vars = { key, title: tk.title, name: 'Erika Muster', author: 'Anna Berger', body: '', link: `https://helfi.firma.local/browse/${key}`, app, contact: '', closing: t(lang, 'mail.closing', { author: 'Anna Berger', app }) };
    const { html, attachments } = commentMail({ format: 'md', body }, lang, 'mail.comment.body', vars, (id) => ctx.tickets.mailImage(tk.id, id));
    let pageHtml = html;
    for (const x of attachments) pageHtml = pageHtml.replace(`cid:${x.cid}`, `data:${x.contentType};base64,${fs.readFileSync(x.path).toString('base64')}`);
    const c = await browser.newContext({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 1.25 });
    const mp = await c.newPage();
    await mp.setContent(`<div style="padding:24px 28px;max-width:700px">${pageHtml}</div>`); await mp.waitForTimeout(300);
    const h = await mp.evaluate(() => document.body.scrollHeight);
    await shot.clip(mp, 'mail-images', { x: 0, y: 0, width: 760, height: Math.min(h, 680) });
    await c.close();
  });
});

/** A made-up photo of a printer display (drawn in the page, no real photo needed) */
const displayPhoto = (p, text) => p.evaluate(async (txt) => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 1200, 900); gr.addColorStop(0, '#C9D3DF'); gr.addColorStop(1, '#7E8FA6');
  g.fillStyle = gr; g.fillRect(0, 0, 1200, 900);
  g.fillStyle = '#2B3440'; g.beginPath(); g.roundRect(170, 220, 860, 460, 36); g.fill();
  g.fillStyle = '#B9E3F5'; g.fillRect(230, 280, 740, 340);
  g.fillStyle = '#12324A'; g.font = 'bold 64px sans-serif'; g.fillText(txt[0], 270, 400);
  g.font = '44px sans-serif'; g.fillText(txt[1], 270, 490);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return [...new Uint8Array(await blob.arrayBuffer())];
}, text).then((a) => Buffer.from(a));

// ---------- Passkeys (served as localhost, so that the browser offers them) ----------
scene('passkeys', ['login-passkey', 'mfa-passkey', 'm-mfa-passkey', 'profile-passkeys', 'passkey-hint', 'm-passkeys', 'm-passkey-hint'], async (S) => {
  const { page, go, shot, step, d, T, db, B } = S;
  const { config } = await import('../../src/config.js');
  const before = config.baseUrl;
  config.baseUrl = B;
  try {
    const now = Date.now();
    const ins = db.prepare('INSERT INTO user_passkeys(user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    ins.run(d.ids['m.mustermann'], 'demo-1', Buffer.from([1]), 3, '["internal","hybrid"]', 'multiDevice', 1, 'iPhone', now - 20 * 86400000, now - 2 * 3600000);
    ins.run(d.ids['m.mustermann'], 'demo-2', Buffer.from([2]), 0, '["internal"]', 'singleDevice', 0, T('Büro-PC (Windows Hello)', 'Office PC (Windows Hello)'), now - 3 * 86400000, null);
    await step('login', async () => {
      const p = await page(null, { height: 900 });
      await go(p, '/login'); await p.waitForSelector('[data-passkey-login]');
      await shot.el(p, 'login-passkey', '.auth-card', { pad: 0 });
    });
    await step('mfa', async () => {
      // Password filled in instead of the passkey: the code step offers the passkey
      S.ctx.settings.set('mfa.internal', 'all');
      try {
        for (const mobile of [false, true]) {
          const p = await page(null, mobile ? { mobile: true } : { height: 900 });
          await p.addInitScript(() => { if (window.PublicKeyCredential) window.PublicKeyCredential.isConditionalMediationAvailable = async () => false; });
          await go(p, mobile ? '/m/login' : '/login');
          await p.fill('input[name="username"]', 'm.mustermann');
          await p.fill('input[name="password"]', 'Demo-Kennwort-2026');
          await p.click('button[type=submit]');
          await p.waitForSelector('[data-passkey-confirm]'); await p.evaluate(() => document.activeElement?.blur()); await S.settle(p);
          if (mobile) await shot.full(p, 'm-mfa-passkey');
          else await shot.el(p, 'mfa-passkey', '.auth-card', { pad: 0 });
        }
      } finally { S.ctx.settings.set('mfa.internal', ''); }
    });
    await step('profile', async () => {
      const p = await page('m.mustermann', { width: 1100, height: 1400 });
      // Has passkeys already: adding another one needs a session with the second factor (as after a passkey sign-in)
      db.prepare('UPDATE sessions SET mfa=1 WHERE user_id=?').run(d.ids['m.mustermann']);
      await go(p, '/profile'); await p.waitForSelector('[data-passkeys-panel] .passkey-item');
      await p.fill('[data-passkeys-panel] input[name="passkey-name"]', T('Büro-Mac', 'Office Mac'));
      await shot.el(p, 'profile-passkeys', '[data-passkeys-panel]', { pad: 0 });
    });
    await step('hint', async () => {
      const p = await page('s.neu', { width: 1020, height: 700 });
      await go(p, '/portal'); await p.waitForSelector('[data-passkey-hint]');
      const hb = await p.locator('[data-passkey-hint]').boundingBox();
      await shot.clip(p, 'passkey-hint', { x: 0, y: 0, width: 1020, height: Math.min(700, hb.y + hb.height + 140) });
      const m = await page('s.neu', { mobile: true });
      await go(m, '/m'); await m.waitForSelector('[data-passkey-hint]');
      await shot.clip(m, 'm-passkey-hint', { x: 0, y: 0, width: 390, height: 520 });
    });
    await step('mobile', async () => {
      const l = await page(null, { mobile: true });
      await go(l, '/m/login'); await l.waitForSelector('[data-passkey-login]');
      const m = await page('m.mustermann', { mobile: true });
      db.prepare('UPDATE sessions SET mfa=1 WHERE user_id=?').run(d.ids['m.mustermann']);
      await go(m, '/m/me/passkeys'); await m.waitForSelector('[data-passkey-add]');
      await shot.phones('m-passkeys', [l, m]);
    });
  } finally {
    config.baseUrl = before;
    db.prepare("DELETE FROM user_passkeys WHERE credential_id LIKE 'demo-%'").run();
  }
});

// ---------- Phone ----------
scene('mobile', ['m-portal', 'mobile-app-1', 'mobile-app-2', 'm-mail', 'm-image', 'm-done-comment', 'm-reporter', 'm-reply-format', 'm-theme', 'saved-filters-mobile'], async (S) => {
  const { page, go, shot, step, d, T, settle } = S;
  const phone = (u, o = {}) => page(u, { mobile: true, ...o });
  await step('portal', async () => {
    const p = await phone('e.muster');
    await go(p, '/m/portal'); await p.waitForSelector('.m-portal-depts');
    await shot.full(p, 'm-portal');
  });
  await step('app-1', async () => {
    const a = await phone('e.muster'); await go(a, '/m/requests');
    const b = await phone('e.muster'); await go(b, `/m/t/${d.keys.printer}`);
    const c = await phone('e.muster'); await go(c, '/m/new');
    await shot.phones('mobile-app-1', [a, b, c]);
  });
  await step('app-2', async () => {
    const a = await phone('e.muster'); await go(a, '/m/new');
    await a.tap('.m-tile-report'); await a.waitForSelector('input[name=title]');
    await a.fill('input[name=title]', T('Drucker druckt nur leere Seiten', 'Printer prints only blank pages'));
    await a.fill('textarea[name=description]', T('Drucker PR-0001 im 2. OG, seit heute früh. Neustart hat nicht geholfen.', 'Printer PR-0001 on the 2nd floor, since this morning. A restart did not help.'));
    const photo = await displayPhoto(a, T(['Papierstau', 'Fach 2 prüfen'], ['Paper jam', 'Check tray 2']));
    const ch = a.waitForEvent('filechooser'); await a.locator('.m-attach-btn').first().tap();
    await (await ch).setFiles({ name: T('drucker.jpg', 'printer.jpg'), mimeType: 'image/jpeg', buffer: photo });
    await a.waitForSelector('.m-file.ready');
    const proj = a.locator('select').filter({ has: a.locator('option', { hasText: T('IT-Helpdesk', 'IT Help Desk') }) });
    if (await proj.count()) await proj.first().selectOption({ label: `${T('IT-Helpdesk', 'IT Help Desk')} (IT)` }).catch(() => {});
    await a.fill('input[name=title]', T('Drucker druckt nur leere Seiten ', 'Printer prints only blank pages ')); await a.waitForTimeout(900);
    await a.evaluate(() => { document.activeElement?.blur(); document.querySelectorAll('.m-scroll').forEach((e) => e.scrollTo(0, 0)); window.scrollTo(0, 0); });
    const b = await phone('e.muster'); await go(b, `/m/kb/${d.kb.vpn.id}`);
    const c = await phone('s.neu'); await go(c, '/m/me/2fa');
    await c.tap('.m-mfa-start'); await c.waitForSelector('.m-secret');
    await shot.phones('mobile-app-2', [a, b, c]);
  });
  await step('mail', async () => {
    const a = await phone('a.berger'); await go(a, `/m/t/${d.keys.mail}`);
    await a.locator('[data-mail-original]').first().scrollIntoViewIfNeeded();
    const b = await phone('a.berger'); await go(b, `/m/t/${d.keys.mail}`);
    await b.locator('[data-mail-original]').first().tap(); await b.waitForTimeout(900);
    await shot.phones('m-mail', [a, b]);
  });
  await step('image', async () => {
    const tk = await d.mk(d.erika, { title: T('Drucker 2. OG zeigt Fehler', 'Printer 2nd floor shows an error'), description: T('Im Display steht eine Fehlermeldung, Foto anbei.', 'The display shows an error, photo attached.'), projectId: d.it.id });
    const p = await phone('a.berger');
    const photo = await displayPhoto(p, ['Fehler 49.4C02', T('Gerät neu starten', 'Restart the device')]);
    await d.erika.upload(`/api/tickets/${tk.key}/attachments`, 'files', T('display-foto.jpg', 'display-photo.jpg'), 'image/jpeg', photo);
    await go(p, `/m/t/${tk.key}`);
    await p.locator('a.m-att-img').first().tap(); await p.waitForTimeout(900);
    await shot.full(p, 'm-image');
  });
  await step('done', async () => {
    const tk = await d.mk(d.jonas, { title: T('VPN bricht im Homeoffice ab', 'VPN drops when working from home'), projectId: d.it.id });
    const p = await phone('a.berger'); await go(p, `/m/t/${tk.key}`);
    await p.locator('.m-status-btn').tap(); await p.waitForTimeout(400);
    await p.locator('.m-choice-row[data-value=done]').tap(); await p.waitForSelector('.m-sheet-resolve textarea');
    await p.locator('.m-sheet-resolve textarea').fill(T('VPN-Client aktualisiert, Verbindung stabil.', 'VPN client updated, connection stable.'));
    await p.locator('.m-sheet-resolve [data-done-kind=note]').tap(); await p.waitForTimeout(300);
    await shot.full(p, 'm-done-comment');
  });
  await step('reporter', async () => {
    const p = await phone('a.berger'); await go(p, '/m/new/report');
    await p.locator('.m-reporter').tap(); await p.waitForSelector('.m-sheet-search-input');
    await p.locator('.m-sheet-search-input').fill('erika'); await p.waitForSelector('.m-person-hit');
    await p.locator('.m-person-hit').first().tap(); await p.waitForTimeout(500);
    await shot.clip(p, 'm-reporter', { x: 0, y: 0, width: 390, height: 410 });
  });
  await step('reply-format', async () => {
    const p = await phone('a.berger'); await go(p, `/m/t/${d.keys.printer}`);
    await p.tap('.m-reply .kb-editable');
    await p.keyboard.type(T('Toner ist ', 'Toner is '));
    await p.tap(`.m-reply .kb-tb-btn[aria-label="${T('Fett', 'Bold')}"]`);
    await p.keyboard.type(T('getauscht', 'replaced')); await settle(p);
    const vh = p.viewportSize().height;
    await shot.clip(p, 'm-reply-format', { x: 0, y: vh - 290, width: 390, height: 290 });
  });
  await step('theme', async () => {
    const p = await phone('a.berger', { theme: 'dark' }); await go(p, '/m/me');
    const box = await p.locator('.m-theme').boundingBox();
    await shot.clip(p, 'm-theme', { x: 0, y: Math.max(0, box.y + box.height - 390), width: 390, height: 400 });
  });
  await step('filters', async () => {
    const p = await phone('a.berger'); await go(p, '/m/tickets'); await p.waitForSelector('.m-chips', { timeout: 30000 });
    await p.locator('.m-chip', { hasText: T('Drucker offen', 'Printers open') }).first().scrollIntoViewIfNeeded();
    await p.locator('.m-chip', { hasText: T('Drucker offen', 'Printers open') }).first().tap(); await p.waitForTimeout(500);
    await shot.clip(p, 'saved-filters-mobile', { x: 0, y: 0, width: 390, height: 360 });
  });
});

// ---------- Notice about a new version ----------
scene('updates', ['update-notice'], async (S) => {
  const { page, go, shot, step, ctx } = S;
  const installed = S.githubLatest;
  const v = installed.split('.').map(Number);
  S.githubLatest = `${v[0]}.${v[1] + 1}.0`;
  try {
    await ctx.updates.check();
    await step('notice', async () => {
      const a = await page('admin', { height: 900 });
      await go(a, '/admin/users');
      const box = await a.locator('[data-update-notice]').boundingBox();
      await shot.clip(a, 'update-notice', { x: 0, y: 0, width: 1280, height: Math.ceil(box.y + box.height + 20) });
    });
  } finally {
    S.githubLatest = installed;
    await ctx.updates.check();
  }
});

// ---------- Deleting a comment (last: it adds a ticket of its own) ----------
scene('comments', ['comment-delete', 'm-comment-delete'], async (S) => {
  const { page, go, shot, step, d, T } = S;
  const tk = await d.mk(d.erika, { title: T('Zugang zum Lohnordner', 'Access to the payroll folder'), description: T('Ich komme nicht mehr in den Ordner Lohn 2026.', 'I can no longer open the folder Payroll 2026.'), projectId: d.it.id });
  await d.erika('POST', `/api/tickets/${tk.key}/comments`, { body: T('Hier meine Anmeldedaten, damit du es testen kannst: e.muster / ••••••••', 'Here are my sign-in details so you can test it: e.muster / ••••••••') });
  await d.anna('POST', `/api/tickets/${tk.key}/comments`, { body: T('Bitte schreib nie Anmeldedaten ins Ticket – ich lösche den Kommentar. Den Ordner habe ich freigegeben.', 'Please never put sign-in details into a ticket – I am deleting the comment. The folder is shared with you again.') });
  await step('comment-delete', async () => {
    const p = await page('a.berger');
    await go(p, `/browse/${tk.key}`);
    const c = p.locator('.comment', { hasText: 'e.muster /' });
    await c.hover(); await c.locator('.comment-delete').click(); await p.waitForSelector('.modal .btn-danger');
    await shot.full(p, 'comment-delete');
    await p.keyboard.press('Escape');
  });
  await step('m-comment-delete', async () => {
    const a = await page('a.berger', { mobile: true }); await go(a, `/m/t/${tk.key}`);
    const msg = a.locator('.m-msg', { hasText: 'e.muster /' });
    await msg.locator('.m-msg-del').tap(); await a.waitForSelector('.m-sheet-foot .m-btn-danger'); await a.waitForTimeout(400);
    const b = await page('a.berger', { mobile: true }); await go(b, `/m/t/${tk.key}`);
    await b.locator('.m-msg', { hasText: 'e.muster /' }).locator('.m-msg-del').tap();
    await b.locator('.m-sheet-foot .m-btn-danger').tap(); await b.waitForSelector('.m-msg-deleted');
    await b.locator('.m-msg-deleted').evaluate((e) => e.scrollIntoView({ block: 'center' })); await b.waitForTimeout(4500); // the toast is gone again
    await shot.phones('m-comment-delete', [a, b]);
  });
});

// ---------- A reply to the customer sets "Waiting" (adds a ticket of its own) ----------
scene('reply-wait', ['reply-wait'], async (S) => {
  const { page, go, shot, step, d, T } = S;
  const tk = await d.mk(d.erika, { title: T('Monitor flackert', 'Monitor flickers'), description: T('Der zweite Monitor flackert seit heute früh.', 'The second monitor has been flickering since this morning.'), projectId: d.it.id });
  await step('reply-wait', async () => {
    const p = await page('a.berger');
    await go(p, `/browse/${tk.key}`);
    const box = p.locator('.composer');
    await box.locator('.cm-editor, textarea').first().click();
    await p.keyboard.type(T('Ist das Kabel fest eingesteckt? Probier bitte auch den anderen Anschluss.', 'Is the cable plugged in firmly? Please also try the other port.'));
    await p.locator('.composer-wait').hover();
    const b = await box.boundingBox();
    await shot.clip(p, 'reply-wait', { x: Math.max(0, b.x - 16), y: Math.max(0, b.y - 16), width: Math.min(1280, b.width + 32), height: b.height + 32 });
  });
});

// ---------- Automation rules (the IT lead's view; adds rules and tickets of its own) ----------
scene('automation', ['automation', 'automation-edit', 'automation-examples'], async (S) => {
  const { page, go, shot, step, d, T, ctx, db } = S;
  const L = S.lang;
  for (const key of ['waiting-remind', 'waiting-close', 'urgent-unassigned', 'account-priority']) {
    await d.admin('POST', `/api/automation/templates/${key}`, { projectId: d.it.id, lang: L });
  }
  const rules = (await d.admin('GET', `/api/automation/rules?projectId=${d.it.id}`)).rules;
  for (const r of rules.filter((x) => ['waiting-remind', 'waiting-close', 'account-priority'].includes(x.template))) {
    await d.admin('PATCH', `/api/automation/rules/${r.id}`, { enabled: true });
  }
  // Tickets waiting for the customer for a while: the reminder acts on them
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  for (const [title, days] of [[T('Laufwerk S: fehlt', 'Drive S: missing'), 8], [T('Neue Maus bestellen', 'Order a new mouse'), 9], [T('Kalender wird nicht geteilt', 'Calendar is not shared'), 12]]) {
    const tk = await d.mk(d.max, { title, projectId: d.it.id });
    await d.anna('POST', `/api/tickets/${tk.key}/comments`, { body: T('Ist das noch aktuell?', 'Is this still an issue?') });
    const id = d.keyRow(tk.key).id;
    db.prepare("UPDATE activity SET created_at=? WHERE ticket_id=? AND field='status'").run(ago(days), id);
  }
  ctx.automation.checkTime();
  // One more that waits longer than the closing rule's 14 days – the preview shows it (not acted on yet)
  const late = await d.mk(d.erika, { title: T('Beamer im Raum 2 flackert', 'Projector in room 2 flickers'), projectId: d.it.id });
  await d.anna('POST', `/api/tickets/${late.key}/comments`, { body: T('Tritt das noch auf?', 'Does this still happen?') });
  db.prepare("UPDATE activity SET created_at=? WHERE ticket_id=? AND field='status'").run(ago(16), d.keyRow(late.key).id);
  await new Promise((r) => setTimeout(r, 300));
  const p = await page('a.berger', { height: 1500 });
  await step('list', async () => {
    await go(p, '/automation');
    await shot.el(p, 'automation', p.locator('section.panel').first(), { pad: 0 });
  });
  await step('edit', async () => {
    await p.locator('[data-rule]', { hasText: T('schließen', 'close') }).locator(`button[aria-label="${T('Regel bearbeiten', 'Edit rule')}"]`).click();
    await p.waitForSelector('.modal #auto-form');
    await p.click('[data-auto-preview]');
    await p.waitForSelector('.auto-preview strong');
    await shot.el(p, 'automation-edit', '.modal', { pad: 0 });
    await p.keyboard.press('Escape');
  });
  await step('examples', async () => {
    await p.click('[data-auto-examples]');
    await p.waitForSelector('.modal .auto-templates');
    await shot.el(p, 'automation-examples', '.modal', { pad: 0 });
    await p.keyboard.press('Escape');
  });
});
