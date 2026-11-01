// Administration: Allgemein, Projekte, Benutzer, Active Directory, SSO, E-Mail, System
import { api } from '../api.js';
import { h, mount, icon, avatar, field, select, toast, modal, fmtDate, relTime, fmtSize } from '../dom.js';
import { t } from '../i18n.js';
import { state, reloadBase } from '../app.js';
import { importPage } from './import.js';

const SECTIONS = [
  ['general', 'admin.general', 'settings'],
  ['security', 'admin.security', 'shield'],
  ['projects', 'admin.projects', 'board'],
  ['users', 'admin.users', 'users'],
  ['ldap', 'admin.ldap', 'server'],
  ['sso', 'admin.sso', 'key'],
  ['mail', 'admin.mail', 'mail'],
  ['import', 'admin.import', 'download'],
  ['system', 'admin.system', 'info'],
];

export async function renderAdmin(content, section) {
  if (!SECTIONS.some(([id]) => id === section)) section = 'general';
  const body = h('div.admin-body', h('div.loading', t('app.loading')));
  mount(content,
    h('div.page-head', h('h1', t('admin.title'))),
    h('div.admin',
      h('nav.admin-nav', SECTIONS.map(([id, label, ic]) => h('a', { href: `/admin/${id}`, 'data-link': '', class: id === section ? 'active' : '' }, icon(ic), t(label)))),
      body));

  if (section === 'projects') return projectsPage(body);
  if (section === 'users') return usersPage(body);
  if (section === 'system') return systemPage(body);
  if (section === 'import') return importPage(body);

  const { settings, redirectUri } = await api.admin.settings();
  const s = { ...settings };
  const pages = { general: generalPage, security: securityPage, ldap: ldapPage, sso: ssoPage, mail: mailPage };
  pages[section](body, s, { redirectUri });
}

// ---------- Formular-Bausteine (an Arbeitskopie s gebunden) ----------
function bindInput(s, key, attrs = {}) {
  const el = h('input', { value: s[key] ?? '', ...attrs });
  el.addEventListener('input', () => { s[key] = attrs.type === 'number' ? Number(el.value) : el.value; });
  return el;
}
function bindCheck(s, key, onChange) {
  const el = h('input', { type: 'checkbox', checked: !!s[key] });
  el.addEventListener('change', () => { s[key] = el.checked; onChange?.(el.checked); });
  return el;
}
function bindSelect(s, key, options, onChange) {
  const el = select(options, s[key]);
  el.addEventListener('change', () => { s[key] = el.value; onChange?.(el.value); });
  return el;
}
function pick(s, prefix) {
  return Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith(prefix)));
}
async function saveKeys(s, prefixes) {
  const payload = {};
  for (const p of prefixes) Object.assign(payload, pick(s, p));
  try {
    const r = await api.admin.saveSettings(payload);
    Object.assign(s, r.settings);
    toast(t('app.saved'), 'success');
    state.boot = await api.bootstrap();
    return true;
  } catch (e) { toast(e.message, 'error'); return false; }
}
const saveBar = (onSave, ...extra) => h('div.form-actions', h('button.btn.btn-primary', { type: 'button', onclick: onSave }, t('app.save')), ...extra);
const result = () => h('div.test-result', { hidden: true });
function showResult(el, ok, ...content) {
  el.hidden = false;
  el.className = `test-result ${ok ? 'ok' : 'fail'}`;
  mount(el, icon(ok ? 'check' : 'warning'), h('div', ...content));
}

// ---------- Allgemein ----------
function generalPage(body, s) {
  mount(body,
    h('section.panel',
      h('h2', t('admin.general')),
      field(t('general.title'), bindInput(s, 'general.title', { maxLength: 60 })),
      field(t('general.defaultProject'), bindSelect(s, 'general.defaultProject', [['', '—'], ...state.projects.map((p) => [p.key, `${p.name} (${p.key})`])]), t('general.defaultProjectHint')),
      field(t('general.defaultLanguage'), bindSelect(s, 'general.defaultLanguage', [['de', 'Deutsch'], ['en', 'English']]), t('general.defaultLanguageHint')),
      field(t('general.allowSelfService'), bindCheck(s, 'general.allowSelfService')),
      saveBar(() => saveKeys(s, ['general.']))));
}

