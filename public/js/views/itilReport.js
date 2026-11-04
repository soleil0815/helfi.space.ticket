// ITIL metrics in the report: quality, SLA compliance, changes, problems
import { api } from '../api.js';
import { h } from '../dom.js';
import { t, getLang } from '../i18n.js';

const locale = () => (getLang() === 'de' ? 'de-DE' : 'en-GB');
const pctText = (v) => (v === null || v === undefined ? '–' : `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(v)} %`);
const tile = (value, label, hint) => h('div.stat-tile', { title: hint || '' }, h('div.stat-value', value), h('div.stat-label', label));

export async function itilPanel(range) {
  let d;
  try { d = await api.itilReport(range); } catch { return null; }
  const q = d.quality; const c = d.changes; const s = d.sla;
  const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(locale(), { month: 'short', year: 'numeric' });
  return h('div.itil-report',
    h('section.panel',
      h('h2', t('itilrep.quality')),
      h('div.stat-row',
        tile(String(q.resolved), t('itilrep.resolved'), t('itilrep.resolvedHint')),
        tile(pctText(q.firstContactRate), t('itilrep.fcr'), t('itilrep.fcrHint')),
        tile(pctText(q.reopenRate), t('itilrep.reopen'), t('itilrep.reopenHint')),
        tile(String(d.majorIncidents), t('itilrep.major'))),
      h('p.muted.small', t('itilrep.qualityNote'))),
    s.enabled ? h('section.panel',
      h('h2', t('itilrep.sla')),
      h('div.stat-row',
        tile(pctText(s.responseRate), t('itilrep.slaResponse')),
        tile(pctText(s.resolveRate), t('itilrep.slaResolve')),
        tile(String(s.count), t('itilrep.slaCount'))),
      s.byPriority.length ? h('table.data.itil-table',
        h('thead', h('tr', h('th', t('ticket.priority')), h('th.num', t('itilrep.slaCount')), h('th.num', t('itilrep.slaResponse')), h('th.num', t('itilrep.slaResolve')))),
        h('tbody', s.byPriority.map((x) => h('tr', h('td', t(`priority.${x.priority}`)), h('td.num', String(x.count)),
          h('td.num', pctText(x.responseRate)), h('td.num', pctText(x.resolveRate)))))) : null) : null,
    h('section.panel',
      h('h2', t('itilrep.changes')),
      h('div.stat-row',
        tile(String(c.totals.total), t('itilrep.changesTotal')),
        tile(pctText(c.totals.successRate), t('itilrep.successRate'), t('itilrep.successHint')),
        tile(pctText(c.totals.emergencyShare), t('itilrep.emergencyShare'))),
      c.months.length ? h('table.data.itil-table',
        h('thead', h('tr', ...['month', 'total', 'standard', 'normal', 'emergency', 'rejected', 'successful', 'issues', 'rolledBack', 'successRate'].map((k) => h(k === 'month' ? 'th' : 'th.num', t(`itilrep.col.${k}`))))),
        h('tbody', c.months.map((m) => h('tr', h('td', monthName(m.month)),
          ...['total', 'standard', 'normal', 'emergency', 'rejected', 'successful', 'issues', 'rolledBack'].map((k) => h('td.num', String(m[k]))),
          h('td.num', pctText(m.successRate)))))) : h('p.muted', t('itilrep.noChanges'))),
    h('section.panel',
      h('h2', t('itilrep.problems')),
      h('div.stat-row',
        tile(String(d.problems.created), t('itilrep.problemsCreated')),
        tile(String(d.problems.resolved), t('itilrep.problemsResolved')),
        tile(String(d.problems.open), t('itilrep.problemsOpen')),
        tile(String(d.problems.knownErrors), t('itilrep.knownErrors')))));
}
