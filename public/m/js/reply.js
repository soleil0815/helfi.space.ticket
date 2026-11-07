// Reply bar at the bottom of the ticket view: text, reply/internal note (agents), templates,
// photos and files (uploaded as drafts, linked to the comment), draft text per ticket.
import { createCommentField } from '/js/commentfield.js';
import { api } from '/js/api.js';
import { h, icon, toast, fmtSize } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { downscale, uploadDraft, isPicture, openAttachSheet as attachSheet, MAX_FILES } from './files.js';
import { openCannedSheet } from './actions.js';
import { openSheet } from './sheet.js';

// Drafts belong to the account and the ticket; a draft of another account is never restored
// (an agent's internal note must not end up in the next user's reply bar). See /js/userdata.js.
const DRAFT_PREFIX = 'helfi.m.draft.';
const draftKey = (uid, key) => `${DRAFT_PREFIX}${uid}.${key}`;
function readDraft(key) {
  const uid = state.user?.id;
  if (!uid) return null;
  try {
    const d = JSON.parse(sessionStorage.getItem(draftKey(uid, key)) || 'null');
    return d && d.uid === uid ? d : null;
  } catch { return null; }
}
function writeDraft(key, d) {
  const uid = state.user?.id;
  if (!uid) return; // signed out meanwhile: keep nothing
  try {
    if (d && d.text) sessionStorage.setItem(draftKey(uid, key), JSON.stringify({ ...d, uid }));
    else sessionStorage.removeItem(draftKey(uid, key));
  } catch { /* storage full or blocked: the text just is not kept */ }
}

/** Text for the image link in the comment: no brackets/newlines (they would end the markdown) */
const altText = (name) => String(name || '').replace(/[[\]\n\r]/g, ' ').slice(0, 120);

/**
 * getTicket(): current ticket; onSent(comment): after a successful send (reload + scroll).
 * Returns { el, focus(), setMode(internal) }.
 */
