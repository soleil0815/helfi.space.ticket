// UI entry point: state, router, base layout.
import { THEMES, getTheme, setTheme, syncTheme } from './theme.js';
import { installShortcuts, clearPageShortcuts, listKeys } from './shortcuts.js';
import { api } from './api.js';
import { h, mount, icon, avatar, dropdown, toast, loadSprite } from './dom.js';
import { t, setLang, getLang, browserLang } from './i18n.js';
import { renderLogin, renderSetup } from './views/auth.js';
import { renderRegister, renderRegisterConfirm, renderForgot, renderReset } from './views/account.js';
import { initIdle } from './idle.js';
import { renderBoard } from './views/board.js';
import { renderList, renderMyWork } from './views/list.js';
import { renderTicket, openCreateDialog } from './views/ticket.js';
import { renderAdmin } from './views/admin.js';
import { renderReports } from './views/reports.js';
import { renderSummary } from './views/summary.js';
import { QUEUES, VIEWS, queueHref, matchQueue } from './queues.js';
import { savedFiltersNav, refreshSavedFilters } from './savedfilters.js';
import { renderProfile } from './views/profile.js';
import { renderNews, showNewsPopup } from './views/news.js';
import { brandLogo, brandTitle } from './brand.js';
import { renderChangeCalendar } from './views/change.js';
import { renderKb } from './views/kb.js';
import { renderCatalog } from './views/catalog.js';
import { renderPortal, userStartPath } from './views/portal.js';
import { renderCmdb } from './views/cmdb.js';
import { renderRate } from './views/survey.js';
import { state } from './state.js';
import { isPhone, setUiPref, wantsMobile, mobileUrlFor, takeDesktopOnce, lockedToMobile } from './uimode.js';
import { clearUserData, noteUser } from './userdata.js';
import { resetCannedCache } from './views/canned.js';
import { resetImportState } from './views/import.js';
import { clearAiSummaries } from './aiassist.js';
import { clearComponentCache } from './components.js';
import { attachQuickSearch } from './quicksearch.js';

// Shared with the mobile UI (/m) – see state.js
export { state };

const root = document.getElementById('app');

// Unsaved changes (e.g. in the article editor): ask before leaving
let leaveGuard = null;
let guardUrl = null;
/** Sidebar footer: link to the website (new tab) and version (→ news) */
export const HOME_URL = 'https://helfi.space';
/** Support link for the developer – shown to admins only */
export const COFFEE_URL = 'https://buymeacoffee.com/soleil0815';
export function coffeeButton(cls = 'a.coffee-btn') {
  return h(cls, { href: COFFEE_URL, target: '_blank', rel: 'noopener noreferrer', title: t('app.coffeeTitle') }, icon('coffee'), h('span', 'Buy me a coffee'));
}
function sidebarFoot() {
  return h('div.sidebar-foot',
    state.isAdmin ? coffeeButton() : null,
    // Website and version always together on their own line
    h('div.sidebar-meta',
      h('a.home-link', { href: HOME_URL, target: '_blank', rel: 'noopener noreferrer', title: t('app.website') }, 'Helfi.Space'),
      h('span', { 'aria-hidden': 'true' }, '·'),
      h('a.version-link', { href: '/news', 'data-link': '', title: t('news.title') }, state.boot.app.version),
      h('span', { 'aria-hidden': 'true' }, '·'),
      // AGPL-3.0: every user can get the source code of the running program
      h('a.source-link', { href: state.boot.app.sourceUrl, target: '_blank', rel: 'noopener noreferrer', title: t('app.sourceTitle') }, t('app.source'))));
}

