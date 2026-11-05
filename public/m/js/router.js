// Mobile UI: router with a page stack (history.pushState), slide transitions,
// edge swipe back and kept scroll positions.
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { sheetOpen, dismissSheet } from './sheet.js';

const routes = [];
let stage = null;
let onChange = () => {};
let idx = 0; // position of the current entry in this tab's history (history.state.idx)
let current = null; // { idx, url, el, route }
// Rendered pages per history position: back shows them again instantly with their scroll position
const cache = new Map();
const CACHE_MAX = 8;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Register a route. def: { path: RegExp, render(page, ctx), root?: (state) => bool (tab page: tab bar, no back button),
 * bare?: bool (no top bar), title?: () => string, parent?: string (target of "back" without history) }
 */
export function route(def) { routes.push(def); }

export function startRouter(stageEl, { changed } = {}) {
  stage = stageEl;
  onChange = changed || onChange;
  idx = Number(history.state?.idx) || 0;
  history.replaceState({ idx }, '', location.href);
  window.addEventListener('popstate', (e) => {
    // A bottom sheet has its own history entry: "back" closes it
    if (sheetOpen()) { dismissSheet({ fromHistory: true }); return; }
    const target = Number(e.state?.idx) || 0;
    const dir = target < idx ? 'back' : 'forward';
    idx = target;
    show(location.pathname + location.search, dir);
  });
  installSwipeBack();
  show(location.pathname + location.search, 'none');
}

const sameOrigin = (url) => /^\/m(\/|$|\?)/.test(url);

/** Go to an address of the mobile UI. anim: 'auto' | 'none' | 'forward' */
export function go(url, { replace = false, anim = 'auto' } = {}) {
  if (!sameOrigin(url)) { location.assign(url); return; }
  if (sheetOpen()) {
    // Navigating from inside a sheet: its history entry becomes the new page
    dismissSheet({ fromHistory: true });
    idx = Number(history.state?.idx) || idx;
    replace = true;
  }
  if (current) saveScroll(current);
  if (replace) history.replaceState({ idx }, '', url);
  else {
    idx += 1;
    history.pushState({ idx }, '', url);
  }
  for (const k of [...cache.keys()]) if (k >= idx) cache.delete(k);
  let dir = anim === 'auto' ? 'forward' : anim;
  const target = find(new URL(url, location.origin).pathname);
  // Switching between tabs: no slide
  if (anim === 'auto' && current && isRoot(current.route) && target && isRoot(target.route)) dir = 'none';
  if (replace && anim === 'auto') dir = 'none';
  show(url, dir);
}

/** "Back": previous page of the history, otherwise the parent page */
export function back() {
  if (idx > 0) history.back();
  else go(current?.route?.parent || '/m', { replace: true, anim: 'none' });
}

export const canGoBack = () => !!current && !isRoot(current.route);

/** Update the address of the current page (filters, search) without rebuilding it */
export function replaceUrl(url) {
  history.replaceState({ idx }, '', url);
  if (current) { current.url = url; const c = cache.get(idx); if (c) c.url = url; }
}

/** Forget rendered pages (after sign-in/out, language change) and build the current one again */
export function rerender() {
  cache.clear();
  if (current) show(location.pathname + location.search, 'none', { fresh: true });
}
export function clearCache() { cache.clear(); }

// Data changed (e.g. a ticket was edited): pages kept in the cache refresh themselves when shown again
let changedAt = 0;
export function dataChanged() { changedAt = Date.now(); }

let rootCheck = () => false;
export function setRootCheck(fn) { rootCheck = fn; }
const isRoot = (r) => !!r && rootCheck(r);

function find(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/m';
  for (const r of routes) {
    const m = r.path.exec(p);
    if (m) return { ...r, match: m };
  }
  return null;
}

function saveScroll(entry) {
  const sc = entry.el.querySelector('.m-scroll');
  const c = cache.get(entry.idx);
  if (sc && c) c.scroll = sc.scrollTop;
}