// ---------- Sicherheit (2FA) ----------
async function securityPage(body, s) {
  const st = await api.mfaStatus();
  mount(body,
    h('section.panel',
      h('h2', t('mfa.adminTitle')),
      h('p.muted', t('mfa.adminIntro')),
      field(t('mfa.mode'), bindSelect(s, 'mfa.mode', [['external', t('mfa.mode.external')], ['always', t('mfa.mode.always')], ['off', t('mfa.mode.off')]])),
      field(t('mfa.networks'), (() => { const ta = h('textarea.mono', { rows: 3 }); ta.value = s['mfa.internalNetworks']; ta.addEventListener('input', () => { s['mfa.internalNetworks'] = ta.value; }); return ta; })(), t('mfa.networksHint')),
      h('div.hint-box', icon(st.network.internal ? 'check' : 'globe'), h('div',
        h('p', t(st.network.internal ? 'mfa.youAreInternal' : 'mfa.youAreExternal', { ip: st.network.ip })),
        st.network.reason === 'untrustedProxy' ? h('p', t('mfa.reason.untrustedProxy')) : null,
        st.network.reason === 'dockerGateway' ? h('p', t('mfa.reason.dockerGateway')) : null)),
      field(t('mfa.enrollExternal'), bindCheck(s, 'mfa.enrollExternal'), t('mfa.enrollExternalHint')),
      field(t('mfa.trustSso'), bindCheck(s, 'mfa.trustSso'), t('mfa.trustSsoHint')),
      saveBar(() => saveKeys(s, ['mfa.']))));
}

// ---------- Projekte ----------
async function projectsPage(body) {
  const { projects } = await api.projects(true);
  const { users } = await api.users();
  const newForm = () => {
    const key = h('input', { required: true, maxLength: 10, style: { textTransform: 'uppercase' } });
    const name = h('input', { required: true });
    const desc = h('textarea', { rows: 3 });
    const lead = select([['', '—'], ...users.map((u) => [u.id, u.displayName])], state.user.id);
    const dlg = modal(t('projects.new'), h('form#proj-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api.createProject({ key: key.value.trim().toUpperCase(), name: name.value.trim(), description: desc.value, leadId: lead.value || null });
          dlg.close(); await reloadBase(); projectsPage(body);
        } catch (ex) { toast(ex.message, 'error'); }
      },
    }, h('div.grid-2', field(t('projects.key'), key, t('setup.projectKeyHint')), field(t('projects.name'), name)), field(t('projects.description'), desc), field(t('projects.lead'), lead)),
    { footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), h('button.btn.btn-primary', { type: 'submit', form: 'proj-form' }, t('app.create'))] });
  };
  mount(body, h('section.panel',
    h('div.section-head', h('h2', t('admin.projects')), h('button.btn.btn-primary', { type: 'button', onclick: newForm }, icon('plus'), t('projects.new'))),
    h('table.data',
      h('thead', h('tr', h('th', t('projects.key')), h('th', t('projects.name')), h('th', t('projects.lead')), h('th', t('projects.openTickets')), h('th', ''))),
      h('tbody', projects.map((p) => h('tr', { class: p.archived ? 'muted' : '' },
        h('td', h('span.project-avatar.small', p.key.slice(0, 2)), ' ', h('strong', p.key)),
        h('td', h('input.input-inline', { value: p.name, onchange: async (e) => { await api.updateProject(p.id, { name: e.target.value }); await reloadBase(); toast(t('app.saved'), 'success'); } })),
        h('td', select([['', '—'], ...users.map((u) => [u.id, u.displayName])], p.leadId || '', { class: 'select-sm', onchange: async (e) => { await api.updateProject(p.id, { leadId: e.target.value || null }); toast(t('app.saved'), 'success'); } })),
        h('td', String(p.openCount ?? '')),
        h('td', h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => { await api.updateProject(p.id, { archived: !p.archived }); await reloadBase(); projectsPage(body); } }, p.archived ? t('projects.unarchive') : t('projects.archive')))))))));
}

