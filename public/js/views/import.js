// Administration → import from another system: tickets (REST API Cloud/Server, Zammad, Znuny/OTRS, GLPI, Zendesk,
// Freshdesk or a CSV file) or knowledge articles (Confluence and the knowledge bases of those ticket systems)
import { api } from '../api.js';
import { h, mount, icon, field, select, toast, fmtSize } from '../dom.js';
import { t } from '../i18n.js';
import { reloadBase } from '../app.js';

// Connection data only in page memory – it is never stored
const emptyConn = () => ({ type: 'cloud', baseUrl: '', faqUrl: '', email: '', token: '', appToken: '', username: '', password: '', verifyTls: true, caPem: '', uploadId: '', name: '', columns: {} });
let source = 'zammad';
let what = 'tickets'; // 'tickets' | 'kb' (knowledge articles)
let conn = emptyConn();
let csvInfo = null; // { headers, rows, preview, suggested, fields }
let zipInfo = null; // uploaded Confluence export { uploadId, name, size }
// Confluence as an export file has its own address on the server
const apiSource = () => (source === 'confluence' && conn.type === 'export' ? 'confluence-zip' : source);
let projects = [];
let connInfo = { user: '', server: {} };
let pollTimer = null;

/** Forget everything of the last import (connection data with token/password) – on sign-in/sign-out */
export function resetImportState() {
  clearTimeout(pollTimer);
  source = 'zammad';
  what = 'tickets';
  conn = emptyConn();
  csvInfo = null;
  zipInfo = null;
  projects = [];
  connInfo = { user: '', server: {} };
}

const SOURCES = [
  { id: 'zammad', icon: 'inbox' },
  { id: 'znuny', icon: 'server' },
  { id: 'glpi', icon: 'monitor' },
  { id: 'zendesk', icon: 'comment' },
  { id: 'freshdesk', icon: 'mail' },
  { id: 'jira', icon: 'globe' },
  { id: 'csv', icon: 'file' },
  { id: 'confluence', icon: 'book', kbOnly: true },
];
// Sources with knowledge articles (the others only have tickets)
const KB_SOURCES = ['confluence', 'zammad', 'zendesk', 'freshdesk', 'glpi', 'znuny'];
const sourcesFor = (w) => (w === 'kb' ? SOURCES.filter((s) => KB_SOURCES.includes(s.id)).sort((a, b) => KB_SOURCES.indexOf(a.id) - KB_SOURCES.indexOf(b.id)) : SOURCES.filter((s) => !s.kbOnly));
const STATUS_TARGETS = ['open', 'in_progress', 'waiting', 'done'];
const TYPE_TARGETS = ['incident', 'request', 'task', 'question'];
const CSV_FIELD_ORDER = ['title', 'id', 'description', 'status', 'type', 'priority', 'reporterEmail', 'reporterName', 'assignee', 'labels', 'created', 'updated', 'resolved', 'due', 'project', 'comments'];

export async function importPage(body) {
  clearTimeout(pollTimer);
  const { job } = await api.admin.importStatus();
  if (job && job.state === 'running') return progressStep(body);
  connectStep(body, job);
}

function header(step, kind = what) {
  const steps = kind === 'kb' ? ['imp.step.connect', 'imp.step.spaces', 'imp.step.run'] : ['imp.step.connect', 'imp.step.projects', 'imp.step.mapping', 'imp.step.run'];
  return h('section.panel',
    h('h2', t('imp.title')),
    h('p.muted', t(kind === 'kb' ? 'imp.kb.intro' : 'imp.intro')),
    h('ol.steps-bar', steps.map((s, i) => h('li', { class: i === step ? 'active' : (i < step ? 'done' : '') }, h('span.n', String(i + 1)), t(s)))));
}

