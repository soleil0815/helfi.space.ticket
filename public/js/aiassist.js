// AI assistance in the ticket view (agents, only if set up): summary section and the AI menu
// in the reply field. Everything the model returns is a suggestion – it is never sent by itself.
import { api } from './api.js';
import { h, mount, icon, richText, toast, dropdown, relTime, fmtDate, modal, field } from './dom.js';
import { t } from './i18n.js';
import { state } from './state.js';

// Summary per ticket key, kept while the page is open (the view is redrawn on every change)
const summaries = new Map();

/** Forget the summaries (they belong to the signed-in account) – on sign-in/sign-out */
export function clearAiSummaries() { summaries.clear(); }

/** Section "AI summary" below the description */
export function aiSummarySection(tk) {
  const box = h('div.ai-summary-body');
  const btn = h('button.btn.btn-subtle.small', { type: 'button', onclick: () => run() }, icon('sparkle'), t('ai.summarize'));
  const section = h('section.ticket-section.ai-summary',
    h('div.section-head', h('h3', icon('sparkle'), t('ai.summaryTitle')), btn),
    box);

  function draw(s) {
    if (!s) { box.hidden = true; btn.lastChild.textContent = t('ai.summarize'); return; }
    box.hidden = false;
    btn.lastChild.textContent = t('ai.summarizeAgain');
    mount(box,
      s.outdated ? h('div.ai-outdated', icon('info'), t('ai.outdated')) : null,
      h('div.ai-text', richText(s.text)),
      h('div.ai-meta', t('ai.suggestionBy', { model: s.model }), ' · ', h('span', { title: fmtDate(s.createdAt) }, relTime(s.createdAt))));
  }

  async function run() {
    btn.disabled = true;
    box.hidden = false;
    mount(box, h('div.ai-working', h('span.spinner'), t('ai.working')));
    try {
      const { summary } = await api.aiSummarize(tk.key);
      summaries.set(tk.key, summary);
      draw(summary);
    } catch (e) {
      toast(e.message, 'error');
      draw(summaries.get(tk.key));
    } finally { btn.disabled = false; }
  }

  if (summaries.has(tk.key)) {
    // Shown before: ask again whether it is still current (cheap, no model call)
    draw(summaries.get(tk.key));
    api.aiSummary(tk.key).then(({ summary }) => { summaries.set(tk.key, summary); if (section.isConnected) draw(summary); }).catch(() => {});
  } else {
    draw(null);
    api.aiSummary(tk.key).then(({ summary }) => { summaries.set(tk.key, summary); if (section.isConnected) draw(summary); }).catch(() => {});
  }
  return section;
}

/** The formatted comment field (createKbEditor) as a "text field" for the AI tools */
export function editorField(editor) {
  return {
    get value() { return editor.getValue(); },
    set value(v) { editor.setValue(v); },
    set disabled(b) { editor.area.contentEditable = b ? 'false' : 'true'; editor.el.classList.toggle('busy', !!b); },
    focus: () => editor.focus(),
    dispatchEvent: () => editor.area.dispatchEvent(new Event('input')),
  };
}

/**
 * "AI" button for the reply field: suggest a reply (the typed text serves as notes), polish,
 * shorten, translate. Returns { button, note } – note shows "AI suggestion, please check" + undo.
 * ta: textarea or editorField(); tk null = no reply suggestion (e.g. comments on articles).
 */
export function aiComposerTools(ta, tk, { isInternal = () => false, className = 'btn.btn-subtle.small' } = {}) {
  let before = null;
  const note = h('div.ai-note', { hidden: true });
  const button = h(`button.${className}.ai-btn`, {
    type: 'button', title: t('ai.menuHint'),
    onclick: (e) => {
      const hasText = !!ta.value.trim();
      const on = state.boot.aiFeatures || {};
      const reply = !!tk && on.reply && !isInternal();
      if (!reply && !hasText) { toast(t('ai.noText')); return; }
      dropdown(e.currentTarget, [
        ...(!reply ? [] : [{ label: hasText ? t('ai.replyFromNotes') : t('ai.reply'), icon: icon('sparkle'), onClick: () => apply(() => api.aiReply(tk.key, ta.value)) }]),
        ...(hasText && on.rewrite ? [
          { label: t('ai.polish'), icon: icon('pencil'), onClick: () => apply(() => api.aiRewrite(ta.value, 'polish')) },
          { label: t('ai.shorter'), icon: icon('list'), onClick: () => apply(() => api.aiRewrite(ta.value, 'shorter')) },
          { label: t('ai.toGerman'), icon: icon('globe'), onClick: () => apply(() => api.aiRewrite(ta.value, 'de')) },
          { label: t('ai.toEnglish'), icon: icon('globe'), onClick: () => apply(() => api.aiRewrite(ta.value, 'en')) },
        ] : []),
      ]);
    },
  }, icon('sparkle'), t('ai.button'), icon('chevron-down'));

  async function apply(call) {
    const label = button.childNodes[1];
    button.disabled = true;
    ta.disabled = true;
    label.textContent = t('ai.working');
    try {
      const r = await call();
      before = ta.value;
      ta.value = r.text;
      ta.dispatchEvent(new Event('input'));
      note.hidden = false;
      mount(note, icon('sparkle'), h('span', t('ai.inserted', { model: r.model })),
        h('button.link.small', { type: 'button', onclick: undo }, t('ai.undo')));
    } catch (e) { toast(e.message, 'error'); }
    finally {
      button.disabled = false;
      ta.disabled = false;
      label.textContent = t('ai.button');
      ta.focus();
    }
  }
  function undo() {
    if (before === null) return;
    ta.value = before;
    before = null;
    ta.dispatchEvent(new Event('input'));
    note.hidden = true;
    ta.focus();
  }
  // Typing on: the note stays (it is still based on the suggestion), undo stays possible
  return { button, note };
}