// ---------- Benutzer ----------
async function usersPage(body, showContacts = false) {
  const { users } = await api.users(true);
  const list = users.filter((u) => showContacts || u.source !== 'email');
  const update = async (u, patch) => {
    try { await api.updateUser(u.id, patch); toast(t('app.saved'), 'success'); await reloadBase(); usersPage(body, showContacts); }
    catch (e) { toast(e.message, 'error'); usersPage(body, showContacts); }
  };
  const newUser = () => {
    const username = h('input', { required: true, autocomplete: 'off' });
    const name = h('input');
    const email = h('input', { type: 'email' });
    const role = select(['user', 'agent', 'admin'].map((r) => [r, t(`role.${r}`)]), 'agent');
    const pw = h('input', { type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
    const dlg = modal(t('users.new'), h('form#user-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try { await api.createUser({ username: username.value.trim(), displayName: name.value.trim(), email: email.value.trim(), role: role.value, password: pw.value }); dlg.close(); await reloadBase(); usersPage(body, showContacts); }
        catch (ex) { toast(ex.message, 'error'); }
      },
    }, h('div.grid-2', field(t('users.username'), username), field(t('users.displayName'), name)), h('div.grid-2', field(t('users.email'), email), field(t('users.role'), role)), field(t('setup.password'), pw)),
    { footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), h('button.btn.btn-primary', { type: 'submit', form: 'user-form' }, t('app.create'))] });
  };
  const setPw = (u) => {
    const pw = h('input', { type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
    const dlg = modal(`${t('users.resetPassword')}: ${u.username}`, h('form#pw-form', { onsubmit: async (e) => { e.preventDefault(); dlg.close(); await update(u, { password: pw.value }); } }, field(t('setup.password'), pw)),
      { footer: [h('span.spacer'), h('button.btn.btn-primary', { type: 'submit', form: 'pw-form' }, t('app.save'))] });
  };
  const contactsToggle = h('input', { type: 'checkbox', checked: showContacts, onchange: (e) => usersPage(body, e.target.checked) });
  mount(body, h('section.panel',
    h('div.section-head', h('h2', t('admin.users')), h('button.btn.btn-primary', { type: 'button', onclick: newUser }, icon('plus'), t('users.new'))),
    h('p.muted', t('users.hint')),
    h('label.check-inline', contactsToggle, t('users.showContacts')),
    h('table.data',
      h('thead', h('tr', h('th', t('users.displayName')), h('th', t('users.username')), h('th', t('users.source')), h('th', t('users.role')), h('th', { title: t('users.roleLockedHint') }, t('users.roleLocked')), h('th', '2FA'), h('th', t('users.lastLogin')), h('th', ''))),
      h('tbody', list.map((u) => h('tr', { class: u.active ? '' : 'muted' },
        h('td.col-person', h('span.person', avatar(u, 'sm'), h('span', u.displayName, u.email ? h('span.muted.block', u.email) : null))),
        h('td', u.username),
        h('td', t(`profile.source.${u.source}`)),
        h('td', select(['user', 'agent', 'admin'].map((r) => [r, t(`role.${r}`)]), u.role, { class: 'select-sm', disabled: u.source === 'email', onchange: (e) => update(u, { role: e.target.value }) })),
        h('td', u.source === 'local' || u.source === 'email' ? '' : h('input', { type: 'checkbox', checked: u.roleLocked, title: t('users.roleLockedHint'), onchange: (e) => update(u, { roleLocked: e.target.checked }) })),
        h('td', u.mfaEnabled ? h('span.badge.badge-ok', { title: t('mfa.statusOn') }, icon('check')) : h('span.muted', '—')),
        h('td', { title: u.lastLogin ? fmtDate(u.lastLogin) : '' }, u.lastLogin ? relTime(u.lastLogin) : '—'),
        h('td.actions-cell',
          u.source === 'local' ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => setPw(u) }, t('users.resetPassword')) : null,
          u.mfaEnabled ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { if (confirm(t('mfa.resetConfirm', { name: u.displayName }))) update(u, { resetMfa: true }); } }, t('mfa.reset')) : null,
          u.id !== state.user.id ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => update(u, { active: !u.active }) }, u.active ? t('users.deactivate') : t('users.activate')) : null)))))));
}

