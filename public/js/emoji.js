// Emojis in Textfeldern: Auswahl-Knopf mit Suche und „:kurzname“-Vorschläge beim Tippen.
// Dargestellt mit der Emoji-Schrift des Betriebssystems – es wird nichts nachgeladen.
import { h, mount } from './dom.js';
import { t } from './i18n.js';
import { EMOJIS, EMOJI_GROUPS } from './emoji-data.js';

const RECENT_KEY = 'helfi.emoji.recent';
const RECENT_MAX = 16;
const byChar = new Map(EMOJIS.map((e) => [e.char, e]));
const byCode = new Map(EMOJIS.map((e) => [e.code, e]));

function recent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.map((c) => byChar.get(c)).filter(Boolean) : [];
  } catch { return []; }
}
function remember(e) {
  try {
    const list = [e.char, ...recent().map((x) => x.char).filter((c) => c !== e.char)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* Speicher nicht verfügbar – egal */ }
}

/** Suche nach Kurzname und Stichwörtern (deutsch/englisch); bessere Treffer zuerst. */
export function searchEmojis(query, limit = Infinity) {
  const q = String(query || '').trim().toLowerCase().replace(/^:/, '');
  if (!q) return EMOJIS.slice(0, limit);
  const score = (e) => {
    if (e.code === q) return 5;
    if (e.code.startsWith(q)) return 4;
    if (e.words.some((w) => w === q)) return 3;
    if (e.words.some((w) => w.startsWith(q))) return 2;
    if (e.code.includes(q) || e.words.some((w) => w.includes(q))) return 1;
    return 0;
  };
  return EMOJIS.map((e, i) => [score(e), i, e]).filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, limit).map(([, , e]) => e);
}

function insert(ta, e, start, end) {
  ta.focus();
  ta.setRangeText(e.char, start, end, 'end');
  ta.dispatchEvent(new Event('input'));
  remember(e);
}

/** Auswahlfenster unter dem Knopf öffnen. */
export function openEmojiPicker(anchor, ta) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const search = h('input.menu-search', { type: 'search', placeholder: t('emoji.search'), autocomplete: 'off', 'aria-label': t('emoji.search') });
  const list = h('div.emoji-list');
  const foot = h('div.emoji-foot', t('emoji.hint'));
  const menu = h('div.menu.menu-emoji', { role: 'dialog', 'aria-label': t('emoji.button') }, search, list, foot);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  // passt es nicht nach unten, dann nach oben aufklappen
  const top = r.bottom + 4 + hgt > window.innerHeight && r.top - 4 - hgt > 0 ? r.top - 4 - hgt : r.bottom + 4;
  menu.style.left = `${left + window.scrollX}px`;
  menu.style.top = `${top + window.scrollY}px`;

  const close = (refocus = true) => {
    menu.remove();
    document.removeEventListener('mousedown', off);
    document.removeEventListener('keydown', esc, true);
    if (refocus) ta.focus();
  };
  const off = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(false); };
  // in der Erfassungsphase, damit Esc nicht zusätzlich einen Dialog schließt
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  setTimeout(() => { document.addEventListener('mousedown', off); document.addEventListener('keydown', esc, true); }, 0);

  const pick = (e) => { close(false); insert(ta, e, start, end); };
  const cell = (e) => h('button.emoji-cell', {
    type: 'button', title: `:${e.code}:`, 'aria-label': `${e.char} ${e.code}`,
    onclick: () => pick(e),
    onmouseenter: () => { foot.textContent = `${e.char}  :${e.code}:`; },
    onfocus: () => { foot.textContent = `${e.char}  :${e.code}:`; },
  }, e.char);
  const grid = (items) => h('div.emoji-grid', items.map(cell));
  const draw = () => {
    const q = search.value.trim();
    if (q) {
      const hits = searchEmojis(q);
      mount(list, hits.length ? grid(hits) : h('div.menu-empty', t('emoji.none')));
      return;
    }
    const rec = recent();
    mount(list,
      rec.length ? [h('div.menu-group', t('emoji.recent')), grid(rec)] : null,
      EMOJI_GROUPS.map((g) => [h('div.menu-group', t(`emoji.group.${g}`)), grid(EMOJIS.filter((e) => e.group === g))]));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.emoji-cell')?.click(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('.emoji-cell')?.focus(); }
  });
  // Pfeiltasten im Raster
  list.addEventListener('keydown', (e) => {
    const cells = [...list.querySelectorAll('.emoji-cell')];
    const i = cells.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = 8;
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (!move) return;
    e.preventDefault();
    const next = i + move;
    if (next < 0) search.focus();
    else cells[Math.min(next, cells.length - 1)].focus();
  });
  draw();
  search.focus();
}

