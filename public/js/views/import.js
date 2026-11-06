// Administration → import from another ticket system: REST API (Cloud/Server), Zammad, Znuny/OTRS or a CSV file
import { api } from '../api.js';
import { h, mount, icon, field, select, toast } from '../dom.js';
import { t } from '../i18n.js';
import { reloadBase } from '../app.js';

// Connection data only in page memory – it is never stored
const emptyConn = () => ({ type: 'cloud', baseUrl: '', email: '', token: '', username: '', password: '', verifyTls: true, caPem: '', uploadId: '', name: '', columns: {} });
let source = 'zammad';
let conn = emptyConn();
let csvInfo = null; // { headers, rows, preview, suggested, fields }
let projects = [];
let connInfo = { user: '', server: {} };
let pollTimer = null;

const SOURCES = [
  { id: 'zammad', icon: 'inbox' },
  { id: 'znuny', icon: 'server' },
  { id: 'jira', icon: 'globe' },
  { id: 'csv', icon: 'file' },
];
const STATUS_TARGETS = ['open', 'in_progress', 'waiting', 'done'];
const TYPE_TARGETS = ['incident', 'request', 'task', 'question'];
const CSV_FIELD_ORDER = ['title', 'id', 'description', 'status', 'type', 'priority', 'reporterEmail', 'reporterName', 'assignee', 'labels', 'created', 'updated', 'resolved', 'due', 'project', 'comments'];

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

const connection = () => (source === 'csv' ? { uploadId: conn.uploadId, name: conn.name, columns: conn.columns } : conn);