// ---------- Active Directory ----------
function ldapPage(body, s) {
  const certInfo = h('div');
  const fetchResult = result();
  const testResult = result();

  function drawStoredCert() {
    let info = [];
    try { info = JSON.parse(s['ldap.caInfo'] || '[]'); } catch { /* egal */ }
    if (!info.length) return mount(certInfo, h('p.muted', t('ldap.noCert')));
    mount(certInfo, h('div.cert-list', info.map(certCard)));
  }
  function certCard(c) {
    return h('div.cert',
      h('div.cert-subject', icon(c.isCA ? 'shield' : 'file'), h('strong', c.subject), c.isCA ? h('span.badge', t('ldap.isCA')) : null),
      h('div.cert-row', h('span.muted', `${t('ldap.issuer')}: `), c.issuer),
      h('div.cert-row', h('span.muted', `${t('ldap.validTo')}: `), fmtDate(c.validTo, false)),
      h('div.cert-row.mono', h('span.muted', `${t('ldap.fingerprint')}: `), c.fingerprint256));
  }

  const portInput = bindInput(s, 'ldap.port', { type: 'number', min: 1, max: 65535 });
  const security = bindSelect(s, 'ldap.security', ['ldaps', 'starttls', 'none'].map((v) => [v, t(`ldap.sec.${v}`)]), (v) => {
    s['ldap.port'] = v === 'ldaps' ? 636 : 389;
    portInput.value = s['ldap.port'];
  });

  const fetchBtn = h('button.btn', {
    type: 'button',
    onclick: async () => {
      fetchBtn.disabled = true;
      try {
        const r = await api.admin.fetchCert(pick(s, 'ldap.'));
        if (!r.ok) return showResult(fetchResult, false, r.error);
        showResult(fetchResult, true,
          h('p', t('ldap.fetchCertHint')),
          h('div.cert-list', r.chain.map(certCard)),
          h('button.btn.btn-primary', {
            type: 'button',
            onclick: async () => {
              s['ldap.caPem'] = r.pem;
              s['ldap.tlsMode'] = 'pinned';
              tlsMode.value = 'pinned';
              if (await saveKeys(s, ['ldap.'])) { fetchResult.hidden = true; drawStoredCert(); }
            },
          }, icon('check'), t('ldap.acceptCert')));
      } finally { fetchBtn.disabled = false; }
    },
  }, icon('download'), t('ldap.fetchCert'));

  const tlsMode = bindSelect(s, 'ldap.tlsMode', ['pinned', 'system', 'insecure'].map((v) => [v, t(`ldap.tls.${v}`)]));
  const pem = h('textarea.mono', { rows: 5, placeholder: '-----BEGIN CERTIFICATE-----' });
  const pemBox = h('details', h('summary', t('ldap.pastePem')), pem,
    h('button.btn.btn-subtle', { type: 'button', onclick: async () => { s['ldap.caPem'] = pem.value; if (await saveKeys(s, ['ldap.'])) { pem.value = ''; drawStoredCert(); } } }, t('app.save')));

  const testUser = h('input', { placeholder: t('login.username'), autocomplete: 'off' });
  const testPw = h('input', { type: 'password', placeholder: t('login.password'), autocomplete: 'new-password' });
  const baseDnInput = bindInput(s, 'ldap.baseDn', { placeholder: 'DC=firma,DC=local' });
  const testBtn = h('button.btn', {
    type: 'button',
    onclick: async () => {
      testBtn.disabled = true;
      try {
        const r = await api.admin.testLdap(pick(s, 'ldap.'), testUser.value, testPw.value);
        const lines = r.steps.map((st) => h('li', { class: st.ok ? 'ok' : 'fail' }, icon(st.ok ? 'check' : 'warning'),
          t(`ldap.step.${st.key}`, { value: st.value }),
          st.key === 'search' ? ` (${st.count}${st.count >= 5 ? '+' : ''})` : '',
          st.key === 'group' && st.dn ? h('span.muted.block.mono', st.dn) : null,
          st.key === 'user' && st.user ? h('span.muted.block', `${st.user.displayName} <${st.user.email}> – admin: ${st.user.groups.admin ? '✓' : '–'}, agent: ${st.user.groups.agent ? '✓' : '–'}, user: ${st.user.groups.user ? '✓' : '–'}`) : null,
          st.message ? h('span.block', st.message) : null));
        const extras = [];
        if (!s['ldap.baseDn'] && r.rootDse?.defaultNamingContext) {
          s['ldap.baseDn'] = r.rootDse.defaultNamingContext;
          baseDnInput.value = s['ldap.baseDn'];
          extras.push(h('p', t('ldap.baseDnFound', { dn: s['ldap.baseDn'] })));
        }
        if (r.domainCAs?.length && s['ldap.tlsMode'] === 'pinned') {
          extras.push(h('p', t('ldap.domainCAs', { n: r.domainCAs.length })), h('div.cert-list', r.domainCAs.map(certCard)),
            h('button.btn', {
              type: 'button',
              onclick: async () => { s['ldap.caPem'] = `${s['ldap.caPem'] || ''}\n${r.domainCaPem}`; if (await saveKeys(s, ['ldap.'])) drawStoredCert(); },
            }, icon('shield'), t('ldap.addDomainCAs')));
        }
        showResult(testResult, r.ok, h('ul.steps', lines), ...extras);
      } catch (e) { showResult(testResult, false, e.message); }
      finally { testBtn.disabled = false; }
    },
  }, icon('check'), t('ldap.test'));

  mount(body,
    h('section.panel',
      h('h2', t('admin.ldap')),
      h('p.muted', t('ldap.intro')),
      field(t('ldap.enabled'), bindCheck(s, 'ldap.enabled'))),
    h('section.panel',
      h('h3', t('ldap.server')),
      h('div.grid-3', field(t('ldap.host'), bindInput(s, 'ldap.host', { placeholder: 'dc01.firma.local' }), t('ldap.hostHint')), field(t('ldap.security'), security), field(t('ldap.port'), portInput))),
    h('section.panel',
      h('h3', t('ldap.certificate')),
      h('div.grid-2', field(t('ldap.tlsMode'), tlsMode), h('div', field(t('ldap.verifyHostname'), bindCheck(s, 'ldap.verifyHostname')))),
      h('div.cert-actions', fetchBtn, h('span.muted.small', t('ldap.fetchCertHint'))),
      fetchResult,
      h('h4', t('ldap.certStored')),
      certInfo,
      pemBox),
    h('section.panel',
      h('h3', t('ldap.directory')),
      field(t('ldap.baseDn'), baseDnInput, t('ldap.baseDnHint')),
      h('div.grid-2',
        field(t('ldap.bindDn'), bindInput(s, 'ldap.bindDn', { autocomplete: 'off' }), t('ldap.bindDnHint')),
        field(t('ldap.bindPassword'), bindInput(s, 'ldap.bindPassword', { type: 'password', autocomplete: 'new-password' }))),
      h('details',
        h('summary', t('ldap.userFilter')),
        field(t('ldap.userFilter'), bindInput(s, 'ldap.userFilter', { class: 'mono' })),
        h('div.grid-3', bindInput(s, 'ldap.usernameAttr'), bindInput(s, 'ldap.displayNameAttr'), bindInput(s, 'ldap.emailAttr')),
        h('div.hint', t('ldap.attributes')))),
    h('section.panel',
      h('h3', t('ldap.groups')),
      h('p.muted', t('ldap.groupsHint')),
      h('div.grid-3',
        field(t('ldap.adminGroup'), bindInput(s, 'ldap.adminGroup', { placeholder: 'Helfi-Admins' })),
        field(t('ldap.agentGroup'), bindInput(s, 'ldap.agentGroup', { placeholder: 'Helfi-Bearbeiter' })),
        field(t('ldap.userGroup'), bindInput(s, 'ldap.userGroup', { placeholder: '' }), t('ldap.userGroupHint'))),
      field(t('ldap.nestedGroups'), bindCheck(s, 'ldap.nestedGroups'))),
    h('section.panel',
      h('h3', t('ldap.test')),
      h('div.grid-3', field(t('ldap.testUser'), testUser), field(t('login.password'), testPw), h('div.field.field-btn', testBtn)),
      testResult),
    saveBar(() => saveKeys(s, ['ldap.'])));
  drawStoredCert();
}

