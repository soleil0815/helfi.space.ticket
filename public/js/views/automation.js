// Automation rules: "When … (trigger), for tickets with … (conditions), then … (actions)".
// Admins: every project and rules for all projects (Administration → Automation); leads and deputies:
// their own projects (sidebar → Automation). New rules start switched off – the preview comes first.
import { api } from '../api.js';
import { h, mount, icon, select, field, modal, toast, fmtDate, relTime } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { state, navigate } from '../app.js';

const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
const PRIORITIES = ['highest', 'high', 'medium', 'low'];
const TYPES = ['incident', 'request', 'task', 'question', 'problem', 'change'];
const TRIGGERS = ['created', 'statusChanged', 'customerReplied', 'agentReplied', 'fieldChanged', 'time', 'sla'];
const ACTIONS = ['reply', 'note', 'notify', 'setStatus', 'setPriority', 'setComponent', 'assign'];
const ROLES = ['lead', 'deputy', 'assignee', 'componentLead'];
const CHANNELS = ['email', 'web'];

/** Sidebar page (leads, deputies, admins) */
export async function renderAutomation(content) {
  const body = h('div.automation-page');
  mount(content, h('div.page-head', h('h1', t('auto.title'))), body);
  await automationPage(body, '/automation');
}
/** Administration → Automation */
export async function automationAdminPage(body) {
  await automationPage(body, '/admin/automation');
}

// ---------- Plain-language summary of a rule ----------
function hoursText(hours) {
  if (hours % 24 === 0) return hours === 24 ? t('auto.day') : t('auto.days', { n: hours / 24 });
  return hours === 1 ? t('auto.hour') : t('auto.hours', { n: hours });
}
export function describeTrigger(tr) {
  if (tr.type === 'statusChanged') {
    const from = tr.from ? t(`status.${tr.from}`) : t('auto.anyStatus');
    const to = tr.to ? t(`status.${tr.to}`) : t('auto.anyStatus');
    return t('auto.sum.statusChanged', { fromStatus: from, toStatus: to });
  }
  if (tr.type === 'fieldChanged') return t(`auto.sum.fieldChanged.${tr.field}`);
  if (tr.type === 'sla') return t(`auto.sum.sla.${tr.level}`);
  if (tr.type === 'time') {
    const time = hoursText(tr.hours);
    if (tr.basis === 'status') return t('auto.sum.time.status', { time, status: t(`status.${tr.status}`) });
    return t(`auto.sum.time.${tr.basis}`, { time }) + (tr.status ? ` (${t(`status.${tr.status}`)})` : '');
  }
  return t(`auto.sum.${tr.type}`);
}
function describeConditions(c, opts) {
  const parts = [];
  if (c.types) parts.push(c.types.map((x) => t(`type.${x}`)).join('/'));
  if (c.priorities) parts.push(`${t('ticket.priority')}: ${c.priorities.map((x) => t(`priority.${x}`)).join('/')}`);
  if (c.statuses) parts.push(`${t('list.status')}: ${c.statuses.map((x) => t(`status.${x}`)).join('/')}`);
  if (c.channels) parts.push(c.channels.map((x) => t(`auto.channel.${x}`)).join('/'));
  if (c.assigned) parts.push(t(`auto.assigned.${c.assigned}`));
  if (c.withoutComponent) parts.push(t('auto.noComponent'));
  if (c.componentIds) parts.push(c.componentIds.map((id) => opts.components?.find((x) => x.id === id)?.name || `#${id}`).join('/'));
  if (c.keywords) {
    const [o, cl] = getLang() === 'en' ? ['"', '"'] : ['„', '“'];
    parts.push(`${o}${c.keywords.slice(0, 4).join(`${cl}, ${o}`)}${cl}${c.keywords.length > 4 ? ' …' : ''}`);
  }
  if (c.senders) parts.push(c.senders.slice(0, 2).join(', ') + (c.senders.length > 2 ? ' …' : ''));
  return parts.join(' · ');
}
function describeAction(a, opts) {
  if (a.type === 'setStatus') return `${t('auto.act.setStatus')}: ${t(`status.${a.status}`)}`;
  if (a.type === 'setPriority') return `${t('auto.act.setPriority')}: ${t(`priority.${a.priority}`)}`;
  if (a.type === 'setComponent') return `${t('auto.act.setComponent')}: ${opts.components?.find((x) => x.id === a.componentId)?.name || `#${a.componentId}`}`;
  if (a.type === 'assign') return `${t('auto.act.assign')}: ${opts.people?.find((x) => x.id === a.userId)?.displayName || `#${a.userId}`}`;
  if (a.type === 'notify') {
    const who = [...(a.roles || []).map((r) => t(`auto.role.${r}`)), ...(a.userIds || []).map((id) => opts.people?.find((x) => x.id === id)?.displayName || `#${id}`)];
    return `${t('auto.act.notify')}: ${who.join(', ')}`;
  }
  return t(`auto.act.${a.type}`);
}
export function describe(rule, opts = {}) {
  const cond = describeConditions(rule.conditions || {}, opts);
  return { when: describeTrigger(rule.trigger || {}), cond, then: (rule.actions || []).map((a) => describeAction(a, opts)).join(' · ') };
}

