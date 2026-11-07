// @-mentions in the comment field (desktop and mobile).
// Typing "@" and a few letters shows matching people; ↑/↓ + Enter/Tab or a tap inserts "@Name".
// The field shows plain names; encode() turns the picked names into "@[Name](user:ID)" for saving,
// decode() turns saved text (drafts) back into names.
import { api } from './api.js';
import { h, mount, avatar } from './dom.js';
import { t } from './i18n.js';
import { mentionEl } from './kbdoc.js';

const TOKEN = /@\[([^\]\n]{1,120})\]\(user:(\d{1,10})\)/g;
// Text right before the cursor: "@" at the start or after a space/bracket, up to two words
const QUERY = /(?:^|[\s(])@([^\s@[\]()]{0,30}(?: [^\s@[\]()]{1,30})?)$/;
const WORD = /[\p{L}\p{N}_]/u;
let uid = 0;

/**
 * ta: textarea. getKey(): ticket key, isInternal(): internal note? (then only agents are offered)
 * Returns { encode(text), decode(text), close() }.
 */
export function attachMentions(ta, { getKey, isInternal = () => false }) {
  const listId = `mention-${++uid}`;
  const pop = h('div.mention-pop', { id: listId, role: 'listbox', 'aria-label': t('mention.list') });
  const picked = new Map(); // name → user ID
  let items = [];
  let active = 0;
  let query = null; // { text, start } while the list is wanted
  let timer = null;
  let seq = 0;

  ta.setAttribute('aria-autocomplete', 'list');
  ta.setAttribute('aria-controls', listId);
  ta.setAttribute('aria-expanded', 'false');

  const isOpen = () => pop.isConnected;
  function place() {
    if (!isOpen()) return;
    const r = ta.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const width = Math.min(320, vw - 16);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, vw - width - 8))}px`;
    const vh = window.visualViewport?.height || window.innerHeight;
    const below = vh - r.bottom;
    if (below < 240 && r.top > below) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 4}px`; }
    else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 4}px`; }
  }
  function open() {
    if (!isOpen()) {
      document.body.append(pop);
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
    }
    ta.setAttribute('aria-expanded', 'true');
    place();
  }
  function close() {
    seq++;
    clearTimeout(timer);
    query = null;
    items = [];
    if (isOpen()) {
      pop.remove();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    }
    ta.setAttribute('aria-expanded', 'false');
    ta.removeAttribute('aria-activedescendant');
  }
  function highlight(i) {
    active = i;
    pop.querySelectorAll('.mention-item').forEach((el, n) => {
      el.classList.toggle('active', n === i);
      el.setAttribute('aria-selected', String(n === i));
      if (n === i) { el.scrollIntoView({ block: 'nearest' }); ta.setAttribute('aria-activedescendant', el.id); }
    });
  }
  function render(people) {
    items = people;
    if (!people.length) { close(); return; }
    mount(pop, people.map((p, i) => h('div.mention-item', {
      id: `${listId}-${i}`, role: 'option', 'aria-selected': 'false',
      // pointerdown: before the field loses focus (keyboard on phones stays open)
      onpointerdown: (e) => { e.preventDefault(); choose(p); },
    }, avatar(p, 'sm'), h('span.mention-name', p.displayName), p.kind === 'customer' ? h('span.mention-kind', t('mention.customer')) : null)));
    open();
    highlight(0);
  }

  async function lookup(text) {
    const my = ++seq;
    try {
      const { people } = await api.mentionCandidates(getKey(), text, isInternal());
      if (my !== seq || !query) return;
      render(people || []);
    } catch { if (my === seq) close(); }
  }

  function check() {
    if (ta.selectionStart !== ta.selectionEnd) { close(); return; }
    const caret = ta.selectionStart;
    const before = ta.value.slice(Math.max(0, caret - 70), caret);
    const m = QUERY.exec(before);
    if (!m) { close(); return; }
    const text = m[1];
    if (query && query.text === text && query.start === caret - text.length - 1) return;
    query = { text, start: caret - text.length - 1 };
    clearTimeout(timer);
    timer = setTimeout(() => lookup(text), text ? 120 : 0);
  }

  function choose(p) {
    if (!query) return;
    const name = String(p.displayName).replace(/[\]\n]/g, ' ').trim();
    const end = query.start + 1 + query.text.length;
    ta.setRangeText(`@${name} `, query.start, end, 'end');
    picked.set(name, p.id);
    close();
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  ta.addEventListener('input', check);
  ta.addEventListener('click', check);
  ta.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') check(); });
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) close(); }, 150));
  // Capture: before the field's own keys (Ctrl+Enter sends, Enter on phones)
  ta.addEventListener('keydown', (e) => {
    if (!isOpen() || !items.length) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { stop(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { stop(); highlight((active - 1 + items.length) % items.length); }
    else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === 'Tab') { stop(); choose(items[active]); }
    else if (e.key === 'Escape') { stop(); close(); }
  }, true);

  /** "@Name" of picked people → "@[Name](user:ID)"; longer names first ("@Max Muster" before "@Max"). */
  function encode(text) {
    let out = String(text ?? '');
    for (const [name, id] of [...picked].sort((a, b) => b[0].length - a[0].length)) {
      const needle = `@${name}`;
      let result = '';
      let from = 0;
      for (let i = out.indexOf(needle); i !== -1; i = out.indexOf(needle, i + needle.length)) {
        const after = out[i + needle.length];
        if (after && WORD.test(after)) continue; // "@Maxi" is not "@Max"
        result += `${out.slice(from, i)}@[${name}](user:${id})`;
        from = i + needle.length;
      }
      out = result + out.slice(from);
    }
    return out;
  }

  /** Saved text (e.g. a draft) back to plain names – the people stay picked. */
  function decode(text) {
    return String(text ?? '').replace(TOKEN, (m, name, id) => { picked.set(name, Number(id)); return `@${name}`; });
  }

  return { encode, decode, close };
}

/**
 * @-mentions in the formatted comment field (createKbEditor, variant 'comment'):
 * the picked person becomes a name tag in the text, saved as "@[Name](user:ID)" (see kbdoc.js).
 */
export function attachMentionsRich(editor, { getKey, isInternal = () => false }) {
  const area = editor.area;
  const listId = `mention-${++uid}`;
  const pop = h('div.mention-pop', { id: listId, role: 'listbox', 'aria-label': t('mention.list') });
  let items = [];
  let active = 0;
  let query = null; // { text, node, start, end }
  let timer = null;
  let seq = 0;
  area.setAttribute('aria-autocomplete', 'list');
  area.setAttribute('aria-controls', listId);
  area.setAttribute('aria-expanded', 'false');

  const isOpen = () => pop.isConnected;
  function place() {
    if (!isOpen() || !query) return;
    const rr = document.createRange();
    try { rr.setStart(query.node, query.start); rr.setEnd(query.node, query.end); } catch { return; }
    const r = rr.getBoundingClientRect().height ? rr.getBoundingClientRect() : area.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const width = Math.min(320, vw - 16);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, vw - width - 8))}px`;
    const vh = window.visualViewport?.height || window.innerHeight;
    const below = vh - r.bottom;
    if (below < 240 && r.top > below) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 4}px`; }
    else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 4}px`; }
  }
  function open() {
    if (!isOpen()) {
      document.body.append(pop);
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
    }
    area.setAttribute('aria-expanded', 'true');
    place();
  }
  function close() {
    seq++;
    clearTimeout(timer);
    query = null;
    items = [];
    if (isOpen()) {
      pop.remove();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    }
    area.setAttribute('aria-expanded', 'false');
    area.removeAttribute('aria-activedescendant');
  }
  function highlight(i) {
    active = i;
    pop.querySelectorAll('.mention-item').forEach((el, n) => {
      el.classList.toggle('active', n === i);
      el.setAttribute('aria-selected', String(n === i));
      if (n === i) { el.scrollIntoView({ block: 'nearest' }); area.setAttribute('aria-activedescendant', el.id); }
    });
  }
  function render(people) {
    items = people;
    if (!people.length) { close(); return; }
    mount(pop, people.map((p, i) => h('div.mention-item', {
      id: `${listId}-${i}`, role: 'option', 'aria-selected': 'false',
      onpointerdown: (e) => { e.preventDefault(); choose(p); },
    }, avatar(p, 'sm'), h('span.mention-name', p.displayName), p.kind === 'customer' ? h('span.mention-kind', t('mention.customer')) : null)));
    open();
    highlight(0);
  }
  async function lookup(text) {
    const my = ++seq;
    try {
      const { people } = await api.mentionCandidates(getKey(), text, isInternal());
      if (my !== seq || !query) return;
      render(people || []);
    } catch { if (my === seq) close(); }
  }
  function check() {
    const s = window.getSelection();
    if (!s.rangeCount || !s.isCollapsed) { close(); return; }
    const r = s.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== 3 || !area.contains(node) || node.parentElement.closest('pre,code')) { close(); return; }
    const before = node.data.slice(Math.max(0, r.startOffset - 70), r.startOffset);
    const m = QUERY.exec(before);
    if (!m) { close(); return; }
    const text = m[1];
    const start = r.startOffset - text.length - 1;
    if (query && query.text === text && query.node === node && query.start === start) return;
    query = { text, node, start, end: r.startOffset };
    clearTimeout(timer);
    timer = setTimeout(() => lookup(text), text ? 120 : 0);
  }
  function choose(p) {
    if (!query) return;
    const name = String(p.displayName).replace(/[\]\n]/g, ' ').trim();
    const r = document.createRange();
    try { r.setStart(query.node, query.start); r.setEnd(query.node, query.end); } catch { close(); return; }
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    editor.remember();
    close();
    editor.insertNodes(mentionEl(name, p.id, { edit: true }), document.createTextNode(' '));
    area.focus();
  }
  area.addEventListener('input', check);
  area.addEventListener('click', check);
  area.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) check(); });
  area.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== area) close(); }, 150));
  area.addEventListener('keydown', (e) => {
    if (!isOpen() || !items.length) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { stop(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { stop(); highlight((active - 1 + items.length) % items.length); }
    else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === 'Tab') { stop(); choose(items[active]); }
    else if (e.key === 'Escape') { stop(); close(); }
  }, true);
  return { close };
}
