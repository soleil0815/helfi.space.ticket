// Ticketliste mit Filtern, "Meine Arbeit" und "Meine Anfragen"
import { api } from '../api.js';
import { h, mount, icon, avatar, lozenge, typeIcon, priorityIcon, relTime, fmtDate, select } from '../dom.js';
import { t } from '../i18n.js';
import { state, navigate } from '../app.js';
import { openCreateDialog } from './ticket.js';

const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
const TYPES = ['incident', 'request', 'task', 'question'];
const PRIOS = ['highest', 'high', 'medium', 'low'];

export async function renderList(content, params, { requests = false } = {}) {
  const f = Object.fromEntries(params);
  if (!('status' in f) && requests) f.status = '';
  const set = (k, v) => {
    const p = new URLSearchParams(location.search);
    if (v) p.set(k, v); else p.delete(k);
    navigate(`${location.pathname}?${p}`, { replace: true });
  };

  const filters = h('div.toolbar',
    h('div.toolbar-search', icon('search'), h('input.input-search', {
      type: 'search', placeholder: t('filter.search'), value: f.q || '',
      onkeydown: (e) => { if (e.key === 'Enter') set('q', e.target.value.trim()); },
      onsearch: (e) => set('q', e.target.value.trim()),
    })),
    requests ? select([['', t('filter.allRequests')], ['reporter', t('filter.reportedByMe')], ['participant', t('filter.participating')]],
      f.reporter === 'me' ? 'reporter' : (f.participant === 'me' ? 'participant' : ''), {
        class: 'select-sm',
        onchange: (e) => {
          const p = new URLSearchParams(location.search);
          p.delete('reporter'); p.delete('participant');
          if (e.target.value) p.set(e.target.value, 'me');
          navigate(`${location.pathname}?${p}`, { replace: true });
        },
      }) : null,
    !requests && state.projects.length > 1 ? select([['', t('nav.allProjects')], ...state.projects.map((p) => [p.key, p.name])], f.project || '', { class: 'select-sm', onchange: (e) => set('project', e.target.value) }) : null,
    select([['', t('filter.allStatus')], ['unresolved', t('status.unresolved')], ...STATUSES.map((s) => [s, t(`status.${s}`)])], f.status || '', { class: 'select-sm', onchange: (e) => set('status', e.target.value) }),
    !requests ? select([['', t('filter.allTypes')], ...TYPES.map((s) => [s, t(`type.${s}`)])], f.type || '', { class: 'select-sm', onchange: (e) => set('type', e.target.value) }) : null,
    !requests ? select([['', t('filter.allPriorities')], ...PRIOS.map((s) => [s, t(`priority.${s}`)])], f.priority || '', { class: 'select-sm', onchange: (e) => set('priority', e.target.value) }) : null,
    !requests ? select([['', t('filter.allAssignees')], ['me', t('app.me')], ['none', t('app.unassigned')], ...state.agents.map((a) => [a.id, a.displayName])], f.assignee || '', { class: 'select-sm', onchange: (e) => set('assignee', e.target.value) }) : null,
    Object.keys(f).some((k) => f[k] && k !== 'reporter') ? h('button.btn.btn-subtle', { type: 'button', onclick: () => navigate(location.pathname, { replace: true }) }, t('filter.reset')) : null,
  );

  const title = requests ? t('nav.myRequests') : t('nav.list');
  const tableHost = h('div', h('div.loading', t('app.loading')));
  mount(content,
    h('div.page-head', h('h1', title), requests && state.boot.allowSelfService ? h('button.btn.btn-primary', { type: 'button', onclick: () => openCreateDialog() }, icon('plus'), t('app.create')) : null),
    filters,
    tableHost,
  );

  const { tickets } = await api.tickets({ ...f, sort: f.sort || 'updated' });
  mount(tableHost, ticketTable(tickets, { requests, sort: f.sort || 'updated', onSort: (s) => set('sort', s) }));
}

export function ticketTable(tickets, { requests = false, sort, onSort, compact = false } = {}) {
  if (!tickets.length) return h('div.empty-state.small', t('list.empty'));
  const th = (label, key) => h('th', onSort && key ? h('button.th-sort', { type: 'button', class: sort === key ? 'active' : '', onclick: () => onSort(key) }, label, sort === key ? icon('arrow-down') : null) : label);
  return h('div.table-wrap',
    compact ? null : h('div.table-count', t('list.count', { n: tickets.length })),
    h('table.issues',
      h('thead', h('tr',
        h('th.col-type', ''),
        th(t('list.key'), 'key'),
        th(t('list.summary')),
        th(t('list.status'), 'status'),
        requests ? null : th(t('list.assignee')),
        requests || compact ? null : th(t('list.reporter')),
        th(t('list.priority'), 'priority'),
        th(t('list.updated'), 'updated'),
      )),
      h('tbody', tickets.map((tk) => h('tr', { 'data-key': tk.key, onclick: (e) => { if (!e.target.closest('a')) navigate(`/browse/${tk.key}`); } },
        h('td.col-type', typeIcon(tk.type)),
        h('td.col-key', h('a', { href: `/browse/${tk.key}`, 'data-link': '' }, tk.key)),
        h('td.col-summary', h('a', { href: `/browse/${tk.key}`, 'data-link': '' }, tk.title), tk.source === 'email' ? h('span.src-mail', { title: t('source.email') }, icon('mail')) : null),
        h('td', lozenge(tk.status)),
        requests ? null : h('td.col-person', h('span.person', avatar(tk.assignee, 'sm'), h('span', tk.assignee?.displayName || t('app.unassigned')))),
        requests || compact ? null : h('td.col-person', h('span.person', avatar(tk.reporter, 'sm'), h('span', tk.reporter?.displayName || '—'))),
        h('td', priorityIcon(tk.priority), h('span.prio-label', t(`priority.${tk.priority}`))),
        h('td.col-date', { title: fmtDate(tk.updatedAt) }, relTime(tk.updatedAt)),
      ))),
    ));
}

export async function renderMyWork(content) {
  const [assigned, unassigned, reported, stats] = await Promise.all([
    api.tickets({ assignee: 'me', status: 'unresolved', sort: 'priority' }),
    api.tickets({ assignee: 'none', status: 'unresolved', sort: 'created', limit: 50 }),
    api.tickets({ reporter: 'me', sort: 'updated', limit: 20 }),
    api.stats(),
  ]);
  const tile = (n, label, href) => h('a.stat', { href, 'data-link': '' }, h('div.stat-n', String(n)), h('div.stat-l', label));
  mount(content,
    h('div.page-head', h('h1', t('my.welcome', { name: state.user.displayName.split(' ')[0] }))),
    h('div.stats',
      tile(stats.mine, t('my.assigned'), '/issues?assignee=me&status=unresolved'),
      tile(stats.unassigned, t('my.unassigned'), '/issues?assignee=none&status=unresolved'),
      tile(stats.byStatus.open, t('status.open'), '/issues?status=open'),
      tile(stats.byStatus.in_progress, t('status.in_progress'), '/issues?status=in_progress'),
      tile(stats.byStatus.waiting, t('status.waiting'), '/issues?status=waiting'),
    ),
    h('section.panel', h('h2', t('my.assigned')), ticketTable(assigned.tickets, { compact: true })),
    h('section.panel', h('h2', t('my.unassigned')), ticketTable(unassigned.tickets, { compact: true })),
    h('section.panel', h('h2', t('my.reported')), ticketTable(reported.tickets, { compact: true })),
  );
}
