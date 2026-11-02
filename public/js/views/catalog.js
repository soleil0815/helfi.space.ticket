// Servicekatalog: Angebote, Formular, Genehmigung im Ticket, Verwaltung
import { api } from '../api.js';
import { h, mount, icon, toast, field, select, avatar } from '../dom.js';
import { t } from '../i18n.js';
import { state, navigate } from '../app.js';
import { withEmoji } from '../emoji.js';

export async function renderCatalog(content, path) {
  const m = /^\/catalog\/(\d+)$/.exec(path);
  return m ? orderForm(content, Number(m[1])) : overview(content);
}

async function overview(content) {
  const { items } = await api.catalog();
  mount(content,
    h('div.page-head', h('h1', t('catalog.title'))),
    h('p.muted', t('catalog.intro')),
    items.length ? h('div.catalog-grid', items.map((x) => h('a.catalog-card', { href: `/catalog/${x.id}`, 'data-link': '' },
      h('div.catalog-emoji', x.emoji || '📦'),
      h('div', h('div.catalog-title', x.title), x.description ? h('div.catalog-desc', x.description) : null,
        x.needsApproval ? h('div.catalog-approval', icon('check'), t('catalog.needsApproval')) : null)))) : h('p.muted', t('catalog.empty')));
}

async function orderForm(content, id) {
  const { item } = await api.catalogItem(id);
  const inputs = {};
  const fieldEl = (f) => {
    let el;
    if (f.type === 'textarea') { el = h('textarea', { rows: 4, required: f.required }); inputs[f.id] = () => el.value; return field(f.label, withEmoji(el)); }
    if (f.type === 'select') el = select([['', '—'], ...f.options.map((o) => [o, o])], '');
    else if (f.type === 'checkbox') { el = h('input', { type: 'checkbox' }); inputs[f.id] = () => el.checked; return h('div.field.field-check', el, h('label', f.label)); }
    else if (f.type === 'date') el = h('input', { type: 'date' });
    else el = h('input', { maxLength: 500 });
    el.required = !!f.required;
    inputs[f.id] = () => el.value;
    return field(`${f.label}${f.required ? ' *' : ''}`, el);
  };
  const err = h('div.form-error', { role: 'alert', hidden: true });
  const submit = h('button.btn.btn-primary', { type: 'submit' }, t('catalog.submit'));
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/catalog', 'data-link': '' }, t('catalog.title'))),
    h('div.page-head', h('h1', h('span.catalog-emoji-inline', item.emoji || '📦'), ' ', item.title)),
    item.description ? h('p', item.description) : null,
    item.needsApproval ? h('div.hint-box', icon('info'), h('div', t('catalog.approvalHint'))) : null,
    h('form.panel.catalog-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true; submit.disabled = true;
        try {
          const answers = Object.fromEntries(Object.entries(inputs).map(([k, fn]) => [k, fn()]));
          const r = await api.catalogOrder(id, answers);
          toast(t('catalog.sent', { key: r.ticket.key }), 'success');
          navigate(`/browse/${r.ticket.key}`);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; submit.disabled = false; }
      },
    }, err, item.fields.map(fieldEl), h('div.form-actions', submit, h('a.btn.btn-subtle', { href: '/catalog', 'data-link': '' }, t('app.cancel')))));
}

/** Genehmigung einer Katalog-Anfrage in der Ticketansicht */
export function catalogApprovalBox(tk, refresh) {
  const a = tk.approval;
  if (!a) return null;
  const comment = h('input', { placeholder: t('change.commentHint'), maxLength: 2000 });
  const decide = async (decision) => { try { await api.decideApproval(tk.key, { decision, comment: comment.value }); refresh(); } catch (e) { toast(e.message, 'error'); } };
  return h(`div.approvals.approval-${a.state}`,
    h('div.approvals-head', h('strong', t('catalog.approval')), ' ', h(`span.badge.decision-${a.state === 'pending' ? 'pending' : a.state === 'approved' ? 'approve' : 'reject'}`, t(`catalog.state.${a.state}`)),
      ' ', h('span.muted.small', t(`change.mode.${a.mode}`))),
    a.items.map((x) => h('div.approval-row', avatar({ displayName: x.name }, 'sm'), h('span', x.name),
      h(`span.badge.decision-${x.decision || 'pending'}`, t(`change.decision.${x.decision || 'pending'}`)),
      x.comment ? h('span.muted.small', `„${x.comment}“`) : null)),
    a.canDecide ? h('div.approval-actions', comment,
      h('button.btn.btn-primary.small', { type: 'button', onclick: () => decide('approve') }, icon('check'), t('change.approve')),
      h('button.btn.btn-danger.small', { type: 'button', onclick: () => decide('reject') }, t('change.reject'))) : null);
}

