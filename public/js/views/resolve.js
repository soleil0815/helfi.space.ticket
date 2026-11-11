// Close tickets as "rejected" (reason required, goes to the reporter as a reply) or as a
// "duplicate" of another ticket (original required, optional note). Single ticket or several
// at once (bulk); the server sends no extra "Resolved" mail and no satisfaction survey.
import { api } from '../api.js';
import { h, modal, toast, field, icon } from '../dom.js';
import { t } from '../i18n.js';
import { ticketPicker } from './links.js';
import { openTemplatePicker, fillPlaceholders } from './canned.js';
import { withEmoji } from '../emoji.js';

/**
 * "Done" with an optional closing comment – reply to the reporter (default) or internal note –
 * in one step. With a reply the reporter gets no extra "resolved" mail (the reply informs).
 */
export function openDoneDialog({ keys, tk = null, onDone }) {
  const many = keys.length > 1;
  const ta = h('textarea', { id: 'done-comment', rows: 6, maxLength: 100000, placeholder: t('done.placeholder') });
  let internal = false;
  const label = h('label', { for: 'done-comment' });
  const hint = h('div.hint');
  const reply = h('button.mode', { type: 'button', 'data-done-kind': 'reply', onclick: () => setKind(false) }, icon('mail'), t('bulk.asReply'));
  const note = h('button.mode', { type: 'button', 'data-done-kind': 'note', onclick: () => setKind(true) }, icon('lock'), t('bulk.asNote'));
  function setKind(isInternal) {
    internal = isInternal;
    for (const [b, on] of [[reply, !internal], [note, internal]]) { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
    label.textContent = t(internal ? 'done.noteLabel' : 'done.replyLabel');
    hint.textContent = t(internal ? 'done.noteHint' : 'done.replyHint');
    ta.classList.toggle('internal', internal);
  }
  const tplBtn = h('button.btn.btn-subtle.small', { type: 'button', onclick: (e) => openTemplatePicker(e.currentTarget, (x) => {
    const text = tk ? fillPlaceholders(x.body, tk) : x.body;
    const at = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, at) + text + ta.value.slice(ta.selectionEnd ?? at);
    ta.focus();
  }) }, icon('comment'), t('canned.toolbar'));
  const err = h('div.form-error', { role: 'alert', hidden: true });
  const ok = h('button.btn.btn-primary', { type: 'submit', form: 'done-form', 'data-done-submit': '' }, icon('check'), t('done.btn'));
  const dlg = modal(t(many ? 'done.titleMany' : 'done.title', { n: keys.length, key: keys[0] }),
    h('form#done-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        ok.disabled = true;
        const comment = ta.value.trim();
        try {
          // Placeholders like {melder} are filled in per ticket on the server
          const r = await api.bulk({ keys, changes: { status: 'done' }, ...(comment ? { comment, internal } : {}) });
          if (!r.ok.length && r.failed.length) {
            err.textContent = r.failed.map((x) => `${x.key}: ${x.error}`).join(', ');
            err.hidden = false; ok.disabled = false; return;
          }
          if (r.failed.length) toast(t('bulk.partly', { ok: r.ok.length, failed: r.failed.length, list: r.failed.map((x) => `${x.key}: ${x.error}`).join(', ') }), 'error');
          else toast(many ? t('done.doneMany', { n: r.ok.length }) : t('done.done', { key: r.ok[0] || keys[0] }), 'success');
          dlg.close();
          onDone?.(r);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; ok.disabled = false; }
      },
      // Ctrl/Cmd+Enter in the text field closes the ticket right away
      onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ok.click(); } },
    },
    h('p.muted', t('done.intro')),
    err,
    h('div.composer-modes.bulk-modes', { role: 'group', 'aria-label': t('bulk.kind') }, reply, note),
    h('div.field',
      h('div.resolve-label-row', label, tplBtn),
      withEmoji(ta),
      hint)),
    { wide: true, footer: [h('span.muted.small.done-shortcut', t('done.shortcut')), h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), ok] });
  setKind(false);
  ta.focus();
  return dlg;
}

/**
 * kind: 'rejected' | 'duplicate'; keys: ticket keys; tk: the single ticket (for placeholders in
 * templates – with several tickets they are filled per ticket on the server); onDone(result)
 */
