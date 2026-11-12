// Major incident: notice in the ticket, message to everyone affected
import { api } from '../api.js';
import { h, icon, modal, toast, field } from '../dom.js';
import { t } from '../i18n.js';
import { withEmoji } from '../emoji.js';
import { openTemplatePicker, fillPlaceholders } from './canned.js';

/** Message to everyone affected (major incident or problem) */
export function openBroadcast(tk, refresh) {
  {
    const text = h('textarea', { rows: 7, required: true, maxLength: 20000, placeholder: t('major.messageHint') });
    const resolve = h('input', { type: 'checkbox' });
    const err = h('div.form-error', { role: 'alert', hidden: true });
    const tpl = h('button.btn.btn-subtle.small', {
      type: 'button',
      onclick: (e) => openTemplatePicker(e.currentTarget, (x) => { text.value = fillPlaceholders(x.body, tk); }, { projectId: tk?.projectId }),
    }, icon('comment'), t('canned.insert'));
    const dlg = modal(t('major.broadcastTitle'), h('form#major-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await api.broadcast(tk.key, { body: text.value, resolve: resolve.checked });
          dlg.close();
          toast(t('major.sent', { n: r.notified }), 'success');
          refresh();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      },
    }, err, h('p.muted', t('major.broadcastIntro', { n: (tk.affectedCount || 0) + 1 })),
    field(t('major.message'), withEmoji(text)), tpl,
    h('div.field.field-check', resolve, h('label', t('major.resolveAll')))),
    { footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), h('button.btn.btn-primary', { type: 'submit', form: 'major-form' }, t('major.send'))] });
  }
}

export function majorBanner(tk, refresh) {
  if (!tk.major) return null;
  const open = () => openBroadcast(tk, refresh);
  return h('div.major-banner', icon('warning'),
    h('div', h('strong', t('major.title')), ' · ', t('major.affected', { n: tk.affectedCount || 0 }), h('span.muted.block.small', t('major.howto'))),
    h('span.spacer'),
    h('button.btn.btn-primary.small', { type: 'button', onclick: open }, t('major.broadcast')));
}
