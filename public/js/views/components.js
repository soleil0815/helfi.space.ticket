// Administration → Components: sub-areas per project with lead/deputy, keywords and sender patterns,
// order (decides ties), test field and example sets to take over.
import { api } from '../api.js';
import { h, mount, icon, select, field, modal, toast, lozenge } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { state, navigate } from '../app.js';
import { clearComponentCache } from '../components.js';

export async function componentsAdminPage(body) {
  const projects = state.projects;
  if (!projects.length) return mount(body, h('section.panel', h('p.muted', t('comp.noProject'))));
  const params = new URLSearchParams(location.search);
  const wanted = params.get('project');
  const project = projects.find((p) => p.key === String(wanted || '').toUpperCase()) || projects[0];
  if (params.get('view') === 'review') return reviewPage(body, project);
  const { components } = await api.components(project.id, true);
  const agents = state.agents || [];
  const reload = () => { clearComponentCache(); componentsAdminPage(body); };
  const people = [['', '—'], ...agents.map((a) => [a.id, a.displayName])];

  function editDialog(c = null) {
    const name = h('input', { required: true, maxLength: 80, value: c?.name || '' });
    const desc = h('textarea', { rows: 2, maxLength: 1000 }, c?.description || '');
    const lead = select(people, c?.leadId || '');
    const deputy = select(people, c?.deputyId || '');
    const keywords = h('textarea', { rows: 3, placeholder: t('comp.keywordsPlaceholder') }, (c?.keywords || []).join(', '));
    const senders = h('textarea', { rows: 2, placeholder: '*@zabbix.firma.local' }, (c?.senders || []).join(', '));
    const err = h('div.form-error', { role: 'alert', hidden: true });
    const dlg = modal(c ? `${t('comp.edit')}: ${c.name}` : t('comp.new'), h('form#comp-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        const d = { name: name.value, description: desc.value, leadId: lead.value || null, deputyId: deputy.value || null, keywords: keywords.value, senders: senders.value };
        try {
          if (c) await api.updateComponent(c.id, d); else await api.createComponent(project.id, d);
          dlg.close(); toast(t('app.saved'), 'success'); reload();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      },
    }, err,
    field(t('comp.name'), name),
    field(t('comp.description'), desc, t('comp.descriptionHint')),
    h('div.grid-2', field(t('comp.lead'), lead), field(t('comp.deputy'), deputy, t('comp.deputyHint'))),
    field(t('comp.keywords'), keywords, t('comp.keywordsHint')),
    field(t('comp.senders'), senders, t('comp.sendersHint'))),
    { wide: true, footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), h('button.btn.btn-primary', { type: 'submit', form: 'comp-form' }, c ? t('app.save') : t('app.create'))] });
    name.focus();
  }

  function removeDialog(c) {
    const dlg = modal(`${t('comp.delete')}: ${c.name}`, h('div',
      h('p', c.ticketCount ? t('comp.deleteHasTickets', { n: c.ticketCount }) : t('comp.deleteEmpty')),
      c.ticketCount ? h('p.muted.small', t('comp.deleteArchiveHint')) : null),
    { footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
      h('button.btn.btn-danger', { type: 'button', onclick: async () => { try { await api.deleteComponent(c.id); dlg.close(); reload(); } catch (e) { toast(e.message, 'error'); } } }, t('comp.delete'))] });
  }

  async function examplesDialog() {
    const { examples } = await api.componentExamples();
    const lang = getLang() === 'en' ? 'en' : 'de';
    const have = new Set(components.map((c) => c.name.toLowerCase()));
    const boxes = [];
    const groups = examples.map((set) => h('fieldset.comp-examples',
      h('legend', set[lang]),
      set.items.map((ex) => {
        const exists = have.has(ex.de.name.toLowerCase()) || have.has(ex.en.name.toLowerCase());
        const box = h('input', { type: 'checkbox', value: ex.key, disabled: exists, checked: false });
        if (!exists) boxes.push(box);
        return h('label.comp-example', box, h('span', h('strong', ex[lang].name), exists ? h('span.muted', ` · ${t('comp.exampleExists')}`) : null,
          h('span.muted.block', ex[lang].description)));
      })));
    const allBtn = h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { const on = boxes.some((b) => !b.checked); boxes.forEach((b) => { b.checked = on; }); } }, t('comp.exampleAll'));
    const dlg = modal(t('comp.examples'), h('div', h('p.muted', t('comp.examplesIntro')), allBtn, groups), {
      wide: true,
      footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
        h('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => {
            const keys = boxes.filter((b) => b.checked).map((b) => b.value);
            if (!keys.length) { dlg.close(); return; }
            try {
              const r = await api.addExampleComponents(project.id, keys, lang);
              dlg.close(); toast(t('comp.examplesAdded', { n: r.added.length }), 'success'); reload();
            } catch (e) { toast(e.message, 'error'); }
          },
        }, t('comp.examplesTake'))],
    });
  }

  async function move(c, dir) {
    const ids = components.map((x) => x.id);
    const i = ids.indexOf(c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.orderComponents(project.id, ids); reload(); } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- Test field ----------
  const tTitle = h('input', { placeholder: t('comp.testTitle') });
  const tDesc = h('textarea', { rows: 2, placeholder: t('comp.testDescription') });
  const tSender = h('input', { type: 'email', placeholder: t('comp.testSender') });
  const tOut = h('div.comp-test-result', { role: 'status', 'aria-live': 'polite' });
  const runTest = async (e) => {
    e?.preventDefault();
    try {
      const r = await api.testComponents(project.id, { title: tTitle.value, description: tDesc.value, sender: tSender.value });
      if (!r.component) mount(tOut, h('span.muted', t('comp.testNone')));
      else {
        const c = components.find((x) => x.id === r.component.id);
        const who = c?.lead?.displayName || c?.deputy?.displayName;
        mount(tOut, icon('check'), ' ', h('strong', r.component.name), ` (${t(`comp.reason.${r.kind}`)}: ${r.detail})`,
          who ? h('span.muted', ` → ${t('comp.testAssign', { name: who })}`) : null);
      }
    } catch (ex) { toast(ex.message, 'error'); }
  };

  // Rules column: sender patterns (decide first) and keywords
  const rules = (c, max = 6) => {
    if (!c.keywords.length && !c.senders.length) return h('span.muted', t('comp.noRules'));
    return h('span.comp-chips',
      c.senders.map((s) => h('span.chip.small.comp-sender', { title: t('comp.senders') }, icon('mail'), h('span', s))),
      c.keywords.slice(0, max).map((k) => h('span.chip.small', k)),
      c.keywords.length > max ? h('span.muted.small', ` +${c.keywords.length - max}`) : null);
  };

  mount(body,
    h('section.panel',
      h('div.section-head', h('h2', t('admin.components')),
        h('div.actions',
          h('button.btn.btn-subtle', { type: 'button', onclick: examplesDialog }, icon('sparkle'), t('comp.examples')),
          h('button.btn.btn-primary', { type: 'button', onclick: () => editDialog() }, icon('plus'), t('comp.new')))),
      h('p.muted', t('comp.intro')),
      projects.length > 1 ? field(t('ticket.project'), select(projects.map((p) => [p.key, `${p.name} (${p.key})`]), project.key, {
        onchange: (e) => navigate(`/admin/components?project=${e.target.value}`, { replace: true }),
      })) : null,
      components.length ? h('div.table-wrap', h('table.data.comp-table',
        h('thead', h('tr', h('th', ''), h('th', t('comp.name')), h('th', t('comp.lead')), h('th', t('comp.rules')), h('th', t('comp.tickets')), h('th', ''))),
        h('tbody', components.map((c, i) => h('tr', { class: c.archived ? 'muted' : '' },
          h('td.comp-order',
            h('button.btn-icon.small', { type: 'button', disabled: i === 0, title: t('comp.up'), 'aria-label': t('comp.up'), onclick: () => move(c, -1) }, h('span', { 'aria-hidden': 'true' }, '↑')),
            h('button.btn-icon.small', { type: 'button', disabled: i === components.length - 1, title: t('comp.down'), 'aria-label': t('comp.down'), onclick: () => move(c, 1) }, h('span', { 'aria-hidden': 'true' }, '↓'))),
          h('td', h('strong', c.name), c.archived ? h('span.muted', ` · ${t('comp.archived')}`) : null, c.description ? h('span.muted.block.small', c.description) : null),
          h('td', c.lead?.displayName || h('span.muted', '—'), c.deputy ? h('span.muted.block.small', t('comp.deputyShort', { name: c.deputy.displayName })) : null),
          h('td.comp-rules', rules(c)),
          h('td', c.ticketCount ? h('a', { href: `/issues?project=${project.key}&component=${c.id}`, 'data-link': '' }, `${c.openCount} / ${c.ticketCount}`) : '0'),
          h('td.actions-cell',
            h('button.btn-icon.small', { type: 'button', title: t('comp.edit'), 'aria-label': t('comp.edit'), onclick: () => editDialog(c) }, icon('pencil')),
            h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => { await api.updateComponent(c.id, { archived: !c.archived }); reload(); } }, c.archived ? t('projects.unarchive') : t('projects.archive')),
            h('button.btn-icon.small', { type: 'button', title: t('comp.delete'), 'aria-label': t('comp.delete'), onclick: () => removeDialog(c) }, icon('trash')))))))) :
        h('div.empty-state.small', t('comp.empty')),
      components.length ? h('p.muted.small', t('comp.orderHint')) : null),
    components.length ? h('section.panel',
      h('h3', t('comp.test')),
      h('p.muted', t('comp.testIntro')),
      h('form.comp-test', { onsubmit: runTest },
        field(t('comp.testTitle'), tTitle),
        field(t('comp.testDescription'), tDesc),
        field(t('comp.testSender'), tSender),
        h('div', h('button.btn.btn-primary', { type: 'submit' }, t('comp.testRun')))),
      tOut) : null,
    components.some((c) => !c.archived) ? backfillPanel(project) : null);
}