// ---------- SSO ----------
function ssoPage(body, s, { redirectUri }) {
  const res = result();
  const copy = h('button.btn-icon', { type: 'button', title: t('ticket.copyLink'), onclick: () => navigator.clipboard?.writeText(redirectUri).then(() => toast(t('ticket.linkCopied'))) }, icon('copy'));
  mount(body,
    h('section.panel',
      h('h2', t('admin.sso')),
      h('p.muted', t('sso.intro')),
      field(t('sso.enabled'), bindCheck(s, 'oidc.enabled')),
      h('div.field', h('label', t('sso.redirectUri')), h('div.copy-field', h('code', redirectUri), copy)),
      field(t('sso.issuer'), bindInput(s, 'oidc.issuer', { placeholder: 'https://login.microsoftonline.com/…/v2.0' }), t('sso.issuerHint')),
      h('div.grid-2', field(t('sso.clientId'), bindInput(s, 'oidc.clientId', { autocomplete: 'off' })), field(t('sso.clientSecret'), bindInput(s, 'oidc.clientSecret', { type: 'password', autocomplete: 'new-password' }))),
      h('div.grid-2', field(t('sso.buttonLabel'), bindInput(s, 'oidc.buttonLabel')), field(t('sso.scopes'), bindInput(s, 'oidc.scopes'))),
      h('div.grid-2', field(t('sso.usernameClaim'), bindInput(s, 'oidc.usernameClaim')), field(t('sso.groupsClaim'), bindInput(s, 'oidc.groupsClaim'))),
      field(t('sso.mergeDomain'), bindInput(s, 'oidc.mergeDomain', { placeholder: 'firma.local' }), t('sso.mergeDomainHint')),
      h('div.grid-2', field(t('sso.adminGroup'), bindInput(s, 'oidc.adminGroup'), t('sso.groupHint')), field(t('sso.agentGroup'), bindInput(s, 'oidc.agentGroup'))),
      field(t('sso.allowCreate'), bindCheck(s, 'oidc.allowCreate')),
      field(t('sso.autoRedirect'), bindCheck(s, 'oidc.autoRedirect')),
      res),
    saveBar(() => saveKeys(s, ['oidc.']), h('button.btn', {
      type: 'button',
      onclick: async () => {
        const r = await api.admin.testOidc(pick(s, 'oidc.'));
        showResult(res, r.ok, r.ok ? t('sso.testOk', { issuer: r.issuer }) : r.error);
      },
    }, t('app.test'))));
}