/** Page frame: top bar (back, title, action) and scroll area */
function createPage(r) {
  const root = isRoot(r);
  const titleEl = h('h1.m-title');
  const actions = h('div.m-actions');
  const backBtn = root ? null : h('button.m-iconbtn.m-back', { type: 'button', 'aria-label': t('m.back'), onclick: () => back() }, icon('arrow-left'));
  const bar = r.bare ? null : h('header.m-topbar', { class: root ? 'is-root' : '' }, backBtn, titleEl, actions);
  const body = h('div.m-body');
  const scroll = h('div.m-scroll', body);
  const el = h('section.m-page', { class: [root && !r.bare ? 'has-tabs' : '', r.bare ? 'is-bare' : ''].filter(Boolean).join(' ') }, bar, scroll);
  const page = {
    el, body, scroll,
    title(text) { titleEl.textContent = text; if (!r.bare) document.title = `${text} – ${document.body.dataset.appTitle || 'Helfi.Space'}`; },
    action(...nodes) { actions.replaceChildren(...nodes.filter(Boolean)); },
    isActive: () => current?.el === el,
  };
  return page;
}

async function show(url, dir, { fresh = false } = {}) {
  const u = new URL(url, location.origin);
  const r = find(u.pathname) || find('/m/404');
  const prev = current;
  const cached = !fresh && cache.get(idx);
  let el; let page = null;
  if (cached && cached.url === url && cached.el !== prev?.el) {
    el = cached.el;
  } else {
    page = createPage(r);
    el = page.el;
    cache.set(idx, { url, el, scroll: 0, page, at: Date.now() });
    while (cache.size > CACHE_MAX) cache.delete(Math.min(...cache.keys()));
  }
  current = { idx, url, el, route: r };
  onChange(r, u);

  const swiped = swipe.committed && swipe.prevEl === el;
  transition(prev?.el && prev.el !== el ? prev.el : null, el, swiped ? 'none' : dir);
  swipe.committed = false; swipe.prevEl = null;

  if (page) {
    if (r.title) page.title(r.title());
    try {
      await r.render(page, { params: u.searchParams, match: r.match, url: u });
    } catch (e) {
      if (!page.isActive() && e?.status === 401) return;
      page.body.replaceChildren(errorState(e, () => { cache.delete(idx); show(url, 'none', { fresh: true }); }));
    }
  } else {
    const c = cache.get(idx);
    const sc = el.querySelector('.m-scroll');
    if (sc && c) sc.scrollTop = c.scroll || 0;
    if (c?.page && c.page.el === el) document.title = c.page.el.querySelector('.m-title')?.textContent || document.title;
    // Shown again after a change elsewhere: reload quietly (keeps the scroll position)
    if (c && c.at < changedAt && c.page?.refresh) {
      c.at = Date.now();
      c.page.refresh().catch(() => { /* the page keeps its content; pull to refresh retries */ });
    }
  }
}

export function errorState(e, retry) {
  const notFound = e?.status === 404;
  return h('div.m-empty',
    h('div.m-empty-icon', icon(notFound ? 'search' : 'warning')),
    h('p.m-empty-title', notFound ? t('m.notFound') : t('app.error')),
    notFound ? null : h('p.m-empty-text', e?.message || t('m.offline')),
    retry && !notFound ? h('button.m-btn', { type: 'button', onclick: retry }, icon('refresh'), t('m.retry')) : null);
}

// ---------- Transitions ----------
function transition(oldEl, newEl, dir) {
  if (!newEl.isConnected) stage.append(newEl);
  newEl.classList.remove('m-leaving');
  newEl.style.transform = '';
  newEl.removeAttribute('aria-hidden');
  newEl.inert = false;
  if (!oldEl) { cleanupStage(newEl); return; }
  oldEl.inert = true;
  oldEl.setAttribute('aria-hidden', 'true');
  if (dir === 'none' || reduceMotion()) { oldEl.remove(); cleanupStage(newEl); return; }
  // Forward: the new page comes in from the right over the old one. Back: the old page leaves to the right.
  const front = dir === 'back' ? oldEl : newEl;
  if (dir === 'back') stage.append(oldEl); // keep the leaving page on top
  front.classList.add('m-front');
  newEl.classList.add(dir === 'back' ? 'm-anim-under-in' : 'm-anim-in');
  oldEl.classList.add(dir === 'back' ? 'm-anim-out' : 'm-anim-under-out', 'm-leaving');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    oldEl.classList.remove('m-anim-out', 'm-anim-under-out', 'm-front', 'm-leaving');
    newEl.classList.remove('m-anim-in', 'm-anim-under-in', 'm-front');
    oldEl.remove();
    cleanupStage(newEl);
  };
  front.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 450);
}

