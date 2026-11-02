// Wissensartikel: eigenes, schlichtes Textformat im Markdown-Stil.
// Gespeichert wird nur Text – angezeigt wird er ausschließlich über DOM-Aufbau (nie innerHTML).
//
//   # Überschrift (1–3)          **fett**  *kursiv*  ++unterstrichen++  ~~durchgestrichen~~  `code`
//   - Liste / 1. Liste / - [ ] Checkliste / - [x] erledigt (Einrückung = Unterliste)
//   > Zitat     ``` Codeblock ```     ---  Trennlinie
//   :::info / :::tip / :::warning … :::   Infobox
//   | Kopf | Kopf |  + Trennzeile |---|---|  Tabelle
//   ![Bildunterschrift|small](/api/kb/images/…)   Bild (small | medium | full)
//   [Text](https://… | /browse/IT-1 | /kb/3)       Link
import { h } from './dom.js';

export const PANEL_KINDS = ['info', 'tip', 'warning'];
export const IMAGE_SIZES = ['small', 'medium', 'full'];
const IMG_SRC = /^\/api\/(kb\/images\/[A-Za-z0-9_-]{16,64}|attachments\/\d+)$/;
const ESCAPABLE = '\\`*[]~+|#>-.:!_()';

/** Erlaubte Link-Ziele: http(s), mailto und Pfade dieser Anwendung */
export function safeHref(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\/[^\s<>"]+$/i.test(u)) return u;
  if (/^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(u)) return u;
  if (/^\/(?!\/)[^\s<>"]*$/.test(u)) return u;
  return null;
}
export const safeImg = (src) => (IMG_SRC.test(String(src || '')) ? src : null);

/** Ticketnummer / KB-Nummer / Adresse → Link-Ziel */
export function linkTarget(input) {
  const v = String(input || '').trim();
  if (/^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(v) && !/^kb-/i.test(v)) return `/browse/${v.toUpperCase()}`;
  const kb = /^kb-?(\d+)$/i.exec(v); if (kb) return `/kb/${kb[1]}`;
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v) && !v.includes('@')) return `https://${v}`;
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return `mailto:${v}`;
  return safeHref(v);
}

// ---------------------------------------------------------------- Lesen (Text → Blöcke)

const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const RE_IMGLINE = /^!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/;

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l || '');
  const splitRow = (l) => {
    let s = l.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = []; let cur = '';
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '\\' && s[k + 1] === '|') { cur += '\\|'; k++; } else if (s[k] === '|') { cells.push(cur.trim()); cur = ''; } else cur += s[k];
    }
    cells.push(cur.trim());
    return cells;
  };
  const startsBlock = (k) => {
    const l = lines[k];
    return /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^:::\s*(info|tip|warning)\s*$/.test(l.trim()) || /^\s*>/.test(l) || RE_LIST.test(l)
      || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || (l.trim().startsWith('|') && isTableSep(lines[k + 1])) || (RE_IMGLINE.test(l.trim()) && !!safeImg(RE_IMGLINE.exec(l.trim())[2]));
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // Codeblock
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    // Infobox
    const panel = /^:::\s*(info|tip|warning)\s*$/.exec(line.trim());
    if (panel) {
      const inner = []; i++; let depth = 0;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (/^:::\s*(info|tip|warning)\s*$/.test(l)) depth++;
        else if (l === ':::') { if (!depth) break; depth--; }
        inner.push(lines[i++]);
      }
      i++;
      out.push({ type: 'panel', kind: panel[1], children: parseBlocks(inner) });
      continue;
    }
    const hd = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hd) { out.push({ type: 'heading', level: Math.min(hd[1].length, 3), text: hd[2] }); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push({ type: 'hr' }); i++; continue; }
    // Tabelle
    if (line.trim().startsWith('|') && isTableSep(lines[i + 1])) {
      const head = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      const n = Math.max(head.length, ...rows.map((r) => r.length));
      const pad = (r) => [...r, ...Array(n - r.length).fill('')];
      out.push({ type: 'table', head: pad(head), rows: rows.map(pad) });
      continue;
    }
    // Zitat
    if (/^\s*>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }
    // Liste (Einrückung → Unterliste)
    if (RE_LIST.test(line)) {
      const items = [];
      while (i < lines.length && RE_LIST.test(lines[i])) {
        const m = RE_LIST.exec(lines[i]);
        items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), check: m[3] === undefined ? null : m[3] !== ' ', text: m[4] });
        i++;
        // Fortsetzungszeilen (eingerückt, kein neuer Punkt) gehören zum Punkt
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !RE_LIST.test(lines[i])) items[items.length - 1].text += `\n${lines[i++].trim()}`;
      }
      out.push(buildList(items));
      continue;
    }
    // Bild in eigener Zeile
    const im = RE_IMGLINE.exec(line.trim());
    if (im && safeImg(im[2])) {
      const [alt, size] = im[1].split('|');
      out.push({ type: 'image', src: im[2], caption: /\.(png|jpe?g|gif|webp)$/i.test(alt.trim()) ? '' : alt.trim(), size: IMAGE_SIZES.includes((size || '').trim()) ? size.trim() : 'full' });
      i++;
      continue;
    }
    // Absatz
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(i))) para.push(lines[i++]);
    out.push({ type: 'para', text: para.join('\n') });
  }
  return out;
}

