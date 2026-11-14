// Home tab: "My work" for agents (counters + assigned tickets); for users the portal or "My requests" (setting).
import { api } from '/js/api.js';
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { attachPasskeyHint } from '/js/passkey-hint.js';
import { replaceUrl } from '../router.js';
import { pullToRefresh } from '../ptr.js';
import { ticketList, chip, chipRow, section, emptyState, skeletonList } from '../ui.js';
import { renderPortal } from './portal.js';

export async function renderHome(page, ctx) {
  if (state.isAgent) await agentHome(page);
  else if (state.boot?.userStart === 'requests') await userHome(page, ctx);
  else await renderPortal(page, ctx);
  // First tab: hint "set up a passkey" for people without one (checked once per sign-in)
  attachPasskeyHint(page.body, { mobile: true });
}
/** Users' requests as their own tab (when the portal is the start page) */
export const renderRequests = (page, ctx) => userHome(page, ctx);

function majorBanners() {
  return (state.boot.majorIncidents || []).map((mi) => h('a.m-banner.m-banner-major', { href: `/m/t/${encodeURIComponent(mi.key)}`, 'data-link': '' },
    icon('warning'), h('span', h('strong', t('major.title')), ' ', `${mi.key} ${mi.title}`)));
}

async function agentHome(page) {
  page.title(t('m.home.title'));
  page.body.replaceChildren(h('div.m-stats.m-stats-loading', Array.from({ length: 5 }, () => h('div.m-stat.m-skeleton'))), skeletonList(3));
  const load = async () => {
    const [stats, assigned] = await Promise.all([
      api.stats(),
      api.tickets({ assignee: 'me', status: 'unresolved', sort: 'priority', limit: 100 }),
    ]);
    const stat = (n, label, query, accent) => h('a.m-stat', { href: `/m/tickets?${query}`, 'data-link': '', class: accent || '' },
      h('span.m-stat-n', String(n ?? 0)), h('span.m-stat-l', label));
    const first = (state.user.displayName || '').split(' ')[0];
    page.body.replaceChildren(
      ...majorBanners(),
      h('p.m-greeting', t('m.home.greeting', { name: first })),
      h('div.m-stats', { role: 'list', 'aria-label': t('m.home.counters') },
        stat(stats.mine, t('my.assigned'), 'assignee=me&status=unresolved', 'accent'),
        stat(stats.unassigned, t('my.unassigned'), 'assignee=none&status=unresolved', stats.unassigned ? 'warn' : ''),
        stat(stats.byStatus.open, t('status.open'), 'status=open'),
        stat(stats.byStatus.in_progress, t('status.in_progress'), 'status=in_progress'),
        stat(stats.byStatus.waiting, t('status.waiting'), 'status=waiting')),
      section(t('my.assigned'),
        assigned.tickets.length
          ? ticketList(assigned.tickets, { showAssignee: false })
          : emptyState('check', t('m.home.emptyTitle'), t('m.home.emptyText'))));
    for (const el of page.body.querySelectorAll('.m-stat')) el.setAttribute('role', 'listitem');
  };
  await load();
  pullToRefresh(page, load);
}

const USER_FILTERS = [
  { id: 'open', label: 'm.req.open', params: { status: 'unresolved' } },
  { id: 'waiting', label: 'portal.count.waiting', params: { status: 'waiting' } },
  { id: 'done', label: 'm.req.done', params: { status: 'done' } },
  { id: 'participant', label: 'm.req.participant', params: { participant: 'me' } },
  // Target of the portal counter "Active" (open + in progress); its chip only shows while it is chosen
  { id: 'active', label: 'portal.count.active', params: { status: 'open,in_progress' }, onlyActive: true },
];

async function userHome(page, ctx) {
  page.title(t('m.req.title'));
  let filter = USER_FILTERS.find((f) => f.id === ctx.params.get('filter')) || null;
  // mine=1 (from the portal counters, which count only the user's own reports): only tickets they reported
  let mine = ctx.params.get('mine') === '1';
  const chips = h('div');
  const listHost = h('div', skeletonList(3));
  page.body.replaceChildren(chips, listHost);
  const sync = () => {
    const base = location.pathname === '/m/requests' ? '/m/requests' : '/m/';
    const q = new URLSearchParams();
    if (filter) q.set('filter', filter.id);
    if (mine) q.set('mine', '1');
    replaceUrl(q.toString() ? `${base}?${q}` : base);
    drawChips();
    load();
  };
  const drawChips = () => chips.replaceChildren(chipRow([
    ...USER_FILTERS.filter((f) => !f.onlyActive || filter?.id === f.id).map((f) => chip(t(f.label), {
      active: filter?.id === f.id,
      onClick: () => { filter = filter?.id === f.id ? null : f; sync(); },
    })),
    mine ? chip(t('filter.reportedByMe'), { active: true, onClick: () => { mine = false; sync(); } }) : null,
  ], t('m.req.title')));
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    const { tickets } = await api.tickets({ ...(filter?.params || {}), ...(mine ? { reporter: 'me' } : {}), sort: 'updated' });
    if (my !== seq) return;
    listHost.replaceChildren(tickets.length
      ? ticketList(tickets)
      : emptyState('inbox', filter ? t('list.empty') : t('m.req.emptyTitle'), filter ? null : t('m.req.emptyText'),
        state.boot.allowSelfService ? h('a.m-btn.m-btn-primary', { href: '/m/new', 'data-link': '' }, icon('plus'), t('m.newTicket')) : null));
  };
  drawChips();
  await load();
  pullToRefresh(page, load);
}
