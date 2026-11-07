// Tickets tab: full-text search, queue chips, filter sheet, card list with "load more".
import { api } from '/js/api.js';
import { h, icon, avatar, priorityIcon, typeIcon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { QUEUES, VIEWS, matchQueue, matchSaved } from '/js/queues.js';
import { typesFor } from '/js/types.js';
import { replaceUrl, go } from '../router.js';
import { attachQuickSearch } from '/js/quicksearch.js';
import { pullToRefresh } from '../ptr.js';
import { openSheet } from '../sheet.js';
import { ticketCard, chip, chipRow, emptyState, skeletonList } from '../ui.js';

const PAGE = 50;
const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
const PRIOS = ['highest', 'high', 'medium', 'low'];
// Filter keys: a queue chip replaces all of them (search and project stay)
const QUEUE_KEYS = ['status', 'assignee', 'resolvedDays', 'type', 'priority', 'label', 'reporter', 'overdue', 'sla', 'approval', 'participant', 'mentioned', 'component'];
const ALLOWED = [...QUEUE_KEYS, 'q', 'project', 'sort'];
const USER_CHIPS = [
  { id: 'all', label: 'm.q.all', params: {} },
  { id: 'open', label: 'm.req.open', params: { status: 'unresolved' } },
  { id: 'done', label: 'm.req.done', params: { status: 'done' } },
];
const QUEUE_SHORT = { open: 'm.q.open', mine: 'm.q.mine', unassigned: 'm.q.unassigned', waiting: 'm.q.waiting', recent: 'm.q.recent', all: 'm.q.all', mentions: 'm.q.mentions' };
// Queues plus "Mentions me" (as a chip after "Mine")
const AGENT_CHIPS = [...QUEUES.slice(0, 2), VIEWS.find((v) => v.id === 'mentions'), ...QUEUES.slice(2)];

export async function renderTickets(page, ctx) {
  page.title(t('m.tab.tickets'));
  const f = {};
  for (const k of ALLOWED) { const v = ctx.params.get(k); if (v) f[k] = v; }
  let nextPage = 2; // page that "load more" fetches
  let shown = 0;
  let counts = null;
  let saved = null; // saved filters and shared queues (agents), as chips after the queues

  const writeUrl = () => {
    const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    replaceUrl(`/m/tickets${p.toString() ? `?${p}` : ''}`);
  };

  // ---------- Search ----------
  const input = h('input.m-search-input', {
    type: 'search', value: f.q || '', placeholder: t('m.tickets.search'), 'aria-label': t('m.tickets.search'),
    enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
  });
  const runSearch = () => {
    const q = input.value.trim();
    if ((f.q || '') === q) return;
    if (q) f.q = q; else delete f.q;
    delete f.sort;
    writeUrl();
    load();
  };
  const search = h('form.m-search', { role: 'search', onsubmit: (e) => { e.preventDefault(); input.blur(); runSearch(); } },
    icon('search'), input);
  input.addEventListener('search', runSearch); // the clear button (×) of the field
  // Results while typing (as on the desktop); Enter without a choice filters the list below
  attachQuickSearch(input, {
    openTicket: (key) => { input.blur(); go(`/m/t/${encodeURIComponent(key)}`); },
    showAll: (q) => { input.value = q; input.blur(); runSearch(); },
  });
  input.addEventListener('input', () => { if (!input.value) runSearch(); });

  // ---------- Chips ----------
  const chipsHost = h('div');
  function drawChips() {
    if (state.isAgent) {
      const cur = matchQueue(new URLSearchParams(f));
      const curSaved = cur ? null : matchSaved(saved, new URLSearchParams(f));
      chipsHost.replaceChildren(chipRow([
        ...AGENT_CHIPS.map((q) => chip(t(QUEUE_SHORT[q.id] || q.label), {
          active: cur?.id === q.id,
          count: counts ? counts[q.count] ?? null : null,
          onClick: () => {
            for (const k of QUEUE_KEYS) delete f[k];
            Object.assign(f, q.params);
                    writeUrl(); drawChips(); load();
          },
        })),
        // A saved filter replaces all filters (including search, project and sorting)
        ...(saved || []).map((sf) => chip(sf.name, {
          active: curSaved?.id === sf.id,
          count: sf.count ?? null,
          onClick: () => {
            for (const k of Object.keys(f)) delete f[k];
            for (const [k, v] of new URLSearchParams(sf.query)) if (ALLOWED.includes(k)) f[k] = v;
            input.value = f.q || '';
                    writeUrl(); drawChips(); drawFilterBtn(); load();
          },
        })),
      ], t('nav.queues')));
      // Active chip (e.g. a saved filter far right) into view
      requestAnimationFrame(() => chipsHost.querySelector('.m-chip.active')?.scrollIntoView({ inline: 'center', block: 'nearest' }));
    } else {
      const curId = f.status === 'done' ? 'done' : (f.status === 'unresolved' ? 'open' : 'all');
      chipsHost.replaceChildren(chipRow(USER_CHIPS.map((c) => chip(t(c.label), {
        active: c.id === curId,
        onClick: () => { delete f.status; Object.assign(f, c.params); writeUrl(); drawChips(); load(); },
      })), t('m.filter.status')));
    }
  }

  // ---------- Filter sheet ----------
  const extraCount = () => ['type', 'priority', 'project'].filter((k) => f[k]).length
    + (f.assignee && !['me', 'none'].includes(f.assignee) ? 1 : 0);
  const filterBtn = h('button.m-iconbtn.m-filter-btn', { type: 'button', 'aria-label': t('m.tickets.filter'), onclick: () => openFilters() }, icon('sliders'));
  const drawFilterBtn = () => {
    const n = extraCount();
    filterBtn.classList.toggle('has-dot', n > 0);
    filterBtn.setAttribute('aria-label', n ? t('m.tickets.filterActive', { n }) : t('m.tickets.filter'));
  };
  page.action(filterBtn);

  function openFilters() {
    const draft = { ...f };
    const group = (label, key, options) => {
      const wrap = h('div.m-choice-group', { role: 'radiogroup', 'aria-label': label });
      const draw = () => wrap.replaceChildren(...options.map(([v, text, ic]) => h('button.m-choice', {
        type: 'button', role: 'radio', 'aria-checked': String((draft[key] || '') === v), class: (draft[key] || '') === v ? 'active' : '',
        onclick: () => { if (v) draft[key] = v; else delete draft[key]; draw(); },
      }, ic || null, h('span', text))));
      draw();
      return h('div.m-filter', h('h3', label), wrap);
    };
    const all = t('m.filter.any');
    const content = [
      group(t('m.filter.status'), 'status', [['', all], ['unresolved', t('status.unresolved')], ...STATUSES.map((s) => [s, t(`status.${s}`)])]),
      group(t('ticket.type'), 'type', [['', all], ...typesFor(state.isAgent).map((x) => [x, t(`type.${x}`), typeIcon(x)])]),
      group(t('ticket.priority'), 'priority', [['', all], ...PRIOS.map((x) => [x, t(`priority.${x}`), priorityIcon(x)])]),
      state.isAgent ? group(t('ticket.assignee'), 'assignee', [['', all], ['me', t('app.me'), avatar(state.user, 'xs')], ['none', t('app.unassigned'), avatar(null, 'xs')],
        ...state.agents.filter((a) => a.id !== state.user.id).map((a) => [String(a.id), a.displayName, avatar(a, 'xs')])]) : null,
      state.projects.length > 1 ? group(t('ticket.project'), 'project', [['', all], ...state.projects.map((p) => [p.key, p.name])]) : null,
    ];
    let apply = null;
    const sheet = openSheet({
      title: t('m.tickets.filterTitle'),
      content,
      footer: [
        h('button.m-btn', { type: 'button', onclick: () => { apply = {}; sheet.close(); } }, t('m.tickets.reset')),
        h('button.m-btn.m-btn-primary', { type: 'button', onclick: () => { apply = draft; sheet.close(); } }, t('m.tickets.apply')),
      ],
      // Only after the sheet has left the history: the address of the list page is updated
      onClose: () => {
        if (!apply) return;
        for (const k of QUEUE_KEYS.concat('project')) delete f[k];
        Object.assign(f, apply);
            writeUrl(); drawChips(); drawFilterBtn(); load();
      },
    });
  }

  // ---------- List ----------
  const info = h('div.m-list-info', { 'aria-live': 'polite' });
  const listHost = h('div', skeletonList(5));
  const more = h('div.m-more');
  page.body.replaceChildren(h('div.m-sticky-tools', search, chipsHost), info, listHost, more);

  let seq = 0;
  let loadingMore = false;
  let total = 0;
  let terms = [];
  const sortNow = () => f.sort || (f.q ? 'relevance' : 'updated');
  function drawInfo() {
    info.textContent = total ? t(shown < total ? 'm.tickets.countOf' : 'm.tickets.count', { n: shown, total }) : '';
  }
  /** "Load more" button at the end; loads automatically when it comes into view */
  function drawMore() {
    more.replaceChildren();
    if (shown >= total) return;
    const btn = h('button.m-btn.m-btn-block', { type: 'button', onclick: () => loadMore() }, t('m.tickets.loadMore'));
    more.append(btn);
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && page.isActive()) { io.disconnect(); loadMore(); } }, { root: page.scroll, rootMargin: '200px' });
      io.observe(btn);
    }
  }
  async function load() {
    const my = ++seq;
    listHost.replaceChildren(skeletonList(4)); more.replaceChildren(); info.textContent = '';
    const [r, q, sf] = await Promise.all([
      api.tickets({ ...f, sort: sortNow(), page: 1, pageSize: PAGE }),
      state.isAgent && !counts ? api.queues().catch(() => null) : Promise.resolve(null),
      state.isAgent && !counts ? api.filters().catch(() => null) : Promise.resolve(null),
    ]);
    if (my !== seq) return;
    if (sf) saved = sf.filters;
    if (q || sf) { if (q) counts = q.counts; drawChips(); }
    terms = r.searchTerms || [];
    total = r.total || 0;
    shown = r.tickets.length;
    nextPage = 2;
    drawInfo();
    listHost.replaceChildren(r.tickets.length
      ? h('div.m-list', r.tickets.map((tk) => ticketCard(tk, { terms })))
      : emptyState('search', t('list.empty'), f.q ? t('m.tickets.emptySearch') : null));
    drawMore();
  }
  /** Next page appended to the list (no upper limit) */
  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    const my = seq;
    more.replaceChildren(h('div.m-spinner', { role: 'status', 'aria-label': t('app.loading') }));
    try {
      const r = await api.tickets({ ...f, sort: sortNow(), page: nextPage, pageSize: PAGE });
      if (my !== seq) return;
      // the server answers a page past the end with the last one: only append when it is really the next page
      if (r.page === nextPage && r.tickets.length) {
        listHost.querySelector('.m-list')?.append(...r.tickets.map((tk) => ticketCard(tk, { terms })));
        shown += r.tickets.length;
        nextPage += 1;
      }
      total = r.total || 0;
      if (r.page !== nextPage - 1) shown = total; // nothing more to fetch
      drawInfo();
      drawMore();
    } catch { drawMore(); } finally { loadingMore = false; }
  }

  drawChips();
  drawFilterBtn();
  await load();
  pullToRefresh(page, async () => { counts = null; await load(); });
}
