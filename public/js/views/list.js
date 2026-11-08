// Ticket list with filters, "My work" and "My requests"
import { api } from '../api.js';
import { h, mount, icon, avatar, lozenge, typeIcon, priorityIcon, relTime, fmtDate, select, dropdown, modal, toast, field, highlight } from '../dom.js';
import { openTemplatePicker } from './canned.js';
import { openResolveDialog } from './resolve.js';
import { t } from '../i18n.js';
import { state, navigate } from '../app.js';
import { openCreateDialog } from './ticket.js';
import { matchQueue, matchSaved, savedQuery } from '../queues.js';
import { openSaveFilterDialog } from '../savedfilters.js';
import { slaBadge } from './sla.js';
import { CHOICES, ticketPicker } from './links.js';
import { projectComponents } from '../components.js';

const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
import { TYPES } from '../types.js';
const PRIOS = ['highest', 'high', 'medium', 'low'];

// ---------- Pages ----------
export const PAGE_SIZES = [50, 100, 250, 500];
const PAGE_SIZE_KEY = 'helfi.pageSize';
export function getPageSize() {
  try { const v = Number(localStorage.getItem(PAGE_SIZE_KEY)); if (PAGE_SIZES.includes(v)) return v; } catch { /* storage blocked */ }
  return 100;
}
function setPageSize(n) { try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* storage blocked */ } }

/** Page numbers around the current page: 1 … 4 5 [6] 7 8 … 80 (null = gap) */
export function pageNumbers(page, pages) {
  const want = new Set([1, pages]);
  for (let i = page - 2; i <= page + 2; i++) if (i >= 1 && i <= pages) want.add(i);
  const sorted = [...want].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((n, i) => {
    if (i && n - sorted[i - 1] === 2) out.push(n - 1); // a single missing number instead of "…"
    else if (i && n - sorted[i - 1] > 2) out.push(null);
    out.push(n);
  });
  return out;
}

/** Pager below the list: « ‹ 1 … 5 6 7 … 80 › » plus entries per page */
function pager({ page, pages, pageSize, range, onPage, onSize }) {
  const btn = (n, label, aria, disabled = false) => h('button.btn.btn-subtle.small.pager-btn', {
    type: 'button', disabled, 'aria-label': aria, title: aria, onclick: () => onPage(n),
  }, label);
  return h('nav.pager', { 'aria-label': t('list.pages') },
    pages > 1 ? h('div.pager-pages',
      btn(1, '«', t('list.firstPage'), page === 1),
      btn(page - 1, '‹', t('list.prevPage'), page === 1),
      ...pageNumbers(page, pages).map((n) => (n === null
        ? h('span.pager-gap', { 'aria-hidden': 'true' }, '…')
        : h('button.btn.btn-subtle.small.pager-btn', {
          type: 'button', class: n === page ? 'active' : '', 'aria-label': t('list.page', { n }),
          ...(n === page ? { 'aria-current': 'page' } : {}), onclick: () => { if (n !== page) onPage(n); },
        }, String(n)))),
      btn(page + 1, '›', t('list.nextPage'), page === pages),
      btn(pages, '»', t('list.lastPage'), page === pages)) : null,
    range ? h('span.pager-range', range) : null,
    h('span.spacer'),
    select(PAGE_SIZES.map((n) => [String(n), t('list.perPage', { n })]), String(pageSize), {
      class: 'select-sm', 'aria-label': t('list.pageSize'), onchange: (e) => onSize(Number(e.target.value)),
    }));
}