/** Text vor der Schreibmarke auf „:kurz“ prüfen → { start, query } */
export function shortcodeAt(text, caret) {
  const before = text.slice(0, caret);
  const m = /(^|[\s([{"'])(:[a-z0-9_+\-äöüß]{2,30})$/i.exec(before);
  return m ? { start: caret - m[2].length, query: m[2].slice(1) } : null;
}

/** Fertig getippter Kurzname „:thumbsup:“ → Emoji */
export function completedShortcode(text, caret) {
  const m = /(^|[\s([{"'])(:([a-z0-9_+-]{1,30}):)$/i.exec(text.slice(0, caret));
  const e = m && byCode.get(m[3].toLowerCase());
  return e ? { start: caret - m[2].length, emoji: e } : null;
}

/** Vorschläge beim Tippen von „:kurz“ */
export function enableEmojiShortcodes(ta) {
  let box = null;
  let items = [];
  let active = 0;
  let range = null;
  const close = () => { box?.remove(); box = null; items = []; };
  const choose = (e) => {
    const r = range;
    close();
    insert(ta, e, r.start, ta.selectionStart);
  };
  const drawBox = () => {
    if (!box) {
      box = h('div.menu.emoji-suggest', { role: 'listbox' });
      document.body.append(box);
    }
    const r = ta.getBoundingClientRect();
    box.style.left = `${r.left + window.scrollX}px`;
    box.style.top = `${r.bottom + window.scrollY + 2}px`;
    mount(box, items.map((e, i) => h('button.menu-item', {
      type: 'button', role: 'option', class: i === active ? 'active' : '', tabindex: -1,
      onmousedown: (ev) => { ev.preventDefault(); choose(e); },
    }, h('span.emoji-big', e.char), h('span', `:${e.code}:`))));
  };
  ta.addEventListener('input', () => {
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) { close(); return; }
    const done = completedShortcode(ta.value, caret);
    if (done) {
      close();
      ta.setRangeText(done.emoji.char, done.start, caret, 'end');
      remember(done.emoji);
      return;
    }
    range = shortcodeAt(ta.value, caret);
    items = range ? searchEmojis(range.query, 8) : [];
    if (!items.length) { close(); return; }
    active = 0;
    drawBox();
  });
  // Erfassungsphase: vor anderen Tastenkürzeln (Strg+Enter, Esc im Dialog)
  ta.addEventListener('keydown', (e) => {
    if (!box) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      drawBox();
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      close();
    }
  }, true);
  ta.addEventListener('blur', () => setTimeout(close, 150));
}

/** Knopf zum Öffnen der Auswahl */
export function emojiButton(ta) {
  return h('button.btn.btn-subtle.small.emoji-btn', {
    type: 'button', title: t('emoji.button'), 'aria-label': t('emoji.button'),
    onclick: (e) => openEmojiPicker(e.currentTarget, ta),
  }, '🙂');
}

/** Textfeld mit Emoji-Knopf in der Ecke und Kurzname-Vorschlägen */
export function withEmoji(ta) {
  enableEmojiShortcodes(ta);
  return h('div.emoji-wrap', ta, emojiButton(ta));
}
