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
