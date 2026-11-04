// Editor for knowledge articles: WYSIWYG editing, toolbar, keyboard shortcuts,
// Markdown shortcuts, images via Ctrl+V / drag & drop. Stores text (kbdoc.js), never HTML.
import { api } from './api.js';
import { h, mount, icon, toast, modal, field, dropdown } from './dom.js';
import { t } from './i18n.js';
import { openEmojiPicker } from './emoji.js';
import { renderDoc, toMarkdown, linkTarget, safeImg, PANEL_KINDS, IMAGE_SIZES } from './kbdoc.js';

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Strg+';

export function createKbEditor({ value = '', placeholder = '', onChange = () => {} } = {}) {
  const area = renderDoc(value, { edit: true });
  area.classList.add('kb-editable');
  area.contentEditable = 'true';
  area.spellcheck = true;
  area.setAttribute('role', 'textbox');
  area.setAttribute('aria-multiline', 'true');
  area.dataset.placeholder = placeholder;
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* ignore */ }

  // ---------- Remember selection (menus and dialogs take the focus) ----------
  let saved = null;
  const inArea = (n) => !!n && (n === area || area.contains(n));
  const sel = () => window.getSelection();
  const rememberSel = () => { const s = sel(); if (s.rangeCount && inArea(s.anchorNode)) saved = s.getRangeAt(0).cloneRange(); };
  const restore = () => {
    area.focus({ preventScroll: true });
    if (saved && inArea(saved.startContainer)) { const s = sel(); s.removeAllRanges(); s.addRange(saved); }
  };
  const caretTo = (node, atEnd = false) => {
    const r = document.createRange();
    r.selectNodeContents(node); r.collapse(!atEnd);
    const s = sel(); s.removeAllRanges(); s.addRange(r); saved = r.cloneRange();
  };
  const anchorEl = () => { const s = sel(); const n = s.rangeCount ? s.anchorNode : saved?.startContainer; return n ? (n.nodeType === 1 ? n : n.parentElement) : null; };
  const closest = (selector) => { const el = anchorEl(); const c = el && inArea(el) ? el.closest(selector) : null; return c && inArea(c) ? c : null; };
  /** current block (paragraph, heading, …) */
  const currentBlock = () => {
    let el = anchorEl();
    while (el && el !== area && !/^(P|H[1-6]|PRE|LI|BLOCKQUOTE|DIV|TD|TH|FIGURE)$/.test(el.tagName)) el = el.parentElement;
    return el && el !== area && inArea(el) ? el : null;
  };

  /** Insert node at the caret (instead of insertHTML: the browser would add style attributes) */
  function insertNodes(...nodes) {
    restore();
    const s = sel();
    if (!s.rangeCount) return;
    const r = s.getRangeAt(0);
    r.deleteContents();
    const frag = document.createDocumentFragment();
    frag.append(...nodes);
    const last = frag.lastChild;
    r.insertNode(frag);
    if (last) { r.setStartAfter(last); r.collapse(true); s.removeAllRanges(); s.addRange(r); saved = r.cloneRange(); }
  }

  // ---------- Changes ----------
  let timer;
  const changed = () => { normalize(); updateState(); clearTimeout(timer); timer = setTimeout(() => onChange(getValue()), 300); };
  const exec = (cmd, val = null) => { restore(); document.execCommand(cmd, false, val); rememberSel(); changed(); };

  /** Clean up after every change: empty line at the end, checklist attributes, placeholders */
  function normalize() {
    const last = area.lastElementChild;
    if (!last || !/^P$/.test(last.tagName) || last.classList.length) area.append(h('p', h('br')));
    area.querySelectorAll('ul').forEach((ul) => {
      const check = ul.classList.contains('checklist');
      for (const li of ul.children) {
        if (li.tagName !== 'LI') continue;
        if (check && !li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false');
        if (!check && li.hasAttribute('data-checked')) li.removeAttribute('data-checked');
      }
    });
    area.querySelectorAll('ol').forEach((ol) => { ol.classList.remove('checklist'); for (const li of ol.children) li.removeAttribute('data-checked'); });
    area.querySelectorAll('[style]').forEach((x) => { if (!x.closest('.kb-figure')) x.removeAttribute('style'); });
    area.querySelectorAll('span:not([class])').forEach((x) => { if (!x.attributes.length) x.replaceWith(...x.childNodes); });
    area.querySelectorAll('.kb-panel').forEach((p) => { if (!p.firstElementChild) p.append(h('p', h('br'))); });
    // Code blocks: line breaks as text, always a trailing \n (otherwise the last empty line is invisible)
    area.querySelectorAll('pre').forEach((pre) => {
      pre.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      if (!pre.textContent.endsWith('\n')) pre.append('\n');
    });
    area.classList.toggle('is-empty', !area.textContent.trim() && !area.querySelector('img,hr,table,li'));
  }

  const getValue = () => toMarkdown(area);
  const setValue = (md) => { mount(area, ...renderDoc(md, { edit: true }).childNodes); normalize(); updateState(); };

  // ---------- Block and inline formats ----------
  const BLOCKS = [['p', 'kb.ed.normal'], ['h1', 'kb.ed.h1'], ['h2', 'kb.ed.h2'], ['h3', 'kb.ed.h3'], ['blockquote', 'kb.ed.quote'], ['pre', 'kb.ed.code']];
  function setBlock(tag) {
    restore();
    const quote = closest('blockquote');
    if (quote && tag !== 'blockquote') { quote.replaceWith(...(quote.querySelector('p,h1,h2,h3,pre') ? quote.childNodes : [h('p', ...quote.childNodes)])); }
    if (quote && tag === 'blockquote') { changed(); return; }
    if (tag === 'blockquote' && !closest('pre,li,td,th')) {
      const b = currentBlock();
      if (b && /^(P|H[1-3])$/.test(b.tagName)) {
        const p = h('p', ...b.childNodes); if (!p.firstChild) p.append(h('br'));
        const q = h('blockquote', p); b.replaceWith(q); caretTo(p, true); changed(); return;
      }
    }
    const pre = closest('pre');
    if (pre && tag !== 'pre') {
      const lines = pre.textContent.split('\n');
      const ps = lines.map((l) => h(tag === 'blockquote' ? 'p' : tag, l || h('br')));
      pre.replaceWith(...ps);
      caretTo(ps[0], true);
      if (tag === 'blockquote') document.execCommand('formatBlock', false, '<blockquote>');
      changed();
      return;
    }
    exec('formatBlock', `<${tag}>`);
  }

  function inlineCode() {
    restore();
    const code = closest('code');
    if (code && !code.closest('pre')) { code.replaceWith(...code.childNodes); changed(); return; }
    const text = sel().toString().replace(/\n/g, ' ');
    insertNodes(h('code', text || '\u200b'));
    rememberSel();
    changed();
  }

  function toggleList(kind) {
    restore();
    const li = closest('li');
    const list = li?.parentElement;
    const isCheck = list?.classList.contains('checklist');
    const current = !list ? null : list.tagName === 'OL' ? 'ol' : isCheck ? 'check' : 'ul';
    if (current === kind) { document.execCommand(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList'); changed(); return; }
    if ((current === 'ul' && kind === 'check') || (current === 'check' && kind === 'ul')) { list.classList.toggle('checklist', kind === 'check'); changed(); return; }
    // a single paragraph → build the list ourselves (otherwise the browser nests <ol> in <p>)
    const block = currentBlock();
    const r = sel().rangeCount ? sel().getRangeAt(0) : null;
    if (!list && block && /^(P|H[1-3])$/.test(block.tagName) && r && block.contains(r.startContainer) && block.contains(r.endContainer)) {
      const li = h('li', kind === 'check' ? { 'data-checked': 'false' } : {});
      li.append(...block.childNodes);
      if (!li.firstChild) li.append(h('br'));
      const listEl = h(kind === 'ol' ? 'ol' : 'ul', kind === 'check' ? { class: 'checklist' } : {}, li);
      block.replaceWith(listEl);
      caretTo(li, true);
      changed();
      return;
    }
    document.execCommand(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
    if (kind === 'check') closest('ul')?.classList.add('checklist');
    else closest('ul')?.classList.remove('checklist');
    rememberSel();
    changed();
  }

  /** Insert a new block element after the current block (an empty paragraph is replaced) */
  function insertBlock(el) {
    restore();
    let block = currentBlock();
    while (block && block.parentElement !== area && !block.parentElement.classList.contains('kb-panel')) block = block.parentElement;
    if (block && block.tagName === 'P' && !block.textContent.trim() && !block.querySelector('img')) block.replaceWith(el);
    else if (block) block.after(el);
    else area.append(el);
    normalize();
    return el;
  }

  // ---------- Info box ----------
  function panel(kind) {
    restore();
    const existing = closest('.kb-panel');
    if (existing && kind === 'remove') { existing.replaceWith(...existing.childNodes); changed(); return; }
    if (existing) { existing.dataset.kind = kind; existing.className = `kb-panel kb-panel-${kind}`; changed(); return; }
    let block = currentBlock();
    while (block && block.parentElement !== area) block = block.parentElement;
    const box = h(`div.kb-panel.kb-panel-${kind}`, { 'data-kind': kind });
    if (block && block.tagName === 'P') { block.replaceWith(box); box.append(block); } else { insertBlock(box); box.append(h('p', h('br'))); }
    caretTo(box.querySelector('p') || box, true);
    changed();
  }

  // ---------- Table ----------
  function insertTable() {
    const wrapEl = renderDoc('| | | |\n| --- | --- | --- |\n| | | |\n| | | |', { edit: true }).firstElementChild;
    insertBlock(wrapEl);
    caretTo(wrapEl.querySelector('th'));
    changed();
  }
  const emptyCell = (tag) => h(tag, h('br'));
  function tableOp(op) {
    restore();
    const cell = closest('td,th');
    if (!cell) return;
    const row = cell.parentElement;
    const table = cell.closest('table');
    const idx = [...row.children].indexOf(cell);
    const allRows = [...table.querySelectorAll('tr')];
    if (op === 'rowBelow') {
      const n = row.children.length;
      const tr = h('tr', Array.from({ length: n }, () => emptyCell('td')));
      if (row.parentElement.tagName === 'THEAD') { const tb = table.querySelector('tbody') || table.appendChild(h('tbody')); tb.prepend(tr); } else row.after(tr);
      caretTo(tr.children[idx]);
    } else if (op === 'colRight') {
      for (const tr of allRows) tr.children[idx]?.after(emptyCell(tr.parentElement.tagName === 'THEAD' ? 'th' : 'td'));
      caretTo(row.children[idx + 1]);
    } else if (op === 'delRow') {
      if (row.parentElement.tagName === 'THEAD' || allRows.length <= 2) return tableOp('delTable');
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove(); if (next) caretTo(next.children[Math.min(idx, next.children.length - 1)]);
    } else if (op === 'delCol') {
      if (row.children.length <= 1) return tableOp('delTable');
      for (const tr of allRows) tr.children[idx]?.remove();
      caretTo(row.children[Math.max(0, idx - 1)]);
    } else if (op === 'delTable') {
      const box = table.closest('.kb-table') || table;
      const p = h('p', h('br'));
      box.replaceWith(p); caretTo(p);
    }
    changed();
  }
  function moveCell(back) {
    const cell = closest('td,th');
    const cells = [...cell.closest('table').querySelectorAll('th,td')];
    const i = cells.indexOf(cell) + (back ? -1 : 1);
    if (i >= cells.length) { tableOp('rowBelow'); caretTo(closest('tr').children[0]); return; }
    if (i >= 0) { const r = document.createRange(); r.selectNodeContents(cells[i]); const s = sel(); s.removeAllRanges(); s.addRange(r); saved = r.cloneRange(); }
  }

  // ---------- Images ----------
  function figureFor(src, { caption = '', size = 'full' } = {}) {
    return h('figure.kb-figure', { contenteditable: 'false', 'data-size': size }, h('img', { src, alt: caption, draggable: 'false' }), caption ? h('figcaption', caption) : null);
  }
  async function uploadImages(files, at = null) {
    for (const f of files) {
      if (!IMAGE_TYPES.test(f.type)) { toast(t('kb.ed.imageType'), 'error'); continue; }
      const blobUrl = URL.createObjectURL(f);
      const fig = figureFor(blobUrl);
      fig.classList.add('uploading');
      if (at) { at.after(fig); at = fig; } else { insertBlock(fig); at = fig; }
      normalize();
      try {
        const r = await api.kbImage(f);
        fig.querySelector('img').src = r.url;
        fig.classList.remove('uploading');
      } catch (e) {
        fig.remove();
        toast(e.message, 'error');
      } finally { URL.revokeObjectURL(blobUrl); }
      changed();
    }
  }
  function pickImage() {
    rememberSel();
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true });
    input.addEventListener('change', () => uploadImages([...input.files]));
    input.click();
  }

  // Click an image → size, caption, remove
  let figBar = null;
  const closeFigBar = () => { figBar?.remove(); figBar = null; area.querySelectorAll('.kb-figure.selected').forEach((f) => f.classList.remove('selected')); };
  function openFigBar(fig) {
    closeFigBar();
    fig.classList.add('selected');
    const cap = fig.querySelector('figcaption');
    const capIn = h('input', { value: cap?.textContent || '', placeholder: t('kb.ed.caption'), maxLength: 200 });
    capIn.addEventListener('input', () => {
      let c = fig.querySelector('figcaption');
      if (capIn.value.trim()) { if (!c) { c = h('figcaption'); fig.append(c); } c.textContent = capIn.value; } else c?.remove();
      fig.querySelector('img').alt = capIn.value;
      changed();
    });
    capIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); closeFigBar(); const p = fig.nextElementSibling; if (p) caretTo(p); } });
    const sizeBtn = (s) => h(`button.kb-tb-btn${fig.dataset.size === s ? '.active' : ''}`, { type: 'button', onclick: () => { fig.dataset.size = s; changed(); openFigBar(fig); } }, t(`kb.ed.size.${s}`));
    figBar = h('div.kb-figbar', IMAGE_SIZES.map(sizeBtn), h('span.kb-tb-sep'), capIn, h('span.kb-tb-sep'),
      h('button.kb-tb-btn', { type: 'button', title: t('kb.ed.removeImage'), onclick: () => { const p = fig.nextElementSibling; fig.remove(); closeFigBar(); if (p) caretTo(p); changed(); } }, icon('trash')));
    figBar.figure = fig;
    document.body.append(figBar);
    placeFigBar();
  }
  function placeFigBar() {
    if (!figBar) return;
    const r = figBar.figure.getBoundingClientRect();
    figBar.style.top = `${Math.max(8, r.top + window.scrollY - figBar.offsetHeight - 6)}px`;
    figBar.style.left = `${Math.max(8, r.left + window.scrollX)}px`;
  }

  // ---------- Link ----------
  function linkDialog() {
    rememberSel();
    const a = closest('a');
    const text = h('input', { value: a ? a.textContent : sel().toString(), maxLength: 300 });
    const target = h('input', { value: a ? a.getAttribute('href') : '', placeholder: 'https://…  ·  IT-42  ·  KB-3', maxLength: 2000 });
    const err = h('div.form-error', { hidden: true });
    let dlg;
    const apply = () => {
      const href = linkTarget(target.value);
      if (!href) { err.textContent = t('kb.ed.badLink'); err.hidden = false; return; }
      dlg.close();
      restore();
      const label = text.value.trim() || target.value.trim();
      if (a) { a.setAttribute('href', href); if (a.textContent !== label) a.textContent = label; } else if (!sel().isCollapsed && sel().toString() === label) document.execCommand('createLink', false, href);
      else insertNodes(h('a', { href }, label));
      rememberSel();
      changed();
    };
    target.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    dlg = modal(a ? t('kb.ed.editLink') : t('kb.ed.insertLink'), h('div', field(t('kb.ed.linkText'), text), field(t('kb.ed.linkTarget'), target, t('kb.ed.linkHint')), err), {
      footer: [
        a ? h('button.btn.btn-subtle', { type: 'button', onclick: () => { dlg.close(); a.replaceWith(...a.childNodes); changed(); } }, t('kb.ed.unlink')) : null,
        h('span.spacer'),
        h('button.btn.btn-subtle', { type: 'button', onclick: () => { dlg.close(); restore(); } }, t('app.cancel')),
        h('button.btn.btn-primary', { type: 'button', onclick: apply }, t('kb.ed.apply'))],
    });
    setTimeout(() => (text.value ? target : text).focus(), 40);
  }

  // ---------- Pasting and dragging ----------
  const pasteDoc = async (html) => {
    // rename style attributes: otherwise the content security policy (CSP) reports every single one
    const doc = new DOMParser().parseFromString(String(html).replace(/<[^>]+>/g, (tag) => tag.replace(/\sstyle\s*=/gi, ' data-s=')), 'text/html');
    // upload embedded images (data:); external URLs are not taken over
    for (const img of [...doc.querySelectorAll('img')]) {
      const src = img.getAttribute('src') || '';
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(src);
      if (!m) { if (!safeImg(src)) img.remove(); continue; }
      try {
        const bin = atob(m[2]); const buf = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
        const r = await api.kbImage(new File([buf], `bild.${m[1].split('/')[1]}`, { type: m[1] }));
        img.setAttribute('src', r.url);
      } catch { img.remove(); }
    }
    return toMarkdown(doc.body, { styles: true });
  };
  function insertMarkdown(md) {
    if (!md.trim()) return;
    const frag = renderDoc(md, { edit: true });
    const nodes = [...frag.childNodes];
    restore();
    // only one paragraph → insert as inline content (stays in the current block)
    if (nodes.length === 1 && nodes[0].tagName === 'P') { insertNodes(...nodes[0].childNodes); changed(); return; }
    const s = sel();
    if (s.rangeCount && !s.isCollapsed) s.deleteFromDocument();
    let block = currentBlock();
    while (block && block.parentElement !== area && !block.parentElement.classList.contains('kb-panel')) block = block.parentElement;
    if (block && block.tagName === 'P' && !block.textContent.trim() && !block.querySelector('img')) { block.replaceWith(...nodes); } else if (block) block.after(...nodes); else area.append(...nodes);
    const last = nodes[nodes.length - 1];
    normalize();
    caretTo(last.nextElementSibling || last, !last.nextElementSibling);
    changed();
  }
  area.addEventListener('paste', async (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [...cd.files].filter((f) => IMAGE_TYPES.test(f.type));
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    e.preventDefault();
    rememberSel();
    if (closest('pre')) { document.execCommand('insertText', false, text); changed(); return; }
    if (files.length && !html.replace(/<[^>]*>/g, '').trim()) { await uploadImages(files.map((f, i) => new File([f], f.name || `bild-${i + 1}.png`, { type: f.type }))); return; }
    if (html) { insertMarkdown(await pasteDoc(html)); return; }
    if (text) {
      // text with Markdown characters (e.g. from another article) is parsed as such
      if (/(^|\n)(#{1,3} |[-*] |\d+\. |> |```|\|.+\|)/.test(text) || /\*\*[^*]+\*\*/.test(text)) insertMarkdown(text);
      else { document.execCommand('insertText', false, text); changed(); }
    }
  });
  area.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); area.classList.add('drop'); } });
  area.addEventListener('dragleave', () => area.classList.remove('drop'));
  area.addEventListener('drop', async (e) => {
    area.classList.remove('drop');
    const files = [...e.dataTransfer.files].filter((f) => IMAGE_TYPES.test(f.type));
    const html = e.dataTransfer.getData('text/html');
    e.preventDefault();
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos) { const s = sel(); s.removeAllRanges(); s.addRange(pos); saved = pos.cloneRange(); }
    if (files.length) { await uploadImages(files); return; }
    if (html) insertMarkdown(await pasteDoc(html));
    else { const txt = e.dataTransfer.getData('text/plain'); if (txt) { restore(); document.execCommand('insertText', false, txt); changed(); } }
  });

  // ---------- Keyboard ----------
  const blockText = (b) => b.textContent.replace(/​/g, '');
  area.addEventListener('keydown', (e) => {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.altKey) {
      const lk = k.toLowerCase();
      if (lk === 'k') { e.preventDefault(); linkDialog(); return; }
      if (lk === 'e') { e.preventDefault(); inlineCode(); return; }
      if (e.shiftKey && lk === 'x') { e.preventDefault(); exec('strikeThrough'); return; }
      if (e.shiftKey && (lk === '7' || k === '&')) { e.preventDefault(); toggleList('ol'); return; }
      if (e.shiftKey && (lk === '8' || k === '(' || k === '*')) { e.preventDefault(); toggleList('ul'); return; }
      if (e.altKey === false && lk === 'z' && !e.shiftKey) { e.preventDefault(); exec('undo'); return; }
      if (lk === 'y' || (lk === 'z' && e.shiftKey)) { e.preventDefault(); exec('redo'); return; }
    }
    if (ctrl && e.altKey && ['0', '1', '2', '3'].includes(k)) { e.preventDefault(); setBlock(k === '0' ? 'p' : `h${k}`); return; }
    if (k === 'Tab') {
      if (closest('td,th')) { e.preventDefault(); moveCell(e.shiftKey); return; }
      if (closest('li')) { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); return; }
      if (closest('pre')) { e.preventDefault(); document.execCommand('insertText', false, '  '); changed(); return; }
    }
    const block = currentBlock();
    if (k === 'Enter' && !e.shiftKey) {
      const pre = closest('pre');
      if (pre) {
        e.preventDefault();
        // Enter on an empty last line leaves the code block
        const r = sel().getRangeAt(0);
        const after = document.createRange(); after.selectNodeContents(pre); after.setStart(r.endContainer, r.endOffset);
        const before = document.createRange(); before.selectNodeContents(pre); before.setEnd(r.endContainer, r.endOffset);
        if (!after.toString().replace(/\n/g, '') && /\n$/.test(before.toString())) {
          pre.textContent = pre.textContent.replace(/\n+$/, '');
          const p = h('p', h('br')); pre.after(p); caretTo(p); changed(); return;
        }
        const s2 = sel(); s2.deleteFromDocument();
        const nl = document.createTextNode('\n');
        const rr = s2.getRangeAt(0); rr.insertNode(nl); rr.setStartAfter(nl); rr.collapse(true);
        s2.removeAllRanges(); s2.addRange(rr); saved = rr.cloneRange();
        changed();
        return;
      }
      if (block && block.tagName === 'P' && block.parentElement === area) {
        const txt = blockText(block).trim();
        if (txt === '```') { e.preventDefault(); const pre2 = h('pre', '\n'); block.replaceWith(pre2); caretTo(pre2); changed(); return; }
        if (/^(-{3,}|\*{3,})$/.test(txt)) { e.preventDefault(); const p = h('p', h('br')); block.replaceWith(h('hr'), p); caretTo(p); changed(); return; }
      }
      // Empty paragraph at the end of an info box/quote → leave it
      const box = closest('.kb-panel, blockquote');
      if (box && block && block !== box && !blockText(block).trim() && block === box.lastElementChild && box.children.length > 1) {
        e.preventDefault(); block.remove(); const p = h('p', h('br')); box.after(p); caretTo(p); changed(); return;
      }
    }
    if (k === 'Backspace' && block) {
      // At the start of an empty heading/quote → normal paragraph
      const s = sel();
      if (s.isCollapsed && /^H[1-3]$/.test(block.tagName) && !blockText(block)) { e.preventDefault(); setBlock('p'); return; }
      if (s.isCollapsed && block.tagName === 'P' && !blockText(block).trim() && block.previousElementSibling?.classList.contains('kb-figure')) {
        e.preventDefault(); block.previousElementSibling.remove(); changed(); return;
      }
    }
    if (k === ' ' && block && block.tagName === 'P' && !closest('li,td,th,pre')) {
      const s = sel();
      const r = s.rangeCount ? s.getRangeAt(0) : null;
      if (!r || !s.isCollapsed) return;
      const pre = document.createRange(); pre.selectNodeContents(block); pre.setEnd(r.endContainer, r.endOffset);
      const before = pre.toString();
      if (before !== blockText(block)) return;
      const rule = { '#': 'h1', '##': 'h2', '###': 'h3', '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'check', '[ ]': 'check', '>': 'blockquote' }[before];
      if (!rule) return;
      e.preventDefault();
      block.replaceChildren(h('br'));
      caretTo(block);
      if (rule === 'ul' || rule === 'ol' || rule === 'check') toggleList(rule);
      else setBlock(rule);
    }
  });
  area.addEventListener('input', changed);
  area.addEventListener('keyup', rememberSel);
  area.addEventListener('mouseup', rememberSel);

  // Tick checklist items, select images
  area.addEventListener('mousedown', (e) => {
    const li = e.target.closest?.('ul.checklist > li');
    if (li && inArea(li) && e.target === li && e.clientX - li.getBoundingClientRect().left < 24) {
      e.preventDefault();
      li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
      changed();
      return;
    }
    const fig = e.target.closest?.('.kb-figure');
    if (fig && inArea(fig)) { e.preventDefault(); openFigBar(fig); return; }
    closeFigBar();
  });
  area.addEventListener('click', (e) => {
    const a = e.target.closest?.('a');
    if (a && inArea(a) && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
  });
  const onSel = () => { if (inArea(sel().anchorNode)) { rememberSel(); updateState(); } };
  document.addEventListener('selectionchange', onSel);
  const onScroll = () => placeFigBar();
  window.addEventListener('scroll', onScroll, true);

  // ---------- Toolbar ----------
  const btns = {};
  const tb = (key, ic, label, onClick, shortcut = '') => {
    const b = h('button.kb-tb-btn', {
      type: 'button', title: shortcut ? `${label} (${shortcut})` : label, 'aria-label': label,
      onmousedown: (e) => e.preventDefault(),
      onclick: (e) => { closeFigBar(); onClick(e.currentTarget); },
    }, typeof ic === 'string' ? icon(ic) : ic);
    btns[key] = b;
    return b;
  };
  const glyph = (txt, cls) => h(`span.kb-glyph.${cls}`, txt);
  const blockBtn = h('button.kb-tb-btn.kb-tb-block', {
    type: 'button', onmousedown: (e) => e.preventDefault(),
    onclick: (e) => dropdown(e.currentTarget, BLOCKS.map(([tag, key]) => ({ label: t(key), active: currentTag() === tag, onClick: () => setBlock(tag) }))),
  }, h('span.kb-tb-label', t('kb.ed.normal')), icon('ed-chevron'));
  const currentTag = () => {
    if (closest('pre')) return 'pre';
    if (closest('blockquote')) return 'blockquote';
    const b = closest('h1,h2,h3');
    return b ? b.tagName.toLowerCase() : 'p';
  };
  const withSel = (fn) => (anchor) => { rememberSel(); fn(anchor); };
  const toolbar = h('div.kb-toolbar', { role: 'toolbar', 'aria-label': t('kb.ed.toolbar') },
    blockBtn,
    h('span.kb-tb-sep'),
    tb('bold', glyph('B', 'b'), t('kb.ed.bold'), () => exec('bold'), `${mod}B`),
    tb('italic', glyph('I', 'i'), t('kb.ed.italic'), () => exec('italic'), `${mod}I`),
    tb('underline', glyph('U', 'u'), t('kb.ed.underline'), () => exec('underline'), `${mod}U`),
    tb('more', 'ed-more', t('kb.ed.moreFormats'), withSel((a) => dropdown(a, [
      { label: t('kb.ed.strike'), onClick: () => exec('strikeThrough') },
      { label: t('kb.ed.inlineCode'), onClick: () => inlineCode() },
      '-',
      { label: t('kb.ed.clear'), onClick: () => exec('removeFormat') },
    ]))),
    h('span.kb-tb-sep'),
    tb('ul', 'list', t('kb.ed.bullets'), () => toggleList('ul')),
    tb('ol', 'ed-ol', t('kb.ed.numbers'), () => toggleList('ol')),
    tb('check', 'ed-check', t('kb.ed.checklist'), () => toggleList('check')),
    h('span.kb-tb-sep'),
    tb('link', 'link', t('kb.ed.insertLink'), () => linkDialog(), `${mod}K`),
    tb('image', 'ed-image', t('kb.ed.image'), () => pickImage()),
    tb('emoji', h('span.kb-glyph', '🙂'), t('emoji.button'), withSel((a) => openEmojiPicker(a, {
      insertEmoji: (ch) => { restore(); document.execCommand('insertText', false, ch); rememberSel(); changed(); },
      focus: () => restore(),
    }))),
    tb('panel', 'ed-panel', t('kb.ed.panel'), withSel((a) => dropdown(a, [
      ...PANEL_KINDS.map((k) => ({ label: t(`kb.ed.panel.${k}`), icon: h(`span.kb-swatch.kb-panel-${k}`), active: closest('.kb-panel')?.dataset.kind === k, onClick: () => panel(k) })),
      ...(closest('.kb-panel') ? ['-', { label: t('kb.ed.panel.remove'), onClick: () => panel('remove') }] : []),
    ]))),
    tb('table', 'ed-table', t('kb.ed.table'), withSel((a) => dropdown(a, closest('td,th') ? [
      { label: t('kb.ed.rowBelow'), onClick: () => tableOp('rowBelow') },
      { label: t('kb.ed.colRight'), onClick: () => tableOp('colRight') },
      '-',
      { label: t('kb.ed.delRow'), onClick: () => tableOp('delRow') },
      { label: t('kb.ed.delCol'), onClick: () => tableOp('delCol') },
      { label: t('kb.ed.delTable'), onClick: () => tableOp('delTable') },
    ] : [{ label: t('kb.ed.insertTable'), onClick: () => insertTable() }]))),
    tb('hr', 'ed-hr', t('kb.ed.hr'), () => { const p = h('p', h('br')); insertBlock(h('hr')).after(p); caretTo(p); changed(); }),
    h('span.spacer'),
    tb('undo', 'ed-undo', t('kb.ed.undo'), () => exec('undo'), `${mod}Z`),
    tb('redo', 'ed-redo', t('kb.ed.redo'), () => exec('redo'), isMac ? '⇧⌘Z' : 'Strg+Y'),
  );

  function updateState() {
    if (!inArea(sel().anchorNode) && !saved) return;
    const q = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
    btns.bold.classList.toggle('active', q('bold') && !closest('h1,h2,h3'));
    btns.italic.classList.toggle('active', q('italic'));
    btns.underline.classList.toggle('active', q('underline') && !closest('a'));
    const list = closest('li')?.parentElement;
    btns.ul.classList.toggle('active', list?.tagName === 'UL' && !list.classList.contains('checklist'));
    btns.ol.classList.toggle('active', list?.tagName === 'OL');
    btns.check.classList.toggle('active', !!list?.classList.contains('checklist'));
    btns.link.classList.toggle('active', !!closest('a'));
    btns.panel.classList.toggle('active', !!closest('.kb-panel'));
    btns.table.classList.toggle('active', !!closest('td,th'));
    const tag = currentTag();
    blockBtn.querySelector('.kb-tb-label').textContent = t(BLOCKS.find(([x]) => x === tag)[1]);
  }

  const el = h('div.kb-editor-box', toolbar, area);
  normalize();
  return {
    el, area, getValue, setValue,
    focus: () => { area.focus(); const last = area.lastElementChild; if (last) caretTo(last, true); },
    destroy: () => { document.removeEventListener('selectionchange', onSel); window.removeEventListener('scroll', onScroll, true); closeFigBar(); },
  };
}
