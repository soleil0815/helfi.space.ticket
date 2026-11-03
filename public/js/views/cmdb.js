// Geräte und Dienste: Liste, Eintrag mit Ticket-Verlauf, CSV-Import, Abschnitt im Ticket
import { api } from '../api.js';
import { h, mount, icon, toast, field, select, modal, lozenge, typeIcon, fmtDate } from '../dom.js';
import { peoplePicker } from '../peoplepicker.js';
import { t } from '../i18n.js';
import { state, navigate } from '../app.js';

export const CI_KINDS = ['device', 'server', 'network', 'printer', 'phone', 'service', 'application', 'other'];
const CI_STATUS = ['active', 'maintenance', 'retired'];
const KIND_EMOJI = { device: '💻', server: '🖥️', network: '🔌', printer: '🖨️', phone: '📱', service: '🧩', application: '📦', other: '🔧' };
const kindLabel = (k) => `${KIND_EMOJI[k] || ''} ${t(`ci.kind.${k}`)}`;
const statusBadge = (s) => (s === 'active' ? null : h(`span.badge.ci-${s}`, t(`ci.status.${s}`)));

export async function renderCmdb(content, params, path) {
  if (path === '/cis/new') return editor(content, null);
  const m = /^\/cis\/(\d+)$/.exec(path);
  if (m) return detail(content, Number(m[1]));
  return list(content, params);
}

async function list(content, params) {
  const q = params.get('q') || '';
  const kind = params.get('kind') || '';
  const status = params.get('status') || '';
  const go = (patch) => {
    const p = new URLSearchParams({ q, kind, status, ...patch });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    navigate(`/cis${p.toString() ? `?${p}` : ''}`, { replace: true });
  };
  const search = h('input.kb-search', { type: 'search', value: q, placeholder: t('ci.searchHint'), 'aria-label': t('ci.search') });
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => go({ q: search.value.trim() }), 300); });
  const kindSel = select([['', t('ci.allKinds')], ...CI_KINDS.map((k) => [k, kindLabel(k)])], kind);
  kindSel.addEventListener('change', () => go({ kind: kindSel.value }));
  const statusSel = select([['', t('ci.notRetired')], ...CI_STATUS.map((s) => [s, t(`ci.status.${s}`)]), ['all', t('ci.allStatus')]], status);
  statusSel.addEventListener('change', () => go({ status: statusSel.value }));
  const { items } = await api.cis({ q, kind, status });
  mount(content,
    h('div.page-head', h('h1', t('ci.title')), h('span.spacer'),
      state.user.role === 'admin' ? h('button.btn.btn-subtle', { type: 'button', onclick: () => importDialog() }, icon('download'), t('ci.import')) : null,
      h('a.btn.btn-primary', { href: '/cis/new', 'data-link': '' }, icon('plus'), t('ci.new'))),
    h('p.muted', t('ci.intro')),
    h('div.ci-filters', h('div.kb-search-row', icon('search'), search), kindSel, statusSel),
    items.length ? h('table.data.ci-table',
      h('thead', h('tr', h('th', t('ci.f.name')), h('th', t('ci.f.kind')), h('th', t('ci.f.location')), h('th', t('ci.f.owner')), h('th', t('ci.f.ip')), h('th', t('ci.openTickets')))),
      h('tbody', items.map((x) => h('tr',
        h('td', h('a', { href: `/cis/${x.id}`, 'data-link': '' }, x.name), ' ', statusBadge(x.status)),
        h('td', kindLabel(x.kind)), h('td', x.location), h('td', x.owner?.displayName || ''), h('td.mono', x.ip),
        h('td', x.openTickets ? h('span.badge', String(x.openTickets)) : ''))))) : h('p.muted', q || kind || status ? t('ci.noMatch') : t('ci.empty')));
  if (q) { search.focus(); search.setSelectionRange(q.length, q.length); }
}