// ---------- Sort existing tickets without component afterwards ----------
let backfillTimer = null;
function backfillPanel(project) {
  const aiOn = !!state.boot?.aiFeatures?.classify;
  const includeDone = h('input', { type: 'checkbox' }); // open tickets by default; done ones only on request
  const retry = h('input', { type: 'checkbox' });
  const mode = select([['suggest', t('backfill.modeSuggest')], ['auto', t('backfill.modeAuto')]], 'suggest');
  const result = h('div.backfill-result', { role: 'status', 'aria-live': 'polite' });
  const progress = h('div.backfill-progress', { hidden: true });
  const reviewLink = h('a.backfill-review', { href: `/admin/components?project=${project.key}&view=review`, 'data-link': '', hidden: true });
  let plan = null;
  const startBtn = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: () => confirmStart() }, t('backfill.start'));
  const opts = () => ({ includeDone: includeDone.checked, retry: retry.checked, mode: mode.value });
  const invalidate = () => { plan = null; startBtn.disabled = true; mount(result); };
  [includeDone, retry, mode].forEach((x) => x.addEventListener('change', invalidate));

  async function previewNow() {
    try {
      plan = await api.admin.backfillPreview(project.id, opts());
      mount(result,
        h('p', h('strong', t('backfill.total', { n: plan.total })), plan.total ? ' – ' : '', plan.total ? t('backfill.split', plan) : ''),
        plan.skipped ? h('p.muted.small', t('backfill.skipped', { n: plan.skipped })) : null,
        plan.aiMore ? h('p.muted.small', t('backfill.aiMore', { n: plan.aiMore, max: plan.maxAi })) : null,
        !plan.aiOn && plan.remaining ? h('p.muted.small', t('backfill.noAi', { n: plan.remaining })) : null);
      startBtn.disabled = !(plan.rules || plan.ai) || !!plan.run?.running;
      if (plan.run) showRun(plan.run);
    } catch (e) { toast(e.message, 'error'); }
  }

  function confirmStart() {
    if (!plan) return;
    if (!plan.ai) { start(); return; }
    const dlg = modal(t('backfill.title'), h('div',
      h('p', t('backfill.confirm', { rules: plan.rules, ai: plan.ai })),
      h('p.muted', t('backfill.confirmData')),
      plan.aiChars ? h('p.muted', t(plan.remote ? 'backfill.confirmVolumeRemote' : 'backfill.confirmVolume', { chars: plan.aiChars.toLocaleString(), tokens: plan.aiTokens.toLocaleString() })) : null,
      h('p.muted', t(mode.value === 'auto' ? 'backfill.confirmAuto' : 'backfill.confirmSuggest'))), {
      footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
        h('button.btn.btn-primary', { type: 'button', onclick: () => { dlg.close(); start(); } }, t('backfill.start'))],
    });
  }

  async function start() {
    startBtn.disabled = true;
    try {
      const { run } = await api.admin.backfillStart(project.id, opts());
      if (run.rules) toast(t('backfill.rulesDone', { n: run.rules }), 'success');
      showRun(run);
      poll();
    } catch (e) { toast(e.message, 'error'); startBtn.disabled = false; }
  }

  function poll() {
    clearTimeout(backfillTimer);
    backfillTimer = setTimeout(async () => {
      if (!progress.isConnected) return; // page left
      try {
        const { run } = await api.admin.backfillStatus();
        if (run) showRun(run);
        if (run?.running) poll(); else { refreshReview(); previewNow(); } // fresh counts after the run
      } catch { poll(); }
    }, 1500);
  }

  function showRun(run) {
    progress.hidden = false;
    const pct = run.total ? Math.round((run.done / run.total) * 100) : 100;
    mount(progress,
      run.project !== project.key ? h('p.muted.small', t('backfill.otherProject', { project: run.project })) : null,
      run.total ? h('div.progress', { role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t('backfill.title') },
        h('div.progress-bar', { style: { width: `${pct}%` } })) : null,
      h('p.small',
        run.running ? t('backfill.running', run) : t(run.cancelled ? (run.error === 'aiFailing' ? 'backfill.aiFailing' : 'backfill.cancelled') : 'backfill.finished', run),
        ' · ', t('backfill.counts', run)),
      run.running ? h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => {
        try { const r = await api.admin.backfillCancel(); if (r.run) showRun(r.run); } catch (ex) { toast(ex.message, 'error'); }
      } }, t('backfill.cancel')) : null);
    if (run.running) poll();
  }

  async function refreshReview() {
    try {
      const { suggestions } = await api.componentSuggestions(project.id);
      reviewLink.hidden = !suggestions.length;
      mount(reviewLink, icon('sparkle'), ' ', t('backfill.review', { n: suggestions.length }));
    } catch { /* ignore */ }
  }
  refreshReview();
  api.admin.backfillStatus().then(({ run }) => { if (run) showRun(run); }).catch(() => {});

  return h('section.panel.backfill',
    h('h3', t('backfill.title')),
    h('p.muted', t(aiOn ? 'backfill.intro' : 'backfill.introNoAi')),
    h('div.backfill-options',
      h('label.check-inline', includeDone, t('backfill.includeDone')),
      aiOn ? h('label.check-inline', retry, t('backfill.retry')) : null,
      aiOn ? field(t('backfill.mode'), mode) : null),
    h('div.actions', h('button.btn.btn-subtle', { type: 'button', onclick: previewNow }, t('backfill.preview')), startBtn),
    result, progress, reviewLink);
}