export function setLeaveGuard(isDirty) { leaveGuard = isDirty; guardUrl = isDirty ? location.pathname + location.search : null; }
const mayLeave = () => !leaveGuard || !leaveGuard() || window.confirm(t('app.leaveConfirm'));
window.addEventListener('beforeunload', (e) => { if (leaveGuard && leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });

export function navigate(path, { replace = false, force = false } = {}) {
  if (!force && !mayLeave()) return;
  leaveGuard = null;
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  route();
}

/**
 * Everything of the previous account that lives in this page (the desktop UI does not reload on
 * sign-in/sign-out): module caches (personal templates, import access data, AI summaries,
 * components) and lists. clearData also removes drafts and lists in the browser storage.
 */
export function resetAccountState({ clearData = false, keepDrafts = false } = {}) {
  resetCannedCache();
  resetImportState();
  clearAiSummaries();
  clearComponentCache();
  state.projects = []; state.agents = []; state.savedFilters = [];
  if (clearData) clearUserData({ keepDrafts });
}

export async function reloadBase() {
  const [p, a, f] = await Promise.all([
    api.projects(),
    state.isAgent ? api.users() : Promise.resolve({ users: [] }),
    // saved filters: the list page names a matching one at once
    state.isAgent ? api.filters().catch(() => ({ filters: [] })) : Promise.resolve({ filters: [] }),
  ]);
  state.projects = p.projects;
  state.agents = a.users;
  state.savedFilters = f.filters;
}

function applyLanguage() {
  let stored = null;
  try { stored = localStorage.getItem('helfi.lang'); } catch { /* ignore */ }
  setLang(state.user?.language || stored || browserLang() || state.boot?.defaultLanguage || 'de');
  // the account's colour theme (chosen on another device) applies here too
  syncTheme(state.user);
}

export async function setLanguage(lang) {
  try { if (lang) localStorage.setItem('helfi.lang', lang); else localStorage.removeItem('helfi.lang'); } catch { /* ignore */ }
  if (state.user) {
    const r = await api.updateMe({ language: lang || null });
    state.user = r.user;
  }
  applyLanguage();
  route();
}

async function start() {
  initIdle({ login: '/login' });
  try {
    [state.boot] = await Promise.all([api.bootstrap(), loadSprite()]);
  } catch {
    mount(root, h('div.fatal', 'Helfi.Space ist nicht erreichbar / not reachable.'));
    return;
  }
  state.user = state.boot.user;
  // Drafts of the mobile UI belong to one account (see userdata.js)
  if (state.user) noteUser(state.user.id); else clearUserData({ keepDrafts: true });
  applyLanguage();
  if (state.user) await reloadBase();
  window.addEventListener('popstate', () => {
    if (!mayLeave()) { history.pushState({}, '', guardUrl); return; }
    leaveGuard = null;
    route();
  });
  window.addEventListener('helfi:unauthorized', () => { state.user = null; resetAccountState({ clearData: true, keepDrafts: true }); navigate('/login', { replace: true }); });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    // Only route paths of this application itself (never “//…” or “/\…” – that would be an external address)
    const href = a.getAttribute('href') || '';
    if (!/^\/(?![/\\])/.test(href) || new URL(href, location.href).origin !== location.origin) { e.preventDefault(); return; }
    e.preventDefault(); navigate(href);
  });
  installShortcuts({
    isActive: () => !!state.user,
    isAgent: () => state.isAgent,
    global: {
      keys: {
        c: () => openCreateDialog(),
        '/': () => document.querySelector('.topbar-search input')?.focus(),
        ...listKeys((key) => navigate(`/browse/${key}`)),
      },
      go: {
        b: () => state.isAgent && navigate('/board'),
        i: () => state.isAgent && navigate('/issues'),
        m: () => navigate(state.isAgent ? '/my' : '/requests'),
      },
    },
  });
  route();
}

export async function route() {
  const url = new URL(location.href);
  const path = url.pathname;
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  clearPageShortcuts();

  // Rating link from the email: no login required
  if (path.startsWith('/rate/')) return renderRate(root, path, url.searchParams);
  if (state.boot.setupRequired && !state.user) return renderSetup(root);
  // Account pages from the sign-in page and from mails (only without sign-in)
  const accountPage = { '/register': renderRegister, '/register/confirm': renderRegisterConfirm, '/forgot': renderForgot, '/reset': renderReset }[path];
  if (accountPage) {
    if (!state.user) return accountPage(root);
    return navigate('/', { replace: true });
  }
  if (!state.user) {
    if (path !== '/login') history.replaceState({}, '', `/login${location.search}`);
    return renderLogin(root);
  }
  if (path === '/login' || path === '/setup') return navigate('/', { replace: true });

  const content = h('main.content');
  mount(root, layout(content, path));
  const params = url.searchParams;

  try {
    // Start page: agents and admins always the backend; users the portal or their requests (setting)
    if (path === '/') return navigate(state.isAgent ? '/board' : userStartPath(), { replace: true });
    if (path === '/portal' || path.startsWith('/portal/')) return await renderPortal(content, path);
    if (path === '/board') return await renderBoard(content, params);
    if (path === '/issues') return await renderList(content, params);
    // Users only see their own and shared requests here anyway (participants); agents see those they reported by default
    if (path === '/requests') return await renderList(content, state.isAgent && !params.has('participant') && !params.has('approval') ? new URLSearchParams({ reporter: 'me', ...Object.fromEntries(params) }) : params, { requests: true });
    if (path === '/my') return await renderMyWork(content);
    if (path === '/reports' && state.isAgent) return await renderReports(content, params);
    if (path === '/changes' && state.isAgent) return await renderChangeCalendar(content, params);
    if (path === '/kb' || path.startsWith('/kb/')) return await renderKb(content, params, path);
    if (path === '/catalog' || path.startsWith('/catalog/')) return await renderCatalog(content, path);
    if (state.isAgent && (path === '/cis' || path.startsWith('/cis/'))) return await renderCmdb(content, params, path);
    if (path === '/summary' && state.isAgent) return await renderSummary(content);
    if (path.startsWith('/browse/')) return await renderTicket(content, decodeURIComponent(path.slice(8)));
    if (path.startsWith('/admin') && state.isAdmin) return await renderAdmin(content, path.split('/')[2] || 'projects');
    if (path === '/profile') return renderProfile(content);
    if (path === '/news') return await renderNews(content);
    mount(content, h('div.empty-state', h('h2', '404'), h('a', { href: '/', 'data-link': '' }, '←')));
  } catch (e) {
    mount(content, h('div.empty-state', h('h2', t('app.error')), h('p', e.message)));
  }
}