export async function renderList(content, params, { requests = false } = {}) {
  const f = Object.fromEntries(params);
  if (!('status' in f) && requests) f.status = '';
  const set = (k, v) => {
    const p = new URLSearchParams(location.search);
    if (v) p.set(k, v); else p.delete(k);
    p.delete('page'); // other filter, search or sorting → back to page 1
    // A resolution only exists for done tickets (the server then filters status=done):
    // switching to another status drops it, otherwise the list would stay empty
    if (k === 'status' && v !== 'done') p.delete('resolution');
    navigate(`${location.pathname}?${p}`, { replace: true });
  };

  // Smartphone: filters behind a button (with the number of active filters)
  // Component filter: components belong to a project – offered once a project is chosen (or there is only one)
  const filterProject = !requests && state.isAgent ? (f.project ? state.projects.find((p) => p.key === String(f.project).toUpperCase() || String(p.id) === String(f.project)) : (state.projects.length === 1 ? state.projects[0] : null)) : null;
  const comps = filterProject ? await projectComponents(filterProject.id) : [];
  if (!content.isConnected) return;
  const active = ['project', 'status', 'type', 'priority', 'assignee', 'participant', 'component'].filter((k) => f[k]).length + (requests && f.reporter === 'me' ? 0 : 0);
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
          p.delete('reporter'); p.delete('participant'); p.delete('page');
          if (e.target.value) p.set(e.target.value, 'me');
          navigate(`${location.pathname}?${p}`, { replace: true });
        },
      }) : null,
    !requests && state.projects.length > 1 ? select([['', t('nav.allProjects')], ...state.projects.map((p) => [p.key, p.name])], f.project || '', { class: 'select-sm', onchange: (e) => set('project', e.target.value) }) : null,
    select([['', t('filter.allStatus')], ['unresolved', t('status.unresolved')], ...STATUSES.map((s) => [s, t(`status.${s}`)])], f.status || '', { class: 'select-sm', onchange: (e) => set('status', e.target.value) }),
    // Resolution: only meaningful for done tickets
    f.status === 'done' || f.resolution ? select([['', t('filter.allResolutions')], ...['done', 'rejected', 'duplicate'].map((r) => [r, t(`resolution.${r}`)])], f.resolution || '', { class: 'select-sm', 'aria-label': t('field.resolution'), onchange: (e) => set('resolution', e.target.value) }) : null,
    !requests ? select([['', t('filter.allTypes')], ...TYPES.map((s) => [s, t(`type.${s}`)])], f.type || '', { class: 'select-sm', onchange: (e) => set('type', e.target.value) }) : null,
    !requests ? select([['', t('filter.allPriorities')], ...PRIOS.map((s) => [s, t(`priority.${s}`)])], f.priority || '', { class: 'select-sm', onchange: (e) => set('priority', e.target.value) }) : null,
    comps.length || f.component ? select([['', t('filter.allComponents')], ['none', t('filter.noComponent')], ...comps.map((c) => [c.id, c.name])], f.component || '', { class: 'select-sm', 'aria-label': t('ticket.component'), onchange: (e) => set('component', e.target.value) }) : null,
    !requests ? select([['', t('filter.allAssignees')], ['me', t('app.me')], ['none', t('app.unassigned')], ...state.agents.map((a) => [a.id, a.displayName])], f.assignee || '', { class: 'select-sm', onchange: (e) => set('assignee', e.target.value) }) : null,
    Object.keys(f).some((k) => f[k] && k !== 'reporter') ? h('button.btn.btn-subtle', { type: 'button', onclick: () => navigate(location.pathname, { replace: true }) }, t('filter.reset')) : null,
  ));

  const queue = requests ? null : matchQueue(params);
  // Saved filter (agents): title from the filter; "Save filter" when something is filtered that is not saved yet
  const saved = !requests && state.isAgent && !queue ? matchSaved(state.savedFilters, params) : null;
  const title = requests ? t('nav.myRequests') : (queue ? t(queue.label) : (saved ? saved.name : (f.overdue ? t('summary.overdue') : t('nav.list'))));
  const canSave = !requests && state.isAgent && !queue && !saved && savedQuery(params, false) !== '';
  const tableHost = h('div', h('div.loading', t('app.loading')));
  mount(content,
    h('div.page-head', h('h1', title),
      canSave ? h('button.btn.btn-subtle.save-filter-btn', { type: 'button', onclick: () => openSaveFilterDialog(params, { onSaved: () => navigate(`${location.pathname}${location.search}`, { replace: true }) }) }, icon('star'), t('filters.save')) : null,
      requests && state.boot.allowSelfService ? h('button.btn.btn-primary', { type: 'button', onclick: () => openCreateDialog() }, icon('plus'), t('app.create')) : null),
    filters,
    tableHost,
  );

  // Search: default “best matches first”
  const sort = f.sort || (f.q ? 'relevance' : 'updated');
  const pageSize = getPageSize();
  const want = Math.max(1, Number.parseInt(f.page, 10) || 1);
  const { tickets, searchTerms, searchCapped, total, page } = await api.tickets({ ...f, sort, page: want, pageSize });
  if (!content.isConnected) return;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // Page past the end (e.g. after bulk changes): the server delivered the last one – keep the address right
  if (page !== want) {
    const p = new URLSearchParams(location.search);
    if (page > 1) p.set('page', String(page)); else p.delete('page');
    history.replaceState({}, '', `${location.pathname}?${p}`);
  }
  const goPage = (n) => {
    const p = new URLSearchParams(location.search);
    if (n > 1) p.set('page', String(n)); else p.delete('page');
    navigate(`${location.pathname}?${p}`);
    document.querySelector('.main')?.scrollTo({ top: 0 });
  };
  const from = total ? (page - 1) * pageSize + 1 : 0;
  mount(tableHost,
    f.q && searchTerms ? h('div.search-info',
      sort !== 'relevance' ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => set('sort', '') }, t('search.byRelevance')) : h('span.muted.small', t('search.sortedByRelevance')),
      h('span.muted.small.search-help', { title: t('search.help') }, ' ⓘ')) : null,
    searchCapped ? h('div.hint-box.small.search-capped', t('search.capped')) : null,
    ticketTable(tickets, {
      terms: searchTerms || [],
      requests, sort, onSort: (s) => set('sort', s),
      selectable: state.isAgent && !requests,
      count: total > tickets.length ? t('list.range', { from, last: from + tickets.length - 1, total }) : null,
      onChanged: () => navigate(`${location.pathname}${location.search}`, { replace: true }),
    }),
    total ? pager({
      page, pages, pageSize,
      range: pages > 1 ? t('list.range', { from, last: from + tickets.length - 1, total }) : null,
      onPage: goPage,
      onSize: (n) => { setPageSize(n); const p = new URLSearchParams(location.search); p.delete('page'); navigate(`${location.pathname}?${p}`, { replace: true }); },
    }) : null);
}