function cleanupStage(keep) {
  for (const el of [...stage.children]) if (el !== keep && !el.classList.contains('m-leaving')) el.remove();
}

// ---------- Edge swipe: back (the installed app has no browser gesture) ----------
const swipe = { committed: false, prevEl: null };
function installSwipeBack() {
  let s = null;
  const reset = (el, prevEl) => {
    for (const x of [el, prevEl]) if (x) { x.style.transition = ''; x.style.transform = ''; x.classList.remove('m-swiping', 'm-swipe-under'); }
  };
  stage.addEventListener('touchstart', (e) => {
    s = null;
    if (e.touches.length !== 1 || sheetOpen() || !canGoBack()) return;
    const tp = e.touches[0];
    if (tp.clientX > 20) return;
    s = { x0: tp.clientX, y0: tp.clientY, t0: Date.now(), dx: 0, active: false, el: current.el, prevEl: null };
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!s) return;
    const tp = e.touches[0];
    const dx = tp.clientX - s.x0; const dy = tp.clientY - s.y0;
    if (!s.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { s = null; return; }
      if (dx < 12 || dx < Math.abs(dy) * 1.4) return;
      s.active = true;
      // Show the previous page underneath if it is still rendered
      const prev = cache.get(idx - 1);
      if (prev && idx > 0 && !prev.el.isConnected) {
        s.prevEl = prev.el;
        prev.el.classList.add('m-swipe-under');
        stage.prepend(prev.el);
        const sc = prev.el.querySelector('.m-scroll');
        if (sc) sc.scrollTop = prev.scroll || 0;
      }
      s.el.classList.add('m-front', 'm-swiping');
    }
    e.preventDefault();
    s.dx = Math.max(0, dx);
    const w = stage.clientWidth;
    s.el.style.transform = `translate3d(${s.dx}px,0,0)`;
    if (s.prevEl) s.prevEl.style.transform = `translate3d(${(s.dx - w) * 0.3}px,0,0)`;
  }, { passive: false });
  const end = () => {
    if (!s) return;
    const st = s; s = null;
    if (!st.active) return;
    const w = stage.clientWidth;
    const v = st.dx / Math.max(1, Date.now() - st.t0);
    const commit = st.dx > w * 0.35 || (v > 0.5 && st.dx > 40);
    const ms = reduceMotion() ? 0 : 220;
    st.el.style.transition = `transform ${ms}ms ease-out`;
    if (st.prevEl) st.prevEl.style.transition = `transform ${ms}ms ease-out`;
    if (commit) {
      st.el.style.transform = 'translate3d(100%,0,0)';
      if (st.prevEl) st.prevEl.style.transform = 'translate3d(0,0,0)';
      setTimeout(() => {
        st.el.classList.add('m-leaving');
        swipe.committed = true; swipe.prevEl = st.prevEl;
        reset(st.prevEl);
        back();
        setTimeout(() => { st.el.remove(); reset(st.el); }, 0);
      }, ms);
    } else {
      st.el.style.transform = '';
      if (st.prevEl) st.prevEl.style.transform = `translate3d(${-w * 0.3}px,0,0)`;
      setTimeout(() => { reset(st.el); if (st.prevEl) { reset(st.prevEl); st.prevEl.remove(); } st.el.classList.remove('m-front'); }, ms);
    }
  };
  stage.addEventListener('touchend', end);
  stage.addEventListener('touchcancel', end);
}
