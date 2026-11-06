// Saved filters in the desktop UI: sidebar group with counts, "Save filter" dialog on the
// ticket list and a dialog to rename, reorder and delete. Shared queues come from admins.
import { api } from './api.js';
import { h, icon, field, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { state } from './state.js';
import { matchSaved, savedQuery } from './queues.js';

const hosts = new Set();
let current = null; // params of the list page (to highlight the active filter)
let loading = null;

const href = (f) => `/issues${f.query ? `?${f.query}` : ''}`;

function draw(host) {
  const list = state.savedFilters || [];
  const active = current ? matchSaved(list, current) : null;
  if (!list.length) { host.replaceChildren(); host.hidden = true; return; }
  host.hidden = false;
  host.replaceChildren(
    h('div.sidebar-label.saved-head', h('span', t('filters.title')),
      h('button.btn-icon.small', { type: 'button', title: t('filters.manage'), 'aria-label': t('filters.manage'), onclick: () => openManageFilters() }, icon('sliders'))),
    ...list.map((f) => h('a.nav-item.nav-sub.saved-filter', {
      href: href(f), 'data-link': '', class: active?.id === f.id ? 'active' : '', title: f.shared ? t('filters.sharedHint') : f.name,
    }, f.shared ? icon('users', 'saved-shared') : null, h('span.saved-name', f.name), h('span.nav-count', f.count === null || f.count === undefined ? '' : String(f.count)))));
}

/** Sidebar group (agents); filled from state.savedFilters and updated by refreshSavedFilters() */
export function savedFiltersNav(params = null) {
  current = params;
  const host = h('div.saved-filters', { hidden: true });
  hosts.add(host);
  draw(host);
  return host;
}

/** Load filters with counts and redraw every sidebar group still on the page */
export async function refreshSavedFilters() {
  if (!state.isAgent) return;
  if (!loading) {
    loading = api.filters().then((r) => { state.savedFilters = r.filters; }).catch(() => { /* keep the last list */ }).finally(() => { loading = null; });
  }
  await loading;
  for (const host of [...hosts]) { if (!host.isConnected) hosts.delete(host); else draw(host); }
}

/** "Save filter" on the list: name, admins can share it as a queue */
export function openSaveFilterDialog(params, { onSaved } = {}) {
  const query = savedQuery(params);
  const name = h('input', { required: true, maxLength: 60 });
  const shared = h('input', { type: 'checkbox' });
  const err = h('div.form-error', { role: 'alert', hidden: true });
  const dlg = modal(t('filters.save'), h('form#save-filter-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        await api.createFilter({ name: name.value, query, shared: shared.checked });
        dlg.close();
        toast(t('filters.saved'), 'success');
        await refreshSavedFilters();
        onSaved?.();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    },
  }, err,
  field(t('filters.name'), name),
  h('p.muted.small', t('filters.saveHint')),
  state.isAdmin ? field(t('filters.share'), shared, t('filters.shareHint')) : null),
  { footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), h('button.btn.btn-primary', { type: 'submit', form: 'save-filter-form' }, t('app.save'))] });
  name.focus();
}

/** Rename, reorder and delete (own filters; shared ones for admins) */
export function openManageFilters() {
  const body = h('div.manage-filters');
  const dlg = modal(t('filters.manage'), body, { footer: [h('span.spacer'), h('button.btn.btn-primary', { type: 'button', onclick: () => dlg.close() }, t('app.close'))] });
  const redraw = () => {
    const list = state.savedFilters || [];
    const groups = [[true, t('filters.shared')], [false, t('filters.mine')]];
    body.replaceChildren(...groups.map(([shared, label]) => {
      const items = list.filter((f) => f.shared === shared);
      if (!items.length) return null;
      return h('section', h('h3', label), h('ul.manage-list', items.map((f, i) => {
        if (!f.canEdit) return h('li', h('span.manage-name', f.name), h('span.muted.small', t('filters.byAdmin')));
        const move = async (dir) => {
          const ids = items.map((x) => x.id);
          [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
          try { await api.orderFilters(ids, shared); await refreshSavedFilters(); redraw(); } catch (e) { toast(e.message, 'error'); }
        };
        const input = h('input.input-inline.manage-name', {
          value: f.name, maxLength: 60, 'aria-label': t('filters.name'),
          onchange: async (e) => {
            try { await api.updateFilter(f.id, { name: e.target.value }); await refreshSavedFilters(); toast(t('app.saved'), 'success'); } catch (ex) { toast(ex.message, 'error'); redraw(); }
          },
        });
        return h('li',
          h('button.btn-icon.small', { type: 'button', disabled: i === 0, 'aria-label': t('comp.up'), title: t('comp.up'), onclick: () => move(-1) }, h('span', { 'aria-hidden': 'true' }, '↑')),
          h('button.btn-icon.small', { type: 'button', disabled: i === items.length - 1, 'aria-label': t('comp.down'), title: t('comp.down'), onclick: () => move(1) }, h('span', { 'aria-hidden': 'true' }, '↓')),
          input,
          h('button.btn-icon.small', {
            type: 'button', 'aria-label': t('filters.delete'), title: t('filters.delete'),
            onclick: async () => {
              if (!confirm(t('filters.deleteConfirm', { name: f.name }))) return;
              try { await api.deleteFilter(f.id); await refreshSavedFilters(); redraw(); } catch (e) { toast(e.message, 'error'); }
            },
          }, icon('trash')));
      })));
    }).filter(Boolean));
    if (!list.length) body.replaceChildren(h('p.muted', t('filters.none')));
  };
  redraw();
  return dlg;
}
