// Einstieg der Oberfläche: Zustand, Router, Grundlayout.
import { api } from './api.js';
import { h, mount, icon, avatar, dropdown, toast } from './dom.js';
import { t, setLang, getLang, browserLang } from './i18n.js';
import { renderLogin, renderSetup } from './views/auth.js';
import { renderBoard } from './views/board.js';
import { renderList, renderMyWork } from './views/list.js';
import { renderTicket, openCreateDialog } from './views/ticket.js';
import { renderAdmin } from './views/admin.js';
import { renderProfile } from './views/profile.js';

export const state = {
  boot: null,
  user: null,
  projects: [],
  agents: [],
  get isAgent() { return this.user && (this.user.role === 'agent' || this.user.role === 'admin'); },
  get isAdmin() { return this.user?.role === 'admin'; },
  get project() {
    let key = null;
    try { key = localStorage.getItem('helfi.project'); } catch { /* egal */ }
    return this.projects.find((p) => p.key === key) || this.projects[0] || null;
  },
  set project(p) { try { localStorage.setItem('helfi.project', p?.key || ''); } catch { /* egal */ } },
};

const root = document.getElementById('app');

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  route();
}

export async function reloadBase() {
  const [p, a] = await Promise.all([
    api.projects(),
    state.isAgent ? api.users() : Promise.resolve({ users: [] }),
  ]);
  state.projects = p.projects;
  state.agents = a.users;
}

function applyLanguage() {
  let stored = null;
  try { stored = localStorage.getItem('helfi.lang'); } catch { /* egal */ }
  setLang(state.user?.language || stored || browserLang() || state.boot?.defaultLanguage || 'de');
}

export async function setLanguage(lang) {
  try { if (lang) localStorage.setItem('helfi.lang', lang); else localStorage.removeItem('helfi.lang'); } catch { /* egal */ }
  if (state.user) {
    const r = await api.updateMe({ language: lang || null });
    state.user = r.user;
  }
  applyLanguage();
  route();
}