/**
 * AI in the article editor (agents, function "knowledge articles"): works on the selection or – without
 * one – on the whole article. Polish, shorten, translate, guide from notes, title/category suggestion and,
 * for a new article from a ticket, a draft from the ticket history. Undo restores the previous text.
 */
export function kbAiTools(editor, { getTitle, setTitle, getCategory, setCategory, categories = [], sourceTicket = null }) {
  let before = null;
  const note = h('div.ai-note.kb-ai-note', { hidden: true });
  const label = h('span.ai-label', t('ai.button'));
  const button = h('button.kb-tb-btn.cm-tb-text.ai-btn', {
    type: 'button', title: t('ai.kbHint'), 'aria-label': t('ai.kbHint'),
    onmousedown: (e) => e.preventDefault(),
    onclick: (e) => {
      editor.remember();
      const part = editor.selectedMarkdown();
      const empty = editor.isEmpty();
      const on = (mode) => () => run(mode, part);
      dropdown(e.currentTarget, [
        sourceTicket ? { label: t('ai.kb.fromTicket', { key: sourceTicket }), icon: icon('sparkle'), onClick: () => draft() } : null,
        sourceTicket && !empty ? '-' : null,
        ...(empty ? [] : [
          h('div.menu-group', part ? t('ai.kb.onSelection') : t('ai.kb.onArticle')),
          { label: t('ai.polish'), icon: icon('pencil'), onClick: on('polish') },
          { label: t('ai.shorter'), icon: icon('list'), onClick: on('shorter') },
          { label: t('ai.kb.steps'), icon: icon('ed-ol'), onClick: on('steps') },
          { label: t('ai.toGerman'), icon: icon('globe'), onClick: on('de') },
          { label: t('ai.toEnglish'), icon: icon('globe'), onClick: on('en') },
          '-',
          { label: t('ai.kb.meta'), icon: icon('type-question'), onClick: () => meta() },
        ]),
      ].filter(Boolean));
      if (empty && !sourceTicket) toast(t('ai.kb.empty'));
    },
  }, icon('sparkle'), label, icon('chevron-down'));

  const busy = (on) => { button.disabled = on; label.textContent = on ? t('ai.working') : t('ai.button'); editor.el.classList.toggle('busy', on); };
  const done = (model) => {
    note.hidden = false;
    mount(note, icon('sparkle'), h('span', t('ai.inserted', { model })), h('button.link.small', { type: 'button', onclick: undo }, t('ai.undo')));
  };
  async function run(mode, part) {
    busy(true);
    try {
      const r = await api.aiKb({ mode, text: part || editor.getValue() });
      before = editor.getValue();
      if (part) editor.insertMarkdown(r.text); else editor.setValue(r.text);
      editor.area.dispatchEvent(new Event('input'));
      done(r.model);
    } catch (e) { toast(e.message, 'error'); } finally { busy(false); }
  }
  async function draft() {
    if (!editor.isEmpty() && !confirm(t('ai.kb.replaceConfirm'))) return;
    busy(true);
    try {
      const r = await api.aiKbDraft(sourceTicket);
      before = editor.getValue();
      editor.setValue(r.text);
      editor.area.dispatchEvent(new Event('input'));
      done(r.model);
    } catch (e) { toast(e.message, 'error'); } finally { busy(false); }
  }
  async function meta() {
    busy(true);
    try {
      const r = await api.aiKb({ mode: 'meta', text: editor.getValue(), title: getTitle(), categories });
      busy(false);
      const tIn = h('input', { value: r.title || getTitle(), maxLength: 200 });
      const cIn = h('input', { value: r.category || getCategory(), maxLength: 60 });
      const dlg = modal(t('ai.kb.meta'), h('div', h('p.muted.small', t('ai.suggestionBy', { model: r.model })),
        field(t('kb.f.title'), tIn), field(t('kb.f.category'), cIn)), {
        footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
          h('button.btn.btn-primary', { type: 'button', onclick: () => { setTitle(tIn.value); setCategory(cIn.value); dlg.close(); } }, t('ai.accept'))],
      });
    } catch (e) { toast(e.message, 'error'); busy(false); }
  }
  function undo() {
    if (before === null) return;
    editor.setValue(before);
    before = null;
    editor.area.dispatchEvent(new Event('input'));
    note.hidden = true;
  }
  return { button, note };
}