async function detail(content, id) {
  const { item } = await api.ci(id);
  const row = (label, value) => (value ? h('tr', h('th', label), h('td', value)) : null);
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/cis', 'data-link': '' }, t('ci.title'))),
    h('div.page-head', h('h1', `${KIND_EMOJI[item.kind] || ''} ${item.name}`), ' ', statusBadge(item.status), h('span.spacer'),
      h('button.btn.btn-subtle', { type: 'button', onclick: () => editor(content, item) }, t('app.edit')),
      state.user.role === 'admin' ? h('button.btn.btn-subtle', {
        type: 'button',
        onclick: async () => {
          if (!confirm(t('app.confirmDelete'))) return;
          try { await api.ciDelete(item.id); navigate('/cis'); } catch (e) { toast(e.message, 'error'); }
        },
      }, icon('trash')) : null),
    h('div.ci-detail',
      h('section.panel', h('table.ci-props', h('tbody',
        row(t('ci.f.kind'), kindLabel(item.kind)), row(t('ci.f.status'), t(`ci.status.${item.status}`)), row(t('ci.f.location'), item.location),
        row(t('ci.f.owner'), item.owner ? `${item.owner.displayName}${item.owner.email ? ` <${item.owner.email}>` : ''}` : ''),
        row(t('ci.f.ip'), item.ip), row(t('ci.f.serial'), item.serial), row(t('ci.f.vendor'), item.vendor), row(t('ci.f.model'), item.model))),
      item.description ? h('p.ci-desc', item.description) : null),
      h('section.panel',
        h('h2', t('ci.history'), ' ', h('span.muted.small', t('ci.historyCount', { n: item.history.length, open: item.openTickets }))),
        item.history.length ? h('table.data', h('tbody', item.history.map((x) => h('tr',
          h('td', typeIcon(x.type)), h('td', h('a', { href: `/browse/${x.key}`, 'data-link': '' }, x.key)),
          h('td', h('a', { href: `/browse/${x.key}`, 'data-link': '' }, x.title)), h('td', lozenge(x.status)), h('td.muted', fmtDate(x.createdAt, false)))))) : h('p.muted', t('ci.noHistory')))));
}

function editor(content, item) {
  const v = item ? { ...item, ownerId: item.owner?.id || null } : { name: '', kind: 'device', status: 'active', location: '', ip: '', serial: '', vendor: '', model: '', description: '', ownerId: null };
  const inp = (k, attrs = {}) => { const el = h('input', { value: v[k] ?? '', ...attrs }); el.addEventListener('input', () => { v[k] = el.value; }); return el; };
  const kindSel = select(CI_KINDS.map((k) => [k, kindLabel(k)]), v.kind); kindSel.addEventListener('change', () => { v.kind = kindSel.value; });
  const statusSel = select(CI_STATUS.map((s) => [s, t(`ci.status.${s}`)]), v.status); statusSel.addEventListener('change', () => { v.status = statusSel.value; });
  const desc = h('textarea', { rows: 3 }); desc.value = v.description; desc.addEventListener('input', () => { v.description = desc.value; });
  // Verantwortlich: Personensuche (nur vorhandene Personen)
  const owner = h('input', { value: item?.owner?.displayName || '', placeholder: t('ci.ownerHint'), 'aria-label': t('ci.f.owner') });
  owner.addEventListener('input', () => { v.ownerId = null; });
  peoplePicker(owner, {
    ad: false,
    onPick: (choice, person) => { v.ownerId = choice.userId; owner.value = person.displayName; },
  });
  const err = h('div.form-error', { role: 'alert', hidden: true });
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/cis', 'data-link': '' }, t('ci.title'))),
    h('h1', item ? item.name : t('ci.new')),
    h('form.panel.ci-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        if (!owner.value.trim()) v.ownerId = null;
        try {
          const r = item ? await api.ciUpdate(item.id, v) : await api.ciCreate(v);
          toast(t('app.saved'), 'success');
          if (item) detail(content, item.id); else navigate(`/cis/${r.item.id}`, { replace: true });
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      },
    }, err,
    h('div.grid-3', field(t('ci.f.name'), inp('name', { maxLength: 120, required: true, placeholder: 'PC-0001' })), field(t('ci.f.kind'), kindSel), field(t('ci.f.status'), statusSel)),
    h('div.grid-3', field(t('ci.f.location'), inp('location', { maxLength: 200 })), field(t('ci.f.owner'), owner), field(t('ci.f.ip'), inp('ip', { maxLength: 100, placeholder: '10.0.10.21' }))),
    h('div.grid-3', field(t('ci.f.serial'), inp('serial', { maxLength: 100 })), field(t('ci.f.vendor'), inp('vendor', { maxLength: 100 })), field(t('ci.f.model'), inp('model', { maxLength: 100 }))),
    field(t('ci.f.description'), desc),
    h('div.form-actions', h('button.btn.btn-primary', { type: 'submit' }, t('app.save')),
      h('button.btn.btn-subtle', { type: 'button', onclick: () => (item ? detail(content, item.id) : navigate('/cis')) }, t('app.cancel')))));
}

