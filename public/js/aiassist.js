// AI assistance in the ticket view (agents, only if set up): summary section and the AI menu
// in the reply field. Everything the model returns is a suggestion – it is never sent by itself.
import { api } from './api.js';
import { h, mount, icon, richText, toast, dropdown, relTime, fmtDate } from './dom.js';
import { t } from './i18n.js';
import { state } from './state.js';

// Summary per ticket key, kept while the page is open (the view is redrawn on every change)
const summaries = new Map();

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

/**
 * "AI" button for the reply field: suggest a reply (the typed text serves as notes), polish,
 * shorten, translate. Returns { button, note } – note shows "AI suggestion, please check" + undo.
 */
export function aiComposerTools(ta, tk, { isInternal }) {
  let before = null;
  const note = h('div.ai-note', { hidden: true });
  const button = h('button.btn.btn-subtle.small', {
    type: 'button', title: t('ai.menuHint'),
    onclick: (e) => {
      const hasText = !!ta.value.trim();
      const on = state.boot.aiFeatures || {};
      if ((isInternal() || !on.reply) && !hasText) { toast(t('ai.noText')); return; }
      dropdown(e.currentTarget, [
        ...(isInternal() || !on.reply ? [] : [{ label: hasText ? t('ai.replyFromNotes') : t('ai.reply'), icon: icon('sparkle'), onClick: () => apply(() => api.aiReply(tk.key, ta.value)) }]),
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
