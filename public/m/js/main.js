// Mobile UI (/m): start, sign-in state, app shell with tab bar, routes.
import { syncTheme } from '/js/theme.js';
import { api } from '/js/api.js';
import { initIdle } from '/js/idle.js';
import { h, mount, icon, toast, loadSprite } from '/js/dom.js';
import { t, setLang, browserLang } from '/js/i18n.js';
import { state } from '/js/state.js';
import { wantsMobile, desktopUrlFor } from '/js/uimode.js';
import { route, startRouter, go, setRootCheck, rerender, clearCache } from './router.js';
import { renderLogin } from './views/login.js';
import { renderHome } from './views/home.js';
import { renderTickets } from './views/tickets.js';
import { renderTicket } from './views/ticket.js';
import { renderMe, renderNews, renderMfa } from './views/me.js';
import { renderNew, renderReport, renderCatalogItem } from './views/new.js';
import { renderKb, renderKbArticle } from './views/kb.js';
import { resetActionCaches } from './actions.js';
import { clearUserData, noteUser } from '/js/userdata.js';
import { renderNotFound } from './views/misc.js';
import { setupPwa } from './pwa.js';

const NEXT_KEY = 'helfi.m.next';

/** Language: account → saved choice → browser → default of the installation (as in the desktop UI) */
export function applyLanguage() {
  let stored = null;
  try { stored = localStorage.getItem('helfi.lang'); } catch { /* ignore */ }
  setLang(state.user?.language || stored || browserLang() || state.boot?.defaultLanguage || 'de');
  // the account's colour theme (chosen on another device) applies here too
  syncTheme(state.user);
}

export async function setLanguage(lang) {
  try { localStorage.setItem('helfi.lang', lang); } catch { /* ignore */ }
  if (state.user) {
    const r = await api.updateMe({ language: lang });
    state.user = r.user;
  }
  applyLanguage();
  drawTabs();
  rerender();
}

export async function reloadBase() {
  const [p, a] = await Promise.all([api.projects(), state.isAgent ? api.users() : Promise.resolve({ users: [] })]);
  state.projects = p.projects;
  state.agents = a.users;
}

/** After sign-in: load everything again and continue where the user wanted to go */
/**
 * Everything of the previous account that lives in this page: rendered pages, module caches
 * (personal templates …), lists. clearData also removes drafts and viewed articles.
 */
function resetAccountState({ clearData = false } = {}) {
  clearCache();
  resetActionCaches();
  state.projects = []; state.agents = [];
  if (clearData) clearUserData();
}

export async function signedIn(user) {
  resetAccountState();
  noteUser(user.id); // another account than before in this tab: its drafts go
  state.user = user;
  state.boot = await api.bootstrap();
  state.user = state.boot.user || user;
  applyLanguage();
  await reloadBase();
  let next = null;
  try { next = sessionStorage.getItem(NEXT_KEY); sessionStorage.removeItem(NEXT_KEY); } catch { /* ignore */ }
  clearCache();
  drawTabs();
  go(next && /^\/m\/(?![/\\])/.test(next) && !next.startsWith('/m/login') ? next : '/m', { replace: true, anim: 'none' });
}

export async function signOut() {
  try { await api.logout(); } catch { /* signed out anyway */ }
  state.user = null;
  // Nothing of this account stays on the device: viewed articles, unsent drafts, caches
  resetAccountState({ clearData: true });
  try { state.boot = await api.bootstrap(); } catch { /* ignore */ }
  clearCache();
  drawTabs();
  go('/m/login', { replace: true, anim: 'none' });
}

// ---------- Shell ----------
let tabbar; let shell;
const TAB_DEFS = () => {
  const canCreate = state.isAgent || state.boot?.allowSelfService;
  return [
    state.isAgent
      ? { id: 'home', href: '/m/', icon: 'home', label: t('m.tab.home') }
      : { id: 'home', href: '/m/', icon: 'inbox', label: t('m.tab.requests') },
    state.isAgent ? { id: 'tickets', href: '/m/tickets?status=unresolved', icon: 'tickets', label: t('m.tab.tickets') } : null,
    canCreate ? { id: 'new', href: '/m/new', icon: 'plus', label: t('m.newTicket'), center: true } : null,
    { id: 'kb', href: '/m/kb', icon: 'book', label: t('m.tab.kb') },
    { id: 'me', href: '/m/me', icon: 'user', label: t('m.tab.me') },
  ].filter(Boolean);
};
let activeTab = null;

function drawTabs() {
  if (!tabbar) return;
  const tabs = state.user ? TAB_DEFS() : [];
  tabbar.replaceChildren(...tabs.map((tb) => {
    if (tb.center) {
      return h('div.m-tab.m-tab-center', h('button.m-tab-new', { type: 'button', 'aria-label': tb.label, onclick: () => go(tb.href) }, icon('plus')));
    }
    const active = tb.id === activeTab;
    return h('a.m-tab', {
      href: tb.href, 'data-tab': tb.id, class: active ? 'active' : '', 'aria-current': active ? 'page' : undefined,
      onclick: (e) => {
        e.preventDefault();
        const cur = document.querySelector('.m-page:not(.m-leaving) .m-scroll');
        // Tapping the active tab: back to its top
        if (tb.id === activeTab && location.pathname === new URL(tb.href, location.origin).pathname) { cur?.scrollTo({ top: 0, behavior: 'smooth' }); return; }
        go(tb.href);
      },
    }, icon(tb.icon), h('span.m-tab-label', tb.label));
  }));
  tabbar.setAttribute('aria-label', t('m.tabs'));
}