function buildList(items) {
  // flache Punkte mit Einrückung → verschachtelte Listen
  const root = { type: 'list', ordered: items[0].ordered, check: items[0].check !== null, items: [] };
  const stack = [{ indent: items[0].indent, list: root }];
  for (const it of items) {
    while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (it.indent > top.indent && top.list.items.length) {
      const parent = top.list.items[top.list.items.length - 1];
      const sub = { type: 'list', ordered: it.ordered, check: it.check !== null, items: [] };
      parent.children.push(sub);
      stack.push({ indent: it.indent, list: sub });
      top = stack[stack.length - 1];
    }
    top.list.items.push({ text: it.text, checked: it.check === true, children: [] });
  }
  return root;
}

// ---------------------------------------------------------------- Inline

const INLINE = [
  { re: /\\([\\`*[\]~+|#>\-.:!_()])/y, make: (m) => document.createTextNode(m[1]) },
  { re: /(`+)([\s\S]*?[^`])\1(?!`)/y, make: (m) => h('code', m[2].replace(/^ (.*) $/, '$1')) },
  { re: /!\[([^\]\n]*)\]\(([^)\s]+)\)/y, make: (m) => (safeImg(m[2]) ? h('img', { src: m[2], alt: m[1].split('|')[0], loading: 'lazy' }) : document.createTextNode(m[0])) },
  { re: /\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)\)/y, make: (m, o) => { const href = safeHref(m[2]); if (!href) return inline(m[1], o); const a = h('a', linkAttrs(href, o)); a.append(inline(m[1], { ...o, noAuto: true })); return a; } },
  { re: /\*\*((?:\\.|[^*\\]|\*(?!\*))+?)\*\*/y, make: (m, o) => wrap('strong', m[1], o) },
  { re: /\+\+((?:\\.|[^+\\]|\+(?!\+))+?)\+\+/y, make: (m, o) => wrap('u', m[1], o) },
  { re: /~~((?:\\.|[^~\\]|~(?!~))+?)~~/y, make: (m, o) => wrap('s', m[1], o) },
  { re: /\*((?:\\.|[^*\\\s])(?:(?:\\.|[^*\\])*?(?:\\.|[^*\\\s]))?)\*/y, make: (m, o) => wrap('em', m[1], o) },
  { re: /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/y, make: (m, o) => h('a', linkAttrs(m[1], o), m[1]) },
  { re: /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/y, make: (m) => h('a', { href: `mailto:${m[1]}` }, m[1]) },
];
const linkAttrs = (href, o) => (/^\//.test(href) && !o.edit ? { href, 'data-link': '' } : /^https?:/.test(href) ? { href, target: '_blank', rel: 'noopener noreferrer' } : { href });
function wrap(tag, text, o) { const el = h(tag); el.append(inline(text, o)); return el; }

/** Inline-Text → DocumentFragment */
export function inline(text, o = {}) {
  const frag = document.createDocumentFragment();
  const s = String(text || '');
  let buf = '';
  const flush = () => { if (buf) { const parts = buf.split('\n'); parts.forEach((p, k) => { if (k) frag.append(h('br')); if (p) frag.append(document.createTextNode(p)); }); buf = ''; } };
  let i = 0;
  outer: while (i < s.length) {
    const c = s[i];
    if ('\\`![*+~h@'.includes(c) || /[A-Za-z0-9._%+-]/.test(c)) {
      for (const tk of INLINE) {
        // E-Mail nur an Wortanfang prüfen
        if ((tk.re.source.startsWith('([A-Za-z0-9') || tk.re.source.startsWith('(https?')) && o.noAuto) continue;
        if (tk.re.source.startsWith('([A-Za-z0-9') && i > 0 && /[A-Za-z0-9._%+-]/.test(s[i - 1])) continue;
        if (tk.re.source.startsWith('(https?') && i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) continue;
        tk.re.lastIndex = i;
        const m = tk.re.exec(s);
        if (m) { flush(); frag.append(tk.make(m, o)); i += m[0].length; continue outer; }
      }
    }
    buf += c; i++;
  }
  flush();
  return frag;
}

// ---------------------------------------------------------------- Anzeige / Editor-Inhalt

export const slug = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'abschnitt';

function renderList(b, o) {
  const el = h(b.ordered ? 'ol' : 'ul', b.check ? { class: 'checklist' } : {});
  for (const it of b.items) {
    const li = h('li', b.check ? { 'data-checked': it.checked ? 'true' : 'false' } : {});
    li.append(inline(it.text, o));
    if (!it.text) li.append(h('br'));
    for (const c of it.children) li.append(renderList(c, o));
    el.append(li);
  }
  return el;
}

function renderBlocks(blocks, o, parent) {
  const ids = o.ids || (o.ids = new Map());
  for (const b of blocks) {
    if (b.type === 'para') { const p = h('p'); p.append(inline(b.text, o)); parent.append(p); }
    else if (b.type === 'heading') {
      const el = h(`h${b.level}`); el.append(inline(b.text, o));
      if (!o.edit) { let id = slug(el.textContent); const n = ids.get(id) || 0; ids.set(id, n + 1); if (n) id += `-${n + 1}`; el.id = id; }
      parent.append(el);
    } else if (b.type === 'hr') parent.append(h('hr'));
    else if (b.type === 'code') parent.append(h('pre', h('code', b.text)));
    else if (b.type === 'quote') { const q = h('blockquote'); renderBlocks(b.children.length ? b.children : [{ type: 'para', text: '' }], o, q); parent.append(q); }
    else if (b.type === 'panel') {
      const box = h(`div.kb-panel.kb-panel-${b.kind}`, { 'data-kind': b.kind });
      renderBlocks(b.children.length ? b.children : [{ type: 'para', text: '' }], o, box);
      if (o.edit) box.querySelectorAll('p:empty').forEach((p) => p.append(h('br')));
      parent.append(box);
    } else if (b.type === 'list') parent.append(renderList(b, o));
    else if (b.type === 'table') {
      const cell = (tag, txt) => { const c = h(tag); c.append(inline(txt, o)); if (o.edit && !txt) c.append(h('br')); return c; };
      parent.append(h('div.kb-table', h('table', h('thead', h('tr', b.head.map((x) => cell('th', x)))), h('tbody', b.rows.map((r) => h('tr', r.map((x) => cell('td', x))))))));
    } else if (b.type === 'image') {
      parent.append(h('figure.kb-figure', { 'data-size': b.size, ...(o.edit ? { contenteditable: 'false' } : {}) },
        o.edit ? h('img', { src: b.src, alt: b.caption, draggable: 'false' }) : h('a', { href: b.src, target: '_blank', rel: 'noopener' }, h('img', { src: b.src, alt: b.caption, loading: 'lazy' })),
        b.caption ? h('figcaption', b.caption) : null));
    }
  }
}

/** Text → Element (Ansicht oder, mit { edit: true }, Inhalt für den Editor) */
export function renderDoc(md, o = {}) {
  const root = h('div.kb-doc');
  renderBlocks(parseBlocks(String(md || '').replace(/\r\n?/g, '\n').split('\n')), o, root);
  if (o.edit && !root.firstChild) root.append(h('p', h('br')));
  return root;
}

/** Überschriften für das Inhaltsverzeichnis */
export const headings = (root) => [...root.querySelectorAll('h1, h2, h3')].map((x) => ({ id: x.id, level: Number(x.tagName[1]), text: x.textContent }));

// ---------------------------------------------------------------- Schreiben (DOM → Text)

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'FIGURE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'DL', 'DT', 'DD', 'ADDRESS', 'CENTER', 'DETAILS', 'SUMMARY', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'META', 'LINK', 'TITLE', 'HEAD', 'SVG', 'CANVAS', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'COLGROUP']);
const hasBlocks = (el) => [...el.children].some((c) => BLOCK_TAGS.has(c.tagName));

function escText(s, atLineStart) {
  let out = String(s).replace(/\u00a0/g, ' ').replace(/[\\`*[\]]/g, '\\$&').replace(/~~/g, '\\~\\~').replace(/\+\+/g, '\\+\\+');
  if (atLineStart) out = out.replace(/^(\s*)(#|>|[-+](?=\s)|\d+[.)](?=\s)|:::|---)/, '$1\\$2');
  return out;
}

/** Inline-Inhalt eines Elements → Text. opts.styles: Formatierungen aus style-Angaben übernehmen (beim Einfügen) */
function inlineMd(node, opts, ctx = { code: false }) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { out += ctx.code ? c.data : escText(c.data.replace(/[\t\n\r ]+/g, ' '), false); continue; }
    if (c.nodeType !== 1 || SKIP_TAGS.has(c.tagName)) continue;
    const tag = c.tagName;
    if (tag === 'BR') { out += ctx.cell ? ' ' : '\n'; continue; }
    if (tag === 'IMG') {
      const src = safeImg(c.getAttribute('src'));
      if (src) out += `![${(c.getAttribute('alt') || '').replace(/[[\]|\n]/g, ' ').trim()}](${src})`;
      continue;
    }
    if (BLOCK_TAGS.has(tag) && !['TD', 'TH'].includes(tag)) { const inner = inlineMd(c, opts, ctx).trim(); if (inner) out += (out && !out.endsWith('\n') ? '\n' : '') + inner + '\n'; continue; }
    let inner = inlineMd(c, opts, { ...ctx, code: ctx.code || tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' });
    const st = opts.styles ? (c.getAttribute('data-s') || c.getAttribute('style') || '').toLowerCase() : '';
    const marks = [];
    const weightNormal = /font-weight\s*:\s*(normal|[1-5]00)\b/.test(st);
    if (((tag === 'STRONG' || tag === 'B') && !weightNormal) || /font-weight\s*:\s*(bold|[6-9]00)\b/.test(st)) marks.push('**');
    if (tag === 'EM' || tag === 'I' || /font-style\s*:\s*italic/.test(st)) marks.push('*');
    if (tag === 'U' || tag === 'INS' || /text-decoration[^;]*underline/.test(st)) marks.push('++');
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE' || /text-decoration[^;]*line-through/.test(st)) marks.push('~~');
    if ((tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') && !ctx.code) {
      const raw = c.textContent.replace(/\n/g, ' ');
      if (raw.trim()) { const tick = raw.includes('`') ? '``' : '`'; out += `${tick}${tick.length > 1 ? ' ' : ''}${raw}${tick.length > 1 ? ' ' : ''}${tick}`; }
      continue;
    }
    if (tag === 'A') {
      const href = safeHref(c.getAttribute('href'));
      const text = inner.trim();
      if (href && text) {
        const plain = /^https?:/.test(href) && text === escText(href, false);
        const mail = href.startsWith('mailto:') && text === escText(href.slice(7), false);
        inner = plain ? href : mail ? text : `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
      }
    }
    for (const m of marks) {
      const lead = inner.match(/^\s*/)[0]; const trail = inner.match(/\s*$/)[0];
      const core = inner.trim();
      inner = core ? `${lead}${m}${core}${m}${trail}` : inner;
    }
    out += inner;
  }
  return out;
}