export function replyBar({ getTicket, onSent }) {
  const agent = state.isAgent;
  const key = () => getTicket().key;
  let internal = false;
  let busy = false;
  let files = []; // { id, file, url, resized, state: 'processing'|'ready'|'uploading'|'error', progress, attId, el }

  // Formatted field with a small, swipeable format bar (bold, italic, lists, quote, code, link, emoji, @).
  // Pictures come in through "+" (downscaled, uploaded on sending) – not through the field.
  const field = createCommentField({
    placeholder: t('m.reply.placeholder'), label: t('m.reply.placeholder'),
    onSubmit: () => send(),
    onChange: () => changed(),
    uploadImage: null,
    mention: agent ? { getKey: key, isInternal: () => internal } : null,
  });
  field.el.classList.add('m-reply-editor');
  field.area.classList.add('m-reply-input');
  const text = () => field.getValue();
  // Buttons next to the field keep the focus in it (keyboard and format bar stay, nothing jumps under the finger)
  const keep = (e) => e.preventDefault();
  const sendBtn = h('button.m-reply-send', { type: 'button', 'aria-label': t('m.reply.send'), title: t('m.reply.send'), onmousedown: keep, onclick: () => send() }, icon('send'));
  const attachBtn = h('button.m-reply-attach', { type: 'button', 'aria-label': t('m.reply.attach'), title: t('m.reply.attach'), onmousedown: keep, onclick: () => openAttachSheet() }, icon('plus'));
  const filesEl = h('div.m-reply-files', { role: 'list', 'aria-label': t('m.reply.attachments'), hidden: true });
  const hint = h('div.m-reply-hint', { hidden: true }, icon('lock'), h('span', t('m.reply.internalHint')));

  const modeReply = agent ? h('button.m-reply-mode', { type: 'button', 'aria-pressed': 'true', onclick: () => setMode(false) }, t('m.reply.reply')) : null;
  const modeNote = agent ? h('button.m-reply-mode.m-reply-mode-note', { type: 'button', 'aria-pressed': 'false', onclick: () => setMode(true) }, icon('lock'), t('m.reply.internal')) : null;
  const tplBtn = agent ? h('button.m-reply-tpl', {
    type: 'button', onmousedown: keep,
    onclick: () => {
      field.remember();
      let picked = null;
      openCannedSheet(getTicket(), (txt) => { picked = txt; }, () => {
        if (picked === null) return;
        field.insertMarkdown(picked);
        changed();
      });
    },
  }, icon('comment'), t('m.reply.template')) : null;
  // AI suggestions (agents, only if set up): reply from the ticket/notes, polish, shorten, translate
  const aiNote = h('div.m-reply-ai', { hidden: true });
  let aiBefore = null;
  const aiBtn = agent && (state.boot.aiFeatures?.reply || state.boot.aiFeatures?.rewrite) ? h('button.m-reply-tpl.m-reply-ai-btn', { type: 'button', onmousedown: keep, 'aria-label': t('ai.menuHint'), title: t('ai.menuHint'), onclick: () => openAiSheet() }, icon('sparkle')) : null;
  function openAiSheet() {
    const has = !field.isEmpty();
    const opt = (label, ic, call) => h('button.m-canned-item', { type: 'button', onclick: () => { sheet.close(); runAi(call); } },
      h('span.m-canned-title', icon(ic), ' ', label));
    const sheet = openSheet({
      title: t('ai.title'),
      content: h('div.m-canned',
        internal || !state.boot.aiFeatures?.reply ? null : opt(has ? t('ai.replyFromNotes') : t('ai.reply'), 'sparkle', () => api.aiReply(key(), text())),
        has && state.boot.aiFeatures?.rewrite ? [
          opt(t('ai.polish'), 'pencil', () => api.aiRewrite(text(), 'polish')),
          opt(t('ai.shorter'), 'list', () => api.aiRewrite(text(), 'shorter')),
          opt(t('ai.toGerman'), 'globe', () => api.aiRewrite(text(), 'de')),
          opt(t('ai.toEnglish'), 'globe', () => api.aiRewrite(text(), 'en')),
        ] : null,
        (internal || !state.boot.aiFeatures?.reply) && !has ? h('p.m-sheet-empty', t('ai.noText')) : null),
    });
  }
  async function runAi(call) {
    busy = true;
    update();
    aiBtn.disabled = true;
    aiNote.hidden = false;
    aiNote.replaceChildren(h('span.m-spinner-inline'), h('span', t('ai.working')));
    try {
      const r = await call();
      aiBefore = text();
      field.setValue(r.text);
      aiNote.replaceChildren(icon('sparkle'), h('span', { title: r.model }, t('ai.insertedShort')),
        h('button.m-link.m-link-small', { type: 'button', onclick: () => { field.setValue(aiBefore ?? ''); aiBefore = null; aiNote.hidden = true; changed(); } }, t('ai.undo')));
    } catch (e) {
      aiNote.hidden = true;
      toast(e.message, 'error');
    } finally {
      busy = false;
      aiBtn.disabled = false;
      changed();
    }
  }
  const tools = agent ? h('div.m-reply-tools',
    h('div.m-reply-modes', { role: 'group', 'aria-label': t('m.reply.mode') }, modeReply, modeNote),
    h('span.spacer'), aiBtn, tplBtn) : null;

  const el = h('div.m-reply', { role: 'region', 'aria-label': t('m.reply.placeholder') },
    tools, aiNote, filesEl,
    h('div.m-reply-row', attachBtn, h('div.m-reply-field', field.el), sendBtn),
    hint);

  // ---------- Text: draft (the field grows by itself up to 40 % of the screen) ----------
  let saveTimer = null;
  function changed() {
    update();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 250);
  }
  const saveDraft = () => writeDraft(key(), { text: field.isEmpty() ? '' : text(), internal, format: 'md' });
  field.area.addEventListener('input', () => { update(); });
  field.area.addEventListener('blur', saveDraft);

  function setMode(isInternal) {
    if (!agent) return;
    internal = isInternal;
    el.classList.toggle('internal', internal);
    modeReply.setAttribute('aria-pressed', String(!internal));
    modeNote.setAttribute('aria-pressed', String(internal));
    hint.hidden = !internal;
    const ph = internal ? t('m.reply.placeholderInternal') : t('m.reply.placeholder');
    field.area.dataset.placeholder = ph;
    field.area.setAttribute('aria-label', ph);
    if (!field.isEmpty()) saveDraft();
  }

  const ready = () => files.filter((f) => f.state !== 'error');
  function update() {
    const pending = files.some((f) => f.state === 'processing');
    sendBtn.disabled = busy || pending || (field.isEmpty() && !ready().length);
    attachBtn.disabled = busy;
    el.classList.toggle('busy', busy);
    field.area.contentEditable = busy ? 'false' : 'true';
  }

  // ---------- Attachments ----------
  const openAttachSheet = () => attachSheet(pick);

  function pick(list) {
    const room = MAX_FILES - files.length;
    if (list.length > room) toast(t('m.reply.tooMany', { n: MAX_FILES }), 'error');
    for (const file of list.slice(0, Math.max(0, room))) addFile(file);
  }

  let seq = 0;
  async function addFile(original) {
    const f = { id: ++seq, file: original, url: null, resized: false, state: 'processing', progress: 0, attId: null, error: null };
    files.push(f);
    drawFiles(); update();
    try {
      if (isPicture(original.type)) {
        const r = await downscale(original);
        f.file = r.file; f.resized = r.resized;
        f.url = URL.createObjectURL(f.file);
      }
    } catch { /* keep the original */ }
    if (!files.includes(f)) { if (f.url) URL.revokeObjectURL(f.url); return; } // removed meanwhile
    const max = state.boot?.maxUploadMb;
    if (max && f.file.size > max * 1024 * 1024) {
      f.state = 'error';
      f.error = t('m.reply.tooLarge', { name: f.file.name, max });
      toast(f.error, 'error');
    } else f.state = 'ready';
    drawFiles(); update();
  }

  function removeFile(f) {
    files = files.filter((x) => x !== f);
    // Already uploaded (e.g. after a failed send): remove the unsent draft on the server too
    if (f.attId) api.discardDraft(f.attId).catch(() => { /* removed after a day anyway */ });
    if (f.url) URL.revokeObjectURL(f.url);
    drawFiles(); update();
    field.area.focus({ preventScroll: true });
  }

  function drawFiles() {
    filesEl.hidden = !files.length;
    filesEl.replaceChildren(...files.map((f) => {
      const pic = isPicture(f.file.type);
      const meta = f.state === 'processing' ? t('m.reply.processing')
        : f.state === 'uploading' ? t('m.reply.uploading', { pct: Math.round(f.progress * 100) })
          : f.state === 'error' ? f.error
            : [fmtSize(f.file.size), f.resized ? t('m.reply.resized') : null].filter(Boolean).join(' · ');
      const bar = h('span.m-file-progress', { 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round(f.progress * 100)}%` } }));
      f.el = h('div.m-file', { role: 'listitem', class: [f.state, pic ? 'pic' : ''].filter(Boolean).join(' '), 'data-name': f.file.name },
        h('span.m-file-thumb', f.url ? h('img', { src: f.url, alt: '' }) : icon(pic ? 'image' : 'file')),
        h('span.m-file-text', h('span.m-file-name', f.file.name), h('span.m-file-meta', meta)),
        f.state === 'uploading' ? bar : null,
        h('button.m-file-x', {
          type: 'button', 'aria-label': t('m.reply.remove', { name: f.file.name }), disabled: busy, onclick: () => removeFile(f),
        }, icon('close')));
      return f.el;
    }));
  }

  function setProgress(f, p) {
    f.progress = p;
    const meta = f.el?.querySelector('.m-file-meta');
    if (meta) meta.textContent = t('m.reply.uploading', { pct: Math.round(p * 100) });
    const bar = f.el?.querySelector('.m-file-progress > span');
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  }

  // ---------- Send ----------
  async function send() {
    if (sendBtn.disabled) return;
    const k = key();
    busy = true;
    update(); drawFiles();
    try {
      const list = ready();
      // Upload one by one (progress per file); ids already uploaded are kept for a retry
      for (const f of list) {
        if (f.attId) continue;
        f.state = 'uploading'; f.progress = 0;
        drawFiles();
        try {
          f.attId = await uploadDraft(k, f.file, isPicture(f.file.type) ? '1' : 'file', (p) => setProgress(f, p));
          f.state = 'ready';
        } catch (e) {
          f.state = 'error'; f.error = e.message;
          drawFiles();
          throw new Error(`${t('m.reply.uploadFailed', { name: f.file.name })} – ${e.message}`);
        }
      }
      // Pictures appear in the text (as in the desktop UI), other files are linked to the comment
      const pics = list.filter((f) => isPicture(f.file.type));
      const others = list.filter((f) => !isPicture(f.file.type));
      let txt = field.isEmpty() ? '' : text().trim();
      if (!txt && !pics.length) txt = others.map((f) => `📎 ${f.file.name}`).join('\n\n');
      // each picture as its own block (shown below the text)
      const body = [txt, ...pics.map((f) => `![${altText(f.file.name)}](/api/attachments/${f.attId})`)].filter(Boolean).join('\n\n');
      const r = await api.comment(k, body, agent && internal, others.map((f) => f.attId), 'md');
      // Sent: empty the bar
      for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
      files = [];
      field.clear();
      field.mentions?.close();
      writeDraft(k, null);
      busy = false;
      drawFiles(); update();
      await onSent?.(r.comment);
    } catch (e) {
      busy = false;
      drawFiles(); update();
      toast(e.message, 'error');
    }
  }

  // Toasts sit above the bar: its height as a CSS variable
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (el.isConnected && el.offsetHeight) document.documentElement.style.setProperty('--m-reply-h', `${el.offsetHeight}px`);
    }).observe(el);
  }

  // ---------- Start: restore the draft of this ticket ----------
  const d = readDraft(key());
  // Drafts of the earlier plain field are taken over as they are (mention tokens included)
  if (d?.text) field.setValue(d.text);
  if (agent && d?.internal) setMode(true);
  else if (agent) setMode(false);
  update();

  return {
    el,
    focus: () => field.area.focus(),
    setMode,
    /** After a project move the key changes: keep the draft under the new key */
    rekey(oldKey, newKey) { if (oldKey !== newKey && !field.isEmpty()) { writeDraft(oldKey, null); writeDraft(newKey, { text: text(), internal, format: 'md' }); } },
  };
}
