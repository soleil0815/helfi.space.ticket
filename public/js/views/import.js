// Administration → Import aus Jira (Cloud oder Server/Data Center)
import { api } from '../api.js';
import { h, mount, icon, field, select, toast } from '../dom.js';
import { t } from '../i18n.js';
import { reloadBase } from '../app.js';

// Verbindungsdaten nur im Speicher der Seite – sie werden nirgends gespeichert
let conn = { type: 'cloud', baseUrl: '', email: '', token: '', username: '', password: '', verifyTls: true, caPem: '' };
let projects = [];
let connInfo = { user: '', server: {} };
let pollTimer = null;

const STATUS_TARGETS = ['open', 'in_progress', 'waiting', 'done'];
const TYPE_TARGETS = ['incident', 'request', 'task', 'question'];

export async function importPage(body) {
  clearTimeout(pollTimer);
  const { job } = await api.admin.importStatus();
  if (job && job.state === 'running') return progressStep(body);
  connectStep(body, job);
}

function header(step) {
  const steps = ['imp.step.connect', 'imp.step.projects', 'imp.step.mapping', 'imp.step.run'];
  return h('section.panel',
    h('h2', t('imp.title')),
    h('p.muted', t('imp.intro')),
    h('ol.steps-bar', steps.map((s, i) => h('li', { class: i === step ? 'active' : (i < step ? 'done' : '') }, h('span.n', String(i + 1)), t(s)))));
}

// ---------- 1. Verbinden ----------
function connectStep(body, lastJob) {
  const err = h('div.form-error', { hidden: true });
  const bind = (key, attrs = {}) => {
    const el = h('input', { value: conn[key] ?? '', ...attrs });
    el.addEventListener('input', () => { conn[key] = el.value; });
    return el;
  };
  const authBox = h('div');
  const drawAuth = () => mount(authBox, conn.type === 'cloud'
    ? h('div.grid-2',
      field(t('imp.email'), bind('email', { type: 'email', autocomplete: 'off', placeholder: 'admin@firma.local' })),
      field(t('imp.apiToken'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.apiTokenHint')))
    : h('div',
      field(t('imp.pat'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.patHint')),
      h('details', h('summary', t('imp.basicAuth')),
        h('div.grid-2', field(t('login.username'), bind('username', { autocomplete: 'off' })), field(t('login.password'), bind('password', { type: 'password', autocomplete: 'new-password' })))),
      h('div.grid-2',
        h('div', field(t('imp.verifyTls'), (() => { const c = h('input', { type: 'checkbox', checked: conn.verifyTls }); c.addEventListener('change', () => { conn.verifyTls = c.checked; }); return c; })())),
        h('div')),
      h('details', h('summary', t('imp.caPem')), (() => { const ta = h('textarea.mono', { rows: 4, placeholder: '-----BEGIN CERTIFICATE-----' }); ta.value = conn.caPem; ta.addEventListener('input', () => { conn.caPem = ta.value; }); return ta; })())));
  const typeSel = select([['cloud', 'Jira Cloud (atlassian.net)'], ['server', 'Jira Server / Data Center']], conn.type, {
    onchange: (e) => { conn.type = e.target.value; drawAuth(); },
  });
  drawAuth();

  const btn = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      err.hidden = true;
      btn.disabled = true;
      try {
        const r = await api.admin.jiraConnect(conn);
        if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
        projects = r.projects.map((p) => ({ ...p, selected: false, targetKey: p.suggestedKey }));
        connInfo = r;
        toast(t('imp.connected', { user: r.user, server: r.server.title || conn.baseUrl }), 'success');
        projectsStep(body, r);
      } catch (e) { err.textContent = e.message; err.hidden = false; }
      finally { btn.disabled = false; }
    },
  }, icon('link'), t('imp.connect'));

  mount(body,
    header(0),
    lastJob ? lastJobPanel(lastJob) : null,
    h('section.panel',
      err,
      h('div.grid-2', field(t('imp.type'), typeSel), field(t('imp.url'), bind('baseUrl', { placeholder: 'https://firma.atlassian.net' }), t('imp.urlHint'))),
      authBox,
      h('p.muted.small', icon('lock'), ' ', t('imp.notStored')),
      h('div.form-actions', btn)));
}

function lastJobPanel(job) {
  return h('section.panel', h('h3', t('imp.lastRun')), summary(job));
}

// ---------- 2. Projekte ----------
function projectsStep(body, info) {
  const err = h('div.form-error', { hidden: true });
  const rows = projects.map((p) => {
    const cb = h('input', { type: 'checkbox', checked: p.selected, onchange: (e) => { p.selected = e.target.checked; } });
    const key = h('input.input-inline.mono', { value: p.targetKey, maxLength: 10, style: { width: '110px', textTransform: 'uppercase' }, oninput: (e) => { p.targetKey = e.target.value.toUpperCase(); } });
    return h('tr', h('td', cb), h('td.mono', p.key), h('td', p.name), h('td', key, p.exists ? h('span.badge', { title: t('imp.existsHint') }, t('imp.exists')) : null));
  });
  const all = h('input', { type: 'checkbox', onchange: (e) => { projects.forEach((p) => { p.selected = e.target.checked; }); rows.forEach((r) => { r.querySelector('input').checked = e.target.checked; }); } });
  const next = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      const chosen = projects.filter((p) => p.selected);
      if (!chosen.length) { err.textContent = t('imp.chooseProject'); err.hidden = false; return; }
      next.disabled = true;
      try {
        const r = await api.admin.jiraInspect(conn, chosen.map((p) => p.key));
        if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
        mappingStep(body, chosen, r);
      } finally { next.disabled = false; }
    },
  }, t('imp.next'));
  mount(body,
    header(1),
    h('section.panel',
      h('p', t('imp.connectedAs', { user: info.user, server: `${info.server.title || conn.baseUrl} ${info.server.version || ''}`.trim() })),
      err,
      projects.length ? h('table.data',
        h('thead', h('tr', h('th', all), h('th', t('imp.jiraKey')), h('th', t('projects.name')), h('th', { title: t('imp.targetKeyHint') }, t('imp.targetKey')))),
        h('tbody', rows)) : h('p.muted', t('imp.noProjects')),
      h('p.muted.small', t('imp.targetKeyHint')),
      h('div.form-actions', h('button.btn.btn-subtle', { type: 'button', onclick: () => connectStep(body) }, t('imp.back')), next)));
}

