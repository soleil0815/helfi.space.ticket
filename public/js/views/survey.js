// Satisfaction: public rating page (link from the email), rating in the ticket, evaluation
import { api } from '../api.js';
import { h, mount, icon, toast, fmtDate } from '../dom.js';
import { t } from '../i18n.js';
import { authFrame } from './auth.js';

/** Row of stars; onPick(n) makes it clickable */
export function stars(value, onPick = null, size = '') {
  const box = h(`span.stars${onPick ? '.stars-pick' : ''}${size ? `.stars-${size}` : ''}`, { role: onPick ? 'radiogroup' : 'img', 'aria-label': value ? `${value}/5` : t('survey.none') });
  for (let n = 1; n <= 5; n++) {
    const on = value && n <= value;
    box.append(onPick
      ? h(`button.star${on ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(n === value), title: t(`survey.label.${n}`), onclick: () => onPick(n) }, '★')
      : h(`span.star${on ? '.on' : ''}`, '★'));
  }
  return box;
}

/** /rate/<token>?r=1..5 – no login. One click in the email is enough: the choice is saved immediately. */
export async function renderRate(root, path, params) {
  const token = path.split('/')[2] || '';
  const box = h('div', h('div.loading', t('app.loading')));
  mount(root, authFrame(box));
  let info;
  try { info = await api.ratingInfo(token); } catch (e) { mount(box, h('h1', t('survey.title')), h('p', e.status === 410 ? t('survey.expired') : t('survey.invalid'))); return; }
  const pre = Number(params.get('r'));
  if (pre >= 1 && pre <= 5 && info.rating !== pre) {
    try { info = await api.rate(token, { rating: pre }); } catch (e) { toast(e.message, 'error'); }
    history.replaceState({}, '', `/rate/${token}`);
  }
  const draw = () => {
    const comment = h('textarea', { rows: 4, maxLength: 2000, placeholder: t('survey.commentHint') });
    comment.value = info.comment || '';
    const saveRating = async (n) => { try { info = await api.rate(token, { rating: n }); draw(); } catch (e) { toast(e.message, 'error'); } };
    mount(box,
      h('h1', t('survey.title')),
      h('p.muted', `${info.key} · ${info.title}`),
      h('div.rate-stars', stars(info.rating, saveRating, 'lg'), info.rating ? h('div.rate-label', t(`survey.label.${info.rating}`)) : h('div.rate-label.muted', t('survey.pick'))),
      info.rating ? h('div.hint-box.hint-ok', icon('check'), h('div', t('survey.thanks'))) : null,
      info.rating ? h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          try { info = await api.rate(token, { rating: info.rating, comment: comment.value }); toast(t('survey.commentSaved'), 'success'); draw(); } catch (ex) { toast(ex.message, 'error'); }
        },
      }, h('label.field-label', t('survey.comment')), comment, h('button.btn.btn-primary.btn-block', { type: 'submit' }, t('survey.sendComment'))) : null);
  };
  draw();
}

/** In the ticket: the reporter rates, agents see the result */
export function ratingBox(tk, refresh, agent) {
  const r = tk.rating;
  if (!r) return null;
  if (agent) {
    return h('div.rating-box', h('strong', t('survey.result')), ' ', stars(r.value), ' ', h('span', t(`survey.label.${r.value}`)),
      r.comment ? h('div.rating-comment', `„${r.comment}“`) : null, h('div.muted.small', fmtDate(r.ratedAt)));
  }
  const comment = h('textarea', { rows: 2, maxLength: 2000, placeholder: t('survey.commentHint') });
  comment.value = r.comment || '';
  const save = async (n, withComment = false) => {
    try { await api.rateTicket(tk.key, { rating: n, ...(withComment ? { comment: comment.value } : {}) }); refresh(); } catch (e) { toast(e.message, 'error'); }
  };
  return h('div.rating-box.rating-open',
    h('strong', r.value ? t('survey.yourRating') : t('survey.question')), ' ', stars(r.value, (n) => save(n)),
    r.value ? h('div.rating-form', comment, h('button.btn.btn-subtle.small', { type: 'button', onclick: () => save(r.value, true) }, t('survey.sendComment'))) : null);
}

/** Section in the report */
export async function satisfactionPanel(range) {
  let d;
  try { d = await api.satisfaction(range); } catch { return null; }
  if (!d.sent) return null;
  const max = Math.max(1, ...d.distribution);
  return h('section.panel.survey-panel',
    h('h2', t('survey.reportTitle')),
    h('div.stat-row',
      h('div.stat-tile', h('div.stat-value', d.average ?? '–', d.average ? h('span.stat-unit', ' / 5') : null), h('div.stat-label', t('survey.average'))),
      h('div.stat-tile', h('div.stat-value', `${d.answered} / ${d.sent}`), h('div.stat-label', t('survey.answered'))),
      h('div.stat-tile', h('div.stat-value', d.responseRate === null ? '–' : `${d.responseRate} %`), h('div.stat-label', t('survey.rate')))),
    h('div.survey-grid',
      h('div', h('h3', t('survey.distribution')), [5, 4, 3, 2, 1].map((n) => h('div.dist-row',
        h('span.dist-label', stars(n)), h('span.dist-track', h('span.dist-bar', { style: { width: `${(d.distribution[n - 1] / max) * 100}%` } })), h('span.dist-n', String(d.distribution[n - 1]))))),
      d.byAssignee.length ? h('div', h('h3', t('survey.byAgent')), h('table.data', h('tbody', d.byAssignee.map((a) => h('tr',
        h('td', a.name || t('app.unassigned')), h('td', stars(Math.round(a.average))), h('td', `${a.average}`), h('td.muted', t('survey.count', { n: a.count }))))))) : null),
    d.comments.length ? h('div', h('h3', t('survey.comments')), d.comments.map((c) => h('div.survey-comment', stars(c.rating), ' ',
      h('a', { href: `/browse/${c.key}`, 'data-link': '' }, c.key), ' ', h('span.muted', c.title), h('div', `„${c.comment}“`)))) : null);
}