function importDialog() {
  const ta = h('textarea.mono', { rows: 10, placeholder: 'Name;Typ;Standort;IP-Adresse;Benutzer\nPC-0001;Notebook;Raum 1.12;10.0.10.21;karl' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
  file.addEventListener('change', async () => { const f = file.files[0]; if (f) ta.value = await f.text(); });
  const result = h('div');
  const run = async () => {
    try {
      const r = await api.ciImport(ta.value);
      mount(result, h('div.hint-box', icon('check'), h('div', t('ci.importResult', { created: r.created, updated: r.updated }),
        r.errors.length ? h('ul.small', r.errors.map((e) => h('li', t('ci.importLine', { line: e.line }), ' ', e.message))) : null)));
      if (location.pathname === '/cis') navigate(location.pathname + location.search, { replace: true });
    } catch (e) { mount(result, h('div.form-error', e.message)); }
  };
  modal(t('ci.import'), h('div', h('p.muted.small', t('ci.importHint')), field(t('ci.importFile'), file), ta, result), {
    wide: true,
    footer: h('button.btn.btn-primary', { type: 'button', onclick: run }, t('ci.importRun')),
  });
}

/** Abschnitt „Geräte & Dienste“ in der Ticketansicht (nur Bearbeiter) */
export function ciSection(tk, refresh) {
  const cis = tk.cis || [];
  const listId = `ci-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input.link-target', { placeholder: t('ci.addHint'), list: listId, autocomplete: 'off' });
  const dl = h('datalist', { id: listId });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      try { mount(dl, (await api.cis({ q })).items.slice(0, 15).map((x) => h('option', { value: x.name }, [t(`ci.kind.${x.kind}`), x.location].filter(Boolean).join(' · ')))); } catch { /* egal */ }
    }, 200);
  });
  const form = h('form.link-form', {
    hidden: true,
    onsubmit: async (e) => {
      e.preventDefault();
      try { await api.linkCi(tk.key, { name: input.value.trim() }); refresh(); } catch (ex) { toast(ex.message, 'error'); }
    },
  }, input, dl, h('button.btn.btn-primary.small', { type: 'submit' }, t('link.add')),
  h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { form.hidden = true; } }, t('app.cancel')));
  return h('section.ticket-section.ci-section',
    h('div.section-head', h('h3', t('ci.inTicket'), cis.length ? h('span.count', cis.length) : null), h('span.spacer'),
      h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { form.hidden = false; input.focus(); } }, icon('server'), t('ci.add'))),
    form,
    cis.length ? h('div.ci-chips', cis.map((c) => h('span.ci-chip',
      h('a', { href: `/cis/${c.id}`, 'data-link': '', title: [c.location, c.ip].filter(Boolean).join(' · ') }, `${KIND_EMOJI[c.kind] || ''} ${c.name}`),
      c.openTickets > 1 ? h('span.badge', { title: t('ci.otherOpen') }, String(c.openTickets - 1)) : null,
      h('button.btn-icon.small', { type: 'button', title: t('link.remove'), onclick: async () => { try { await api.unlinkCi(tk.key, c.id); refresh(); } catch (e) { toast(e.message, 'error'); } } }, icon('close'))))) : null);
}