async function start() {
  try {
    state.boot = await api.bootstrap();
  } catch {
    mount(root, h('div.fatal', 'Helfi.Space ist nicht erreichbar / not reachable.'));
    return;
  }
  state.user = state.boot.user;
  applyLanguage();
  if (state.user) await reloadBase();
  window.addEventListener('popstate', route);
  window.addEventListener('helfi:unauthorized', () => { state.user = null; navigate('/login', { replace: true }); });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); navigate(a.getAttribute('href')); }
  });
  document.addEventListener('keydown', (e) => {
    if (!state.user || e.target.closest('input,textarea,select,[contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'c' && !document.querySelector('.overlay')) { e.preventDefault(); openCreateDialog(); }
    if (e.key === '/') { e.preventDefault(); document.querySelector('.topbar-search input')?.focus(); }
  });
  route();
}

export async function route() {
  const url = new URL(location.href);
  const path = url.pathname;
  document.querySelectorAll('.menu').forEach((m) => m.remove());

  if (state.boot.setupRequired && !state.user) return renderSetup(root);
  if (!state.user) {
    if (path !== '/login') history.replaceState({}, '', `/login${location.search}`);
    return renderLogin(root);
  }
  if (path === '/login' || path === '/setup') return navigate('/', { replace: true });

  const content = h('main.content');
  mount(root, layout(content, path));
  const params = url.searchParams;

  try {
    if (path === '/' ) return navigate(state.isAgent ? '/board' : '/requests', { replace: true });
    if (path === '/board') return await renderBoard(content, params);
    if (path === '/issues') return await renderList(content, params);
    // Benutzer sehen hier ohnehin nur eigene und geteilte Anfragen (Teilnehmer); Bearbeiter standardmäßig die selbst gemeldeten
    if (path === '/requests') return await renderList(content, state.isAgent && !params.has('participant') ? new URLSearchParams({ reporter: 'me', ...Object.fromEntries(params) }) : params, { requests: true });
    if (path === '/my') return await renderMyWork(content);
    if (path.startsWith('/browse/')) return await renderTicket(content, decodeURIComponent(path.slice(8)));
    if (path.startsWith('/admin') && state.isAdmin) return await renderAdmin(content, path.split('/')[2] || 'general');
    if (path === '/profile') return renderProfile(content);
    mount(content, h('div.empty-state', h('h2', '404'), h('a', { href: '/', 'data-link': '' }, '←')));
  } catch (e) {
    mount(content, h('div.empty-state', h('h2', t('app.error')), h('p', e.message)));
  }
}

function layout(content, path) {
  const u = state.user;
  const p = state.project;
  const nav = (href, label, ic, active) => h('a.nav-item', { href, 'data-link': '', class: active ? 'active' : '' }, icon(ic), h('span', label));

  const search = h('input', {
    type: 'search', placeholder: t('app.searchPlaceholder'), 'aria-label': t('app.search'),
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim();
      if (/^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(q)) navigate(`/browse/${q.toUpperCase()}`);
      else navigate(`/${state.isAgent ? 'issues' : 'requests'}?q=${encodeURIComponent(q)}`);
    },
  });

  const userBtn = h('button.topbar-user', {
    type: 'button', 'aria-label': u.displayName,
    onclick: (e) => dropdown(e.currentTarget, [
      { label: t('app.profile'), icon: icon('user'), onClick: () => navigate('/profile') },
      ...(state.isAdmin ? [{ label: t('nav.admin'), icon: icon('settings'), onClick: () => navigate('/admin') }] : []),
      '-',
      { label: 'Deutsch', active: getLang() === 'de', onClick: () => setLanguage('de') },
      { label: 'English', active: getLang() === 'en', onClick: () => setLanguage('en') },
      '-',
      { label: t('app.logout'), icon: icon('logout'), onClick: async () => { await api.logout(); state.user = null; navigate('/login'); } },
    ], { align: 'right' }),
  }, avatar(u, 'sm'));

  const topbar = h('header.topbar',
    h('a.brand', { href: '/', 'data-link': '' }, h('img', { src: '/logo.svg', alt: '', width: 24, height: 24 }), h('span', state.boot.app.title || 'Helfi.Space')),
    state.isAgent ? h('nav.topnav',
      h('a', { href: '/my', 'data-link': '', class: path === '/my' ? 'active' : '' }, t('nav.myWork')),
      h('a', { href: '/issues', 'data-link': '', class: path === '/issues' ? 'active' : '' }, t('nav.list')),
    ) : null,
    (state.isAgent || state.boot.allowSelfService) ? h('button.btn.btn-primary', { type: 'button', onclick: () => openCreateDialog() }, icon('plus'), t('app.create')) : null,
    h('div.spacer'),
    h('div.topbar-search', icon('search'), search),
    userBtn,
  );

  let sidebar;
  if (state.isAgent) {
    sidebar = h('aside.sidebar',
      p ? h('div.sidebar-project',
        h('div.project-avatar', p.key.slice(0, 2)),
        h('div', h('div.project-name', p.name), h('div.project-sub', p.key)),
        state.projects.length > 1 ? h('button.btn-icon', {
          type: 'button', title: t('nav.projects'),
          onclick: (e) => dropdown(e.currentTarget, state.projects.map((pr) => ({
            label: `${pr.name} (${pr.key})`, active: pr.key === p.key,
            onClick: () => { state.project = pr; route(); },
          }))),
        }, icon('chevron-down')) : null,
      ) : null,
      h('div.sidebar-label', t('nav.planning')),
      nav('/board', t('nav.board'), 'board', path === '/board'),
      nav(`/issues?project=${p?.key || ''}`, t('nav.list'), 'list', path === '/issues'),
      nav('/my', t('nav.myWork'), 'inbox', path === '/my'),
      state.isAdmin ? h('div.sidebar-label', t('nav.admin')) : null,
      state.isAdmin ? nav('/admin', t('app.settings'), 'settings', path.startsWith('/admin')) : null,
      h('div.sidebar-foot', `Helfi.Space ${state.boot.app.version}`),
    );
  } else {
    sidebar = h('aside.sidebar',
      nav('/requests', t('nav.myRequests'), 'inbox', path === '/requests'),
      h('div.sidebar-foot', `Helfi.Space ${state.boot.app.version}`),
    );
  }

  const warnings = (state.boot.warnings || []).map((w) => h('div.banner.banner-warn', icon('warning'), t(`warn.${w.code}`, w)));
  const m = state.boot.mfa;
  if (m && m.mode === 'external' && !m.enabled && u.source !== 'oidc' && path !== '/profile') {
    warnings.push(h('div.banner.banner-info', icon('shield'), h('span', t('mfa.banner')), h('a', { href: '/profile', 'data-link': '' }, t('mfa.setup'))));
  }
  return h('div.shell', topbar, h('div.body', sidebar, h('div.main', warnings, content)));
}

start().catch((e) => { console.error(e); toast(e.message, 'error'); });