function routeChanged(r) {
  const showTabs = !!state.user && !r.bare && !!r.root?.(state);
  shell.classList.toggle('tabs-hidden', !showTabs);
  activeTab = r.tab || null;
  for (const a of tabbar.querySelectorAll('.m-tab[data-tab]')) {
    const on = a.dataset.tab === activeTab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

/** Route that requires a signed-in user */
const authed = (fn) => async (page, ctx) => {
  if (!state.user) {
    try { sessionStorage.setItem(NEXT_KEY, location.pathname + location.search); } catch { /* ignore */ }
    go('/m/login', { replace: true, anim: 'none' });
    return;
  }
  return fn(page, ctx);
};

function defineRoutes() {
  const always = () => true;
  route({ path: /^\/m\/login$/, bare: true, render: (page) => (state.user ? go('/m', { replace: true, anim: 'none' }) : renderLogin(page)) });
  route({ path: /^\/m$/, tab: 'home', root: always, render: authed(renderHome) });
  route({ path: /^\/m\/tickets$/, tab: 'tickets', root: (s) => s.isAgent, parent: '/m', render: authed(renderTickets) });
  route({ path: /^\/m\/t\/([^/]+)$/, parent: '/m', render: authed(renderTicket) });
  route({ path: /^\/m\/new$/, parent: '/m', render: authed(renderNew) });
  route({ path: /^\/m\/new\/report$/, parent: '/m/new', render: authed(renderReport) });
  route({ path: /^\/m\/new\/c\/(\d+)$/, parent: '/m/new', render: authed(renderCatalogItem) });
  route({ path: /^\/m\/kb$/, tab: 'kb', root: always, render: authed(renderKb) });
  route({ path: /^\/m\/kb\/(\d+)$/, parent: '/m/kb', render: authed(renderKbArticle) });
  route({ path: /^\/m\/me$/, tab: 'me', root: always, render: authed(renderMe) });
  route({ path: /^\/m\/me\/2fa$/, parent: '/m/me', render: authed(renderMfa) });
  route({ path: /^\/m\/news$/, parent: '/m/me', render: authed(renderNews) });
  route({ path: /^\/m\/404$/, parent: '/m', render: renderNotFound });
  route({ path: /^\/m\/.*$/, parent: '/m', render: renderNotFound });
}

/**
 * On-screen keyboard: the visual viewport shrinks (iOS always; Android where the layout viewport
 * is not resized). The app root and sheets follow it through CSS variables so the reply bar
 * and sheet fields stay above the keyboard. Pinch zoom (scale ≠ 1) is left alone.
 */
function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    const kb = Math.round(window.innerHeight - vv.height - vv.offsetTop);
    if (Math.abs(vv.scale - 1) < 0.01 && kb > 0) {
      root.style.setProperty('--m-vv-top', `${Math.round(vv.offsetTop)}px`);
      root.style.setProperty('--m-vv-h', `${Math.round(vv.height)}px`);
      root.style.setProperty('--m-kb', `${kb}px`);
    } else {
      for (const p of ['--m-vv-top', '--m-vv-h', '--m-kb']) root.style.removeProperty(p);
    }
    // A keyboard (not just a browser bar) is open: the safe area at the bottom is covered by it
    root.classList.toggle('m-kb-open', kb > 120);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  apply();
}

async function start() {
  const app = document.getElementById('m-app');
  initIdle({ login: '/m/login' });
  trackKeyboard();
  setupPwa();
  try {
    [state.boot] = await Promise.all([api.bootstrap(), loadSprite()]);
  } catch {
    mount(app, h('div.m-fatal', 'Helfi.Space ist nicht erreichbar / not reachable.'));
    return;
  }
  // Initial setup is only offered in the desktop UI
  if (state.boot.setupRequired && !state.boot.user) { location.replace('/setup'); return; }
  state.user = state.boot.user;
  if (state.user) noteUser(state.user.id);
  else clearUserData();
  document.body.dataset.appTitle = state.boot.app?.title || 'Helfi.Space';
  applyLanguage();
  if (state.user) {
    try { await reloadBase(); } catch { /* lists show their own error */ }
  }

  const stage = h('main.m-stage');
  tabbar = h('nav.m-tabbar');
  shell = h('div.m-shell.tabs-hidden', stage, tabbar);
  mount(app, shell);
  drawTabs();

  setRootCheck((r) => !!r.root?.(state));
  defineRoutes();

  window.addEventListener('helfi:unauthorized', () => {
    if (!state.user) return;
    state.user = null;
    // Session expired or signed out elsewhere: the next sign-in may be another account
    resetAccountState({ clearData: true });
    drawTabs();
    try { sessionStorage.setItem(NEXT_KEY, location.pathname + location.search); } catch { /* ignore */ }
    go('/m/login', { replace: true, anim: 'none' });
  });
  // Internal links (only paths of the mobile UI; everything else loads normally)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    const href = a.getAttribute('href') || '';
    if (!/^\/m(\/|$|\?)/.test(href)) return;
    e.preventDefault();
    go(href);
  });
  startRouter(stage, { changed: routeChanged });
}

// Not a phone (and no "mobile" preference): the desktop UI fits better
if (!wantsMobile()) location.replace(desktopUrlFor(location.pathname, location.search));
else start().catch((e) => { console.error(e); toast(e.message, 'error'); });
