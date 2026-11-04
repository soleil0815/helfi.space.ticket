// Change management: section in the change ticket, approval, calendar, settings
import { api } from '../api.js';
import { h, mount, icon, toast, field, select, modal, fmtDate, richText, avatar } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { state } from '../app.js';

const PHASES = ['draft', 'approval', 'approved', 'scheduled', 'implementing', 'review', 'closed'];
const TEXT_FIELDS = ['reason', 'implementationPlan', 'backoutPlan', 'testPlan'];

// ISO (UTC) ↔ datetime-local input (local time)
const toLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fromLocal = (v) => (v ? new Date(v).toISOString() : '');

/** “Please fill in” error message with field labels instead of internal names */
function errorText(e) {
  if (e.code === 'err.changeMissing' && e.detail) return t('change.missing', { fields: String(e.detail).split(',').map((n) => t(`change.f.${n}`)).join(', ') });
  return e.message;
}

export function changeSection(tk, refresh) {
  const c = tk.change || { phase: 'draft', next: [], approvals: { items: [] } };
  const f = tk.fields || {};
  const editable = !['closed', 'rejected'].includes(c.phase);
  const vals = { ...f };
  const inp = (name, el) => { el.addEventListener('input', () => { vals[name] = el.type === 'datetime-local' ? fromLocal(el.value) : el.value; }); el.disabled = !editable; return el; };
  const area = (name, rows = 4) => { const ta = h('textarea', { rows, maxLength: 50000 }); ta.value = f[name] || ''; return inp(name, ta); };
  const sel = (name, values, def) => { const s = select(values.map((v) => [v, t(`change.${name}.${v}`)]), f[name] || def); vals[name] = s.value; s.addEventListener('change', () => { vals[name] = s.value; }); s.disabled = !editable; return s; };
  const changeType = sel('changeType', ['normal', 'standard', 'emergency'], 'normal');
  const risk = sel('risk', ['low', 'medium', 'high'], 'medium');
  const start = inp('plannedStart', h('input', { type: 'datetime-local', value: toLocal(f.plannedStart) }));
  const end = inp('plannedEnd', h('input', { type: 'datetime-local', value: toLocal(f.plannedEnd) }));
  const services = inp('services', h('input', { value: f.services || '', maxLength: 2000, placeholder: t('change.servicesHint') }));
  const areas = Object.fromEntries(TEXT_FIELDS.map((n) => [n, area(n, n === 'reason' ? 3 : 5)]));

  const saveFields = async () => {
    const data = {};
    for (const n of ['changeType', 'risk', 'plannedStart', 'plannedEnd', 'services', ...TEXT_FIELDS]) data[n] = vals[n] ?? '';
    await api.saveFields(tk.key, data);
  };
  const save = async () => { try { await saveFields(); toast(t('app.saved'), 'success'); refresh(); } catch (e) { toast(errorText(e), 'error'); } };
  const go = async (to, extra = {}) => {
    try {
      if (editable) await saveFields();
      await api.changeTransition(tk.key, { to, ...extra });
      refresh();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const close = () => {
    const outcome = select(['successful', 'issues', 'rolledBack'].map((v) => [v, t(`change.outcome.${v}`)]), 'successful');
    const review = h('textarea', { rows: 5, placeholder: t('change.reviewHint') });
    const err = h('div.form-error', { role: 'alert', hidden: true });
    const dlg = modal(t('change.closeTitle'), h('form#change-close', {
      onsubmit: async (e) => {
        e.preventDefault();
        try { await api.changeTransition(tk.key, { to: 'closed', outcome: outcome.value, review: review.value }); dlg.close(); refresh(); }
        catch (ex) { err.textContent = errorText(ex); err.hidden = false; }
      },
    }, err, field(t('change.outcomeLabel'), outcome), field(t('change.f.review'), review, t('change.reviewRequired'))),
    { footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), h('button.btn.btn-primary', { type: 'submit', form: 'change-close' }, t('change.go.closed'))] });
  };

  // Template for standard changes
  const templatePick = (f.changeType === 'standard' && c.phase === 'draft') ? (() => {
    const s = h('select', h('option', { value: '' }, t('change.templatePick')));
    api.changeTemplates().then((r) => {
      r.templates.forEach((x, i) => s.append(h('option', { value: i }, x.title)));
      s.addEventListener('change', async () => {
        const x = r.templates[Number(s.value)];
        if (!x) return;
        await api.saveFields(tk.key, { risk: x.risk || 'low', services: x.services || '', implementationPlan: x.implementationPlan || '', backoutPlan: x.backoutPlan || '', testPlan: x.testPlan || '', reason: vals.reason || x.title });
        refresh();
      });
    }).catch(() => {});
    return s;
  })() : null;

  const steps = h('ol.change-steps', PHASES.map((p) => h('li', { class: p === c.phase ? 'current' : (PHASES.indexOf(p) < PHASES.indexOf(c.phase) ? 'done' : '') }, t(`change.phase.${p}`))));
  const actions = c.next.map((to) => h(`button.btn${to === 'draft' ? '.btn-subtle' : '.btn-primary'}.small`, { type: 'button', onclick: () => (to === 'closed' ? close() : go(to)) }, t(`change.go.${to}`)));
  if (f.changeType === 'emergency' && c.phase !== 'draft' && !c.approvals.round) {
    actions.push(h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => { try { await api.changeLateApproval(tk.key); refresh(); } catch (e) { toast(errorText(e), 'error'); } } }, t('change.lateApproval')));
  }

  return h('section.ticket-section.itil-box.change-box',
    h('div.section-head', h('h3', icon('type-change'), ' ', t('change.title')),
      h(`span.badge.phase-${c.phase}`, t(`change.phase.${c.phase}`)),
      c.phase === 'rejected' ? h('span.badge.phase-rejected', t('change.phase.rejected')) : null,
      h('span.spacer'), ...actions),
    c.phase === 'rejected' ? null : steps,
    approvalsBox(tk, c, refresh),
    f.outcome ? h('div.change-outcome', h('strong', t('change.outcomeLabel'), ': '), t(`change.outcome.${f.outcome}`), f.review ? h('div', richText(f.review)) : null) : null,
    h('div.grid-3', field(t('change.f.changeType'), changeType), field(t('change.f.risk'), risk), templatePick ? field(t('change.template'), templatePick) : h('div')),
    h('p.muted.small', t(`change.typeHint.${f.changeType || 'normal'}`)),
    h('div.grid-2', field(t('change.f.plannedStart'), start), field(t('change.f.plannedEnd'), end)),
    field(t('change.f.services'), services),
    field(t('change.f.reason'), areas.reason),
    field(t('change.f.implementationPlan'), areas.implementationPlan),
    field(t('change.f.backoutPlan'), areas.backoutPlan),
    field(t('change.f.testPlan'), areas.testPlan),
    editable ? h('div.form-actions', h('button.btn', { type: 'button', onclick: save }, t('app.save'))) : null);
}