export function openResolveDialog({ kind, keys, tk = null, original: preset = '', onDone }) {
  const many = keys.length > 1;
  const reason = h('textarea', { rows: 6, maxLength: 100000, placeholder: t(kind === 'rejected' ? 'resolve.reasonPlaceholder' : 'resolve.notePlaceholder') });
  const tplBtn = h('button.btn.btn-subtle.small', { type: 'button', onclick: (e) => openTemplatePicker(e.currentTarget, (x) => {
    const text = tk ? fillPlaceholders(x.body, tk) : x.body;
    const at = reason.selectionStart ?? reason.value.length;
    reason.value = reason.value.slice(0, at) + text + reason.value.slice(reason.selectionEnd ?? at);
    reason.focus();
  }) }, icon('comment'), t('canned.toolbar'));
  const picker = kind === 'duplicate' ? ticketPicker(many ? null : keys[0], { forKeys: keys }) : null;
  if (picker && preset) picker.input.value = preset;
  const addToOriginal = h('input', { type: 'checkbox' });
  const err = h('div.form-error', { role: 'alert', hidden: true });
  const ok = h('button.btn.btn-primary', { type: 'submit', form: 'resolve-form' }, t(kind === 'rejected' ? 'resolve.rejectBtn' : 'resolve.duplicateBtn'));
  const dlg = modal(t(kind === 'rejected' ? (many ? 'resolve.rejectMany' : 'resolve.rejectTitle') : (many ? 'resolve.duplicateMany' : 'resolve.duplicateTitle'), { n: keys.length, key: keys[0] }),
    h('form#resolve-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        const text = reason.value.trim();
        if (kind === 'rejected' && !text) { err.textContent = t('resolve.reasonRequired'); err.hidden = false; reason.focus(); return; }
        const original = picker ? picker.input.value.trim().toUpperCase() : null;
        if (picker && !original) { err.textContent = t('resolve.originalRequired'); err.hidden = false; picker.input.focus(); return; }
        ok.disabled = true;
        try {
          let r;
          if (many) {
            r = await api.bulk({ keys, comment: text, resolve: { resolution: kind, duplicateOf: original, addToOriginal: addToOriginal.checked } });
            // Nothing done at all: keep the dialog (typed reason) and the selection, show why
            if (!r.ok.length && r.failed.length) {
              err.textContent = r.failed.map((x) => `${x.key}: ${x.error}`).join(', ');
              err.hidden = false; ok.disabled = false; return;
            }
            if (r.failed.length) toast(t('bulk.partly', { ok: r.ok.length, failed: r.failed.length, list: r.failed.map((x) => `${x.key}: ${x.error}`).join(', ') }), 'error');
            else toast(t(kind === 'rejected' ? 'resolve.rejectedMany' : 'resolve.duplicatedMany', { n: r.ok.length }), 'success');
          } else {
            r = await api.resolveTicket(keys[0], { resolution: kind, reason: text, duplicateOf: original, addToOriginal: addToOriginal.checked });
            toast(t(kind === 'rejected' ? 'resolve.rejected' : 'resolve.duplicated', { key: original }), 'success');
          }
          dlg.close();
          onDone?.(r);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; ok.disabled = false; }
      },
    },
    h('p.muted', t(kind === 'rejected' ? 'resolve.rejectIntro' : 'resolve.duplicateIntro')),
    err,
    picker ? field(t('resolve.original'), picker.el, t('resolve.originalHint')) : null,
    h('div.field',
      h('div.resolve-label-row', h('label', { for: 'resolve-reason' }, t(kind === 'rejected' ? 'resolve.reason' : 'resolve.note')), tplBtn),
      withEmoji(reason),
      h('div.hint', t(kind === 'rejected' ? 'resolve.reasonHint' : 'resolve.noteHint'))),
    picker ? h('label.check-inline', addToOriginal, t('resolve.addToOriginal')) : null,
    picker ? h('p.muted.small', t('resolve.addToOriginalHint')) : null),
    { wide: true, footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), ok] });
  reason.id = 'resolve-reason';
  (picker && !preset ? picker.input : reason).focus();
  return dlg;
}