// ---------- 3. Zuordnung ----------
function mappingStep(body, chosen, info) {
  const statusMap = Object.fromEntries(info.statuses.map((s) => [s.name, s.suggested]));
  const typeMap = Object.fromEntries(info.types.map((s) => [s.name, s.suggested]));
  const opts = { comments: true, attachments: true, maxAttachmentMb: 50 };
  const total = Object.values(info.counts).reduce((a, b) => a + (b || 0), 0);
  const cat = { new: t('imp.cat.new'), indeterminate: t('imp.cat.indeterminate'), done: t('imp.cat.done') };

  const check = (key, label) => field(label, (() => { const c = h('input', { type: 'checkbox', checked: opts[key] }); c.addEventListener('change', () => { opts[key] = c.checked; }); return c; })());
  const start = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      start.disabled = true;
      try {
        await api.admin.jiraStart(conn, chosen.map((p) => ({ key: p.key, name: p.name, targetKey: p.targetKey })), statusMap, typeMap, opts);
        progressStep(body);
      } catch (e) { toast(e.message, 'error'); start.disabled = false; }
    },
  }, icon('download'), t('imp.start', { n: total }));

  mount(body,
    header(2),
    h('section.panel',
      h('p', chosen.map((p) => `${p.key} → ${p.targetKey} (${info.counts[p.key] ?? '?'})`).join(' · ')),
      h('h3', t('imp.statusMapping')),
      h('table.data', h('thead', h('tr', h('th', t('imp.jiraStatus')), h('th', t('imp.category')), h('th', 'Helfi.Space'))),
        h('tbody', info.statuses.map((s) => h('tr', h('td', s.name), h('td.muted', cat[s.category] || s.category),
          h('td', select(STATUS_TARGETS.map((x) => [x, t(`status.${x}`)]), statusMap[s.name], { class: 'select-sm', onchange: (e) => { statusMap[s.name] = e.target.value; } })))))),
      h('h3', t('imp.typeMapping')),
      h('table.data', h('thead', h('tr', h('th', t('imp.jiraType')), h('th', 'Helfi.Space'))),
        h('tbody', info.types.map((s) => h('tr', h('td', s.name),
          h('td', select(TYPE_TARGETS.map((x) => [x, t(`type.${x}`)]), typeMap[s.name], { class: 'select-sm', onchange: (e) => { typeMap[s.name] = e.target.value; } })))))),
      h('h3', t('imp.options')),
      check('comments', t('imp.optComments')),
      check('attachments', t('imp.optAttachments')),
      field(t('imp.maxMb'), (() => { const i = h('input', { type: 'number', min: 1, max: 1024, value: opts.maxAttachmentMb, style: { width: '120px' } }); i.addEventListener('input', () => { opts.maxAttachmentMb = Number(i.value) || 50; }); return i; })()),
      h('div.hint-box', icon('info'), h('div', h('p', t('imp.hintNoMail')), h('p', t('imp.hintUsers')), h('p', t('imp.hintRepeat')))),
      h('div.form-actions', h('button.btn.btn-subtle', { type: 'button', onclick: () => projectsStep(body, connInfo) }, t('imp.back')), start)));
}

// ---------- 4. Fortschritt ----------
function summary(job) {
  const c = job.counts;
  return h('div',
    h('p', h('strong', t(`imp.state.${job.state}`)), job.current ? ` · ${job.current}` : ''),
    job.projects.map((p) => {
      const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : (p.state === 'done' ? 100 : 0);
      return h('div.progress-row',
        h('div.progress-label', `${p.key} → `, h('a', { href: `/issues?project=${p.targetKey}`, 'data-link': '' }, p.targetKey), h('span.muted', ` ${p.done}${p.total ? ` / ${p.total}` : ''}`)),
        h('div.progress', h('div.progress-bar', { style: { width: `${pct}%` } })));
    }),
    h('p.muted', t('imp.counts', c)),
    job.errors.length ? h('details', h('summary', t('imp.errors', { n: job.errors.length })), h('ul.error-list', job.errors.slice(-50).map((e) => h('li.mono', e)))) : null);
}

async function progressStep(body) {
  clearTimeout(pollTimer);
  const { job } = await api.admin.importStatus();
  if (!job) return connectStep(body);
  const running = job.state === 'running';
  mount(body,
    header(3),
    h('section.panel',
      summary(job),
      h('div.form-actions',
        running
          ? h('button.btn', { type: 'button', disabled: job.cancelRequested, onclick: async () => { await api.admin.importCancel(); progressStep(body); } }, t('imp.cancel'))
          : [h('a.btn.btn-primary', { href: `/board?project=${job.projects[0]?.targetKey || ''}`, 'data-link': '' }, t('imp.toBoard')),
            h('button.btn', { type: 'button', onclick: () => connectStep(body, job) }, t('imp.again'))])));
  if (running && document.body.contains(body)) pollTimer = setTimeout(() => progressStep(body), 1500);
  else if (!running) reloadBase().catch(() => {});
}
