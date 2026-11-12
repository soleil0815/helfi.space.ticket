// "Was this article helpful?" below knowledge articles (desktop and phone).
// One vote per account: tapping the same thumb again withdraws it, the other one changes it.
// After "not helpful" an optional note on what was missing – only agents read it.
// Agents (desktop) also see the notes and can reset the rating after reworking the article.
import { api } from './api.js';
import { h, mount, toast, relTime, fmtDate, modal } from './dom.js';
import { t } from './i18n.js';
import { state } from './state.js';

export function ratingBox(a, { compact = false } = {}) {
  let rating = a.rating || { up: 0, down: 0, mine: 0 };
  let noteSent = false;
  let askNote = false; // the note field only right after a "not helpful" click, not on every visit
  const box = h(`section.kb-rating.no-print${compact ? '.compact' : ''}`, { 'aria-label': t('kb.rate.question') });
  const thumb = (value, emoji, label) => h('button.kb-rate-btn', {
    type: 'button',
    'aria-pressed': String(rating.mine === value),
    title: label,
    'aria-label': `${label} (${value === 1 ? rating.up : rating.down})`,
    class: rating.mine === value ? 'active' : '',
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        ({ rating } = await api.kbVote(a.id, rating.mine === value ? 0 : value));
        noteSent = false;
        askNote = rating.mine === -1;
        draw(true);
      } catch (ex) { toast(ex.message, 'error'); btn.disabled = false; }
    },
  }, h('span.kb-rate-emoji', { 'aria-hidden': 'true' }, emoji), h('span.kb-rate-n', String(value === 1 ? rating.up : rating.down)));

  function noteForm() {
    const ta = h('textarea', { rows: 2, maxLength: 1000, placeholder: t('kb.rate.notePlaceholder'), 'aria-label': t('kb.rate.noteLabel') });
    const send = h('button.btn.btn-primary.small', {
      type: 'button',
      onclick: async () => {
        if (!ta.value.trim()) { ta.focus(); return; }
        send.disabled = true;
        try { ({ rating } = await api.kbFeedbackAdd(a.id, ta.value)); noteSent = true; draw(); } catch (ex) { toast(ex.message, 'error'); send.disabled = false; }
      },
    }, t('kb.rate.noteSend'));
    return h('div.kb-rate-note', h('label.small', t('kb.rate.noteLabel')), ta, h('div.form-actions', send, h('span.muted.small', t('kb.rate.noteHint'))));
  }

  function draw(justVoted = false) {
    // Notes and reset: only the article's project people (a.canEdit)
    const agent = state.isAgent && a.canEdit !== false;
    mount(box,
      h('div.kb-rate-row',
        h('span.kb-rate-q', t('kb.rate.question')),
        thumb(1, '👍', t('kb.rate.yes')),
        thumb(-1, '👎', t('kb.rate.no')),
        justVoted && rating.mine ? h('span.muted.small.kb-rate-thanks', { role: 'status' }, t('kb.rate.thanks')) : null,
        agent && !compact ? h('span.spacer') : null,
        agent && !compact ? feedbackButton() : null),
      askNote && rating.mine === -1 && !noteSent ? noteForm() : null,
      noteSent ? h('p.muted.small', { role: 'status' }, t('kb.rate.noteThanks')) : null);
  }

  // Agents: notes on what was missing, reset after reworking
  function feedbackButton() {
    return h('button.btn.btn-subtle.small', { type: 'button', onclick: openFeedback },
      t('kb.rate.feedback', { n: rating.feedback || 0 }));
  }
  async function openFeedback() {
    let data;
    try { data = await api.kbFeedback(a.id); } catch (ex) { toast(ex.message, 'error'); return; }
    const item = (f) => h('div.kb-fb', h('div.kb-fb-head', h('strong', f.author || '—'), h('span.muted', { title: fmtDate(f.createdAt) }, relTime(f.createdAt))), h('div.kb-fb-body', f.body));
    const dlg = modal(t('kb.rate.feedbackTitle'), h('div',
      h('p.muted', t('kb.rate.summary', { up: rating.up, down: rating.down })),
      data.current.length ? data.current.map(item) : h('p.muted', t('kb.rate.noFeedback')),
      data.earlier.length ? h('details', h('summary', t('kb.rate.earlier', { n: data.earlier.length })), data.earlier.map(item)) : null), {
      footer: [
        h('button.btn.btn-subtle', {
          type: 'button',
          disabled: !rating.up && !rating.down && !data.current.length,
          onclick: async () => {
            if (!confirm(t('kb.rate.resetConfirm'))) return;
            try { ({ rating } = await api.kbRatingReset(a.id)); dlg.close(); draw(); toast(t('kb.rate.resetDone'), 'success'); } catch (ex) { toast(ex.message, 'error'); }
          },
        }, t('kb.rate.reset')),
        h('span.spacer'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => dlg.close() }, t('app.close')),
      ],
    });
  }

  draw();
  return box;
}
