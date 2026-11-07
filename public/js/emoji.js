// Emojis in text fields: picker button with search and “:shortname” suggestions while typing.
// Rendered with the operating system's emoji font – nothing is loaded.
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
  } catch { /* storage unavailable – ignore */ }
}

/** Search by short name and keywords (German/English); better matches first. */
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
  // custom editor (e.g. knowledge article): inserts at the remembered position itself
  if (typeof ta.insertEmoji === 'function') { ta.insertEmoji(e.char); remember(e); return; }
  ta.focus();
  ta.setRangeText(e.char, start, end, 'end');
  ta.dispatchEvent(new Event('input'));
  remember(e);
}

/** Open the picker below the button. */
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
  // if it does not fit below, open upwards
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
  // in the capture phase so that Esc does not also close a dialog
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
  // Arrow keys in the grid
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

/** Check text before the caret for “:short” → { start, query } */
export function shortcodeAt(text, caret) {
  const before = text.slice(0, caret);
  const m = /(^|[\s([{"'])(:[a-z0-9_+\-äöüß]{2,30})$/i.exec(before);
  return m ? { start: caret - m[2].length, query: m[2].slice(1) } : null;
}

/** Fully typed short name “:thumbsup:” → emoji */
export function completedShortcode(text, caret) {
  const m = /(^|[\s([{"'])(:([a-z0-9_+-]{1,30}):)$/i.exec(text.slice(0, caret));
  const e = m && byCode.get(m[3].toLowerCase());
  return e ? { start: caret - m[2].length, emoji: e } : null;
}

// Classic smileys → emoji (only when standalone: start/whitespace before, whitespace after)
export const EMOTICONS = {
  ':-)': '🙂', ':)': '🙂', ';-)': '😉', ';)': '😉', ':-D': '😄', ':D': '😄', ':-(': '🙁', ':(': '🙁',
  ':-P': '😛', ':P': '😛', ':p': '😛', ':-O': '😮', ':O': '😮', ':o': '😮', '<3': '❤️', '(y)': '👍', '(Y)': '👍',
};
const EMOTICON_LIST = Object.keys(EMOTICONS).sort((a, b) => b.length - a.length);

/** Is pos inside code (```-block or `inline`)? Nothing is converted there. */
export function inCode(text, pos) {
  const before = text.slice(0, pos);
  if (((before.match(/^\s*```/gm) || []).length % 2) === 1) return true;
  const line = before.slice(before.lastIndexOf('\n') + 1);
  return ((line.match(/`/g) || []).length % 2) === 1;
}

/**
 * Standalone smiley ending exactly at end → { start, original, char }.
 * next: the following character ('' = end of text, e.g. before submitting). In technical texts “<3” often means
 * “less than 3” (“response time <3 s”) – it is only converted at the end of a line or the text.
 */
export function emoticonBefore(text, end, next = '') {
  if (inCode(text, end)) return null;
  for (const e of EMOTICON_LIST) {
    const start = end - e.length;
    if (start < 0 || text.slice(start, end) !== e) continue;
    if (start > 0 && !/\s/.test(text[start - 1])) continue;
    if (e === '<3' && next !== '' && next !== '\n') return null;
    return { start, original: e, char: EMOTICONS[e] };
  }
  return null;
}

/** Suggestions while typing “:short” */
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
  // Last automatic conversion – Ctrl+Z undoes it
  let last = null;
  let converting = false;
  const convertAt = (end, caretAfter, next) => {
    const hit = emoticonBefore(ta.value, end, next);
    if (!hit) return false;
    converting = true;
    ta.setRangeText(hit.char, hit.start, end, 'preserve');
    converting = false;
    const pos = caretAfter - hit.original.length + hit.char.length;
    ta.setSelectionRange(pos, pos);
    last = { ...hit };
    return true;
  };
  /** Smiley at the very end (before submitting / when leaving the field) */
  const convertTrailing = () => {
    const trimmed = ta.value.replace(/\s+$/, '');
    if (!emoticonBefore(trimmed, trimmed.length, '')) return;
    convertAt(trimmed.length, ta.selectionStart, '');
    // others (e.g. draft storage) should see the new text – skip our own handling
    converting = true;
    try { ta.dispatchEvent(new Event('input')); } finally { converting = false; }
  };
  ta.addEventListener('input', (ev) => {
    if (converting) return;
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) { close(); return; }
    last = null;
    // space/line break just typed → convert the smiley before it
    if (ev.inputType !== 'insertFromPaste' && caret > 0 && /\s/.test(ta.value[caret - 1]) && convertAt(caret - 1, caret, ta.value[caret - 1])) { close(); return; }
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
  // Capture phase: before other shortcuts (Ctrl+Enter, Esc in dialogs)
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && last
      && ta.value.slice(last.start, last.start + last.char.length) === last.char) {
      e.preventDefault();
      const delta = last.original.length - last.char.length;
      const caret = ta.selectionStart;
      ta.setRangeText(last.original, last.start, last.start + last.char.length, 'preserve');
      ta.setSelectionRange(caret + delta, caret + delta);
      last = null;
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) convertTrailing();
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
  ta.addEventListener('blur', () => { convertTrailing(); setTimeout(close, 150); });
}

/** Button that opens the picker */
export function emojiButton(ta) {
  return h('button.btn.btn-subtle.small.emoji-btn', {
    type: 'button', title: t('emoji.button'), 'aria-label': t('emoji.button'),
    onclick: (e) => openEmojiPicker(e.currentTarget, ta),
  }, '🙂');
}

/** Text field with emoji button in the corner and short-name suggestions */
export function withEmoji(ta) {
  enableEmojiShortcodes(ta);
  return h('div.emoji-wrap', ta, emojiButton(ta));
}

/**
 * Emojis in the formatted comment field (contenteditable), as in plain text fields:
 * ":)" + space → 🙂, ":tada:" → 🎉, and ":dau" suggests 👍 (↑/↓ + Enter/Tab, Esc). Not inside code.
 */
export function enableEmojiShortcodesRich(area) {
  let box = null;
  let items = [];
  let active = 0;
  let range = null; // { node, start, end }
  const close = () => { box?.remove(); box = null; items = []; range = null; };
  const caretNode = () => {
    const s = window.getSelection();
    if (!s.rangeCount || !s.isCollapsed) return null;
    const r = s.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== 3 || !area.contains(node) || node.parentElement.closest('pre,code')) return null;
    return { s, node, caret: r.startOffset };
  };
  const setCaret = (s, node, pos) => {
    const rr = document.createRange();
    rr.setStart(node, Math.min(pos, node.length));
    rr.collapse(true);
    s.removeAllRanges(); s.addRange(rr);
  };
  const choose = (e) => {
    if (!range) return;
    const { node, start, end } = range;
    close();
    node.replaceData(start, end - start, e.char);
    setCaret(window.getSelection(), node, start + e.char.length);
    remember(e);
    area.dispatchEvent(new Event('input'));
  };
  const drawBox = () => {
    if (!box) { box = h('div.menu.emoji-suggest', { role: 'listbox' }); document.body.append(box); }
    const rr = document.createRange();
    rr.setStart(range.node, range.start); rr.setEnd(range.node, range.end);
    const r = rr.getBoundingClientRect();
    box.style.left = `${r.left + window.scrollX}px`;
    box.style.top = `${r.bottom + window.scrollY + 4}px`;
    mount(box, items.map((e, i) => h('button.menu-item', {
      type: 'button', role: 'option', class: i === active ? 'active' : '', tabindex: -1,
      onmousedown: (ev) => { ev.preventDefault(); choose(e); },
    }, h('span.emoji-big', e.char), h('span', `:${e.code}:`))));
  };
  area.addEventListener('input', (ev) => {
    if (ev.inputType && !ev.inputType.startsWith('insert')) { close(); return; }
    const c = caretNode();
    if (!c) { close(); return; }
    const { s, node, caret } = c;
    const text = node.data;
    const prev = text[caret - 1];
    if (ev.inputType !== 'insertFromPaste' && caret > 0 && /\s/.test(prev)) {
      const hit = emoticonBefore(text, caret - 1, prev);
      if (hit) { close(); node.replaceData(hit.start, caret - 1 - hit.start, hit.char); setCaret(s, node, hit.start + hit.char.length + 1); return; }
    }
    const done = completedShortcode(text, caret);
    if (done) { close(); node.replaceData(done.start, caret - done.start, done.emoji.char); setCaret(s, node, done.start + done.emoji.char.length); remember(done.emoji); return; }
    const sc = shortcodeAt(text, caret);
    items = sc ? searchEmojis(sc.query, 8) : [];
    if (!items.length) { close(); return; }
    range = { node, start: sc.start, end: caret };
    active = 0;
    drawBox();
  });
  area.addEventListener('keydown', (e) => {
    if (!box) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopImmediatePropagation();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      drawBox();
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
      e.preventDefault(); e.stopImmediatePropagation();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      close();
    }
  }, true);
  area.addEventListener('blur', () => setTimeout(close, 150));
}
