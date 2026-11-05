// Bottom sheet: slides up, backdrop, drag handle, swipe down / Esc / back closes, focus stays inside.
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';

let active = null;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export const sheetOpen = () => !!active;

/**
 * Open a sheet. content: node(s); footer: optional node(s) fixed at the bottom.
 * Returns { el, body, close }.
 */
export function openSheet({ title, content, footer = null, onClose, className = '' } = {}) {
  // Replacing an open sheet keeps its history entry
  const reuseEntry = !!active;
  if (active) dismissSheet({ fromHistory: true });
  const titleId = `sheet-${Math.random().toString(36).slice(2, 8)}`;
  const body = h('div.m-sheet-body', content);
  const closeBtn = h('button.m-iconbtn', { type: 'button', 'aria-label': t('app.close'), onclick: () => close() }, icon('close'));
  const grab = h('div.m-sheet-grab', { 'aria-hidden': 'true' });
  const head = h('div.m-sheet-head', h('h2', { id: titleId }, title), closeBtn);
  const sheet = h('div.m-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1', class: className },
    grab, head, body, footer ? h('div.m-sheet-foot', footer) : null);
  const backdrop = h('div.m-sheet-backdrop', { onclick: () => close() });
  const layer = h('div.m-sheet-layer', backdrop, sheet);
  const opener = document.activeElement;

  const me = { el: sheet, body, layer, opener, onClose, finish: null };
  active = me;
  // Own history entry: the back button/gesture closes the sheet instead of leaving the page
  if (!reuseEntry || !history.state?.sheet) history.pushState({ idx: (Number(history.state?.idx) || 0) + 1, sheet: true }, '', location.href);

  document.getElementById('m-app').inert = true;
  document.body.append(layer);
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('open')));
  // Focus the sheet – unless a field inside already has it (do not steal it while someone types)
  setTimeout(() => { if (!sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true }); }, 30);

  const onKey = (e) => {
    if (active !== me) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);

  me.finish = () => {
    document.removeEventListener('keydown', onKey);
    document.getElementById('m-app').inert = false;
    layer.classList.remove('open');
    layer.classList.add('closing');
    sheet.style.transform = '';
    setTimeout(() => layer.remove(), reduceMotion() ? 0 : 260);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    onClose?.();
  };

  // Swipe down on the handle/header (or on the content when it is scrolled to the top)
  let drag = null;
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const inBody = body.contains(e.target);
    if (inBody && body.scrollTop > 0) return;
    drag = { y0: e.touches[0].clientY, t0: Date.now(), dy: 0, inBody, active: false };
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const dy = e.touches[0].clientY - drag.y0;
    if (!drag.active) {
      if (dy < 6) { if (dy < -6) drag = null; return; }
      drag.active = true;
      sheet.classList.add('dragging');
    }
    e.preventDefault();
    drag.dy = Math.max(0, dy);
    sheet.style.transform = `translate3d(0,${drag.dy}px,0)`;
  }, { passive: false });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    sheet.classList.remove('dragging');
    if (!d.active) return;
    const v = d.dy / Math.max(1, Date.now() - d.t0);
    if (d.dy > sheet.offsetHeight * 0.25 || (v > 0.6 && d.dy > 30)) close();
    else sheet.style.transform = '';
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);

  function close() {
    if (active !== me) return;
    // Leave the sheet's history entry; popstate then calls dismissSheet
    if (history.state?.sheet) history.back();
    else dismissSheet({ fromHistory: true });
  }
  me.close = close;
  return { el: sheet, body, close };
}

/** Close the open sheet. fromHistory: its history entry is already gone (or is reused by the router). */
export function dismissSheet({ fromHistory = true } = {}) {
  const me = active;
  if (!me) return;
  active = null;
  if (!fromHistory && history.state?.sheet) history.replaceState({ idx: Math.max(0, (Number(history.state.idx) || 1) - 1) }, '', location.href);
  me.finish();
}