function approvalsBox(tk, c, refresh) {
  const a = c.approvals;
  if (!a.round) return null;
  const comment = h('input', { placeholder: t('change.commentHint'), maxLength: 2000 });
  const decide = async (decision) => { try { await api.decideApproval(tk.key, { decision, comment: comment.value }); refresh(); } catch (e) { toast(e.message, 'error'); } };
  return h('div.approvals',
    h('div.approvals-head', h('strong', t('change.approvals')), ' ', h('span.muted.small', t(`change.mode.${c.mode}`)), a.round > 1 ? h('span.muted.small', ` · ${t('change.round', { n: a.round })}`) : null),
    a.items.map((x) => h('div.approval-row', avatar({ displayName: x.name }, 'sm'), h('span', x.name),
      h(`span.badge.decision-${x.decision || 'pending'}`, t(`change.decision.${x.decision || 'pending'}`)),
      x.comment ? h('span.muted.small', `„${x.comment}“`) : null)),
    c.canDecide ? h('div.approval-actions', comment,
      h('button.btn.btn-primary.small', { type: 'button', onclick: () => decide('approve') }, icon('check'), t('change.approve')),
      h('button.btn.btn-danger.small', { type: 'button', onclick: () => decide('reject') }, t('change.reject'))) : null);
}

