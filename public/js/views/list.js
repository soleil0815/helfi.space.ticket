// Ticket list with filters, "My work" and "My requests"
import { api } from '../api.js';
import { h, mount, icon, avatar, lozenge, typeIcon, priorityIcon, relTime, fmtDate, select, dropdown, modal, toast, field } from '../dom.js';
import { openTemplatePicker } from './canned.js';
import { t } from '../i18n.js';
import { state, navigate } from '../app.js';
import { openCreateDialog } from './ticket.js';
import { matchQueue } from '../queues.js';
import { slaBadge } from './sla.js';

const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
import { TYPES } from '../types.js';
const PRIOS = ['highest', 'high', 'medium', 'low'];

export async function renderList(content, params, { requests = false } = {}) {
  const f = Object.fromEntries(params);
  if (!('status' in f) && requests) f.status = '';
  const set = (k, v) => {
    const p = new URLSearchParams(location.search);
    if (v) p.set(k, v); else p.delete(k);
    navigate(`${location.pathname}?${p}`, { replace: true });
  };

  // Smartphone: filters behind a button (with the number of active filters)
  const active = ['project', 'status', 'type', 'priority', 'assignee', 'participant'].filter((k) => f[k]).length + (requests && f.reporter === 'me' ? 0 : 0);
  const filterBtn = h('button.btn.btn-subtle.filter-btn', { type: 'button', 'aria-expanded': 'false', onclick: (e) => { const open = filters.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(open)); } },
    icon('list'), t('list.filter'), active ? h('span.count', String(active)) : null);
  const filters = h('div.toolbar.list-toolbar',
    h('div.toolbar-search', icon('search'), h('input.input-search', {
      type: 'search', placeholder: t('filter.search'), value: f.q || '',
      onkeydown: (e) => { if (e.key === 'Enter') set('q', e.target.value.trim()); },
      onsearch: (e) => set('q', e.target.value.trim()),
    })),
    filterBtn,
    h('div.filter-fields',
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
  ));

  const queue = requests ? null : matchQueue(params);
  const title = requests ? t('nav.myRequests') : (queue ? t(queue.label) : (f.overdue ? t('summary.overdue') : t('nav.list')));
  const tableHost = h('div', h('div.loading', t('app.loading')));
  mount(content,
    h('div.page-head', h('h1', title), requests && state.boot.allowSelfService ? h('button.btn.btn-primary', { type: 'button', onclick: () => openCreateDialog() }, icon('plus'), t('app.create')) : null),
    filters,
    tableHost,
  );

  // Search: default “best matches first”
  const sort = f.sort || (f.q ? 'relevance' : 'updated');
  const { tickets, searchTerms } = await api.tickets({ ...f, sort });
  mount(tableHost,
    f.q && searchTerms ? h('div.search-info',
      sort !== 'relevance' ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => set('sort', '') }, t('search.byRelevance')) : h('span.muted.small', t('search.sortedByRelevance')),
      h('span.muted.small.search-help', { title: t('search.help') }, ' ⓘ')) : null,
    ticketTable(tickets, {
    terms: searchTerms || [],
    requests, sort, onSort: (s) => set('sort', s),
    selectable: state.isAgent && !requests,
    onChanged: () => navigate(`${location.pathname}${location.search}`, { replace: true }),
  }));
}

/** Highlight search terms in the text (as text nodes, never as HTML) */
export function highlight(text, terms = []) {
  const s = String(text ?? '');
  const low = terms.map((x) => x.toLowerCase()).filter(Boolean);
  if (!low.length) return s;
  const out = []; let i = 0; const l = s.toLowerCase();
  while (i < s.length) {
    let best = -1; let len = 0;
    for (const x of low) { const k = l.indexOf(x, i); if (k >= 0 && (best < 0 || k < best || (k === best && x.length > len))) { best = k; len = x.length; } }
    if (best < 0) { out.push(s.slice(i)); break; }
    if (best > i) out.push(s.slice(i, best));
    out.push(h('mark', s.slice(best, best + len)));
    i = best + len;
  }
  return out;
}

