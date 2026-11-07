// Project summary: metrics, distribution, most urgent tickets
import { api } from '../api.js';
import { h, mount, lozenge, typeIcon, priorityIcon, relTime, avatar } from '../dom.js';
import { t } from '../i18n.js';
import { state } from '../app.js';
import { QUEUES, queueHref } from '../queues.js';

const STATUS_ORDER = ['open', 'in_progress', 'waiting', 'done'];
const TYPE_ORDER = ['incident', 'request', 'task', 'question'];
const PRIO_ORDER = ['highest', 'high', 'medium', 'low'];

export async function renderSummary(content) {
  const p = state.project;
  const host = h('div', h('div.loading', t('app.loading')));
  mount(content, h('div.page-head', h('h1', t('summary.title', { name: p?.name || t('nav.allProjects') }))), host);
  const d = await api.summary(p?.key);
  const key = p?.key;
  const link = (params) => `/issues?${new URLSearchParams({ ...(key ? { project: key } : {}), ...params })}`;

  const tile = (n, label, href, warn = false) => h('a.stat-tile.stat-link', { href, 'data-link': '', class: warn && n ? 'stat-warn' : '' },
    h('div.stat-value', String(n)), h('div.stat-label', label));
  // Distribution as horizontal bars (one colour; the value sits next to it)
  const dist = (title, data, order, label, iconFn, params) => {
    const max = Math.max(1, ...order.map((k) => data[k] || 0));
    return h('section.panel.dist',
      h('h2', title),
      order.map((k) => h('a.dist-row', { href: link(params(k)), 'data-link': '' },
        h('span.dist-label', iconFn ? iconFn(k) : null, label(k)),
        h('span.dist-track', h('span.dist-bar', { style: { width: `${((data[k] || 0) / max) * 100}%` } })),
        h('span.dist-n', String(data[k] || 0)))));
  };

  mount(host,
    h('div.stat-row.stat-row-5',
      tile(d.counts.open, t('summary.open'), queueHref(QUEUES[0], key)),
      tile(d.counts.unassigned, t('queue.unassigned'), queueHref(QUEUES[2], key)),
      tile(d.counts.created7, t('summary.created7'), link({ sort: 'created' })),
      tile(d.counts.resolved7, t('summary.resolved7'), queueHref(QUEUES[4], key)),
      tile(d.counts.overdue, t('summary.overdue'), link({ overdue: '1', sort: 'priority' }), true)),
    h('div.chart-grid.chart-grid-3',
      dist(t('summary.byStatus'), d.byStatus, STATUS_ORDER, (k) => t(`status.${k}`), null, (k) => ({ status: k })),
      dist(t('summary.byType'), d.byType, TYPE_ORDER, (k) => t(`type.${k}`), typeIcon, (k) => ({ type: k, status: 'unresolved' })),
      dist(t('summary.byPriority'), d.byPriority, PRIO_ORDER, (k) => t(`priority.${k}`), priorityIcon, (k) => ({ priority: k, status: 'unresolved' }))),
    h('section.panel',
      h('h2', t('summary.urgent')),
      d.urgent.length
        ? h('div.urgent-list', d.urgent.map((tk) => h('a.urgent-row', { href: `/browse/${tk.key}`, 'data-link': '' },
          typeIcon(tk.type), h('span.urgent-key', tk.key), h('span.urgent-title', tk.title),
          priorityIcon(tk.priority), lozenge(tk.status, tk.resolution),
          tk.dueDate ? h('span.muted.small', `${t('ticket.dueDate')}: ${tk.dueDate}`) : null,
          h('span.person', avatar(tk.assignee, 'sm')),
          h('span.muted.small', relTime(tk.createdAt)))))
        : h('p.muted', t('summary.nothingOpen'))));
}