// ---------- Change calendar ----------
export async function renderChangeCalendar(content, params) {
  const now = new Date();
  const base = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? new Date(`${params.get('month')}-01T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), 1);
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const next = new Date(base.getFullYear(), base.getMonth() + 1, 1);
  const prev = new Date(base.getFullYear(), base.getMonth() - 1, 1);
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Grid starting Monday
  const gridStart = new Date(first); gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 42);
  const { changes } = await api.changeCalendar({ from: gridStart.toISOString(), to: gridEnd.toISOString() });
  const locale = getLang() === 'de' ? 'de-DE' : 'en-GB';
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
    const dEnd = new Date(d); dEnd.setDate(d.getDate() + 1);
    const items = changes.filter((c) => new Date(c.start) < dEnd && new Date(c.end) > d);
    days.push(h('div.cal-day', { class: [d.getMonth() !== first.getMonth() ? 'other' : '', d.toDateString() === now.toDateString() ? 'today' : ''].join(' ') },
      h('div.cal-num', d.getDate()),
      items.map((c) => h('a.cal-item', { href: `/browse/${c.key}`, 'data-link': '', class: `phase-${c.phase} ${c.conflicts.length ? 'conflict' : ''}`, title: `${c.key} ${c.title}\n${fmtDate(c.start)} – ${fmtDate(c.end)}` },
        c.conflicts.length ? icon('warning') : null, `${c.key} ${c.title}`))));
  }
  const conflicts = changes.filter((c) => c.conflicts.length && c.phase !== 'closed');
  mount(content,
    h('div.page-head', h('h1', t('change.calendar')),
      h('div.cal-nav',
        h('a.btn.btn-subtle', { href: `/changes?month=${ym(prev)}`, 'data-link': '' }, '‹'),
        h('strong', first.toLocaleDateString(locale, { month: 'long', year: 'numeric' })),
        h('a.btn.btn-subtle', { href: `/changes?month=${ym(next)}`, 'data-link': '' }, '›'),
        h('a.btn.btn-subtle', { href: '/changes', 'data-link': '' }, t('change.today')))),
    conflicts.length ? h('div.banner.banner-warn', icon('warning'), t('change.conflicts', { list: conflicts.map((c) => c.key).join(', ') })) : null,
    h('div.cal-head', [1, 2, 3, 4, 5, 6, 0].map((d) => h('div', t(`day.${d}`)))),
    h('div.cal-grid', days),
    h('h3.cal-list-title', t('change.listTitle')),
    changes.length ? h('table.data', h('tbody', changes.map((c) => h('tr',
      h('td', h('a', { href: `/browse/${c.key}`, 'data-link': '' }, c.key)), h('td', c.title),
      h('td', fmtDate(c.start), ' – ', fmtDate(c.end)),
      h('td', h(`span.badge.phase-${c.phase}`, t(`change.phase.${c.phase}`))),
      h('td', c.risk ? t(`change.risk.${c.risk}`) : ''),
      h('td', c.conflicts.length ? h('span.sla.sla-breached', t('change.conflictWith', { list: c.conflicts.join(', ') })) : ''))))) : h('p.muted', t('change.none')));
}

// ---------- Administration → Change ----------
export async function changeAdminPage(body, s, { saveBar, saveKeys }) {
  const { users } = await api.users();
  const agents = users; // active agents and admins
  const chosen = new Set(String(s['change.approvers'] || '').split(/[\s,;]+/).map(Number).filter(Boolean));
  const sync = () => { s['change.approvers'] = [...chosen].join(','); };
  const boxes = agents.map((u) => {
    const cb = h('input', { type: 'checkbox', checked: chosen.has(u.id) });
    cb.addEventListener('change', () => { if (cb.checked) chosen.add(u.id); else chosen.delete(u.id); sync(); });
    return h('label.approver-box', cb, avatar(u, 'sm'), u.displayName);
  });
  const modeSel = select([['any', t('change.mode.any')], ['all', t('change.mode.all')]], s['change.approvalMode'] || 'any');
  modeSel.addEventListener('change', () => { s['change.approvalMode'] = modeSel.value; });
  let templates = [];
  try { templates = JSON.parse(s['change.standardTemplates'] || '[]'); } catch { templates = []; }
  const list = h('div.std-templates');
  const syncT = () => { s['change.standardTemplates'] = JSON.stringify(templates); };
  const drawT = () => mount(list, templates.map((x, i) => {
    const inp = (k, rows) => { const el = rows ? h('textarea', { rows }) : h('input'); el.value = x[k] || ''; el.addEventListener('input', () => { x[k] = el.value; syncT(); }); return el; };
    const riskSel = select(['low', 'medium', 'high'].map((v) => [v, t(`change.risk.${v}`)]), x.risk || 'low');
    riskSel.addEventListener('change', () => { x.risk = riskSel.value; syncT(); });
    return h('div.std-template',
      h('div.grid-2', field(t('change.templateTitle'), inp('title')), field(t('change.f.risk'), riskSel)),
      field(t('change.f.services'), inp('services')),
      field(t('change.f.implementationPlan'), inp('implementationPlan', 4)),
      h('div.grid-2', field(t('change.f.backoutPlan'), inp('backoutPlan', 3)), field(t('change.f.testPlan'), inp('testPlan', 3))),
      h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { templates.splice(i, 1); syncT(); drawT(); } }, icon('trash'), t('app.delete')));
  }));
  drawT();
  mount(body,
    h('section.panel',
      h('h2', t('change.adminTitle')),
      h('p.muted', t('change.adminIntro')),
      h('h3', t('change.approvers')),
      h('div.approver-list', boxes.length ? boxes : h('p.muted', t('change.noAgents'))),
      field(t('change.modeLabel'), modeSel),
      h('h3', t('change.stdTemplates')),
      h('p.muted.small', t('change.stdTemplatesHint')),
      list,
      h('button.btn.btn-subtle', { type: 'button', onclick: () => { templates.push({ title: '', risk: 'low' }); syncT(); drawT(); } }, icon('plus'), t('change.addTemplate')),
      saveBar(() => saveKeys(s, ['change.']))));
}

export const isChangeAgent = () => state.isAgent;