// ---------- 1. Source and connection ----------
function connectStep(body, lastJob) {
  const err = h('div.form-error', { hidden: true });
  const showErr = (m) => { err.textContent = m; err.hidden = false; };
  const bind = (key, attrs = {}) => {
    const el = h('input', { value: conn[key] ?? '', ...attrs });
    el.addEventListener('input', () => { conn[key] = el.value; });
    return el;
  };
  const check = (key) => { const c = h('input', { type: 'checkbox', checked: conn[key] }); c.addEventListener('change', () => { conn[key] = c.checked; }); return c; };
  const tls = () => [
    h('div.grid-2', h('div', field(t('imp.verifyTls'), check('verifyTls'))), h('div')),
    h('details', h('summary', t('imp.caPem')), (() => { const ta = h('textarea.mono', { rows: 4, placeholder: '-----BEGIN CERTIFICATE-----' }); ta.value = conn.caPem; ta.addEventListener('input', () => { conn.caPem = ta.value; }); return ta; })()),
  ];

  const form = h('div');
  const actions = h('div.form-actions');
  const connectBtn = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      err.hidden = true;
      connectBtn.disabled = true;
      try {
        const r = await api.admin.importConnect(source, connection());
        if (!r.ok) return showErr(r.error);
        projects = r.projects.map((p) => ({ ...p, selected: r.projects.length === 1, targetKey: p.suggestedKey }));
        connInfo = r;
        if (source !== 'csv') toast(t('imp.connected', { user: r.user || '—', server: r.server.title || conn.baseUrl }), 'success');
        projectsStep(body, r);
      } catch (e) { showErr(e.message); }
      finally { connectBtn.disabled = false; }
    },
  }, icon(source === 'csv' ? 'chevron-right' : 'link'), t(source === 'csv' ? 'imp.next' : 'imp.connect'));

  function drawForm() {
    connectBtn.replaceChildren(icon(source === 'csv' ? 'chevron-right' : 'link'), t(source === 'csv' ? 'imp.next' : 'imp.connect'));
    if (source === 'jira') {
      const auth = h('div');
      const drawAuth = () => mount(auth, conn.type === 'cloud'
        ? h('div.grid-2',
          field(t('imp.email'), bind('email', { type: 'email', autocomplete: 'off', placeholder: 'admin@firma.local' })),
          field(t('imp.apiToken'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.apiTokenHint')))
        : h('div',
          field(t('imp.pat'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.patHint')),
          h('details', h('summary', t('imp.basicAuth')),
            h('div.grid-2', field(t('login.username'), bind('username', { autocomplete: 'off' })), field(t('login.password'), bind('password', { type: 'password', autocomplete: 'new-password' })))),
          tls()));
      drawAuth();
      const typeSel = select([['cloud', t('imp.typeCloud')], ['server', t('imp.typeServer')]], conn.type, { onchange: (e) => { conn.type = e.target.value; drawAuth(); } });
      mount(form, h('div.grid-2', field(t('imp.type'), typeSel), field(t('imp.url'), bind('baseUrl', { placeholder: 'https://tickets.firma.local' }), t('imp.urlHint'))), auth);
    } else if (source === 'zammad') {
      mount(form,
        field(t('imp.url'), bind('baseUrl', { placeholder: 'https://zammad.firma.local' }), t('imp.zammad.urlHint')),
        field(t('imp.zammad.token'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.zammad.tokenHint')),
        h('details', h('summary', t('imp.basicAuth')),
          h('div.grid-2', field(t('login.username'), bind('username', { autocomplete: 'off' })), field(t('login.password'), bind('password', { type: 'password', autocomplete: 'new-password' })))),
        tls());
    } else if (source === 'znuny') {
      mount(form,
        field(t('imp.znuny.url'), bind('baseUrl', { placeholder: 'https://tickets.firma.local/otrs/nph-genericinterface.pl/Webservice/GenericTicketConnectorREST' }), t('imp.znuny.urlHint')),
        h('div.grid-2', field(t('imp.znuny.user'), bind('username', { autocomplete: 'off' })), field(t('login.password'), bind('password', { type: 'password', autocomplete: 'new-password' }))),
        h('div.hint-box', icon('info'), h('div', h('p', t('imp.znuny.setup')))),
        tls());
    } else {
      mount(form, csvForm());
    }
    actions.replaceChildren(connectBtn);
    actions.hidden = source === 'csv' && !csvInfo;
  }

  function csvForm() {
    const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      err.hidden = true;
      try {
        const r = await api.admin.importCsvUpload(f);
        if (!r.ok) { csvInfo = null; drawForm(); return showErr(r.error); }
        csvInfo = r;
        conn.uploadId = r.uploadId;
        conn.name = r.name;
        conn.columns = { ...r.suggested };
        drawForm();
      } catch (e) { showErr(e.message); }
    });
    if (!csvInfo) return h('div', field(t('imp.csv.file'), file, t('imp.csv.fileHint')));
    const opts = [['', '—'], ...csvInfo.headers.map((x) => [x, x])];
    const rows = CSV_FIELD_ORDER.filter((f) => csvInfo.fields.includes(f)).map((f) => {
      const sample = conn.columns[f] ? csvInfo.preview.map((r) => r[conn.columns[f]]).filter(Boolean).slice(0, 2).join(' · ') : '';
      const sampleEl = h('td.muted.small', sample.length > 80 ? `${sample.slice(0, 80)}…` : sample);
      return h('tr', h('td', t(`imp.csv.f.${f}`), f === 'title' ? ' *' : ''),
        h('td', select(opts, conn.columns[f] || '', { class: 'select-sm', onchange: (e) => { if (e.target.value) conn.columns[f] = e.target.value; else delete conn.columns[f]; drawForm(); } })),
        sampleEl);
    });
    return h('div',
      h('p', h('strong', t('imp.csv.loaded', { n: csvInfo.rows })), ' ', h('button.link', { type: 'button', onclick: () => { csvInfo = null; conn.uploadId = ''; drawForm(); } }, t('imp.csv.other'))),
      field(t('imp.csv.name'), bind('name', { maxLength: 60 }), t('imp.csv.nameHint')),
      h('h3', t('imp.csv.columns')),
      h('table.data', h('thead', h('tr', h('th', t('imp.csv.field')), h('th', t('imp.csv.column')), h('th', t('imp.csv.sample')))), h('tbody', rows)),
      h('p.muted.small', t('imp.csv.columnsHint')));
  }

  const sourceBtns = h('div.import-sources', { role: 'radiogroup', 'aria-label': t('imp.source') }, SOURCES.map((s) => h('button.import-source', {
    type: 'button', role: 'radio', 'aria-checked': String(s.id === source), class: s.id === source ? 'active' : '',
    onclick: () => { source = s.id; err.hidden = true; connectStep(body, lastJob); },
  }, icon(s.icon), h('span.import-source-name', t(`imp.src.${s.id}`)), h('span.import-source-hint', t(`imp.src.${s.id}.hint`)))));
  drawForm();

  mount(body,
    header(0),
    lastJob ? lastJobPanel(lastJob) : null,
    h('section.panel',
      h('h3', t('imp.source')),
      sourceBtns,
      err,
      form,
      source === 'csv' ? null : h('p.muted.small', icon('lock'), ' ', t('imp.notStored')),
      actions));
}

function lastJobPanel(job) {
  return h('section.panel', h('h3', t('imp.lastRun')), summary(job));
}

// ---------- 2. Projects ----------
function projectsStep(body, info) {
  const err = h('div.form-error', { hidden: true });
  const withKey = source === 'jira';
  const rows = projects.map((p) => {
    const cb = h('input', { type: 'checkbox', checked: p.selected, onchange: (e) => { p.selected = e.target.checked; } });
    const key = h('input.input-inline.mono', { value: p.targetKey, maxLength: 10, style: { width: '110px', textTransform: 'uppercase' }, oninput: (e) => { p.targetKey = e.target.value.toUpperCase(); } });
    return h('tr', h('td', cb), withKey ? h('td.mono', p.key) : null, h('td', p.name), withKey ? null : h('td.num', p.count ?? ''),
      h('td', key, p.exists ? h('span.badge', { title: t('imp.existsHint') }, t('imp.exists')) : null));
  });
  const all = h('input', { type: 'checkbox', onchange: (e) => { projects.forEach((p) => { p.selected = e.target.checked; }); rows.forEach((r) => { r.querySelector('input').checked = e.target.checked; }); } });
  const next = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      const chosen = projects.filter((p) => p.selected);
      if (!chosen.length) { err.textContent = t('imp.chooseProject'); err.hidden = false; return; }
      next.disabled = true;
      try {
        const r = await api.admin.importInspect(source, connection(), chosen.map((p) => p.key));
        if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
        mappingStep(body, chosen, r);
      } finally { next.disabled = false; }
    },
  }, t('imp.next'));
  const intro = source === 'csv'
    ? t('imp.csv.projects', { name: conn.name })
    : t('imp.connectedAs', { user: info.user || '—', server: `${info.server.title || conn.baseUrl} ${info.server.version || ''}`.trim() });
  mount(body,
    header(1),
    h('section.panel',
      h('p', intro),
      err,
      projects.length ? h('table.data',
        h('thead', h('tr', h('th', all), withKey ? h('th', t('imp.jiraKey')) : null, h('th', t(`imp.projectName.${source}`)), withKey ? null : h('th.num', t('imp.ticketCount')), h('th', { title: t('imp.targetKeyHint') }, t('imp.targetKey')))),
        h('tbody', rows)) : h('p.muted', t('imp.noProjects')),
      h('p.muted.small', t('imp.targetKeyHint')),
      h('div.form-actions', h('button.btn.btn-subtle', { type: 'button', onclick: () => connectStep(body) }, t('imp.back')), next)));
}

// ---------- 3. Mapping ----------
function mappingStep(body, chosen, info) {
  const statusMap = Object.fromEntries(info.statuses.map((s) => [s.name, s.suggested]));
  const typeMap = Object.fromEntries(info.types.map((s) => [s.name, s.suggested]));
  const opts = { comments: true, attachments: source !== 'csv', maxAttachmentMb: 50 };
  const total = Object.values(info.counts).reduce((a, b) => a + (b || 0), 0);
  const cat = { new: t('imp.cat.new'), indeterminate: t('imp.cat.indeterminate'), waiting: t('imp.cat.waiting'), done: t('imp.cat.done') };
  const label = (n) => n || h('span.muted', t('imp.empty'));

  const check = (key, labelText) => field(labelText, (() => { const c = h('input', { type: 'checkbox', checked: opts[key] }); c.addEventListener('change', () => { opts[key] = c.checked; }); return c; })());
  const start = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      start.disabled = true;
      try {
        await api.admin.importStart(source, connection(), chosen.map((p) => ({ key: p.key, name: p.name, targetKey: p.targetKey })), statusMap, typeMap, opts);
        progressStep(body);
      } catch (e) { toast(e.message, 'error'); start.disabled = false; }
    },
  }, icon('download'), t('imp.start', { n: total }));

  mount(body,
    header(2),
    h('section.panel',
      h('p', chosen.map((p) => `${source === 'jira' ? p.key : p.name} → ${p.targetKey} (${info.counts[p.key] ?? '?'})`).join(' · ')),
      h('h3', t('imp.statusMapping')),
      h('table.data', h('thead', h('tr', h('th', t('imp.jiraStatus')), h('th', t('imp.category')), h('th', 'Helfi.Space'))),
        h('tbody', info.statuses.map((s) => h('tr', h('td', label(s.name)), h('td.muted', cat[s.category] || s.category),
          h('td', select(STATUS_TARGETS.map((x) => [x, t(`status.${x}`)]), statusMap[s.name], { class: 'select-sm', onchange: (e) => { statusMap[s.name] = e.target.value; } })))))),
      h('h3', t('imp.typeMapping')),
      h('table.data', h('thead', h('tr', h('th', t('imp.jiraType')), h('th', 'Helfi.Space'))),
        h('tbody', info.types.map((s) => h('tr', h('td', label(s.name)),
          h('td', select(TYPE_TARGETS.map((x) => [x, t(`type.${x}`)]), typeMap[s.name], { class: 'select-sm', onchange: (e) => { typeMap[s.name] = e.target.value; } })))))),
      h('h3', t('imp.options')),
      check('comments', t(source === 'csv' ? 'imp.optCommentsCsv' : 'imp.optComments')),
      source === 'csv' ? null : check('attachments', t('imp.optAttachments')),
      source === 'csv' ? null : field(t('imp.maxMb'), (() => { const i = h('input', { type: 'number', min: 1, max: 1024, value: opts.maxAttachmentMb, style: { width: '120px' } }); i.addEventListener('input', () => { opts.maxAttachmentMb = Number(i.value) || 50; }); return i; })()),
      h('div.hint-box', icon('info'), h('div', h('p', t('imp.hintNoMail')), h('p', t('imp.hintUsers')), h('p', t(source === 'csv' ? 'imp.hintRepeatCsv' : 'imp.hintRepeat')))),
      h('div.form-actions', h('button.btn.btn-subtle', { type: 'button', onclick: () => projectsStep(body, connInfo) }, t('imp.back')), start)));
}

// ---------- 4. Progress ----------
function summary(job) {
  const c = job.counts;
  const named = job.kind && job.kind !== 'jira';
  return h('div',
    h('p', h('strong', t(`imp.state.${job.state}`)), job.kind ? h('span.muted', ` · ${t(`imp.src.${job.kind}`)}`) : null, job.current ? ` · ${job.current}` : ''),
    job.projects.map((p) => {
      const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : (p.state === 'done' ? 100 : 0);
      return h('div.progress-row',
        h('div.progress-label', `${named ? (p.name || p.key) : p.key} → `, h('a', { href: `/issues?project=${p.targetKey}`, 'data-link': '' }, p.targetKey), h('span.muted', ` ${p.done}${p.total ? ` / ${p.total}` : ''}`)),
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
            h('button.btn', { type: 'button', onclick: () => { conn = emptyConn(); csvInfo = null; connectStep(body, job); } }, t('imp.again'))])));
  if (running && document.body.contains(body)) pollTimer = setTimeout(() => progressStep(body), 1500);
  else if (!running) reloadBase().catch(() => {});
}
