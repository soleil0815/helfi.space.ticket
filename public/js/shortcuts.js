// Tastenkürzel: global (c, /, ?, g+b/i/m) und je Seite (Ticketansicht, Liste).
// Greifen nie in Eingabefeldern, nie mit Strg/Alt/Cmd und nicht bei offenen Dialogen.
import { h, mount, modal } from './dom.js';
import { t } from './i18n.js';

let page = {}; // Kürzel der aktuellen Seite: { taste: () => void }
let pendingG = 0;

/** Kürzel der aktuellen Seite setzen (beim Seitenwechsel wieder leeren). */
export function setPageShortcuts(map) { page = map || {}; }
export function clearPageShortcuts() { page = {}; }

// Kästchen und Auswahlknöpfe sind keine Texteingabe – dort greifen die Kürzel (z. B. x nach einem Klick)
const typing = (el) => !!el?.closest?.('input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable],[contenteditable=""]');

export function installShortcuts({ isActive, global, isAgent }) {
  document.addEventListener('keydown', (e) => {
    if (!isActive() || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (document.querySelector('.overlay')) return; // Dialog offen: Esc regelt der Dialog selbst
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
    const fn = page[key] || global.keys?.[key];
    if (fn) { e.preventDefault(); fn(e); }
  });
}

/** Übersicht aller Kürzel. */
export function showHelp(agent) {
  // Tasten nacheinander („g dann b“) oder zusammen („Strg + Enter“)
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
 * Aktionsmenü mit Suche (wie ein kleines Befehlsfenster).
 * items: [{ label, group, hint, run }] – Enter führt den ersten Treffer aus, Pfeiltasten wählen.
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

/** Listen: j/k markieren das nächste/vorige Ticket, o/Enter öffnet es (alle Tabellen der Seite). */
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
  const go = () => { const r = document.querySelector('table.issues tr.kbd-focus'); if (r) open(r.dataset.key); };
  // x: markiertes Ticket aus- bzw. abwählen (Mehrfachauswahl)
  const pick = () => document.querySelector('table.issues tr.kbd-focus input.row-check')?.click();
  return { j: () => move(1), k: () => move(-1), o: go, Enter: go, x: pick };
}