function layout(content, path) {
  const u = state.user;
  const p = state.project;
  const nav = (href, label, ic, active) => h('a.nav-item', { href, 'data-link': '', class: active ? 'active' : '' }, icon(ic), h('span', { title: label }, label));
  const activeQueue = path === '/issues' ? matchQueue(new URL(location.href).searchParams) : null;
  // Count on an entry – filled after loading /api/queues (until then the last known value)
  const countEl = (field) => h('span.nav-count', { 'data-count': field }, state.queueCounts?.[field] ?? '');
  const countedNav = (href, label, ic, active, field) => h('a.nav-item', { href, 'data-link': '', class: active ? 'active' : '' }, icon(ic), h('span', { title: label }, label), countEl(field));
  function queuesNav(curPath, proj) {
    let open = true;
    try { open = localStorage.getItem('helfi.queuesOpen') !== '0'; } catch { /* ignore */ }
    const list = h('div.queue-list', { hidden: !open }, QUEUES.map((q) => h('a.nav-item.nav-sub', {
      href: queueHref(q, proj?.key), 'data-link': '', class: curPath === '/issues' && activeQueue?.id === q.id ? 'active' : '',
    }, h('span', { title: t(q.label) }, t(q.label)), countEl(q.count))));
    const head = h('button.nav-item.nav-group', {
      type: 'button', 'aria-expanded': String(open),
      onclick: () => {
        open = !open; list.hidden = !open; head.setAttribute('aria-expanded', String(open)); head.classList.toggle('collapsed', !open);
        try { localStorage.setItem('helfi.queuesOpen', open ? '1' : '0'); } catch { /* ignore */ }
      },
    }, icon('inbox'), h('span', { title: t('nav.queues') }, t('nav.queues')), icon('chevron-down', 'nav-chevron'));
    head.classList.toggle('collapsed', !open);
    return h('div.queue-group', head, list);
  }

  const search = h('input', {
    type: 'search', placeholder: t('app.searchPlaceholder'), 'aria-label': t('app.search'), enterkeyhint: 'search',
    onkeydown: (e) => {
      if (e.key === 'Escape') { topbar.classList.remove('search-open'); return; }
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim();
      if (/^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(q)) navigate(`/browse/${q.toUpperCase()}`);
      else navigate(`/${state.isAgent ? 'issues' : 'requests'}?q=${encodeURIComponent(q)}`);
    },
  });

  // Results while typing; Enter without a choice → all results as before
  attachQuickSearch(search, {
    openTicket: (key) => { search.value = ''; search.blur(); navigate(`/browse/${encodeURIComponent(key)}`); },
    showAll: (q) => { search.blur(); navigate(`/${state.isAgent ? 'issues' : 'requests'}?q=${encodeURIComponent(q)}`); },
  });

  const THEME_ICONS = { system: 'contrast', light: 'sun', dark: 'moon' };
  const userBtn = h('button.topbar-user', {
    type: 'button', 'aria-label': u.displayName,
    onclick: (e) => dropdown(e.currentTarget, [
      { label: t('app.profile'), icon: icon('user'), onClick: () => navigate('/profile') },
      { label: t('news.title'), icon: icon('info'), onClick: () => navigate('/news') },
      ...(state.isAdmin ? [{ label: t('nav.admin'), icon: icon('settings'), onClick: () => navigate('/admin') }] : []),
      '-',
      { label: 'Deutsch', active: getLang() === 'de', onClick: () => setLanguage('de') },
      { label: 'English', active: getLang() === 'en', onClick: () => setLanguage('en') },
      '-',
      // Colour theme: System (follows the device) / Light / Dark
      h('div.menu-group', t('theme.title')),
      ...THEMES.map((th) => ({ label: t(`theme.${th}`), icon: icon(THEME_ICONS[th]), active: getTheme() === th, onClick: () => setTheme(th) })),
      '-',
      // Phone user who chose the desktop view: way back to the mobile UI
      ...(isPhone() ? [{
        label: t('m.switchToMobile'), icon: icon('smartphone'),
        onClick: () => { setUiPref('mobile'); location.assign(mobileUrlFor(location.pathname, location.search) || '/m/'); },
      }, '-'] : []),
      { label: t('app.logout'), icon: icon('logout'), onClick: async () => { await api.logout(); state.user = null; resetAccountState({ clearData: true }); navigate('/login'); } },
    ], { align: 'right' }),
  }, avatar(u, 'sm'));

  // Smartphone: sidebar as drawer, search behind the magnifier
  const toggleNav = (open) => {
    const sh = document.querySelector('.shell');
    const on = open ?? !sh.classList.contains('nav-open');
    sh.classList.toggle('nav-open', on);
    menuBtn.setAttribute('aria-expanded', String(on));
    if (on) sh.querySelector('.sidebar .nav-item')?.focus({ preventScroll: true });
  };
  const menuBtn = h('button.btn-icon.nav-toggle', { type: 'button', 'aria-label': t('nav.menu'), 'aria-expanded': 'false', onclick: () => toggleNav() }, icon('list'));
  const searchBtn = h('button.btn-icon.search-toggle', {
    type: 'button', 'aria-label': t('app.search'),
    onclick: () => { topbar.classList.add('search-open'); search.focus(); },
  }, icon('search'));
  search.addEventListener('blur', () => setTimeout(() => topbar.classList.remove('search-open'), 150));

  const topbar = h('header.topbar',
    menuBtn,
    h('a.brand', { href: '/', 'data-link': '', 'aria-label': state.boot.app.title || 'Helfi.Space' }, brandLogo(24), brandTitle()),
    state.isAgent ? h('nav.topnav',
      h('a', { href: '/my', 'data-link': '', class: path === '/my' ? 'active' : '' }, t('nav.myWork')),
      h('a', { href: '/issues', 'data-link': '', class: path === '/issues' ? 'active' : '' }, t('nav.list')),
    ) : null,
    (state.isAgent || state.boot.allowSelfService) ? h('button.btn.btn-primary.topbar-create', { type: 'button', 'aria-label': t('app.create'), onclick: () => openCreateDialog() }, icon('plus'), h('span.btn-label', t('app.create'))) : null,
    h('div.spacer'),
    h('div.topbar-search', icon('search'), search),
    searchBtn,
    userBtn,
  );

  let sidebar;
  if (state.isAgent) {
    sidebar = h('aside.sidebar',
      p ? h('div.sidebar-project',
        h('div.project-avatar', p.key.slice(0, 2)),
        h('div', h('div.project-name', p.name), h('div.project-sub', p.key)),
        state.agentProjects.length > 1 ? h('button.btn-icon', {
          type: 'button', title: t('nav.projects'),
          onclick: (e) => dropdown(e.currentTarget, state.agentProjects.map((pr) => ({
            label: `${pr.name} (${pr.key})`, active: pr.key === p.key,
            onClick: () => { state.project = pr; route(); },
          }))),
        }, icon('chevron-down')) : null,
      ) : null,
      nav('/summary', t('nav.summary'), 'globe', path === '/summary'),
      queuesNav(path, p),
      savedFiltersNav(path === '/issues' ? new URL(location.href).searchParams : null),
      nav('/board', t('nav.board'), 'board', path === '/board'),
      ...VIEWS.filter((v) => !v.when || v.when(state.boot)).map((v) => countedNav(queueHref(v, p?.key), t(v.label), v.icon, path === '/issues' && activeQueue?.id === v.id, v.count)),
      nav('/changes', t('change.calendar'), 'board', path === '/changes'),
      (state.boot.hasCatalog || state.boot.catalogManage) ? nav('/catalog', t('catalog.title'), 'inbox', path.startsWith('/catalog')) : null,
      nav('/cis', t('ci.title'), 'server', path.startsWith('/cis')),
      nav('/kb', t('kb.title'), 'file', path.startsWith('/kb')),
      nav('/portal', t('portal.title'), 'home', path.startsWith('/portal')),
      nav('/reports', t('nav.reports'), 'chart', path === '/reports'),
      nav(state.isAdmin ? '/admin/templates' : '/profile#templates', t('nav.templates'), 'comment', path === '/admin/templates'),
      state.isAdmin ? nav('/admin/mail-in', t('nav.channelsMail'), 'mail', path === '/admin/mail-in') : null,
      state.isAdmin ? h('div.sidebar-label', t('nav.admin')) : null,
      state.isAdmin ? nav('/admin', t('app.settings'), 'settings', path.startsWith('/admin')) : null,
      sidebarFoot(),
    );
  } else {
    sidebar = h('aside.sidebar',
      nav('/portal', t('portal.title'), 'home', path.startsWith('/portal')),
      nav('/requests', t('nav.myRequests'), 'inbox', path === '/requests'),
      state.boot.hasCatalog ? nav('/catalog', t('catalog.request'), 'plus', path.startsWith('/catalog')) : null,
      state.boot.pendingApprovals ? nav('/requests?approval=mine', t('nav.approvals'), 'check', false) : null,
      nav('/kb', t('kb.titleUser'), 'file', path.startsWith('/kb')),
      sidebarFoot(),
    );
  }

  const warnings = (state.boot.warnings || []).map((w) => h('div.banner.banner-warn', icon('warning'), t(`warn.${w.code}`, w)));
  for (const mi of state.boot.majorIncidents || []) {
    warnings.unshift(h('div.banner.banner-major', icon('warning'), h('strong', t('major.title')), h('a', { href: `/browse/${mi.key}`, 'data-link': '' }, `${mi.key} ${mi.title}`)));
  }
  const m = state.boot.mfa;
  let mfaHidden = false;
  try { mfaHidden = sessionStorage.getItem('helfi.mfaBanner') === 'hidden'; } catch { /* ignore */ }
  if (m && m.mode !== 'off' && !m.enabled && u.source !== 'oidc' && path !== '/profile' && !mfaHidden) {
    const b = h('div.banner.banner-info.banner-mfa', icon('shield'), h('span.banner-text', t('mfa.banner')), h('a', { href: '/profile', 'data-link': '' }, t('mfa.setup')),
      h('button.btn-icon.banner-close', { type: 'button', 'aria-label': t('app.close'), onclick: () => { try { sessionStorage.setItem('helfi.mfaBanner', 'hidden'); } catch { /* ignore */ } b.remove(); } }, icon('close')));
    warnings.push(b);
  }
  if (state.isAgent) refreshQueueCounts(p?.key);
  // After an update, show once what is new (not on the news page itself)
  if (state.boot.news && !state.newsShown && path !== '/news') {
    state.newsShown = true;
    const entry = state.boot.news;
    setTimeout(() => { if (state.boot.news) showNewsPopup(entry); }, 300);
  }
  // Tapping an entry closes the drawer (the page is rebuilt anyway)
  sidebar.addEventListener('click', (e) => { if (e.target.closest('a[data-link]')) toggleNav(false); });
  const backdrop = h('div.nav-backdrop', { onclick: () => toggleNav(false) });
  const shell = h('div.shell', topbar, h('div.body', sidebar, backdrop, h('div.main', warnings, content)));
  shell.addEventListener('keydown', (e) => { if (e.key === 'Escape' && shell.classList.contains('nav-open')) { toggleNav(false); menuBtn.focus(); } });
  return shell;
}

/** Reload queue counts and write them to the sidebar (silent on errors). */
export async function refreshQueueCounts(projectKey = state.project?.key) {
  try {
    const { counts } = await api.queues(projectKey);
    state.queueCounts = counts;
    document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = counts[el.dataset.count] ?? ''; });
  } catch { /* ignore */ }
  await refreshSavedFilters();
}

// Phones (or the preference "mobile") get the app-like UI under /m – decided before anything is rendered.
// "?ui=desktop" shows this one page in the desktop UI anyway – except in the installed app on a phone:
// there every desktop address leads back into the mobile UI (pages that exist only on the desktop → start page).
const desktopOnce = takeDesktopOnce();
const mobileTarget = lockedToMobile()
  ? mobileUrlFor(location.pathname, location.search) || '/m/'
  : !desktopOnce && wantsMobile() ? mobileUrlFor(location.pathname, location.search) : null;
if (mobileTarget) location.replace(mobileTarget);
else start().catch((e) => { console.error(e); toast(e.message, 'error'); });