/** Review list: open AI suggestions, accept or dismiss several at once */
async function reviewPage(body, project) {
  const { suggestions } = await api.componentSuggestions(project.id);
  const back = `/admin/components?project=${project.key}`;
  const boxes = [];
  const all = h('input', { type: 'checkbox', 'aria-label': t('backfill.selectAll'), onchange: () => { boxes.forEach((b) => { b.checked = all.checked; }); sync(); } });
  const accept = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: () => decide('accept') }, t('backfill.accept'));
  const dismiss = h('button.btn.btn-subtle', { type: 'button', disabled: true, onclick: () => decide('dismiss') }, t('backfill.dismiss'));
  function sync() {
    const n = boxes.filter((b) => b.checked).length;
    accept.disabled = dismiss.disabled = !n;
    accept.textContent = n ? t('backfill.acceptN', { n }) : t('backfill.accept');
    all.checked = n && n === boxes.length;
  }
  async function decide(action) {
    const keys = boxes.filter((b) => b.checked).map((b) => b.value);
    try {
      const r = await api.decideSuggestions(keys, action);
      toast(t(action === 'accept' ? 'backfill.accepted' : 'backfill.dismissed', { n: r.done }), r.failed.length ? 'error' : 'success');
      reviewPage(body, project);
    } catch (e) { toast(e.message, 'error'); }
  }
  mount(body, h('section.panel',
    h('div.section-head', h('h2', t('backfill.reviewTitle'), h('span.muted', ` · ${project.name}`)),
      h('a.btn.btn-subtle', { href: back, 'data-link': '' }, t('backfill.back'))),
    h('p.muted', t('backfill.reviewIntro')),
    suggestions.length ? [
      h('div.actions.backfill-bulk', accept, dismiss),
      h('div.table-wrap', h('table.data.backfill-table',
        h('thead', h('tr', h('th', all), h('th', t('list.key')), h('th', t('list.summary')), h('th', t('backfill.suggestion')), h('th', t('list.status')))),
        h('tbody', suggestions.map((s) => {
          const box = h('input', { type: 'checkbox', value: s.key, 'aria-label': s.key, onchange: sync });
          boxes.push(box);
          return h('tr',
            h('td', box),
            h('td', h('a', { href: `/browse/${s.key}`, 'data-link': '' }, s.key)),
            h('td', s.title),
            h('td', h('strong', s.component.name), s.reason ? h('span.muted.block.small', s.reason) : null),
            h('td', lozenge(s.status, s.resolution)));
        }))))] : h('div.empty-state.small', t('backfill.reviewEmpty'))));
}

