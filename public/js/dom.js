// Kleine DOM-Hilfen. Texte immer über textContent – nie Benutzerdaten als HTML.
import { t, getLang } from './i18n.js';

/** h('div.card#x', {onclick, title}, child1, 'text', ...) */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m?.[1] || 'div');
  for (const part of (m?.[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

/** SVG-Symbol aus dem Sprite in index.html */
export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Text mit Zeilenumbrüchen und klickbaren Links – ohne HTML zu interpretieren. */
export function richText(text) {
  const wrap = h('div.rich');
  const re = /(https?:\/\/[^\s<>"')]+)/g;
  for (const para of String(text || '').split(/\n{2,}/)) {
    const p = h('p');
    String(para).split('\n').forEach((line, i) => {
      if (i) p.append(h('br'));
      let last = 0;
      for (const m of line.matchAll(re)) {
        p.append(line.slice(last, m.index));
        p.append(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
        last = m.index + m[0].length;
      }
      p.append(line.slice(last));
    });
    wrap.append(p);
  }
  return wrap;
}

const AVATAR_COLORS = ['#0C66E4', '#1F845A', '#AE2E24', '#5E4DB2', '#A54800', '#206A83', '#943D73', '#626F86'];
export function avatar(user, size = 'md') {
  if (!user) return h(`span.avatar.avatar-${size}.avatar-empty`, { title: t('app.unassigned') }, icon('user'));
  const name = user.displayName || user.username || user.email || '?';
  const initials = name.split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return h(`span.avatar.avatar-${size}`, { title: name, style: { background: AVATAR_COLORS[hash % AVATAR_COLORS.length] } }, initials);
}

export function lozenge(status) {
  return h(`span.lozenge.lozenge-${status}`, t(`status.${status}`));
}

export function typeIcon(type) {
  return h(`span.type-icon.type-${type}`, { title: t(`type.${type}`) }, icon(`type-${type}`));
}

export function priorityIcon(p) {
  return h(`span.prio.prio-${p}`, { title: t(`priority.${p}`) }, icon(`prio-${p}`));
}

export function fmtDate(iso, withTime = true) {
  if (!iso) return t('app.emptyValue');
  const d = new Date(iso);
  return d.toLocaleString(getLang() === 'de' ? 'de-DE' : 'en-GB', withTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function relTime(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return t('time.justNow');
  if (diff < 3600) return t('time.minutes', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('time.hours', { n: Math.floor(diff / 3600) });
  if (diff < 172800) return t('time.yesterday');
  if (diff < 86400 * 14) return t('time.days', { n: Math.floor(diff / 86400) });
  return fmtDate(iso, false);
}

export function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

// ---------- Rückmeldungen ----------
export function toast(message, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div#toasts'); document.body.append(host); }
  const el = h(`div.toast.toast-${kind}`, { role: 'status' }, message);
  host.append(el);
  setTimeout(() => el.classList.add('out'), 3500);
  setTimeout(() => el.remove(), 4000);
}

/** Modal-Dialog. Liefert { el, close }. */
export function modal(title, body, { footer = null, wide = false, onClose } = {}) {
  const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } },
    h(`div.modal${wide ? '.modal-wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.modal-head', h('h2', title), h('button.btn-icon', { type: 'button', title: t('app.close'), onclick: close }, icon('close'))),
      h('div.modal-body', body),
      footer ? h('div.modal-foot', footer) : null,
    ));
  document.body.append(overlay);
  document.addEventListener('keydown', esc);
  setTimeout(() => overlay.querySelector('input:not([type=hidden]),textarea,select')?.focus(), 30);
  return { el: overlay, close };
}

/** Einfaches Aufklappmenü an einem Element. items: [{label, onClick, icon, active}] */
export function dropdown(anchor, items, { align = 'left' } = {}) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div.menu', { role: 'menu' }, items.map((it) => it === '-' ? h('div.menu-sep') : h('button.menu-item', {
    type: 'button', role: 'menuitem', class: it.active ? 'active' : '',
    onclick: () => { menu.remove(); it.onClick(); },
  }, it.icon || null, h('span', it.label))));
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  if (align === 'right') menu.style.right = `${document.documentElement.clientWidth - r.right}px`;
  else menu.style.left = `${r.left + window.scrollX}px`;
  document.body.append(menu);
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
  menu.querySelector('.menu-item')?.focus();
  return menu;
}

/** Formularfeld mit Beschriftung */
export function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  if (input.type === 'checkbox') {
    return h('div.field.field-check', input, h('label', { for: id }, label), hint ? h('div.hint', hint) : null);
  }
  return h('div.field', h('label', { for: id }, label), input, hint ? h('div.hint', hint) : null);
}

export function select(options, value, attrs = {}) {
  return h('select', attrs, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
}