// ---------- E-Mail ----------
async function mailPage(body, s) {
  const imapRes = result();
  const smtpRes = result();
  const status = h('div.muted.small');
  const drawStatus = (st) => {
    if (!st?.lastRun) return mount(status, '');
    const r = st.lastResult || {};
    mount(status, `${t('mail.lastRun')}: ${relTime(st.lastRun)} – ${t('mail.result', { tickets: r.tickets ?? 0, comments: r.comments ?? 0, skipped: r.skipped ?? 0, errors: r.errors ?? 0 })}`,
      st.lastPurge ? h('span.block', t('mail.lastPurge', { when: relTime(st.lastPurge.at), count: st.lastPurge.deleted })) : null,
      st.lastError ? h('span.block.error-text', st.lastError) : null);
  };
  api.admin.system().then((sys) => drawStatus(sys.imap)).catch(() => {});

  const imapPort = bindInput(s, 'imap.port', { type: 'number' });
  const smtpPort = bindInput(s, 'smtp.port', { type: 'number' });
  const testTo = h('input', { type: 'email', value: state.user.email || '' });

  mount(body,
    h('section.panel',
      h('h2', t('mail.incoming')),
      h('p.muted', t('mail.incomingIntro')),
      field(t('mail.imapEnabled'), bindCheck(s, 'imap.enabled')),
      h('div.grid-3',
        field(t('mail.host'), bindInput(s, 'imap.host', { placeholder: 'mail.firma.local' })),
        field(t('mail.security'), bindSelect(s, 'imap.security', ['tls', 'starttls', 'none'].map((v) => [v, t(`mail.sec.${v}`)]), (v) => { s['imap.port'] = v === 'tls' ? 993 : 143; imapPort.value = s['imap.port']; })),
        field(t('mail.port'), imapPort)),
      h('div.grid-2', field(t('mail.user'), bindInput(s, 'imap.user', { autocomplete: 'off', placeholder: 'helpdesk@firma.local' })), field(t('mail.password'), bindInput(s, 'imap.password', { type: 'password', autocomplete: 'new-password' }))),
      h('div.grid-3',
        field(t('mail.folder'), bindInput(s, 'imap.folder')),
        field(t('mail.processedFolder'), bindInput(s, 'imap.processedFolder', { placeholder: 'Helfi' }), t('mail.processedFolderHint')),
        field(t('mail.interval'), bindInput(s, 'imap.intervalSec', { type: 'number', min: 15 }))),
      h('div.grid-2',
        field(t('mail.project'), bindSelect(s, 'imap.project', [['', '—'], ...state.projects.map((p) => [p.key, `${p.name} (${p.key})`])])),
        h('div', field(t('mail.verifyTls'), bindCheck(s, 'imap.verifyTls')))),
      h('div.grid-2',
        field(t('mail.keepDays'), bindInput(s, 'imap.processedKeepDays', { type: 'number', min: 0, step: 1 }), t('mail.keepDaysHint')),
        h('div', field(t('mail.adLookup'), bindCheck(s, 'imap.adLookup'), t('mail.adLookupHint')))),
      field(t('mail.ccParticipants'), bindCheck(s, 'imap.ccParticipants'), t('mail.ccParticipantsHint')),
      imapRes,
      status,
      saveBar(() => saveKeys(s, ['imap.']),
        h('button.btn', { type: 'button', onclick: async () => { const r = await api.admin.testImap(pick(s, 'imap.')); showResult(imapRes, r.ok, r.ok ? t('mail.testOk', r) : r.error); } }, t('app.test')),
        h('button.btn', { type: 'button', onclick: async () => { const r = await api.admin.pollImap(); drawStatus(r.status); } }, icon('refresh'), t('mail.pollNow')))),
    h('section.panel',
      h('h2', t('mail.outgoing')),
      h('p.muted', t('mail.outgoingIntro')),
      field(t('mail.smtpEnabled'), bindCheck(s, 'smtp.enabled')),
      h('div.grid-3',
        field(t('mail.host'), bindInput(s, 'smtp.host', { placeholder: 'mail.firma.local' })),
        field(t('mail.security'), bindSelect(s, 'smtp.security', ['starttls', 'tls', 'none'].map((v) => [v, t(`mail.sec.${v}`)]), (v) => { s['smtp.port'] = v === 'tls' ? 465 : (v === 'starttls' ? 587 : 25); smtpPort.value = s['smtp.port']; })),
        field(t('mail.port'), smtpPort)),
      h('div.grid-2', field(t('mail.user'), bindInput(s, 'smtp.user', { autocomplete: 'off' })), field(t('mail.password'), bindInput(s, 'smtp.password', { type: 'password', autocomplete: 'new-password' }))),
      h('div.grid-2', field(t('mail.from'), bindInput(s, 'smtp.from', { type: 'email', placeholder: 'helpdesk@firma.local' }), t('mail.fromHint')), field(t('mail.fromName'), bindInput(s, 'smtp.fromName'))),
      field(t('mail.verifyTls'), bindCheck(s, 'smtp.verifyTls')),
      h('h3', t('mail.notifications')),
      ['reporterOnCreate', 'reporterOnComment', 'reporterOnDone', 'assignee', 'participantAdded'].map((k) => field(t(`mail.notify.${k}`), bindCheck(s, `notify.${k}`))),
      h('div.grid-2', field(t('mail.testTo'), testTo), h('div.field.field-btn', h('button.btn', {
        type: 'button',
        onclick: async () => { const r = await api.admin.testSmtp(pick(s, 'smtp.'), testTo.value); showResult(smtpRes, r.ok, r.ok ? t('mail.testSent') : r.error); },
      }, icon('mail'), t('mail.sendTest')))),
      smtpRes,
      saveBar(() => saveKeys(s, ['smtp.', 'notify.']))));
}