/** Server error with the part of the rule it is about ("… (Then: action 2)") */
function errorText(e) {
  if (e.code !== 'err.automationInvalid' || !e.detail) return e.message;
  const d = String(e.detail);
  const m = /^actions\.(\d+)$/.exec(d);
  const where = m ? `${t('auto.then')}: ${t('auto.actionN', { n: Number(m[1]) + 1 })}`
    : d === 'actions' ? t('auto.then')
      : d === 'name' ? t('auto.name')
        : d.startsWith('trigger') ? `${t('auto.when')}: ${t('auto.trigger')}`
          : d.startsWith('conditions') ? t('auto.if') : d;
  return `${e.message} (${where})`;
}

async function automationPage(body, base) {
  mount(body, h('div.loading', t('app.loading')));
  const first = await api.automation.rules();
  const projects = first.projects;
  const admin = state.isAdmin;
  if (!projects.length && !admin) return mount(body, h('section.panel', h('p.muted', t('auto.noProject'))));
  const wanted = new URLSearchParams(location.search).get('project');
  // "all": rules for all projects (admins only)
  const scope = wanted === 'all' && admin ? null : (projects.find((p) => p.key === String(wanted || '').toUpperCase()) || projects[0] || null);
  const pid = scope ? scope.id : null;
  const rules = first.rules.filter((r) => (pid ? r.projectId === pid : r.projectId === null));
  const opts = await api.automation.options(pid);
  const reload = () => automationPage(body, base);

  const scopeSelect = (projects.length > 1 || admin) ? field(t('auto.scope'), select([
    ...projects.map((p) => [p.key, `${p.name} (${p.key})`]),
    ...(admin ? [['all', t('auto.allProjects')]] : []),
  ], scope ? scope.key : 'all', { onchange: (e) => navigate(`${base}?project=${e.target.value}`, { replace: true }) }), pid ? null : t('auto.allProjectsHint')) : null;

  async function toggle(r, on) {
    try { await api.automation.update(r.id, { enabled: on }); toast(t(on ? 'auto.switchedOn' : 'auto.switchedOff'), 'success'); reload(); }
    catch (e) { toast(e.message, 'error'); reload(); }
  }
  async function move(r, dir) {
    const ids = rules.map((x) => x.id);
    const i = ids.indexOf(r.id); const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.automation.order(pid, ids); reload(); } catch (e) { toast(e.message, 'error'); }
  }
  function removeDialog(r) {
    const dlg = modal(`${t('auto.delete')}: ${r.name}`, h('p', t('auto.deleteText')), {
      footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
        h('button.btn.btn-danger', { type: 'button', onclick: async () => { try { await api.automation.remove(r.id); dlg.close(); reload(); } catch (e) { toast(e.message, 'error'); } } }, t('auto.delete'))],
    });
  }

  const ruleRow = (r, i) => {
    const d = describe(r, opts);
    const sw = h('input', { type: 'checkbox', checked: r.enabled, 'data-rule-toggle': r.id, onchange: (e) => toggle(r, e.target.checked) });
    return h('tr', { class: r.enabled ? '' : 'muted-row', 'data-rule': r.id },
      h('td.comp-order',
        h('button.btn-icon.small', { type: 'button', disabled: i === 0, title: t('comp.up'), 'aria-label': t('comp.up'), onclick: () => move(r, -1) }, h('span', { 'aria-hidden': 'true' }, '↑')),
        h('button.btn-icon.small', { type: 'button', disabled: i === rules.length - 1, title: t('comp.down'), 'aria-label': t('comp.down'), onclick: () => move(r, 1) }, h('span', { 'aria-hidden': 'true' }, '↓'))),
      h('td.auto-switch', h('label.switch', { title: t(r.enabled ? 'auto.on' : 'auto.off') }, sw, h('span.switch-track', { 'aria-hidden': 'true' }), h('span.sr-only', `${r.name}: ${t('auto.enabled')}`))),
      h('td',
        h('strong', r.name),
        r.disabledReason ? h('span.lozenge.small.auto-brake', t(`auto.disabled.${r.disabledReason}`)) : null,
        h('div.auto-summary',
          h('span', h('span.auto-kw', t('auto.when')), ' ', d.when),
          d.cond ? h('span', h('span.auto-kw', t('auto.if')), ' ', d.cond) : null,
          h('span', h('span.auto-kw', t('auto.then')), ' ', d.then))),
      h('td.auto-runs', r.runs30 ? h('button.link', { type: 'button', onclick: () => runsDialog(r) }, t('auto.runsN', { n: r.runs30 })) : h('span.muted', '—'),
        r.lastRun ? h('span.muted.block.small', { title: fmtDate(r.lastRun) }, relTime(r.lastRun)) : null),
      h('td.actions-cell',
        h('button.btn-icon.small', { type: 'button', title: t('auto.edit'), 'aria-label': t('auto.edit'), onclick: () => editDialog(r) }, icon('pencil')),
        h('button.btn-icon.small', { type: 'button', title: t('auto.protocol'), 'aria-label': t('auto.protocol'), onclick: () => runsDialog(r) }, icon('list')),
        h('button.btn-icon.small', { type: 'button', title: t('auto.delete'), 'aria-label': t('auto.delete'), onclick: () => removeDialog(r) }, icon('trash'))));
  };

  // ---------- Editor ----------
  function editDialog(r = null, preset = null) {
    const src = r || preset || { trigger: { type: 'created' }, conditions: {}, actions: [{ type: 'note', text: '' }] };
    const err = h('div.form-error', { role: 'alert', hidden: true });
    const name = h('input', { maxLength: 100, required: true, value: src.name || '', 'data-auto-name': '' });
    const enabled = h('input', { type: 'checkbox', checked: !!r?.enabled });

    // When
    const tr = { ...src.trigger };
    const trType = select(TRIGGERS.map((x) => [x, t(`auto.trigger.${x}`)]), tr.type, { 'data-auto-trigger': '' });
    const trFrom = select([['', t('auto.anyStatus')], ...STATUSES.map((s) => [s, t(`status.${s}`)])], tr.from || '');
    const trTo = select([['', t('auto.anyStatus')], ...STATUSES.map((s) => [s, t(`status.${s}`)])], tr.to || '');
    const trField = select([['priority', t('ticket.priority')], ['component', t('ticket.component')]], tr.field || 'priority');
    const trLevel = select([['warning', t('auto.slaWarning')], ['breached', t('auto.slaBreached')]], tr.level || 'warning');
    const trBasis = select([['status', t('auto.basis.status')], ['created', t('auto.basis.created')], ['activity', t('auto.basis.activity')]], tr.basis || 'status');
    const trStatus = select([['', t('auto.anyOpen')], ...STATUSES.map((s) => [s, t(`status.${s}`)])], tr.status || (tr.type === 'time' ? '' : 'waiting'));
    const days = tr.hours && tr.hours % 24 === 0;
    const trAmount = h('input', { type: 'number', min: 1, max: 8760, value: tr.hours ? (days ? tr.hours / 24 : tr.hours) : 7, 'data-auto-amount': '' });
    const trUnit = select([['days', t('auto.unit.days')], ['hours', t('auto.unit.hours')]], tr.hours && !days ? 'hours' : 'days');
    const trExtra = h('div.auto-trigger-extra');
    const drawTrigger = () => {
      const ty = trType.value;
      mount(trExtra,
        ty === 'statusChanged' ? h('div.grid-2', field(t('auto.from'), trFrom), field(t('auto.to'), trTo)) : null,
        ty === 'fieldChanged' ? field(t('auto.field'), trField) : null,
        ty === 'sla' ? field(t('auto.slaLevel'), trLevel) : null,
        ty === 'time' ? h('div',
          h('div.auto-time', field(t('auto.after'), trAmount), field(t('auto.unit'), trUnit), field(t('auto.basis'), trBasis)),
          field(t('list.status'), trStatus, trBasis.value === 'status' ? t('auto.statusNeeded') : t('auto.statusOptional')),
          h('p.muted.small', t('auto.timeHint'))) : null);
      // "since it is in status": a status is needed
      if (ty === 'time' && trBasis.value === 'status' && !trStatus.value) trStatus.value = 'waiting';
    };
    trType.addEventListener('change', drawTrigger);
    trBasis.addEventListener('change', drawTrigger);
    drawTrigger();

    // If
    const c = src.conditions || {};
    const checks = (list, chosen, label) => {
      const boxes = list.map(([v, l]) => ({ v, box: h('input', { type: 'checkbox', value: v, checked: (chosen || []).includes(v) }), l }));
      return { boxes, el: h('fieldset.auto-checks', h('legend', label), boxes.map((b) => h('label.auto-check', b.box, h('span', b.l)))) };
    };
    const cTypes = checks(TYPES.map((x) => [x, t(`type.${x}`)]), c.types, t('ticket.type'));
    const cPrios = checks(PRIORITIES.map((x) => [x, t(`priority.${x}`)]), c.priorities, t('ticket.priority'));
    const cStats = checks(STATUSES.map((x) => [x, t(`status.${x}`)]), c.statuses, t('list.status'));
    const cChans = checks(CHANNELS.map((x) => [x, t(`auto.channel.${x}`)]), c.channels, t('auto.channel'));
    const cAssigned = select([['', t('auto.assigned.any')], ['yes', t('auto.assigned.yes')], ['no', t('auto.assigned.no')]], c.assigned || '');
    const cComps = pid && opts.components.length ? checks([['none', t('auto.noComponent')], ...opts.components.map((x) => [String(x.id), x.name])],
      [...(c.withoutComponent ? ['none'] : []), ...(c.componentIds || []).map(String)], t('ticket.component')) : null;
    const cKeywords = h('input', { value: (c.keywords || []).join(', '), placeholder: t('auto.keywordsPlaceholder') });
    const cSenders = h('input', { value: (c.senders || []).join(', '), placeholder: '*@firma.local' });

    // Then
    const actionsEl = h('div.auto-actions');
    const actionRows = [];
    const peopleChecks = (chosen) => opts.people.map((p) => ({ id: p.id, box: h('input', { type: 'checkbox', value: p.id, checked: (chosen || []).includes(p.id) }), name: p.displayName }));
    function actionRow(a) {
      const typeSel = select(ACTIONS.filter((x) => pid || !['setComponent', 'assign'].includes(x)).map((x) => [x, t(`auto.act.${x}`)]), a.type, { 'aria-label': t('auto.actionType'), 'data-auto-action-type': '' });
      const parts = h('div.auto-action-fields');
      const row = { a: { ...a }, el: null, read: null };
      const draw = () => {
        const ty = typeSel.value;
        if (ty === 'setStatus') {
          const st = select(STATUSES.map((s) => [s, t(`status.${s}`)]), row.a.status || 'done');
          const res = select([['done', t('resolution.done')], ['rejected', t('resolution.rejected')]], row.a.resolution || 'done');
          const resField = field(t('auto.resolution'), res);
          const sync = () => { resField.hidden = st.value !== 'done'; };
          st.addEventListener('change', sync); sync();
          mount(parts, h('div.grid-2', field(t('list.status'), st), resField));
          row.read = () => ({ type: ty, status: st.value, ...(st.value === 'done' ? { resolution: res.value } : {}) });
        } else if (ty === 'setPriority') {
          const p = select(PRIORITIES.map((x) => [x, t(`priority.${x}`)]), row.a.priority || 'high');
          mount(parts, field(t('ticket.priority'), p));
          row.read = () => ({ type: ty, priority: p.value });
        } else if (ty === 'setComponent') {
          const p = select(opts.components.map((x) => [x.id, x.name]), row.a.componentId || '');
          mount(parts, opts.components.length ? field(t('ticket.component'), p) : h('p.muted', t('auto.noComponents')));
          row.read = () => ({ type: ty, componentId: Number(p.value) || null });
        } else if (ty === 'assign') {
          const p = select([['', '—'], ...opts.people.map((x) => [x.id, x.displayName])], row.a.userId || '');
          mount(parts, field(t('ticket.assignee'), p, t('auto.assignHint')));
          row.read = () => ({ type: ty, userId: Number(p.value) || null });
        } else if (ty === 'reply' || ty === 'note') {
          const txt = h('textarea', { rows: 4, maxLength: 5000, 'data-auto-text': '' }, row.a.text || '');
          mount(parts, field(t(ty === 'reply' ? 'auto.replyText' : 'auto.noteText'), txt, t(ty === 'reply' ? 'auto.replyHint' : 'auto.noteHint')));
          row.read = () => ({ type: ty, text: txt.value });
        } else {
          const roles = ROLES.map((x) => ({ v: x, box: h('input', { type: 'checkbox', value: x, checked: (row.a.roles || []).includes(x) }) }));
          const people = pid ? peopleChecks(row.a.userIds) : [];
          const txt = h('textarea', { rows: 2, maxLength: 5000 }, row.a.text || '');
          mount(parts,
            h('fieldset.auto-checks', h('legend', t('auto.notifyWho')),
              roles.map((r2) => h('label.auto-check', r2.box, h('span', t(`auto.role.${r2.v}`)))),
              people.map((p) => h('label.auto-check', p.box, h('span', p.name)))),
            field(t('auto.notifyText'), txt, t('auto.notifyHint')));
          row.read = () => ({ type: ty, roles: roles.filter((x) => x.box.checked).map((x) => x.v), userIds: people.filter((x) => x.box.checked).map((x) => x.id), text: txt.value });
        }
      };
      typeSel.addEventListener('change', () => { row.a = { type: typeSel.value }; draw(); });
      draw();
      row.el = h('div.auto-action', h('div.auto-action-head', typeSel,
        h('button.btn-icon.small', { type: 'button', title: t('auto.removeAction'), 'aria-label': t('auto.removeAction'), onclick: () => { actionRows.splice(actionRows.indexOf(row), 1); row.el.remove(); } }, icon('trash'))), parts);
      return row;
    }
    for (const a of src.actions || []) { const row = actionRow(a); actionRows.push(row); actionsEl.append(row.el); }
    const addAction = h('button.btn.btn-subtle.small', { type: 'button', 'data-auto-add-action': '', onclick: () => {
      if (actionRows.length >= 10) return;
      const row = actionRow({ type: 'note' }); actionRows.push(row); actionsEl.append(row.el);
    } }, icon('plus'), t('auto.addAction'));

    const readRule = () => {
      const ty = trType.value;
      const trigger = { type: ty };
      if (ty === 'statusChanged') Object.assign(trigger, { from: trFrom.value, to: trTo.value });
      if (ty === 'fieldChanged') trigger.field = trField.value;
      if (ty === 'sla') trigger.level = trLevel.value;
      if (ty === 'time') Object.assign(trigger, { basis: trBasis.value, status: trStatus.value, hours: Math.round(Number(trAmount.value) * (trUnit.value === 'days' ? 24 : 1)) });
      const picked = (g) => g.boxes.filter((b) => b.box.checked).map((b) => b.v);
      const conditions = { types: picked(cTypes), priorities: picked(cPrios), statuses: picked(cStats), channels: picked(cChans), assigned: cAssigned.value,
        keywords: cKeywords.value, senders: cSenders.value };
      if (cComps) {
        const comp = picked(cComps);
        if (comp.includes('none')) conditions.withoutComponent = true;
        conditions.componentIds = comp.filter((x) => x !== 'none').map(Number);
      }
      return { projectId: pid, name: name.value, enabled: enabled.checked, trigger, conditions, actions: actionRows.map((x) => x.read()) };
    };

    const previewOut = h('div.auto-preview', { role: 'status', 'aria-live': 'polite' });
    async function runPreview() {
      err.hidden = true;
      try {
        const p = await api.automation.preview({ ...readRule(), ruleId: r?.id || null });
        mount(previewOut,
          h('p', h('strong', t(`${p.kind === 'now' ? 'auto.previewNow' : 'auto.previewLast30'}${p.total === 1 ? 'One' : ''}`, { n: p.total }))),
          p.kind === 'last30' ? h('p.muted.small', t('auto.previewLast30Hint')) : null,
          p.tickets.length ? h('ul.auto-preview-list', p.tickets.map((x) => h('li',
            h('a', { href: `/browse/${x.key}`, target: '_blank', rel: 'noopener' }, x.key), ' ', x.title,
            h('span.muted', ` · ${t(`status.${x.status}`)}`), x.done ? h('span.muted', ` · ${t('auto.previewDone')}`) : null))) : null,
          p.total > p.tickets.length ? h('p.muted.small', t('auto.previewMore', { n: p.total - p.tickets.length })) : null);
      } catch (e) { err.textContent = errorText(e); err.hidden = false; err.scrollIntoView({ block: 'nearest' }); }
    }

    const dlg = modal(r ? `${t('auto.edit')}: ${r.name}` : t('auto.new'), h('form#auto-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        try {
          const data = readRule();
          if (r) await api.automation.update(r.id, data); else await api.automation.create(data);
          dlg.close(); toast(t('app.saved'), 'success'); reload();
        } catch (ex) { err.textContent = errorText(ex); err.hidden = false; err.scrollIntoView({ block: 'nearest' }); }
      },
    }, err,
    field(t('auto.name'), name),
    h('section.auto-block', h('h3', h('span.auto-kw', t('auto.when'))), field(t('auto.trigger'), trType), trExtra),
    // Conditions folded away while none is set – most rules need few or none
    h('details.auto-block.auto-cond', { open: Object.keys(c).some((k) => (Array.isArray(c[k]) ? c[k].length : !!c[k])) },
      h('summary', h('span.auto-kw', t('auto.if')), ' ', h('span.muted.small', t('auto.ifHint'))),
      h('div.auto-cond-grid', cTypes.el, cPrios.el, cStats.el, cChans.el),
      field(t('auto.assigned'), cAssigned),
      cComps ? cComps.el : null,
      field(t('auto.keywords'), cKeywords, t('auto.keywordsHint')),
      field(t('auto.senders'), cSenders, t('auto.sendersHint'))),
    h('section.auto-block', h('h3', h('span.auto-kw', t('auto.then'))), actionsEl, addAction),
    field(t('auto.enableNow'), enabled, t('auto.enableHint')),
    previewOut),
    { wide: true, footer: [
      h('button.btn.btn-subtle', { type: 'button', 'data-auto-preview': '', onclick: runPreview }, icon('search'), t('auto.preview')),
      h('span.spacer'),
      h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
      h('button.btn.btn-primary', { type: 'submit', form: 'auto-form' }, r ? t('app.save') : t('app.create'))] });
  }

  // ---------- Protocol ----------
  async function runsDialog(r) {
    try {
      const { runs } = await api.automation.runs(r.id);
      const detail = (d) => d.map((x) => `${t(`auto.act.${x.type}`)}${x.skipped && x.skipped !== 'unchanged' ? ` – ${t(`auto.skip.${x.skipped}`)}` : x.skipped === 'unchanged' ? ` – ${t('auto.skip.unchanged')}` : x.error ? ` – ${t('auto.failed')}` : ''}`).join(' · ');
      modal(`${t('auto.protocol')}: ${r.name}`, runs.length ? h('div.table-wrap', h('table.data',
        h('thead', h('tr', h('th', t('auto.at')), h('th', t('auto.ticket')), h('th', t('auto.result')))),
        h('tbody', runs.map((x) => h('tr',
          h('td', fmtDate(x.at)),
          h('td', x.ticketKey ? h('a', { href: `/browse/${x.ticketKey}`, 'data-link': '' }, x.ticketKey) : '—'),
          h('td', x.ok ? icon('check') : h('span.lozenge.lozenge-waiting.small', t('auto.partly')), ' ', detail(x.detail))))))) : h('p.muted', t('auto.noRuns')),
      { wide: true });
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- Example rules ----------
  async function templatesDialog() {
    const lang = getLang() === 'en' ? 'en' : 'de';
    const { templates } = await api.automation.templates(lang);
    const have = new Set(rules.map((x) => x.template).filter(Boolean));
    const dlg = modal(t('auto.examples'), h('div',
      h('p.muted', t('auto.examplesIntro')),
      h('ul.auto-templates', templates.map((tp) => {
        const d = describe(tp, opts);
        return h('li', { 'data-template': tp.key },
          h('div', h('strong', tp.name), have.has(tp.key) ? h('span.muted', ` · ${t('auto.exampleHave')}`) : null,
            h('div.auto-summary', h('span', h('span.auto-kw', t('auto.when')), ' ', d.when), d.cond ? h('span', h('span.auto-kw', t('auto.if')), ' ', d.cond) : null, h('span', h('span.auto-kw', t('auto.then')), ' ', d.then))),
          h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => {
            try { await api.automation.addTemplate(tp.key, pid, lang); dlg.close(); toast(t('auto.exampleAdded'), 'success'); reload(); }
            catch (e) { toast(e.message, 'error'); }
          } }, t('auto.exampleTake')));
      }))), { wide: true });
  }

  mount(body,
    h('section.panel',
      h('div.section-head', h('h2', t('auto.rules')),
        h('div.actions',
          h('button.btn.btn-subtle', { type: 'button', 'data-auto-examples': '', onclick: templatesDialog }, icon('sparkle'), t('auto.examples')),
          h('button.btn.btn-primary', { type: 'button', 'data-auto-new': '', onclick: () => editDialog() }, icon('plus'), t('auto.new')))),
      h('p.muted', t('auto.intro')),
      scopeSelect,
      rules.length ? h('div.table-wrap', h('table.data.auto-table',
        h('thead', h('tr', h('th', ''), h('th', t('auto.enabled')), h('th', t('auto.rule')), h('th', t('auto.runs30')), h('th', ''))),
        h('tbody', rules.map(ruleRow)))) : h('div.empty-state.small', t('auto.empty')),
      rules.length ? h('p.muted.small', t('auto.orderHint')) : null),
    h('section.panel.auto-help', h('h3', t('auto.howTitle')), h('ul', ['auto.how1', 'auto.how2', 'auto.how3', 'auto.how4'].map((k) => h('li', t(k))))));
}