const connection = () => (source === 'csv' ? { uploadId: conn.uploadId, name: conn.name, columns: conn.columns }
  // knowledge from Znuny/OTRS: only the FAQ web service (public, no sign-in)
  : what === 'kb' && source === 'znuny' ? { faqUrl: conn.faqUrl, verifyTls: conn.verifyTls, caPem: conn.caPem }
  : apiSource() === 'confluence-zip' ? { uploadId: zipInfo?.uploadId || '' } : conn);

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
        if (what === 'kb') {
          const r = await api.admin.importKbConnect(apiSource(), connection());
          if (!r.ok) return showErr(r.error);
          connInfo = r;
          if (apiSource() !== 'confluence-zip') toast(t('imp.connected', { user: r.user || '—', server: r.server.title || conn.baseUrl || conn.faqUrl }), 'success');
          return kbSpacesStep(body, r);
        }
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
    const fileSource = source === 'csv' || apiSource() === 'confluence-zip';
    connectBtn.replaceChildren(icon(fileSource ? 'chevron-right' : 'link'), t(fileSource ? 'imp.next' : 'imp.connect'));
    if (source === 'confluence') {
      const auth = h('div');
      const drawAuth = () => mount(auth, conn.type === 'cloud'
        ? h('div.grid-2',
          field(t('imp.email'), bind('email', { type: 'email', autocomplete: 'off', placeholder: 'admin@firma.local' })),
          field(t('imp.apiToken'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.confluence.tokenHint')))
        : h('div',
          field(t('imp.pat'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.patHint')),
          h('details', h('summary', t('imp.basicAuth')),
            h('div.grid-2', field(t('login.username'), bind('username', { autocomplete: 'off' })), field(t('login.password'), bind('password', { type: 'password', autocomplete: 'new-password' })))),
          tls()));
      drawAuth();
      if (!['cloud', 'server', 'export'].includes(conn.type)) conn.type = 'cloud';
      const typeSel = select([['cloud', t('imp.confluence.cloud')], ['server', t('imp.confluence.server')], ['export', t('imp.confluence.export')]], conn.type, { 'data-imp-confluence-type': '', onchange: (e) => { conn.type = e.target.value; drawForm(); } });
      if (conn.type === 'export') {
        // export file instead of a connection: for installations that are switched off or not reachable
        const file = h('input', { type: 'file', accept: '.zip,application/zip', 'data-imp-zip': '' });
        const state = h('p.muted.small');
        file.addEventListener('change', async () => {
          const f = file.files?.[0];
          if (!f) return;
          err.hidden = true; zipInfo = null; actions.hidden = true;
          state.textContent = t('imp.zip.uploading', { name: f.name });
          try {
            const r = await api.admin.importKbZipUpload(f);
            if (!r.ok) { state.textContent = ''; return showErr(r.error); }
            zipInfo = r;
            drawForm();
          } catch (e) { state.textContent = ''; showErr(e.message); }
        });
        mount(form, field(t('imp.type'), typeSel),
          zipInfo ? h('p', h('strong', t('imp.zip.loaded', { name: zipInfo.name, size: fmtSize(zipInfo.size) })), ' ', h('button.link', { type: 'button', onclick: () => { zipInfo = null; drawForm(); } }, t('imp.csv.other')))
            : field(t('imp.zip.file'), file, t('imp.zip.fileHint')),
          state);
      } else {
        mount(form, h('div.grid-2', field(t('imp.type'), typeSel), field(t('imp.url'), bind('baseUrl', { placeholder: 'https://wiki.firma.local' }), t('imp.confluence.urlHint'))), auth);
      }
    } else if (source === 'znuny' && what === 'kb') {
      mount(form,
        field(t('imp.znuny.faqUrl'), bind('faqUrl', { placeholder: 'https://tickets.firma.local/otrs/nph-genericinterface.pl/Webservice/GenericFAQConnectorREST' }), t('imp.znuny.faqUrlHint')),
        h('div.hint-box', icon('info'), h('div', h('p', t('imp.znuny.faqSetup')))),
        tls());
    } else if (source === 'jira') {
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
    } else if (source === 'glpi') {
      mount(form,
        field(t('imp.glpi.url'), bind('baseUrl', { placeholder: 'https://glpi.firma.local/apirest.php' }), t('imp.glpi.urlHint')),
        h('div.grid-2',
          field(t('imp.glpi.userToken'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.glpi.userTokenHint')),
          field(t('imp.glpi.appToken'), bind('appToken', { type: 'password', autocomplete: 'new-password' }), t('imp.glpi.appTokenHint'))),
        h('details', h('summary', t('imp.basicAuth')),
          h('div.grid-2', field(t('login.username'), bind('username', { autocomplete: 'off' })), field(t('login.password'), bind('password', { type: 'password', autocomplete: 'new-password' })))),
        tls());
    } else if (source === 'zendesk') {
      mount(form,
        field(t('imp.url'), bind('baseUrl', { placeholder: 'https://firma.zendesk.com' }), t('imp.zendesk.urlHint')),
        h('div.grid-2',
          field(t('imp.email'), bind('email', { type: 'email', autocomplete: 'off', placeholder: 'admin@firma.local' })),
          field(t('imp.apiToken'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.zendesk.tokenHint'))));
    } else if (source === 'freshdesk') {
      mount(form,
        field(t('imp.url'), bind('baseUrl', { placeholder: 'https://firma.freshdesk.com' }), t('imp.freshdesk.urlHint')),
        field(t('imp.freshdesk.key'), bind('token', { type: 'password', autocomplete: 'new-password' }), t('imp.freshdesk.keyHint')));
    } else {
      mount(form, csvForm());
    }
    actions.replaceChildren(connectBtn);
    actions.hidden = (source === 'csv' && !csvInfo) || (apiSource() === 'confluence-zip' && !zipInfo);
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

  if (!sourcesFor(what).some((s) => s.id === source)) source = sourcesFor(what)[0].id;
  const whatSeg = (w) => h(`button.seg${what === w ? '.active' : ''}`, { type: 'button', 'data-imp-what': w, 'aria-pressed': String(what === w), onclick: () => { if (what === w) return; what = w; err.hidden = true; connectStep(body, lastJob); } }, icon(w === 'kb' ? 'book' : 'inbox'), t(`imp.what.${w}`));
  const whatRow = h('div.import-what', h('span.import-what-label', t('imp.what')), h('div.segmented', { role: 'group', 'aria-label': t('imp.what') }, whatSeg('tickets'), whatSeg('kb')));
  const sourceBtns = h('div.import-sources', { role: 'radiogroup', 'aria-label': t('imp.source') }, sourcesFor(what).map((s) => h('button.import-source', {
    type: 'button', role: 'radio', 'aria-checked': String(s.id === source), class: s.id === source ? 'active' : '',
    onclick: () => { source = s.id; err.hidden = true; connectStep(body, lastJob); },
  }, icon(s.icon), h('span.import-source-name', t(`imp.src.${s.id}`)), h('span.import-source-hint', t(what === 'kb' ? `imp.kbsrc.${s.id}.hint` : `imp.src.${s.id}.hint`)))));
  drawForm();

  mount(body,
    header(0),
    lastJob ? lastJobPanel(lastJob) : null,
    h('section.panel',
      whatRow,
      h('h3', t(what === 'kb' ? 'imp.kb.source' : 'imp.source')),
      sourceBtns,
      err,
      form,
      source === 'csv' || apiSource() === 'confluence-zip' ? (apiSource() === 'confluence-zip' ? h('p.muted.small', icon('lock'), ' ', t('imp.zip.notKept')) : null) : h('p.muted.small', icon('lock'), ' ', t('imp.notStored')),
      actions));
}

function lastJobPanel(job) {
  return h('section.panel', h('h3', t('imp.lastRun')), summary(job));
}

// ---------- 2. Knowledge: spaces / categories of the source → projects of the knowledge base ----------
function kbSpacesStep(body, info) {
  const err = h('div.form-error', { hidden: true });
  const projects2 = info.projects || [];
  // Suggested project: same name or key, else a project whose name/key starts the space's name ("IT-Anleitungen" → IT), else the default project
  const guess = (name) => {
    const n = String(name).toLowerCase();
    const word = (x) => n === x || new RegExp(`^${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|[-_ /])`).test(n);
    const p = projects2.find((x) => x.name.toLowerCase() === n || x.key.toLowerCase() === n)
      || projects2.find((x) => word(x.name.toLowerCase()) || word(x.key.toLowerCase()));
    return p?.id || info.defaultProjectId || projects2[0]?.id || null;
  };
  const spaces = info.spaces.map((s) => ({ ...s, selected: info.spaces.length === 1, projectId: guess(s.name), language: s.languages?.[0]?.code || null }));
  const opts = { drafts: false, attachments: true, maxAttachmentMb: 50 };
  const rows = spaces.map((s) => h('tr', { 'data-imp-space': s.key },
    h('td', h('input', { type: 'checkbox', checked: s.selected, 'aria-label': s.name, onchange: (e) => { s.selected = e.target.checked; } })),
    h('td', s.note === 'withoutCategory' ? h('span.muted', t('imp.kb.withoutCategory')) : s.name),
    h('td.num', s.count ?? ''),
    h('td', select(projects2.map((p) => [p.id, p.name]), s.projectId, { class: 'select-sm', 'aria-label': t('imp.kb.targetProject'), onchange: (e) => { s.projectId = Number(e.target.value); } })),
    spaces.some((x) => (x.languages || []).length > 1)
      ? h('td', (s.languages || []).length > 1 ? select(s.languages.map((l) => [l.code, l.name]), s.language, { class: 'select-sm', 'aria-label': t('imp.kb.language'), onchange: (e) => { s.language = e.target.value; } }) : h('span.muted', s.languages?.[0]?.name || '—'))
      : null));
  const check = (key, labelText, hint) => field(labelText, (() => { const c = h('input', { type: 'checkbox', checked: opts[key], 'data-imp-opt': key }); c.addEventListener('change', () => { opts[key] = c.checked; }); return c; })(), hint);
  const start = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      const chosen = spaces.filter((s) => s.selected);
      if (!chosen.length) { err.textContent = t('imp.kb.chooseSpace'); err.hidden = false; return; }
      start.disabled = true;
      try {
        await api.admin.importKbStart(apiSource(), connection(), chosen.map((s) => ({ key: s.key, name: s.name, projectId: s.projectId, count: s.count, language: s.language })), opts);
        conn = emptyConn(); csvInfo = null; zipInfo = null; connInfo = { user: '', server: {} };
        progressStep(body);
      } catch (e) { toast(e.message, 'error'); start.disabled = false; }
    },
  }, icon('download'), t('imp.kb.start'));
  const langCol = spaces.some((x) => (x.languages || []).length > 1);
  mount(body,
    header(1, 'kb'),
    h('section.panel',
      h('p', info.type === 'confluence-zip' ? t('imp.zip.spaces', { name: zipInfo?.name || '' }) : t('imp.kb.connectedAs', { user: info.user || '—', server: `${info.server.title || ''} ${info.server.version || ''}`.trim() || conn.baseUrl })),
      err,
      spaces.length ? h('table.data',
        h('thead', h('tr', h('th', h('input', { type: 'checkbox', 'aria-label': t('imp.kb.all'), onchange: (e) => { spaces.forEach((s) => { s.selected = e.target.checked; }); rows.forEach((r) => { r.querySelector('input').checked = e.target.checked; }); } })),
          h('th', t(`imp.kb.spaceName.${source}`)), h('th.num', t('imp.kb.count')), h('th', t('imp.kb.targetProject')), langCol ? h('th', t('imp.kb.language')) : null)),
        h('tbody', rows)) : h('p.muted', t('imp.kb.noSpaces')),
      h('h3', t('imp.options')),
      check('drafts', t('imp.kb.optDrafts'), t('imp.kb.optDraftsHint')),
      check('attachments', t('imp.kb.optFiles')),
      field(t('imp.maxMb'), (() => { const i = h('input', { type: 'number', min: 1, max: 1024, value: opts.maxAttachmentMb, style: { width: '120px' } }); i.addEventListener('input', () => { opts.maxAttachmentMb = Number(i.value) || 50; }); return i; })()),
      h('div.hint-box', icon('info'), h('div', h('p', t('imp.kb.hintWhat')), h('p', t(`imp.kb.hintVis.${source}`)), h('p', t('imp.kb.hintRepeat')), h('p', t('imp.hintNoMail')))),
      h('div.form-actions', h('button.btn.btn-subtle', { type: 'button', onclick: () => connectStep(body) }, t('imp.back')), start)));
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
        // The server has what it needs: the access data does not stay in page memory
        conn = emptyConn(); csvInfo = null; connInfo = { user: '', server: {} };
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
  const kb = job.what === 'kb';
  return h('div',
    h('p', h('strong', t(`imp.state.${job.state}`)), job.kind ? h('span.muted', ` · ${t(`imp.src.${job.kind}`)}`) : null, job.current ? ` · ${job.current}` : ''),
    job.projects.map((p) => {
      const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : (p.state === 'done' ? 100 : 0);
      return h('div.progress-row',
        h('div.progress-label', `${named ? (p.name || p.key) : p.key} → `, h('a', { href: kb ? `/kb?project=${encodeURIComponent(p.targetKey)}` : `/issues?project=${p.targetKey}`, 'data-link': '' }, p.targetKey), h('span.muted', ` ${p.done}${p.total ? ` / ${p.total}` : ''}`)),
        h('div.progress', h('div.progress-bar', { style: { width: `${pct}%` } })));
    }),
    h('p.muted', t(kb ? 'imp.kb.counts' : 'imp.counts', c)),
    job.errors.length ? h('details', h('summary', t('imp.errors', { n: job.errors.length })), h('ul.error-list', job.errors.slice(-50).map((e) => h('li.mono', e)))) : null);
}

async function progressStep(body) {
  clearTimeout(pollTimer);
  const { job } = await api.admin.importStatus();
  if (!job) return connectStep(body);
  const running = job.state === 'running';
  mount(body,
    header(job.what === 'kb' ? 2 : 3, job.what === 'kb' ? 'kb' : 'tickets'),
    h('section.panel',
      summary(job),
      h('div.form-actions',
        running
          ? h('button.btn', { type: 'button', disabled: job.cancelRequested, onclick: async () => { await api.admin.importCancel(); progressStep(body); } }, t('imp.cancel'))
          : [job.what === 'kb'
            ? h('a.btn.btn-primary', { href: `/kb?project=${encodeURIComponent(job.projects[0]?.targetKey || '')}`, 'data-link': '' }, t('imp.kb.toKb'))
            : h('a.btn.btn-primary', { href: `/board?project=${job.projects[0]?.targetKey || ''}`, 'data-link': '' }, t('imp.toBoard')),
          h('button.btn', { type: 'button', onclick: () => { conn = emptyConn(); csvInfo = null; connectStep(body, job); } }, t('imp.again'))])));
  if (running && document.body.contains(body)) pollTimer = setTimeout(() => progressStep(body), 1500);
  else if (!running) reloadBase().catch(() => {});
}