// ---------- System ----------
async function systemPage(body) {
  const sys = await api.admin.system();
  mount(body,
    sys.warnings.length ? h('section.panel', sys.warnings.map((w) => h('div.banner.banner-warn', icon('warning'), t(`warn.${w.code}`, w)))) : null,
    h('section.panel',
      h('h2', t('system.info')),
      h('dl.kv',
        h('dt', t('app.version')), h('dd', sys.version),
        h('dt', t('system.baseUrl')), h('dd.mono', sys.baseUrl),
        h('dt', t('system.compose')), h('dd', `${sys.composeVersion || '?'} / ${sys.composeVersionExpected}`),
        h('dt', t('system.dbSize')), h('dd', fmtSize(sys.dbSize)),
        h('dt', 'Node.js'), h('dd', sys.node),
        h('dt', ''), h('dd', t('system.counts', sys.counts)))),
    h('section.panel',
      h('div.section-head', h('h2', t('system.backups')),
        h('button.btn', { type: 'button', onclick: async () => { const r = await api.admin.backup(); toast(t('system.backupDone', r), 'success'); systemPage(body); } }, icon('download'), t('system.backupNow'))),
      h('p.muted', t('system.backupHint')),
      sys.backups.length ? h('table.data', h('tbody', sys.backups.map((b) => h('tr', h('td.mono', b.name), h('td', fmtSize(b.size)))))) : h('p.muted', '—')));
}