// ---------- Administration → Servicekatalog ----------
export async function catalogAdminPage(body) {
  const [{ items }, { users }] = await Promise.all([api.catalog(true), api.users(true)]);
  const people = users.filter((u) => u.active && u.email);
  const draw = (edit = null) => {
    if (edit) return mount(body, editor(edit));
    mount(body, h('section.panel',
      h('div.section-head', h('h2', t('catalog.adminTitle')), h('span.spacer'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => draw({ title: '', description: '', emoji: '', fields: [], approverIds: [], approvalMode: 'any', active: true, projectKey: '' }) }, icon('plus'), t('catalog.newItem'))),
      h('p.muted', t('catalog.adminIntro')),
      items.length ? h('table.data', h('tbody', items.map((x) => h('tr',
        h('td', x.emoji || '📦'), h('td', h('a', { href: '#', onclick: (e) => { e.preventDefault(); draw(x); } }, x.title)),
        h('td.muted', t('catalog.fieldCount', { n: x.fields.length })),
        h('td', x.needsApproval ? t('catalog.needsApproval') : ''),
        h('td', x.active ? '' : h('span.badge', t('catalog.inactive'))))))) : h('p.muted', t('catalog.empty'))));
  };
  const editor = (x) => {
    const v = { ...x, fields: x.fields.map((f) => ({ ...f, options: Array.isArray(f.options) ? f.options.join('\n') : '' })) };
    const inp = (k, attrs = {}) => { const el = h('input', { value: v[k] ?? '', ...attrs }); el.addEventListener('input', () => { v[k] = el.value; }); return el; };
    const desc = h('textarea', { rows: 3 }); desc.value = v.description; desc.addEventListener('input', () => { v.description = desc.value; });
    const projSel = select([['', t('catalog.defaultProject')], ...state.projects.map((p) => [p.key, `${p.name} (${p.key})`])], v.projectKey || '');
    projSel.addEventListener('change', () => { v.projectKey = projSel.value; });
    const active = h('input', { type: 'checkbox', checked: v.active }); active.addEventListener('change', () => { v.active = active.checked; });
    const fieldsBox = h('div.catalog-fields');
    const drawFields = () => mount(fieldsBox, v.fields.map((f, i) => {
      const lab = h('input', { value: f.label, placeholder: t('catalog.fieldLabel') }); lab.addEventListener('input', () => { f.label = lab.value; });
      const type = select(['text', 'textarea', 'select', 'checkbox', 'date'].map((y) => [y, t(`catalog.type.${y}`)]), f.type);
      const opts = h('textarea', { rows: 3, placeholder: t('catalog.optionsHint'), hidden: f.type !== 'select' }); opts.value = f.options || '';
      opts.addEventListener('input', () => { f.options = opts.value; });
      type.addEventListener('change', () => { f.type = type.value; opts.hidden = f.type !== 'select'; });
      const req = h('input', { type: 'checkbox', checked: !!f.required }); req.addEventListener('change', () => { f.required = req.checked; });
      return h('div.catalog-field-row', h('div.catalog-field-main', lab, type, h('label.inline-check', req, ' ', t('catalog.required')),
        h('button.btn-icon.small', { type: 'button', title: t('app.delete'), onclick: () => { v.fields.splice(i, 1); drawFields(); } }, icon('trash'))), opts);
    }));
    drawFields();
    const chosen = new Set(v.approverIds);
    const approvers = h('div.approver-list', people.map((u) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(u.id) });
      cb.addEventListener('change', () => { if (cb.checked) chosen.add(u.id); else chosen.delete(u.id); });
      return h('label.approver-box', cb, avatar(u, 'sm'), u.displayName);
    }));
    const mode = select([['any', t('change.mode.any')], ['all', t('change.mode.all')]], v.approvalMode);
    mode.addEventListener('change', () => { v.approvalMode = mode.value; });
    const save = async () => {
      const data = { ...v, approverIds: [...chosen], fields: v.fields.map((f) => ({ ...f, options: String(f.options || '').split('\n') })) };
      try {
        const r = x.id ? await api.catalogUpdate(x.id, data) : await api.catalogCreate(data);
        toast(t('app.saved'), 'success');
        const i = items.findIndex((y) => y.id === r.item.id);
        if (i >= 0) items[i] = r.item; else items.push(r.item);
        draw();
      } catch (e) { toast(e.message, 'error'); }
    };
    return h('section.panel',
      h('h2', x.id ? x.title : t('catalog.newItem')),
      h('div.grid-3', field(t('catalog.f.title'), inp('title', { maxLength: 120 })), field(t('catalog.f.emoji'), inp('emoji', { maxLength: 8, placeholder: '💻' })), field(t('catalog.f.project'), projSel)),
      field(t('catalog.f.description'), desc),
      h('div.field.field-check', active, h('label', t('catalog.f.active'))),
      h('h3', t('catalog.fields')),
      fieldsBox,
      h('button.btn.btn-subtle', { type: 'button', onclick: () => { v.fields.push({ label: '', type: 'text', required: false, options: '' }); drawFields(); } }, icon('plus'), t('catalog.addField')),
      h('h3', t('catalog.approval')),
      h('p.muted.small', t('catalog.approversHint')),
      approvers,
      field(t('change.modeLabel'), mode),
      h('div.form-actions',
        h('button.btn.btn-primary', { type: 'button', onclick: save }, t('app.save')),
        h('button.btn.btn-subtle', { type: 'button', onclick: () => draw() }, t('app.cancel')),
        x.id ? h('span.spacer') : null,
        x.id ? h('button.btn.btn-subtle', { type: 'button', onclick: async () => { if (!confirm(t('app.confirmDelete'))) return; await api.catalogDelete(x.id); items.splice(items.findIndex((y) => y.id === x.id), 1); draw(); } }, icon('trash'), t('app.delete')) : null));
  };
  draw();
}