function preText(el) {
  let out = '';
  for (const c of el.childNodes) {
    if (c.nodeType === 3) out += c.data;
    else if (c.nodeType === 1 && c.tagName === 'BR') out += '\n';
    else if (c.nodeType === 1) { const inner = preText(c); out += BLOCK_TAGS.has(c.tagName) && out && !out.endsWith('\n') ? `\n${inner}` : inner; }
  }
  return out.replace(/\u00a0/g, ' ');
}

const indentText = (txt, pre) => txt.split('\n').map((l) => (l ? pre + l : l)).join('\n');

function listMd(el, opts, depth = 0) {
  const ordered = el.tagName === 'OL';
  const check = el.classList.contains('checklist') || [...el.children].some((li) => li.hasAttribute('data-checked') || li.querySelector(':scope > input[type=checkbox]'));
  let n = Number(el.getAttribute('start')) || 1;
  const lines = [];
  let lastPad = '  ';
  for (const li of el.children) {
    if (li.tagName === 'UL' || li.tagName === 'OL') { lines.push(indentText(listMd(li, opts, depth + 1), lastPad)); continue; }
    if (li.tagName !== 'LI') continue;
    const sub = []; const clone = li.cloneNode(true);
    for (const x of [...clone.children]) if (x.tagName === 'UL' || x.tagName === 'OL') { sub.push(x); x.remove(); }
    clone.querySelectorAll('input[type=checkbox]').forEach((x) => x.remove());
    const checked = li.getAttribute('data-checked') === 'true' || !!li.querySelector(':scope > input[type=checkbox]:checked');
    const marker = ordered ? `${n++}.` : '-';
    const box = check ? (checked ? '[x] ' : '[ ] ') : '';
    const text = inlineMd(clone, opts).replace(/\n+$/, '').replace(/^\n+/, '');
    const pad = ' '.repeat(marker.length + 1);
    lastPad = pad;
    lines.push(`${marker} ${box}${text.split('\n').join(`\n${pad}`)}`);
    for (const s of sub) lines.push(indentText(listMd(s, opts, depth + 1), pad));
  }
  return lines.join('\n');
}

