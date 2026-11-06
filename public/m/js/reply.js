// Reply bar at the bottom of the ticket view: text, reply/internal note (agents), templates,
// photos and files (uploaded as drafts, linked to the comment), draft text per ticket.
import { attachMentions } from '/js/mention.js';
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

  const ta = h('textarea.m-reply-input', {
    rows: 1, enterkeyhint: 'enter', autocomplete: 'off', 'aria-label': t('m.reply.placeholder'), placeholder: t('m.reply.placeholder'),
  });
  // @-mentions (agents): "@" + letters shows people who may be mentioned here
  const mentions = agent ? attachMentions(ta, { getKey: key, isInternal: () => internal }) : null;
  const sendBtn = h('button.m-reply-send', { type: 'button', 'aria-label': t('m.reply.send'), title: t('m.reply.send'), onclick: () => send() }, icon('send'));
  const attachBtn = h('button.m-reply-attach', { type: 'button', 'aria-label': t('m.reply.attach'), title: t('m.reply.attach'), onclick: () => openAttachSheet() }, icon('plus'));
  const filesEl = h('div.m-reply-files', { role: 'list', 'aria-label': t('m.reply.attachments'), hidden: true });
  const hint = h('div.m-reply-hint', { hidden: true }, icon('lock'), h('span', t('m.reply.internalHint')));

  const modeReply = agent ? h('button.m-reply-mode', { type: 'button', 'aria-pressed': 'true', onclick: () => setMode(false) }, t('m.reply.reply')) : null;
  const modeNote = agent ? h('button.m-reply-mode.m-reply-mode-note', { type: 'button', 'aria-pressed': 'false', onclick: () => setMode(true) }, icon('lock'), t('m.reply.internal')) : null;
  const tplBtn = agent ? h('button.m-reply-tpl', {
    type: 'button',
    onclick: () => {
      const sel = [ta.selectionStart, ta.selectionEnd];
      let picked = null;
      openCannedSheet(getTicket(), (text) => { picked = text; }, () => {
        if (picked === null) return;
        ta.focus({ preventScroll: true });
        ta.setRangeText(picked, sel[0], sel[1], 'end');
        changed();
      });
    },
  }, icon('comment'), t('m.reply.template')) : null;
  // AI suggestions (agents, only if set up): reply from the ticket/notes, polish, shorten, translate
  const aiNote = h('div.m-reply-ai', { hidden: true });
  let aiBefore = null;
  const aiBtn = agent && state.boot.ai ? h('button.m-reply-tpl.m-reply-ai-btn', { type: 'button', 'aria-label': t('ai.menuHint'), title: t('ai.menuHint'), onclick: () => openAiSheet() }, icon('sparkle')) : null;
  function openAiSheet() {
    const has = !!ta.value.trim();
    const opt = (label, ic, call) => h('button.m-canned-item', { type: 'button', onclick: () => { sheet.close(); runAi(call); } },
      h('span.m-canned-title', icon(ic), ' ', label));
    const sheet = openSheet({
      title: t('ai.title'),
      content: h('div.m-canned',
        internal ? null : opt(has ? t('ai.replyFromNotes') : t('ai.reply'), 'sparkle', () => api.aiReply(key(), ta.value)),
        has ? [
          opt(t('ai.polish'), 'pencil', () => api.aiRewrite(ta.value, 'polish')),
          opt(t('ai.shorter'), 'list', () => api.aiRewrite(ta.value, 'shorter')),
          opt(t('ai.toGerman'), 'globe', () => api.aiRewrite(ta.value, 'de')),
          opt(t('ai.toEnglish'), 'globe', () => api.aiRewrite(ta.value, 'en')),
        ] : null,
        internal && !has ? h('p.m-sheet-empty', t('ai.noText')) : null),
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
      aiBefore = ta.value;
      ta.value = r.text;
      aiNote.replaceChildren(icon('sparkle'), h('span', { title: r.model }, t('ai.insertedShort')),
        h('button.m-link.m-link-small', { type: 'button', onclick: () => { ta.value = aiBefore ?? ''; aiBefore = null; aiNote.hidden = true; changed(); } }, t('ai.undo')));
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
    h('div.m-reply-row', attachBtn, h('div.m-reply-field', ta), sendBtn),
    hint);

  // ---------- Text: auto-grow, draft, keyboard ----------
  const maxHeight = () => Math.round((window.visualViewport?.height || window.innerHeight) * 0.4);
  function grow() {
    ta.style.height = 'auto';
    const max = maxHeight();
    ta.style.height = `${Math.min(ta.scrollHeight + 2, max)}px`;
    ta.style.overflowY = ta.scrollHeight + 2 > max ? 'auto' : 'hidden';
  }
  let saveTimer = null;
  function changed() {
    grow();
    update();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 250);
  }
  const saveDraft = () => writeDraft(key(), { text: mentions ? mentions.encode(ta.value) : ta.value, internal });
  ta.addEventListener('input', changed);
  ta.addEventListener('blur', saveDraft);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  window.visualViewport?.addEventListener('resize', () => { if (el.isConnected) grow(); });

  function setMode(isInternal) {
    if (!agent) return;
    internal = isInternal;
    el.classList.toggle('internal', internal);
    modeReply.setAttribute('aria-pressed', String(!internal));
    modeNote.setAttribute('aria-pressed', String(internal));
    hint.hidden = !internal;
    ta.placeholder = internal ? t('m.reply.placeholderInternal') : t('m.reply.placeholder');
    ta.setAttribute('aria-label', ta.placeholder);
    if (ta.value) saveDraft();
  }

  const ready = () => files.filter((f) => f.state !== 'error');
  function update() {
    const pending = files.some((f) => f.state === 'processing');
    sendBtn.disabled = busy || pending || (!ta.value.trim() && !ready().length);
    attachBtn.disabled = busy;
    el.classList.toggle('busy', busy);
    ta.readOnly = busy;
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
    ta.focus({ preventScroll: true });
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
      let text = (mentions ? mentions.encode(ta.value) : ta.value).trim();
      if (!text && !pics.length) text = others.map((f) => `📎 ${f.file.name}`).join('\n');
      const body = [text, ...pics.map((f) => `![${altText(f.file.name)}](/api/attachments/${f.attId})`)].filter(Boolean).join('\n');
      const r = await api.comment(k, body, agent && internal, others.map((f) => f.attId));
      // Sent: empty the bar
      for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
      files = [];
      ta.value = '';
      mentions?.close();
      writeDraft(k, null);
      busy = false;
      drawFiles(); grow(); update();
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
  if (d?.text) ta.value = mentions ? mentions.decode(d.text) : d.text;
  if (agent && d?.internal) setMode(true);
  else if (agent) setMode(false);
  requestAnimationFrame(grow);
  update();

  return {
    el,
    focus: () => ta.focus(),
    setMode,
    /** After a project move the key changes: keep the draft under the new key */
    rekey(oldKey, newKey) { if (oldKey !== newKey && ta.value) { writeDraft(oldKey, null); writeDraft(newKey, { text: mentions ? mentions.encode(ta.value) : ta.value, internal }); } },
  };
}
