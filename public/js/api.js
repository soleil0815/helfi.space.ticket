// Access to the Helfi.Space API.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.detail = body?.error?.detail;
  }
}

async function request(method, url, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-Helfi-Request': '1', Accept: 'application/json' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    // /api/session/*: idle.js handles the 401 itself (marks "signed out for inactivity" first)
    if (res.status === 401 && !url.includes('/auth/') && !url.startsWith('/api/session/')) window.dispatchEvent(new CustomEvent('helfi:unauthorized'));
    throw new ApiError(res.status, data);
  }
  return data;
}

const qs = (o = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Tell idle.js about the session of this answer (null = not signed in) */
const announceSession = (session) => window.dispatchEvent(new CustomEvent('helfi:session', { detail: session || null }));

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap').then((b) => { announceSession(b?.user ? b.session : null); return b; }),
  sessionStatus: () => request('GET', '/api/session/status'),
  sessionPing: () => request('POST', '/api/session/ping'),
  setup: (d) => request('POST', '/api/setup', d),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout').finally(() => announceSession(null)),
  register: (data) => request('POST', '/api/auth/register', data),
  confirmRegistration: (token) => request('POST', '/api/auth/register/confirm', { token }),
  forgotPassword: (email, language) => request('POST', '/api/auth/password/forgot', { email, language }),
  resetPassword: (token, password) => request('POST', '/api/auth/password/reset', { token, password }),
  mfaEnrollInfo: () => request('POST', '/api/auth/mfa/enroll'),
  mfaVerify: (code) => request('POST', '/api/auth/mfa', { code }),
  mfaStatus: () => request('GET', '/api/me/mfa'),
  mfaSetup: () => request('POST', '/api/me/mfa/setup'),
  mfaEnable: (code) => request('POST', '/api/me/mfa/enable', { code }),
  mfaDisable: (code) => request('POST', '/api/me/mfa/disable', { code }),
  mfaNewRecovery: (code) => request('POST', '/api/me/mfa/recovery', { code }),
  me: () => request('GET', '/api/me'),
  updateMe: (d) => request('PATCH', '/api/me', d),

  users: (all = false) => request('GET', `/api/users${all ? '?all=1' : ''}`),
  createUser: (d) => request('POST', '/api/users', d),
  updateUser: (id, d) => request('PATCH', `/api/users/${id}`, d),

  projects: (all = false) => request('GET', `/api/projects${all ? '?all=1' : ''}`),
  createProject: (d) => request('POST', '/api/projects', d),
  updateProject: (id, d) => request('PATCH', `/api/projects/${id}`, d),
  deleteProject: (id, d) => request('DELETE', `/api/projects/${id}`, d),
  components: (projectId, all = false) => request('GET', `/api/projects/${projectId}/components${all ? '?all=1' : ''}`),
  createComponent: (projectId, d) => request('POST', `/api/projects/${projectId}/components`, d),
  updateComponent: (id, d) => request('PATCH', `/api/components/${id}`, d),
  deleteComponent: (id) => request('DELETE', `/api/components/${id}`),
  orderComponents: (projectId, ids) => request('POST', `/api/projects/${projectId}/components/order`, { ids }),
  testComponents: (projectId, d) => request('POST', `/api/projects/${projectId}/components/test`, d),
  componentExamples: () => request('GET', '/api/components/examples'),
  addExampleComponents: (projectId, keys, lang) => request('POST', `/api/projects/${projectId}/components/examples`, { keys, lang }),

  stats: () => request('GET', '/api/stats'),
  acceptSuggestion: (key) => request('POST', `/api/tickets/${encodeURIComponent(key)}/component-suggestion/accept`),
  dismissDuplicate: (key) => request('POST', `/api/tickets/${encodeURIComponent(key)}/duplicate-suggestion/dismiss`),
  dismissSuggestion: (key) => request('POST', `/api/tickets/${encodeURIComponent(key)}/component-suggestion/dismiss`),
  filters: () => request('GET', '/api/filters'),
  createFilter: (d) => request('POST', '/api/filters', d),
  updateFilter: (id, d) => request('PATCH', `/api/filters/${id}`, d),
  deleteFilter: (id) => request('DELETE', `/api/filters/${id}`),
  orderFilters: (ids, shared = false) => request('POST', '/api/filters/order', { ids, shared }),
  queues: (project) => request('GET', `/api/queues${qs({ project })}`),
  summary: (project) => request('GET', `/api/summary${qs({ project })}`),
  tickets: (f) => request('GET', `/api/tickets${qs(f)}`),
  link: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/links`, d),
  unlink: (key, id) => request('DELETE', `/api/tickets/${encodeURIComponent(key)}/links/${id}`),
  saveFields: (key, d) => request('PATCH', `/api/tickets/${encodeURIComponent(key)}/fields`, d),
  createProblem: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/problem`, d),
  knownErrors: () => request('GET', '/api/known-errors'),
  changeTransition: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/change/transition`, d),
  changeLateApproval: (key) => request('POST', `/api/tickets/${encodeURIComponent(key)}/change/request-approval`),
  decideApproval: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/approval`, d),
  changeCalendar: (f) => request('GET', `/api/changes/calendar${qs(f)}`),
  changeTemplates: () => request('GET', '/api/changes/templates'),
  kbImage: (file) => { const fd = new FormData(); fd.append('file', file, file.name || 'bild.png'); return request('POST', '/api/kb/images', fd); },
  kb: (f) => request('GET', `/api/kb${qs(f)}`),
  kbSuggest: (q) => request('GET', `/api/kb/suggest${qs({ q })}`),
  kbArticle: (id, view = false) => request('GET', `/api/kb/${id}${view ? '?view=1' : ''}`),
  kbCreate: (d) => request('POST', '/api/kb', d),
  kbUpdate: (id, d) => request('PUT', `/api/kb/${id}`, d),
  kbDelete: (id) => request('DELETE', `/api/kb/${id}`),
  kbComments: (id) => request('GET', `/api/kb/${id}/comments`),
  kbVote: (id, vote) => request('POST', `/api/kb/${id}/vote`, { vote }),
  kbFeedbackAdd: (id, body) => request('POST', `/api/kb/${id}/feedback`, { body }),
  kbFeedback: (id) => request('GET', `/api/kb/${id}/feedback`),
  kbRatingReset: (id) => request('POST', `/api/kb/${id}/rating/reset`),
  kbCommentAdd: (id, body, format = 'text') => request('POST', `/api/kb/${id}/comments`, { body, format }),
  kbCommentResolve: (cid, resolved) => request('PATCH', `/api/kb/comments/${cid}`, { resolved }),
  kbCommentDelete: (cid) => request('DELETE', `/api/kb/comments/${cid}`),
  kbMove: (id, parentId) => request('PATCH', `/api/kb/${id}/parent`, { parentId }),
  kbTree: () => request('GET', '/api/kb/tree'),
  kbBundle: (id) => request('GET', `/api/kb/${id}/bundle`),
  kbVersions: (id) => request('GET', `/api/kb/${id}/versions`),
  kbVersion: (id, v) => request('GET', `/api/kb/${id}/versions/${v}`),
  kbRestore: (id, v) => request('POST', `/api/kb/${id}/versions/${v}/restore`),
  kbTemplates: () => request('GET', '/api/kb/templates'),
  kbTemplate: (id) => request('GET', `/api/kb/templates/${id}`),
  kbTemplateCreate: (d) => request('POST', '/api/kb/templates', d),
  kbTemplateUpdate: (id, d) => request('PUT', `/api/kb/templates/${id}`, d),
  kbTemplateDelete: (id) => request('DELETE', `/api/kb/templates/${id}`),
  kbDraft: (key) => request('GET', `/api/tickets/${encodeURIComponent(key)}/kb-draft`),
  ratingInfo: (token) => request('GET', `/api/public/rating/${encodeURIComponent(token)}`),
  rate: (token, d) => request('POST', `/api/public/rating/${encodeURIComponent(token)}`, d),
  rateTicket: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/rating`, d),
  itilReport: (f) => request('GET', `/api/reports/itil${qs(f)}`),
  satisfaction: (f) => request('GET', `/api/reports/satisfaction${qs(f)}`),
  cis: (f) => request('GET', `/api/cis${qs(f)}`),
  ci: (id) => request('GET', `/api/cis/${id}`),
  ciCreate: (d) => request('POST', '/api/cis', d),
  ciUpdate: (id, d) => request('PUT', `/api/cis/${id}`, d),
  ciDelete: (id) => request('DELETE', `/api/cis/${id}`),
  ciImport: (csv) => request('POST', '/api/cis/import', { csv }),
  linkCi: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/cis`, d),
  unlinkCi: (key, id) => request('DELETE', `/api/tickets/${encodeURIComponent(key)}/cis/${id}`),
  catalog: (all = false) => request('GET', `/api/catalog${all ? '?all=1' : ''}`),
  catalogItem: (id) => request('GET', `/api/catalog/${id}`),
  catalogCreate: (d) => request('POST', '/api/catalog', d),
  catalogUpdate: (id, d) => request('PUT', `/api/catalog/${id}`, d),
  catalogDelete: (id) => request('DELETE', `/api/catalog/${id}`),
  catalogOrder: (id, answers) => request('POST', `/api/catalog/${id}/order`, { answers }),
  broadcast: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/broadcast`, d),
  createSubtask: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/subtasks`, d),
  ticket: (key) => request('GET', `/api/tickets/${encodeURIComponent(key)}`),
  createTicket: (d) => request('POST', '/api/tickets', d),
  updateTicket: (key, d) => request('PATCH', `/api/tickets/${encodeURIComponent(key)}`, d),
  bulk: (d) => request('POST', '/api/tickets/bulk', d),
  resolveTicket: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/resolve`, d),
  // attachmentIds: draft uploads (draft=file) that belong to this comment (mobile UI)
  // format 'md': written with the formatting toolbar
  comment: (key, body, internal, attachmentIds, format = 'text') => request('POST', `/api/tickets/${encodeURIComponent(key)}/comments`, { body, internal, format, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
  upload: (key, files, { draft = false } = {}) => {
    const fd = new FormData();
    if (draft) fd.append('draft', '1');
    for (const f of files) fd.append('files', f, f.name);
    return request('POST', `/api/tickets/${encodeURIComponent(key)}/attachments`, fd);
  },
  deleteAttachment: (id) => request('DELETE', `/api/attachments/${id}`),
  discardDraft: (id) => request('DELETE', `/api/attachments/${id}/draft`),
  people: (q, { ad = true } = {}) => request('GET', `/api/people${qs(ad ? { q } : { q, ad: '0' })}`),
  reports: (f) => request('GET', `/api/reports${qs(f)}`),
  canned: {
    list: () => request('GET', '/api/canned'),
    create: (d) => request('POST', '/api/canned', d),
    update: (id, d) => request('PATCH', `/api/canned/${id}`, d),
    remove: (id) => request('DELETE', `/api/canned/${id}`),
  },
  news: () => request('GET', '/api/news'),
  newsSeen: () => request('POST', '/api/news/seen'),
  mentionCandidates: (key, q, internal) => request('GET', `/api/tickets/${encodeURIComponent(key)}/mention-candidates?q=${encodeURIComponent(q || '')}${internal ? '&internal=1' : ''}`),
  linkSuggestions: (keys) => request('GET', `/api/link-suggestions?keys=${encodeURIComponent(keys.join(','))}`),
  aiSummary: (key) => request('GET', `/api/tickets/${encodeURIComponent(key)}/ai/summary`),
  aiSummarize: (key) => request('POST', `/api/tickets/${encodeURIComponent(key)}/ai/summary`),
  aiReply: (key, draft) => request('POST', `/api/tickets/${encodeURIComponent(key)}/ai/reply`, { draft }),
  aiRewrite: (text, mode) => request('POST', '/api/ai/rewrite', { text, mode }),
  aiKb: (d) => request('POST', '/api/ai/kb', d),
  aiKbDraft: (key) => request('POST', `/api/tickets/${encodeURIComponent(key)}/ai/kb-draft`),
  descriptionVersion: (key, id) => request('GET', `/api/tickets/${encodeURIComponent(key)}/description-versions/${id}`),
  examples: (kind) => request('GET', `/api/examples/${encodeURIComponent(kind)}`),
  takeExamples: (kind, keys, lang) => request('POST', `/api/examples/${encodeURIComponent(kind)}`, { keys, lang }),
  componentSuggestions: (project) => request('GET', `/api/component-suggestions${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  decideSuggestions: (keys, action) => request('POST', '/api/component-suggestions/decide', { keys, action }),
  setReporter: (key, reporter, notify = true) => request('PUT', `/api/tickets/${encodeURIComponent(key)}/reporter`, { reporter, notify }),
  addParticipant: (key, d) => request('POST', `/api/tickets/${encodeURIComponent(key)}/participants`, d),
  removeParticipant: (key, userId) => request('DELETE', `/api/tickets/${encodeURIComponent(key)}/participants/${userId}`),

  admin: {
    settings: () => request('GET', '/api/admin/settings'),
    saveSettings: (settings) => request('PUT', '/api/admin/settings', { settings }),
    mfaNetwork: () => request('GET', '/api/admin/mfa/network'),
    suppressions: () => request('GET', '/api/admin/mail/suppressions'),
    releaseSuppression: (address) => request('DELETE', `/api/admin/mail/suppressions/${encodeURIComponent(address)}`),
    fetchCert: (settings) => request('POST', '/api/admin/ldap/fetch-cert', { settings }),
    testLdap: (settings, username, password) => request('POST', '/api/admin/ldap/test', { settings, username, password }),
    testOidc: (settings) => request('POST', '/api/admin/oidc/test', { settings }),
    testImap: (settings) => request('POST', '/api/admin/imap/test', { settings }),
    pollImap: () => request('POST', '/api/admin/imap/poll'),
    testSmtp: (settings, to) => request('POST', '/api/admin/smtp/test', { settings, to }),
    testAi: (settings) => request('POST', '/api/admin/ai/test', { settings }),
    aiModels: (settings) => request('POST', '/api/admin/ai/models', { settings }),
    aiStats: () => request('GET', '/api/admin/ai/stats'),
    backfillPreview: (project, o = {}) => request('GET', `/api/admin/components/backfill?project=${encodeURIComponent(project)}&includeDone=${o.includeDone ? 1 : 0}&retry=${o.retry ? 1 : 0}`),
    backfillStart: (project, o = {}) => request('POST', '/api/admin/components/backfill', { project, ...o }),
    backfillStatus: () => request('GET', '/api/admin/components/backfill/status'),
    backfillCancel: () => request('POST', '/api/admin/components/backfill/cancel'),
    system: () => request('GET', '/api/admin/system'),
    backup: () => request('POST', '/api/admin/backup'),
    deleteBackup: (name) => request('DELETE', `/api/admin/backups/${encodeURIComponent(name)}`),
    backupDownloadUrl: (name) => `/api/admin/backups/${encodeURIComponent(name)}/download`,
    brandLogo: (data) => request('PUT', '/api/admin/brand/logo', { data }),
    brandLogoRemove: () => request('DELETE', '/api/admin/brand/logo'),
    importConnect: (source, connection) => request('POST', `/api/admin/import/${source}/connect`, { connection }),
    importInspect: (source, connection, projects) => request('POST', `/api/admin/import/${source}/inspect`, { connection, projects }),
    importStart: (source, connection, projects, statusMap, typeMap, options) => request('POST', `/api/admin/import/${source}/start`, { connection, projects, statusMap, typeMap, options }),
    importCsvUpload: (file) => { const fd = new FormData(); fd.append('file', file, file.name || 'import.csv'); return request('POST', '/api/admin/import/csv/upload', fd); },
    importStatus: () => request('GET', '/api/admin/import/status'),
    importCancel: () => request('POST', '/api/admin/import/cancel'),
  },
};
