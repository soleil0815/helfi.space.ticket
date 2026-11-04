// Problem management: root cause, workaround, known error; notice in affected incidents
import { api } from '../api.js';
import { h, icon, toast, field, richText } from '../dom.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { openBroadcast } from './major.js';

/** Section in the problem ticket */
export function problemSection(tk, refresh) {
  const f = tk.fields || {};
  const cause = h('textarea', { rows: 4, maxLength: 20000, placeholder: t('problem.rootCauseHint') });
  cause.value = f.rootCause || '';
  const work = h('textarea', { rows: 4, maxLength: 20000, placeholder: t('problem.workaroundHint') });
  work.value = f.workaround || '';
  const known = h('input', { type: 'checkbox', checked: !!f.knownError });
  const save = async () => {
    try { await api.saveFields(tk.key, { rootCause: cause.value, workaround: work.value, knownError: known.checked }); toast(t('app.saved'), 'success'); refresh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return h('section.ticket-section.itil-box',
    h('div.section-head', h('h3', icon('type-problem'), ' ', t('problem.title')),
      f.knownError ? h('span.badge.badge-known', t('problem.knownError')) : null,
      h('span.spacer'),
      tk.affectedCount ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => openBroadcast({ ...tk, affectedCount: tk.affectedCount }, refresh) }, icon('mail'), t('problem.inform', { n: tk.affectedCount })) : null),
    h('p.muted.small', t('problem.howto')),
    field(t('problem.rootCause'), cause),
    field(t('problem.workaround'), work, t('problem.workaroundUse')),
    h('div.field.field-check', known, h('label', t('problem.knownErrorLabel'))),
    h('div.form-actions', h('button.btn.btn-primary', { type: 'button', onclick: save }, t('app.save'))));
}

/** Notice in an incident whose cause is a known problem */
export function problemHint(tk) {
  if (!tk.problems?.length) return null;
  return h('div.problem-hint', tk.problems.map((p) => h('div',
    h('div', icon('type-problem'), ' ', h('strong', t('problem.causeKnown')), ' ',
      h('a', { href: `/browse/${p.key}`, 'data-link': '' }, `${p.key} ${p.title}`),
      p.knownError ? h('span.badge.badge-known', t('problem.knownError')) : null),
    p.workaround ? h('div.problem-workaround', h('span.muted.small', t('problem.workaround')), richText(p.workaround),
      h('button.btn.btn-subtle.small', {
        type: 'button',
        onclick: () => {
          const ta = document.querySelector('.composer textarea');
          if (!ta) return;
          ta.value = ta.value ? `${ta.value}\n\n${p.workaround}` : p.workaround;
          ta.dispatchEvent(new Event('input'));
          ta.focus();
        },
      }, t('problem.useWorkaround'))) : null)));
}

/** Button in incidents: create and link a problem */
export function createProblemButton(tk) {
  if (tk.type !== 'incident') return null;
  return h('button.btn.btn-subtle.small', {
    type: 'button', title: t('problem.createHint'),
    onclick: async () => {
      try { const r = await api.createProblem(tk.key, {}); navigate(`/browse/${r.ticket.key}`); } catch (e) { toast(e.message, 'error'); }
    },
  }, icon('type-problem'), t('problem.create'));
}