export function ticketTable(tickets, { requests = false, sort, onSort, compact = false, selectable = false, onChanged, terms = [], count = null } = {}) {
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
  /**
   * One dialog for status changes, comments and links of the selection:
   * mode "status" (status given, comment optional), "comment" (comment required),
   * "link" (kind + target required; status and comment optional).
   */
  function bulkDialog(mode, status = null) {
    const n = sel.size;
    const ta = h('textarea', { id: 'bulk-comment-text', rows: 5, placeholder: t('bulk.commentPlaceholder') });
    let internal = false;
    const hint = h('div.hint');
    const label = h('label', { for: 'bulk-comment-text' });
    const setKind = (isInternal) => {
      internal = isInternal;
      reply.classList.toggle('active', !internal);
      note.classList.toggle('active', internal);
      reply.setAttribute('aria-pressed', String(!internal));
      note.setAttribute('aria-pressed', String(internal));
      label.textContent = mode === 'comment' ? t(internal ? 'bulk.noteLabel' : 'bulk.replyLabel') : t(internal ? 'bulk.noteLabelOpt' : 'bulk.comment');
      hint.textContent = t(internal ? 'bulk.noteHint' : 'bulk.commentHint');
      ta.classList.toggle('internal', internal);
    };
    const reply = h('button.mode', { type: 'button', onclick: () => setKind(false) }, icon('mail'), t('bulk.asReply'));
    const note = h('button.mode', { type: 'button', onclick: () => setKind(true) }, icon('lock'), t('bulk.asNote'));
    const tpl = h('button.btn.btn-subtle.small', {
      type: 'button',
      onclick: (e) => openTemplatePicker(e.currentTarget, (x) => { ta.focus(); ta.setRangeText(x.body, ta.selectionStart, ta.selectionEnd, 'end'); }),
    }, icon('comment'), t('canned.insert'), icon('chevron-down'));
    const commentPart = h('div.bulk-comment',
      h('div.composer-modes.bulk-modes', { role: 'group', 'aria-label': t('bulk.kind') }, reply, note),
      h('div.field', label, ta, hint), tpl);
    setKind(false);

    // Link: kind (from the point of view of the selected tickets) and target ticket
    const linkKind = mode === 'link' ? h('select', CHOICES.map(([id]) => h('option', { value: id }, t(`link.choice.${id}`)))) : null;
    if (linkKind) linkKind.value = 'causedBy';
    const picker = mode === 'link' ? ticketPicker(null, { forKeys: [...sel] }) : null;
    // Status: fixed for "status", optional for "link"
    const statusSel = mode === 'link' ? select([['', t('bulk.keepStatus')], ...STATUSES.map((st) => [st, t(`status.${st}`)])], '') : null;

    const title = mode === 'status' ? (status === 'done' ? t('bulk.resolveTitle', { n }) : t('bulk.statusTitle', { n, status: t(`status.${status}`) }))
      : mode === 'comment' ? t('bulk.commentTitle', { n }) : t('bulk.linkTitle', { n });
    const submitLabel = mode === 'status' ? (status === 'done' ? t('bulk.resolve') : t('bulk.setStatus'))
      : mode === 'comment' ? t('bulk.addComment') : t('link.add');
    const err = h('div.form-error', { role: 'alert', hidden: true });
    const dlg = modal(title, h('form#bulk-action', {
      onsubmit: (e) => {
        e.preventDefault();
        const comment = ta.value.trim();
        const payload = {};
        if (mode === 'status') payload.changes = { status };
        if (mode === 'link') {
          const target = picker.input.value.trim().toUpperCase();
          if (!target) { err.textContent = t('bulk.linkTargetMissing'); err.hidden = false; picker.input.focus(); return; }
          const [, kind, reverse] = CHOICES.find(([id]) => id === linkKind.value);
          payload.link = { kind, reverse, target };
          if (statusSel.value) payload.changes = { status: statusSel.value };
        }
        if (mode === 'comment' && !comment) { err.textContent = t('bulk.commentMissing'); err.hidden = false; ta.focus(); return; }
        if (comment) { payload.comment = comment; payload.internal = internal; }
        dlg.close();
        run(payload);
      },
    },
    err,
    mode === 'link' ? h('div.bulk-link',
      field(t('bulk.linkKind'), linkKind, t('bulk.linkKindHint')),
      field(t('bulk.linkTarget'), picker.el),
      field(t('bulk.thenStatus'), statusSel)) : null,
    commentPart), {
      footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
        h('button.btn.btn-primary', { type: 'submit', form: 'bulk-action' }, icon(mode === 'link' ? 'link' : (mode === 'comment' ? 'comment' : 'check')), submitLabel)],
    });
    setTimeout(() => (picker ? picker.input : ta).focus(), 0);
  }
  // Component for the selection: components belong to a project – only when all selected tickets are in one
  function componentMenu() {
    const projects = new Set(tickets.filter((tk) => sel.has(tk.key)).map((tk) => tk.projectId));
    const pid = projects.size === 1 ? [...projects][0] : null;
    return h('button.btn.btn-subtle', {
      type: 'button',
      disabled: !pid,
      title: pid ? null : t('bulk.componentOneProject'),
      'data-bulk': 'component',
      onclick: async (e) => {
        const anchor = e.currentTarget;
        const comps = await projectComponents(pid);
        dropdown(anchor, [
          { label: t('filter.noComponent'), onClick: () => run({ changes: { componentId: null } }) },
          ...(comps.length ? ['-'] : []),
          ...comps.map((c) => ({ label: c.name, onClick: () => run({ changes: { componentId: c.id } }) })),
        ]);
      },
    }, t('ticket.component'), icon('chevron-down'));
  }

  function drawBar() {
    const menu = (label, items) => h('button.btn.btn-subtle', { type: 'button', onclick: (e) => dropdown(e.currentTarget, items) }, label, icon('chevron-down'));
    mount(bar,
      h('strong', t('bulk.selected', { n: sel.size })),
      h('button.btn.btn-primary', { type: 'button', onclick: () => bulkDialog('status', 'done') }, icon('check'), t('bulk.resolve')),
      menu(t('list.status'), [
        ...STATUSES.map((st) => ({ label: t(`status.${st}`), onClick: () => bulkDialog('status', st) })),
        '-',
        { label: t('resolve.rejectMenu'), icon: icon('close'), onClick: () => openResolveDialog({ kind: 'rejected', keys: [...sel], onDone: () => { sel.clear(); onChanged?.(); } }) },
        { label: t('resolve.duplicateMenu'), icon: icon('copy'), onClick: () => openResolveDialog({ kind: 'duplicate', keys: [...sel], onDone: () => { sel.clear(); onChanged?.(); } }) },
      ]),
      h('button.btn.btn-subtle', { type: 'button', onclick: () => bulkDialog('comment') }, icon('comment'), t('bulk.comment.action')),
      h('button.btn.btn-subtle', { type: 'button', onclick: () => bulkDialog('link') }, icon('link'), t('bulk.link')),
      menu(t('bulk.assign'), [
        { label: t('ticket.assignToMe'), icon: avatar(state.user, 'sm'), onClick: () => run({ changes: { assigneeId: state.user.id } }) },
        { label: t('app.unassigned'), icon: avatar(null, 'sm'), onClick: () => run({ changes: { assigneeId: null } }) },
        '-',
        ...state.agents.filter((a) => a.id !== state.user.id).map((a) => ({ label: a.displayName, icon: avatar(a, 'sm'), onClick: () => run({ changes: { assigneeId: a.id } }) })),
      ]),
      menu(t('list.priority'), PRIOS.map((x) => ({ label: t(`priority.${x}`), icon: priorityIcon(x), onClick: () => run({ changes: { priority: x } }) }))),
      componentMenu(),
      state.projects.length > 1 ? menu(t('bulk.move'), state.projects.map((p) => ({ label: `${p.name} (${p.key})`, onClick: () => run({ changes: { projectId: p.id } }, t('bulk.moveConfirm', { n: sel.size, key: p.key })) }))) : null,
      h('span.spacer'),
      h('button.btn.btn-subtle', { type: 'button', onclick: () => { sel.clear(); sync(); } }, t('bulk.clear')));
  }

  // SLA column only for agents when SLAs are enabled
  const showSla = !requests && tickets.some((tk) => tk.sla !== undefined);
  const showComponent = !requests && !compact && tickets.some((tk) => tk.component);
  return h('div.table-wrap',
    compact ? null : h('div.table-count', count || t('list.count', { n: tickets.length })),
    bar,
    h('table.issues', { class: selectable ? 'selectable' : '' },
      h('thead', h('tr',
        selectable ? h('th.col-check', allBox) : null,
        h('th.col-type', ''),
        th(t('list.key'), 'key'),
        th(t('list.summary')),
        th(t('list.status'), 'status'),
        showComponent ? th(t('ticket.component')) : null,
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
          tk.mentionUnseen ? h('span.mention-dot', { title: t('mention.unseen'), 'aria-label': t('mention.unseen') }, '@') : null,
          tk.match ? h(`div.match-snippet${tk.match.source === 'internal' ? '.internal' : ''}`,
            h('span.match-src', tk.match.source === 'comment' || tk.match.source === 'internal' ? t(`search.src.${tk.match.source}`, { who: tk.match.author || '—' }) : t(`search.src.${tk.match.source}`)),
            ' ', highlight(tk.match.text, terms)) : null),
        h('td.col-status', lozenge(tk.status, tk.resolution)),
        showComponent ? h('td.col-component', tk.component?.name || '') : null,
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