export function ticketTable(tickets, { requests = false, sort, onSort, compact = false, selectable = false, onChanged, terms = [] } = {}) {
  if (!tickets.length) return h('div.empty-state.small', t('list.empty'));
  const th = (label, key) => h('th', onSort && key ? h('button.th-sort', { type: 'button', class: sort === key ? 'active' : '', onclick: () => onSort(key) }, label, sort === key ? icon('arrow-down') : null) : label);

  // ---------- Multi-select ----------
  const sel = new Set();
  let last = -1;
  const bar = selectable ? h('div.bulk-bar', { hidden: true, role: 'toolbar', 'aria-label': t('bulk.toolbar') }) : null;
  const allBox = selectable ? h('input.row-check', { type: 'checkbox', 'aria-label': t('bulk.selectAll'), onclick: (e) => e.stopPropagation(), onchange: (e) => { tickets.forEach((tk) => (e.target.checked ? sel.add(tk.key) : sel.delete(tk.key))); sync(); } }) : null;
  const boxes = new Map();
  const touchMode = () => window.matchMedia('(max-width: 800px)').matches;
  /** long press (finger) → select; afterwards a click suppresses opening */
  function longPress(fn) {
    let timer = null; let x = 0; let y = 0;
    return {
      onpointerdown: (e) => {
        if (e.pointerType !== 'touch') return;
        x = e.clientX; y = e.clientY;
        timer = setTimeout(() => {
          timer = null;
          // swallow the click after release (otherwise the selection bar shifts what lies beneath)
          const stop = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
          document.addEventListener('click', stop, { capture: true, once: true });
          setTimeout(() => document.removeEventListener('click', stop, { capture: true }), 800);
          navigator.vibrate?.(15);
          fn();
        }, 500);
      },
      onpointermove: (e) => { if (timer && (Math.abs(e.clientX - x) > 10 || Math.abs(e.clientY - y) > 10)) { clearTimeout(timer); timer = null; } },
      onpointerup: () => { clearTimeout(timer); timer = null; },
      onpointercancel: () => { clearTimeout(timer); timer = null; },
      oncontextmenu: (e) => { if (touchMode()) e.preventDefault(); },
    };
  }
  function sync() {
    for (const [key, box] of boxes) { box.checked = sel.has(key); box.closest('tr').classList.toggle('selected', sel.has(key)); }
    if (!selectable) return;
    allBox.checked = sel.size === tickets.length;
    allBox.indeterminate = sel.size > 0 && sel.size < tickets.length;
    bar.hidden = sel.size === 0;
    bar.closest('.table-wrap')?.classList.toggle('selecting', sel.size > 0);
    if (sel.size) drawBar();
  }
  function toggle(i, on, range) {
    const from = range && last >= 0 ? Math.min(last, i) : i;
    const to = range && last >= 0 ? Math.max(last, i) : i;
    for (let k = from; k <= to; k++) (on ? sel.add(tickets[k].key) : sel.delete(tickets[k].key));
    last = i;
    sync();
  }
  async function run(payload, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try {
      const r = await api.bulk({ keys: [...sel], ...payload });
      if (r.failed.length) toast(t('bulk.partly', { ok: r.ok.length, failed: r.failed.length, list: r.failed.map((x) => `${x.key}: ${x.error}`).join(', ') }), 'error');
      else toast(t('bulk.done', { n: r.ok.length }), 'success');
      onChanged?.();
    } catch (e) { toast(e.message, 'error'); }
  }
  function resolveDialog() {
    const ta = h('textarea', { rows: 5, placeholder: t('bulk.commentPlaceholder') });
    const tpl = h('button.btn.btn-subtle.small', {
      type: 'button',
      onclick: (e) => openTemplatePicker(e.currentTarget, (x) => { ta.focus(); ta.setRangeText(x.body, ta.selectionStart, ta.selectionEnd, 'end'); }),
    }, icon('comment'), t('canned.insert'), icon('chevron-down'));
    const dlg = modal(t('bulk.resolveTitle', { n: sel.size }), h('form#bulk-resolve', {
      onsubmit: (e) => { e.preventDefault(); dlg.close(); run({ changes: { status: 'done' }, comment: ta.value.trim() }); },
    }, field(t('bulk.comment'), ta, t('bulk.commentHint')), tpl), {
      footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
        h('button.btn.btn-primary', { type: 'submit', form: 'bulk-resolve' }, icon('check'), t('bulk.resolve'))],
    });
  }
  function drawBar() {
    const menu = (label, items) => h('button.btn.btn-subtle', { type: 'button', onclick: (e) => dropdown(e.currentTarget, items) }, label, icon('chevron-down'));
    mount(bar,
      h('strong', t('bulk.selected', { n: sel.size })),
      h('button.btn.btn-primary', { type: 'button', onclick: resolveDialog }, icon('check'), t('bulk.resolve')),
      menu(t('list.status'), STATUSES.map((st) => ({ label: t(`status.${st}`), onClick: () => run({ changes: { status: st } }) }))),
      menu(t('bulk.assign'), [
        { label: t('ticket.assignToMe'), icon: avatar(state.user, 'sm'), onClick: () => run({ changes: { assigneeId: state.user.id } }) },
        { label: t('app.unassigned'), icon: avatar(null, 'sm'), onClick: () => run({ changes: { assigneeId: null } }) },
        '-',
        ...state.agents.filter((a) => a.id !== state.user.id).map((a) => ({ label: a.displayName, icon: avatar(a, 'sm'), onClick: () => run({ changes: { assigneeId: a.id } }) })),
      ]),
      menu(t('list.priority'), PRIOS.map((x) => ({ label: t(`priority.${x}`), icon: priorityIcon(x), onClick: () => run({ changes: { priority: x } }) }))),
      state.projects.length > 1 ? menu(t('bulk.move'), state.projects.map((p) => ({ label: `${p.name} (${p.key})`, onClick: () => run({ changes: { projectId: p.id } }, t('bulk.moveConfirm', { n: sel.size, key: p.key })) }))) : null,
      h('span.spacer'),
      h('button.btn.btn-subtle', { type: 'button', onclick: () => { sel.clear(); sync(); } }, t('bulk.clear')));
  }

  // SLA column only for agents when SLAs are enabled
  const showSla = !requests && tickets.some((tk) => tk.sla !== undefined);
  return h('div.table-wrap',
    compact ? null : h('div.table-count', t('list.count', { n: tickets.length })),
    bar,
    h('table.issues', { class: selectable ? 'selectable' : '' },
      h('thead', h('tr',
        selectable ? h('th.col-check', allBox) : null,
        h('th.col-type', ''),
        th(t('list.key'), 'key'),
        th(t('list.summary')),
        th(t('list.status'), 'status'),
        showSla ? th(t('sla.short')) : null,
        requests ? null : th(t('list.assignee')),
        requests || compact ? null : th(t('list.reporter')),
        th(t('list.priority'), 'priority'),
        th(t('list.updated'), 'updated'),
      )),
      h('tbody', tickets.map((tk, i) => h('tr', {
        'data-key': tk.key,
        onclick: (e) => {
          // Selection mode (smartphone, after long press): tapping selects instead of opening
          if (selectable && sel.size && touchMode()) { e.preventDefault(); e.stopPropagation(); toggle(i, !sel.has(tk.key), false); return; }
          if (!e.target.closest('a,.col-check')) navigate(`/browse/${tk.key}`);
        },
        ...(selectable ? longPress(() => toggle(i, !sel.has(tk.key), false)) : {}),
      },
        selectable ? h('td.col-check', { onclick: (e) => { if (e.target === e.currentTarget) e.currentTarget.querySelector('input').click(); } }, (() => {
          const box = h('input.row-check', { type: 'checkbox', 'aria-label': tk.key, onclick: (e) => { e.stopPropagation(); toggle(i, e.target.checked, e.shiftKey); } });
          boxes.set(tk.key, box);
          return box;
        })()) : null,
        h('td.col-type', typeIcon(tk.type)),
        h('td.col-key', h('a', { href: `/browse/${tk.key}`, 'data-link': '' }, tk.key)),
        h('td.col-summary', h('a', { href: `/browse/${tk.key}`, 'data-link': '' }, highlight(tk.title, terms)), tk.source === 'email' ? h('span.src-mail', { title: t('source.email') }, icon('mail')) : null,
          tk.match ? h(`div.match-snippet${tk.match.source === 'internal' ? '.internal' : ''}`,
            h('span.match-src', tk.match.source === 'comment' || tk.match.source === 'internal' ? t(`search.src.${tk.match.source}`, { who: tk.match.author || '—' }) : t(`search.src.${tk.match.source}`)),
            ' ', highlight(tk.match.text, terms)) : null),
        h('td.col-status', lozenge(tk.status)),
        showSla ? h('td.col-sla', slaBadge(tk.sla)) : null,
        requests ? null : h('td.col-person.col-assignee', h('span.person', avatar(tk.assignee, 'sm'), h('span', tk.assignee?.displayName || t('app.unassigned')))),
        requests || compact ? null : h('td.col-person.col-reporter', h('span.person', avatar(tk.reporter, 'sm'), h('span', tk.reporter?.displayName || '—'))),
        h('td.col-prio', priorityIcon(tk.priority), h('span.prio-label', t(`priority.${tk.priority}`))),
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
