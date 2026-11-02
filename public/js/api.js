// Zugriff auf die Helfi.Space-API.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
  }
}

async function request(method, url, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-Helfi-Request': '1', Accept: 'application/json' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
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
  ticket: (key) => request('GET', `/api/tickets/${encodeURIComponent(key)}`),
  createTicket: (d) => request('POST', '/api/tickets', d),
  updateTicket: (key, d) => request('PATCH', `/api/tickets/${encodeURIComponent(key)}`, d),
  bulk: (d) => request('POST', '/api/tickets/bulk', d),
  comment: (key, body, internal) => request('POST', `/api/tickets/${encodeURIComponent(key)}/comments`, { body, internal }),
  upload: (key, files, { draft = false } = {}) => {
    const fd = new FormData();
    if (draft) fd.append('draft', '1');
    for (const f of files) fd.append('files', f, f.name);
    return request('POST', `/api/tickets/${encodeURIComponent(key)}/attachments`, fd);
  },
  deleteAttachment: (id) => request('DELETE', `/api/attachments/${id}`),
  people: (q) => request('GET', `/api/people${qs({ q })}`),
  reports: (f) => request('GET', `/api/reports${qs(f)}`),
  canned: {
    list: () => request('GET', '/api/canned'),
    create: (d) => request('POST', '/api/canned', d),
    update: (id, d) => request('PATCH', `/api/canned/${id}`, d),
    remove: (id) => request('DELETE', `/api/canned/${id}`),
  },
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
    brandLogo: (data) => request('PUT', '/api/admin/brand/logo', { data }),
    brandLogoRemove: () => request('DELETE', '/api/admin/brand/logo'),
    jiraConnect: (connection) => request('POST', '/api/admin/import/jira/connect', { connection }),
    jiraInspect: (connection, projects) => request('POST', '/api/admin/import/jira/inspect', { connection, projects }),
    jiraStart: (connection, projects, statusMap, typeMap, options) => request('POST', '/api/admin/import/jira/start', { connection, projects, statusMap, typeMap, options }),
    importStatus: () => request('GET', '/api/admin/import/status'),
    importCancel: () => request('POST', '/api/admin/import/cancel'),
  },
};
