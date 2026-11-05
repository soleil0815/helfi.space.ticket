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
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new CustomEvent('helfi:unauthorized'));
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

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap'),
  setup: (d) => request('POST', '/api/setup', d),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),
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

  stats: () => request('GET', '/api/stats'),
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
  kbCommentAdd: (id, body) => request('POST', `/api/kb/${id}/comments`, { body }),
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
  // attachmentIds: draft uploads (draft=file) that belong to this comment (mobile UI)
  comment: (key, body, internal, attachmentIds) => request('POST', `/api/tickets/${encodeURIComponent(key)}/comments`, attachmentIds?.length ? { body, internal, attachmentIds } : { body, internal }),
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
  descriptionVersion: (key, id) => request('GET', `/api/tickets/${encodeURIComponent(key)}/description-versions/${id}`),
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
    system: () => request('GET', '/api/admin/system'),
    backup: () => request('POST', '/api/admin/backup'),
    deleteBackup: (name) => request('DELETE', `/api/admin/backups/${encodeURIComponent(name)}`),
    brandLogo: (data) => request('PUT', '/api/admin/brand/logo', { data }),
    brandLogoRemove: () => request('DELETE', '/api/admin/brand/logo'),
    jiraConnect: (connection) => request('POST', '/api/admin/import/jira/connect', { connection }),
    jiraInspect: (connection, projects) => request('POST', '/api/admin/import/jira/inspect', { connection, projects }),
    jiraStart: (connection, projects, statusMap, typeMap, options) => request('POST', '/api/admin/import/jira/start', { connection, projects, statusMap, typeMap, options }),
    importStatus: () => request('GET', '/api/admin/import/status'),
    importCancel: () => request('POST', '/api/admin/import/cancel'),
  },
};
