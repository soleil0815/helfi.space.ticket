// Keyboard shortcuts: global (c, /, ?, g+b/i/m) and per page (ticket view, list).
// Never active in input fields, never with Ctrl/Alt/Cmd and not while dialogs are open.
import { h, mount, modal } from './dom.js';
import { t } from './i18n.js';

let page = {}; // Shortcuts of the current page: { key: () => void }
let pendingG = 0;

/** Set shortcuts of the current page (cleared again on page change). */
export function setPageShortcuts(map) { page = map || {}; }
export function clearPageShortcuts() { page = {}; }

// Checkboxes and radio buttons are not text input – shortcuts work there (e.g. x after a click)
const typing = (el) => !!el?.closest?.('input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable],[contenteditable=""]');
// Enter on links, buttons etc. belongs to the browser (open link, trigger button)
const interactive = (el) => !!el?.closest?.('a[href],button,summary,[tabindex],[role=button],[role=link],[role=menuitem],[role=option],[role=tab]');

export function installShortcuts({ isActive, global, isAgent }) {
  document.addEventListener('keydown', (e) => {
    if (!isActive() || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (document.querySelector('.overlay')) return; // Dialog open: the dialog handles Esc itself
    const key = e.key;
    if (pendingG && Date.now() - pendingG < 1500) {
      pendingG = 0;
      const target = global.go?.[key];
      if (target) { e.preventDefault(); target(); }
      return;
    }
    pendingG = 0;
    if (key === 'g') { pendingG = Date.now(); return; }
    if (key === '?') { e.preventDefault(); showHelp(isAgent()); return; }
    if (key === 'Enter' && interactive(e.target)) return;
    const fn = page[key] || global.keys?.[key];
    if (!fn) return;
    // Only intercept Enter if something was actually opened (otherwise the key stays with the browser)
    if (key === 'Enter') { if (fn(e) === true) e.preventDefault(); return; }
    // After j/k, Enter belongs to the highlighted row – so release a previously clicked button
    if ((key === 'j' || key === 'k') && interactive(document.activeElement)) document.activeElement.blur?.();
    e.preventDefault(); fn(e);
  });
}

/** Overview of all shortcuts. */
export function showHelp(agent) {
  // Keys in sequence (“g then b”) or together (“Ctrl + Enter”)
  const kbd = (keys, sep) => h('span.kbd-keys', keys.map((k, i) => [i ? h('span.muted.small', ` ${sep} `) : null, h('kbd', k)]).flat());
  const row = (keys, label, sep = t('keys.then')) => h('tr', h('td', kbd(keys, sep)), h('td', label));
  const section = (title, rows) => [h('h3', title), h('table.kbd-table', h('tbody', rows))];
  const body = h('div.kbd-help',
    section(t('keys.global'), [
      row(['c'], t('keys.create')),
      row(['/'], t('keys.search')),
      agent ? row(['g', 'b'], t('keys.goBoard')) : null,
      agent ? row(['g', 'i'], t('keys.goList')) : null,
      agent ? row(['g', 'm'], t('keys.goMy')) : row(['g', 'm'], t('keys.goRequests')),
      row(['?'], t('keys.help')),
    ]),
    section(t('keys.ticket'), [
      agent ? row(['i'], t('keys.assignMe')) : null,
      agent ? row(['a'], t('keys.assign')) : null,
      row(['m'], t('keys.comment')),
      row(['e'], t('keys.editTitle')),
      agent ? row(['l'], t('keys.labels')) : null,
      agent ? row(['.'], t('keys.actions')) : null,
      row(['Ctrl', 'Enter'], t('keys.saveComment'), '+'),
    ]),
    section(t('keys.list'), [
      row(['j'], t('keys.next')),
      row(['k'], t('keys.prev')),
      row(['o'], t('keys.open')),
      agent ? row(['x'], t('keys.select')) : null,
    ]),
    h('p.muted.small', t('keys.note')));
  modal(t('keys.title'), body);
}

/**
 * Action menu with search (like a small command palette).
 * items: [{ label, group, hint, run }] – Enter runs the first match, arrow keys select.
 */
export function openPalette(items, { placeholder } = {}) {
  const search = h('input.palette-search', { type: 'search', placeholder: placeholder || t('keys.paletteSearch'), autocomplete: 'off', 'aria-label': t('keys.actions') });
  const list = h('div.palette-list', { role: 'listbox' });
  let hits = items;
  let sel = 0;
  const dlg = modal(t('keys.actions'), h('div.palette', search, list));
  dlg.el.classList.add('overlay-palette');
  const run = (it) => { dlg.close(); it.run(); };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    hits = items.filter((it) => !q || `${it.group || ''} ${it.label}`.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, hits.length - 1));
    mount(list, hits.length ? hits.map((it, i) => h('button.palette-item', {
      type: 'button', role: 'option', 'aria-selected': i === sel ? 'true' : 'false', class: i === sel ? 'active' : '',
      onclick: () => run(it), onmouseenter: () => { sel = i; mark(); },
    }, it.group ? h('span.palette-group', it.group) : null, h('span', it.label), it.hint ? h('span.palette-hint', it.hint) : null))
      : h('div.menu-empty', t('keys.noMatch')));
  };
  const mark = () => list.querySelectorAll('.palette-item').forEach((b, i) => { b.classList.toggle('active', i === sel); b.setAttribute('aria-selected', i === sel ? 'true' : 'false'); if (i === sel) b.scrollIntoView({ block: 'nearest' }); });
  search.addEventListener('input', () => { sel = 0; draw(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); mark(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); mark(); }
    if (e.key === 'Enter') { e.preventDefault(); if (hits[sel]) run(hits[sel]); }
  });
  draw();
  setTimeout(() => search.focus(), 30);
}

/** Lists: j/k highlight the next/previous ticket, o/Enter opens it (all tables on the page). */
export function listKeys(open) {
  const rows = () => [...document.querySelectorAll('table.issues tbody tr[data-key]')];
  const move = (d) => {
    const all = rows();
    if (!all.length) return;
    const i = all.findIndex((r) => r.classList.contains('kbd-focus'));
    const next = all[Math.max(0, Math.min(all.length - 1, i < 0 ? 0 : i + d))];
    all.forEach((r) => r.classList.remove('kbd-focus'));
    next.classList.add('kbd-focus');
    next.scrollIntoView({ block: 'nearest' });
  };
  const go = () => { const r = document.querySelector('table.issues tr.kbd-focus[data-key]'); if (!r) return false; open(r.dataset.key); return true; };
  // x: select or deselect the highlighted ticket (multi-select)
  const pick = () => document.querySelector('table.issues tr.kbd-focus input.row-check')?.click();
  return { j: () => move(1), k: () => move(-1), o: go, Enter: go, x: pick };
}
