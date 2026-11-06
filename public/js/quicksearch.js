// Search with results while typing (top bar on the desktop, "Tickets" tab on phones).
// From 2 characters: up to 8 matches with key, title, status and where they matched; empty field:
// recently opened tickets. ↑/↓ choose, Enter/click opens, Enter without a choice shows all results.
// The field keeps the focus; the list is a listbox for screen readers (aria-activedescendant).
import { api } from './api.js';
import { h, mount, icon, typeIcon, lozenge, highlight } from './dom.js';
import { t } from './i18n.js';
import { recentTickets } from './userdata.js';

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/;
const LIMIT = 8;
let uid = 0;

/**
 * input: search field. Options:
 *  - openTicket(key): open a ticket
 *  - showAll(q): show all results (list page)
 *  - agent: whether the account sees internal notes (only for the match label)
 */
export function attachQuickSearch(input, { openTicket, showAll }) {
  const listId = `qs-${++uid}`;
  const pop = h('div.qs-pop', { id: listId, role: 'listbox', 'aria-label': t('qs.list') });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';

  let options = []; // { el, run }
  let active = -1;
  let timer = null;
  let seq = 0;

  const isOpen = () => pop.isConnected;
  function place() {
    if (!isOpen()) return;
    const r = input.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const width = Math.min(Math.max(r.width, 420), vw - 16);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(8, Math.min(r.right - width, vw - width - 8, r.left))}px`;
    pop.style.top = `${r.bottom + 4}px`;
  }
  function open() {
    if (!isOpen()) {
      document.body.append(pop);
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
    }
    input.setAttribute('aria-expanded', 'true');
    place();
  }
  function close() {
    seq++;
    clearTimeout(timer);
    options = [];
    active = -1;
    if (isOpen()) {
      pop.remove();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    }
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function highlightOption(i) {
    active = i;
    options.forEach((o, n) => {
      o.el.classList.toggle('active', n === i);
      o.el.setAttribute('aria-selected', String(n === i));
    });
    if (options[i]) { options[i].el.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', options[i].el.id); }
    else input.removeAttribute('aria-activedescendant');
  }
  const choose = (run) => { close(); run(); };
  function option(content, run, cls = '') {
    const el = h(`div.qs-item${cls}`, {
      id: `${listId}-${options.length}`, role: 'option', 'aria-selected': 'false',
      onpointerdown: (e) => { e.preventDefault(); choose(run); }, // before the field loses focus
    }, content);
    options.push({ el, run });
    return el;
  }
  const ticketRow = (tk, terms = []) => [
    h('div.qs-line', typeIcon(tk.type), h('span.qs-key', tk.key), h('span.qs-title', highlight(tk.title, terms)), tk.status ? lozenge(tk.status) : null),
    tk.match && tk.match.source !== 'title'
      ? h('div.qs-match', { class: tk.match.source === 'internal' ? 'internal' : '' },
        h('span.qs-src', tk.match.source === 'comment' || tk.match.source === 'internal' ? t(`search.src.${tk.match.source}`, { who: tk.match.author || '—' }) : t(`search.src.${tk.match.source}`)),
        ' ', highlight(tk.match.text, terms))
      : null,
  ];

  function render(parts) {
    options = [];
    const nodes = [];
    for (const p of parts) {
      if (p.group) nodes.push(h('div.qs-group', p.group));
      else if (p.empty) nodes.push(h('div.qs-empty', p.empty));
      else nodes.push(option(p.content, p.run, p.cls || ''));
    }
    if (!nodes.length) { close(); return; }
    mount(pop, nodes);
    open();
    highlightOption(-1);
  }

  function showRecent() {
    const recent = recentTickets();
    if (!recent.length) { close(); return; }
    render([{ group: t('qs.recent') }, ...recent.map((tk) => ({ content: ticketRow(tk), run: () => openTicket(tk.key) }))]);
  }

  async function search(q) {
    const my = ++seq;
    const direct = KEY_RE.test(q) ? q.toUpperCase() : null;
    const head = direct ? [{ content: h('div.qs-line', icon('chevron-right'), h('span', t('qs.open', { key: direct }))), run: () => openTicket(direct), cls: '.qs-direct' }] : [];
    let r;
    try { r = await api.tickets({ q, limit: LIMIT, sort: 'relevance' }); } catch { r = { tickets: [] }; }
    if (my !== seq || document.activeElement !== input) return;
    const terms = r.searchTerms || q.split(/\s+/).filter(Boolean);
    const hits = (r.tickets || []).filter((tk) => tk.key !== direct).slice(0, LIMIT);
    render([
      ...head,
      ...(hits.length ? [{ group: t('qs.results') }, ...hits.map((tk) => ({ content: ticketRow(tk, terms), run: () => openTicket(tk.key) }))] : (direct ? [] : [{ empty: t('link.noResults') }])),
      { content: h('div.qs-line', icon('search'), h('span', t('qs.all', { q }))), run: () => showAll(q), cls: '.qs-all' },
    ]);
  }

  function update() {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { seq++; showRecent(); return; }
    timer = setTimeout(() => search(q), 180);
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', () => { if (!isOpen()) update(); });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));
  // Capture: before the field's own Enter/Escape handling
  input.addEventListener('keydown', (e) => {
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!isOpen()) { update(); return stop(); }
      if (!options.length) return undefined;
      stop();
      const n = options.length;
      return highlightOption(e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
    }
    if (e.key === 'Enter' && isOpen() && active >= 0 && options[active]) { stop(); return choose(options[active].run); }
    if (e.key === 'Enter') { close(); return undefined; } // the field's own Enter: all results / direct number
    if (e.key === 'Escape' && isOpen()) { stop(); close(); }
    return undefined;
  }, true);

  return { close };
}