function blocksMd(container, opts) {
  const parts = [];
  let run = null; // lose Inline-Inhalte auf Blockebene sammeln
  const flushRun = () => { if (run) { const t = inlineMd(run, opts).replace(/^\n+|\n+$/g, ''); if (t.trim()) parts.push(lineStart(t)); run = null; } };
  const lineStart = (t) => t.split('\n').map((l) => l.replace(/^(\s*)(#|>|[-+](?=\s)|\d+[.)](?=\s)|:::|---|```)/, '$1\\$2')).join('\n');
  for (const c of [...container.childNodes]) {
    if (c.nodeType === 1 && SKIP_TAGS.has(c.tagName)) continue;
    // Inline-Element, das Blöcke enthält (z. B. <b> um alles beim Einfügen aus Google Docs) → wie ein Container
    if (c.nodeType === 1 && !BLOCK_TAGS.has(c.tagName) && c.querySelector([...BLOCK_TAGS].join(','))) { flushRun(); const t = blocksMd(c, opts); if (t.trim()) parts.push(t); continue; }
    const block = c.nodeType === 1 && (BLOCK_TAGS.has(c.tagName) || (c.tagName === 'IMG' && safeImg(c.getAttribute('src')) && !run));
    if (!block) {
      if (c.nodeType === 3 && !c.data.trim() && !run) continue;
      if (c.nodeType === 1 || c.nodeType === 3) { run = run || document.createElement('p'); run.append(c.cloneNode(true)); }
      continue;
    }
    flushRun();
    const tag = c.tagName;
    if (tag === 'HR') parts.push('---');
    else if (/^H[1-6]$/.test(tag)) { const t = inlineMd(c, opts).replace(/\n/g, ' ').trim(); if (t) parts.push(`${'#'.repeat(Math.min(Number(tag[1]), 3))} ${t}`); }
    else if (tag === 'UL' || tag === 'OL') { const t = listMd(c, opts); if (t.trim()) parts.push(t); }
    else if (tag === 'PRE') { const code = preText(c).replace(/\n+$/, ''); parts.push(`\`\`\`\n${code}\n\`\`\``); }
    else if (tag === 'BLOCKQUOTE') { const t = blocksMd(c, opts); if (t.trim()) parts.push(t.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')); }
    else if (tag === 'TABLE') parts.push(tableMd(c, opts));
    else if (tag === 'FIGURE' || tag === 'IMG') {
      const img = tag === 'IMG' ? c : c.querySelector('img');
      const src = safeImg(img?.getAttribute('src'));
      if (src) {
        const cap = (c.querySelector?.('figcaption')?.textContent || (tag === 'IMG' ? '' : img.getAttribute('alt')) || '').replace(/[[\]|\n]/g, ' ').trim();
        const size = c.getAttribute?.('data-size');
        parts.push(`![${cap}${size && size !== 'full' && IMAGE_SIZES.includes(size) ? `|${size}` : ''}](${src})`);
      } else if (tag === 'FIGURE') { const t = blocksMd(c, opts); if (t.trim()) parts.push(t); }
    } else if (tag === 'DIV' && c.classList.contains('kb-panel')) {
      const kind = PANEL_KINDS.includes(c.dataset.kind) ? c.dataset.kind : 'info';
      parts.push(`:::${kind}\n${blocksMd(c, opts)}\n:::`);
    } else if (tag === 'DIV' && c.classList.contains('kb-table')) parts.push(blocksMd(c, opts));
    else if (tag === 'P' || ((tag === 'DIV' || BLOCK_TAGS.has(tag)) && !hasBlocks(c))) {
      const t = inlineMd(c, opts).replace(/^\n+|\n+$/g, '');
      if (t.trim()) parts.push(lineStart(t));
    } else { const t = blocksMd(c, opts); if (t.trim()) parts.push(t); }
  }
  flushRun();
  return parts.join('\n\n');
}

function tableMd(table, opts) {
  const rows = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
  if (!rows.length) return '';
  const cells = rows.map((tr) => [...tr.children].filter((x) => x.tagName === 'TD' || x.tagName === 'TH')
    .map((td) => inlineMd(td, opts, { cell: true }).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()));
  const n = Math.max(...cells.map((r) => r.length), 1);
  const pad = (r) => [...r, ...Array(n - r.length).fill('')];
  const line = (r) => `| ${pad(r).map((x) => x || ' ').join(' | ')} |`;
  return [line(cells[0]), `|${Array(n).fill(' --- ').join('|')}|`, ...cells.slice(1).map(line)].join('\n');
}

/** Editor- oder eingefügter Inhalt → Text */
export function toMarkdown(root, opts = {}) {
  return blocksMd(root, opts).replace(/\n{3,}/g, '\n\n').trim();
}
