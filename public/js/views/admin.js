// Administration: Allgemein, Projekte, Benutzer, Active Directory, SSO, E-Mail, System
import { api } from '../api.js';
import { h, mount, icon, avatar, field, select, toast, modal, fmtDate, relTime, fmtSize } from '../dom.js';
import { t } from '../i18n.js';
import { state, reloadBase, route, navigate } from '../app.js';
import { importPage } from './import.js';
import { templatesPanel } from './canned.js';
import { loginIntro, loginUserLabel } from './auth.js';
import { logoUrl, refreshBrandAssets } from '../brand.js';
import { slaPage } from './sla.js';
import { changeAdminPage } from './change.js';
import { catalogAdminPage } from './catalog.js';

const SECTIONS = [
  ['general', 'admin.general', 'settings'],
  ['security', 'admin.security', 'shield'],
  ['projects', 'admin.projects', 'board'],
  ['users', 'admin.users', 'users'],
  ['ldap', 'admin.ldap', 'server'],
  ['sso', 'admin.sso', 'key'],
  ['mail', 'admin.mail', 'mail'],
  ['sla', 'admin.sla', 'chart'],
  ['change', 'admin.change', 'refresh'],
  ['catalog', 'admin.catalog', 'inbox'],
  ['templates', 'admin.templates', 'comment'],
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
      // Smartphone: Auswahlliste statt Spalte
      select(SECTIONS.map(([id, label]) => [id, t(label)]), section, { class: 'admin-nav-select', 'aria-label': t('admin.section'), onchange: (e) => navigate(`/admin/${e.target.value}`) }),
      body));

  if (section === 'projects') return projectsPage(body);
  if (section === 'users') return usersPage(body);
  if (section === 'system') return systemPage(body);
  if (section === 'import') return importPage(body);
  if (section === 'templates') return mount(body, templatesPanel({ shared: true }));
  if (section === 'catalog') return catalogAdminPage(body);

  const { settings, redirectUri } = await api.admin.settings();
  const s = { ...settings };
  const pages = { general: generalPage, security: securityPage, ldap: ldapPage, sso: ssoPage, mail: mailPage, sla: (b, x) => slaPage(b, x, { saveBar, saveKeys, bindCheck }), change: (b, x) => changeAdminPage(b, x, { saveBar, saveKeys }) };
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
      saveBar(() => saveKeys(s, ['general.']))),
    designPanel(s),
    loginPagePanel(s));
}

// ---------- Erscheinungsbild: Logo, Hauptfarbe, Kopfzeile ----------
const DEFAULT_COLOR = '#0C66E4';
function contrastToWhite(hex) {
  const lum = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
  return 1.05 / (l + 0.05);
}
const validHex = (v) => /^#[0-9a-f]{6}$/i.test(v);

function designPanel(s) {
  const color = () => (validHex(s['brand.color']) ? s['brand.color'] : DEFAULT_COLOR);
  const picker = h('input.color-input', { type: 'color', value: color(), 'aria-label': t('brand.color') });
  const hex = h('input.mono.color-hex', { value: s['brand.color'] || '', placeholder: DEFAULT_COLOR, maxLength: 7, spellcheck: false });
  const contrastInfo = h('div.small');
  const preview = h('div.brand-preview');
  const logoBox = h('div.brand-logo-box');
  const file = h('input', { type: 'file', accept: 'image/png,image/svg+xml,.png,.svg', hidden: true });
  const removeBtn = h('button.btn.btn-subtle', { type: 'button' }, icon('trash'), t('brand.logoRemove'));

  const drawLogo = () => {
    const custom = !!state.boot.brand?.logo;
    mount(logoBox, h('img.brand-logo', { src: logoUrl(), alt: t('brand.logo'), style: { height: '48px' } }),
      h('div.muted.small', custom ? t('brand.logoCustom') : t('brand.logoDefault')));
    removeBtn.hidden = !custom;
  };
  const draw = () => {
    const c = color();
    const ratio = contrastToWhite(c);
    mount(contrastInfo, ratio >= 4.5
      ? h('span.muted', icon('check'), ' ', t('brand.contrastOk', { ratio: ratio.toFixed(1) }))
      : h('div.hint-box.hint-warn', icon('warning'), h('div', t('brand.contrastLow', { ratio: ratio.toFixed(1) }))));
    const dark = ratio < 3;
    const fg = s['brand.header'] === 'color' ? (dark ? '#172B4D' : '#FFFFFF') : 'var(--text)';
    mount(preview,
      h('div.brand-preview-bar', { style: s['brand.header'] === 'color' ? { background: c, color: fg } : {} },
        h('img.brand-logo', { src: logoUrl(), alt: '', style: { height: '22px' } }),
        s['brand.showTitle'] || !state.boot.brand?.logo ? h('strong', s['general.title'] || 'Helfi.Space') : null,
        h('span.brand-preview-btn', { style: s['brand.header'] === 'color' ? { background: fg, color: dark ? '#fff' : c } : { background: c, color: dark ? '#172B4D' : '#fff' } }, t('app.create'))),
      h('div.brand-preview-body',
        h('span.brand-preview-btn', { style: { background: c, color: dark ? '#172B4D' : '#fff' } }, t('app.save')),
        h('span', { style: { color: c } }, t('brand.previewLink'))));
  };
  const setColor = (v) => { s['brand.color'] = v; draw(); };
  picker.addEventListener('input', () => { hex.value = picker.value.toUpperCase(); setColor(hex.value); });
  hex.addEventListener('input', () => {
    const v = hex.value.trim();
    if (!v) { picker.value = DEFAULT_COLOR; setColor(''); return; }
    if (validHex(v)) { picker.value = v; setColor(v.toUpperCase()); }
  });

  const afterChange = async () => {
    state.boot = await api.bootstrap();
    refreshBrandAssets();
    route();
  };
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try { await api.admin.brandLogo(reader.result); toast(t('app.saved'), 'success'); await afterChange(); }
      catch (e) { toast(e.message, 'error'); }
      file.value = '';
    };
    reader.readAsDataURL(f);
  });
  removeBtn.addEventListener('click', async () => {
    try { await api.admin.brandLogoRemove(); await afterChange(); } catch (e) { toast(e.message, 'error'); }
  });
  const reset = async () => {
    if (!confirm(t('brand.resetConfirm'))) return;
    Object.assign(s, { 'brand.color': '', 'brand.header': 'light', 'brand.showTitle': true });
    try {
      if (state.boot.brand?.logo) await api.admin.brandLogoRemove();
      if (await saveKeys(s, ['brand.'])) await afterChange();
    } catch (e) { toast(e.message, 'error'); }
  };

  drawLogo();
  draw();
  return h('section.panel',
    h('h2', t('brand.title')),
    h('p.muted', t('brand.intro')),
    h('div.field', h('label', t('brand.logo')),
      h('div.brand-logo-row', logoBox,
        h('button.btn', { type: 'button', onclick: () => file.click() }, t('brand.logoUpload')), removeBtn, file),
      h('div.hint', t('brand.logoHint'))),
    field(t('brand.showTitle'), bindCheck(s, 'brand.showTitle', draw), t('brand.showTitleHint')),
    h('div.field', h('label', t('brand.color')), h('div.color-row', picker, hex), contrastInfo),
    h('div.field', h('label', t('brand.header')),
      h('div.radio-row', ...[['light', t('brand.headerLight')], ['color', t('brand.headerColor')]].map(([v, label]) => {
        const r = h('input', { type: 'radio', name: 'brand-header', value: v, checked: (s['brand.header'] || 'light') === v });
        r.addEventListener('change', () => { s['brand.header'] = v; draw(); });
        return h('label.radio', r, ' ', label);
      }))),
    h('div.field', h('label', t('brand.preview')), preview),
    saveBar(async () => {
      if (s['brand.color'] && !validHex(s['brand.color'])) { toast(t('brand.colorInvalid'), 'error'); return; }
      if (await saveKeys(s, ['brand.'])) { refreshBrandAssets(); route(); }
    }, h('button.btn.btn-subtle', { type: 'button', onclick: reset }, t('brand.reset'))));
}

// Anmeldeseite: Überschrift, Begrüßungstext (de/en), Bezeichnung des Anmeldefelds – mit Vorschau
function loginPagePanel(s) {
  const preview = h('div.auth-card.login-preview');
  const area = (key, rows, ph) => { const ta = h('textarea', { rows, maxLength: 4000, placeholder: ph }); ta.value = s[key] || ''; ta.addEventListener('input', () => { s[key] = ta.value; draw(); }); return ta; };
  const input = (key, ph, max = 80) => { const i = h('input', { value: s[key] || '', maxLength: max, placeholder: ph }); i.addEventListener('input', () => { s[key] = i.value; draw(); }); return i; };
  const draw = () => {
    const login = { title: s['login.title'], text: { de: s['login.textDe'], en: s['login.textEn'] }, userLabel: { de: s['login.userLabelDe'], en: s['login.userLabelEn'] } };
    mount(preview,
      ...loginIntro(login),
      field(loginUserLabel(login) || t('login.username'), h('input', { disabled: true })),
      field(t('login.password'), h('input', { type: 'password', disabled: true })),
      h('button.btn.btn-primary.btn-block', { type: 'button', disabled: true }, t('login.submit')));
  };
  draw();
  return h('section.panel',
    h('h2', t('loginPage.title')),
    h('p.muted', t('loginPage.intro')),
    h('div.login-settings',
      h('div',
        field(t('loginPage.heading'), input('login.title', 'Helfi.Space Hilfecenter'), t('loginPage.headingHint')),
        field(t('loginPage.textDe'), area('login.textDe', 7, t('loginPage.textExample')), t('loginPage.textHint')),
        field(t('loginPage.textEn'), area('login.textEn', 4, ''), t('loginPage.textEnHint')),
        h('div.grid-2',
          field(t('loginPage.userLabelDe'), input('login.userLabelDe', 'Windows-Anmeldename')),
          field(t('loginPage.userLabelEn'), input('login.userLabelEn', 'Windows user name'))),
        saveBar(() => saveKeys(s, ['login.']))),
      h('div', h('div.muted.small.preview-label', t('loginPage.preview')), preview)));
}

// ---------- Sicherheit (2FA) ----------
async function securityPage(body, s) {
  const [st, netInfo] = await Promise.all([api.mfaStatus(), api.admin.mfaNetwork()]);
  // Ältere Installationen: Stufen aus dem bisherigen Modus übernehmen
  if (!s['mfa.external']) s['mfa.external'] = netInfo.levels.external;
  if (!s['mfa.internal']) s['mfa.internal'] = netInfo.levels.internal;
  // Eine Angabe pro Zeile (früher durch Komma getrennt)
  const lines = (v) => String(v || '').split(/[\s,;]+/).filter(Boolean).join('\n');
  const textarea = (key, rows, placeholder) => {
    const ta = h('textarea.mono', { rows, placeholder, spellcheck: false });
    ta.value = lines(s[key]);
    s[key] = ta.value;
    ta.addEventListener('input', () => { s[key] = ta.value; onInput?.(); });
    let onInput;
    return Object.assign(ta, { setOnInput: (f) => { onInput = f; } });
  };
  const extWarn = h('div.hint-box.hint-warn', { hidden: s['mfa.external'] !== 'none' }, icon('warning'), h('div', t('mfa.externalNoneWarn')));
  const own = textarea('mfa.ownAddresses', 3, '203.0.113.10\nhelfi.dyndns.example');
  const guestWarn = h('div.hint-box.hint-warn', { hidden: !s['mfa.ownAddresses'].trim() }, icon('warning'), h('div', t('mfa.ownGuestWarn')));
  own.setOnInput(() => { guestWarn.hidden = !s['mfa.ownAddresses'].trim(); });
  const o = netInfo.own;
  const ownStatus = h('div.muted.small',
    h('p', o.ips.length ? t('mfa.ownResolved', { ips: o.ips.join(', ') }) : t('mfa.ownNone')),
    Object.entries(o.errors || {}).map(([name, error]) => h('p', t('mfa.ownError', { name, error }))));
  const reason = { untrustedProxy: 'mfa.reason.untrustedProxy', dockerGateway: 'mfa.reason.dockerGateway', ownAddress: 'mfa.reason.ownAddress' }[st.network.reason];
  mount(body,
    h('section.panel',
      h('h2', t('mfa.adminTitle')),
      h('p.muted', t('mfa.adminIntro')),
      field(t('mfa.external'), bindSelect(s, 'mfa.external', [['all', t('mfa.level.all')], ['agents', t('mfa.level.agents')], ['admins', t('mfa.level.admins')], ['none', t('mfa.level.noneExternal')]], (v) => { extWarn.hidden = v !== 'none'; })),
      extWarn,
      field(t('mfa.internal'), bindSelect(s, 'mfa.internal', [['none', t('mfa.level.noneInternal')], ['admins', t('mfa.level.admins')], ['agents', t('mfa.level.agents')], ['all', t('mfa.level.all')]]), t('mfa.internalHint')),
      h('div.hint-box.hint-warn', icon('warning'), h('div',
        h('p', h('strong', t('mfa.proxyTitle')), ' ', t('mfa.proxyText')),
        h('p', t('mfa.proxyCurrent', { value: netInfo.trustProxy })),
        netInfo.proxyWarning ? h('p', h('strong', t('mfa.proxyProblem'))) : null)),
      field(t('mfa.networksLines'), textarea('mfa.internalNetworks', 5, '10.0.10.0/24'), t('mfa.networksLinesHint')),
      field(t('mfa.ownTitle'), own, t('mfa.ownHint')),
      ownStatus,
      guestWarn,
      h('div.hint-box', icon(st.network.internal ? 'check' : 'globe'), h('div',
        h('p', t(st.network.internal ? 'mfa.youAreInternal' : 'mfa.youAreExternal', { ip: st.network.ip })),
        reason ? h('p', t(reason)) : null)),
      field(t('mfa.enrollExternal'), bindCheck(s, 'mfa.enrollExternal'), t('mfa.enrollExternalHint')),
      field(t('mfa.ssoSecondFactor'), bindSelect(s, 'mfa.ssoSecondFactor', ['confirmed', 'always', 'never'].map((v) => [v, t(`mfa.sso.${v}`)])), t('mfa.ssoSecondFactorHint')),
      s['oidc.enabled'] && s['mfa.ssoSecondFactor'] === 'always' ? h('div.hint-box.hint-warn', icon('warning'), h('p', t('mfa.ssoAlwaysWarn'))) : null,
      saveBar(async () => { if (await saveKeys(s, ['mfa.'])) route(); })));
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
  const removeProject = (p) => {
    const others = projects.filter((x) => x.id !== p.id && !x.archived);
    const count = p.ticketCount || 0;
    const err = h('div.form-error', { role: 'alert', hidden: true });
    const target = select(others.map((x) => [x.key, `${x.name} (${x.key})`]), others[0]?.key || '');
    const content = count === 0
      ? h('p', t('projects.deleteEmpty', { key: p.key, name: p.name }))
      : h('div',
        h('p', t('projects.deleteHasTickets', { key: p.key, count })),
        field(t('projects.deleteMove'), target, t('projects.deleteMoveHint')),
        h('p.muted.small', t('projects.deleteKeepHint')));
    const submit = h('button.btn.btn-danger', { type: 'submit', form: 'del-proj-form' }, t('projects.delete'));
    const dlg = modal(`${t('projects.delete')}: ${p.name} (${p.key})`, h('form#del-proj-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        const d = count === 0 ? {} : { moveTo: target.value };
        if (count && !target.value) { err.textContent = t('projects.deleteNoTarget'); err.hidden = false; return; }
        submit.disabled = true;
        try {
          const r = await api.deleteProject(p.id, d);
          dlg.close();
          toast(r.moved ? t('projects.deletedMoved', { key: r.key, count: r.moved, target: r.target }) : t('projects.deleted', { key: r.key }), 'success');
          await reloadBase();
          route(); // ganze Seite neu – die Seitenleiste darf kein gelöschtes Projekt mehr zeigen
        } catch (ex) { err.textContent = ex.message; err.hidden = false; submit.disabled = false; }
      },
    }, err, content, h('p.muted.small', t('projects.deleteBackup'))),
    { footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), submit] });
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
        h('td.actions-cell',
          h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => { await api.updateProject(p.id, { archived: !p.archived }); await reloadBase(); projectsPage(body); } }, p.archived ? t('projects.unarchive') : t('projects.archive')),
          projects.length > 1 ? h('button.btn-icon.small', { type: 'button', title: t('projects.delete'), 'aria-label': t('projects.delete'), onclick: () => removeProject(p) }, icon('trash')) : null)))))));
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
  const editUser = (u) => {
    const name = h('input', { value: u.displayName, maxLength: 120, required: true });
    const email = h('input', { type: 'email', value: u.email || '', maxLength: 254 });
    const pw = h('input', { type: 'password', minLength: 10, autocomplete: 'new-password', placeholder: t('users.passwordUnchanged') });
    const dlg = modal(`${t('users.edit')}: ${u.username}`, h('form#edit-user-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const patch = { displayName: name.value.trim(), email: email.value.trim() };
        if (pw.value) patch.password = pw.value;
        try { await api.updateUser(u.id, patch); dlg.close(); toast(t('app.saved'), 'success'); await reloadBase(); usersPage(body, showContacts); }
        catch (ex) { toast(ex.message, 'error'); }
      },
    }, h('div.grid-2', field(t('users.displayName'), name), field(t('users.email'), email, t('profile.emailHint'))), field(t('users.newPassword'), pw)),
    { footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), h('button.btn.btn-primary', { type: 'submit', form: 'edit-user-form' }, t('app.save'))] });
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
          u.source === 'local' ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => editUser(u) }, t('app.edit')) : null,
          u.mfaEnabled ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { if (confirm(t('mfa.resetConfirm', { name: u.displayName }))) update(u, { resetMfa: true }); } }, t('mfa.reset')) : null,
          u.id !== state.user.id ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => update(u, { active: !u.active }) }, u.active ? t('users.deactivate') : t('users.activate')) : null)))))));
}

// Schutz vor Mail-Schleifen: Absender-Regeln und gesperrte Empfänger
function loopPanel(s) {
  let rules = [];
  try { rules = JSON.parse(s['imap.senderRules'] || '[]'); } catch { rules = []; }
  if (!Array.isArray(rules)) rules = [];
  const rulesHost = h('div');
  const suppHost = h('div', h('div.loading', t('app.loading')));
  const projOpts = [['', t('mail.rules.defaultProject')], ...state.projects.map((p) => [p.key, `${p.name} (${p.key})`])];
  const drawRules = () => mount(rulesHost,
    rules.length ? h('table.data.rules-table',
      h('thead', h('tr', h('th', t('mail.rules.pattern')), h('th', t('mail.rules.action')), h('th', t('mail.rules.project')), h('th', ''))),
      h('tbody', rules.map((r, i) => h('tr',
        h('td', h('input', { value: r.pattern || '', placeholder: 'monitor@firma.local', oninput: (e) => { r.pattern = e.target.value; } })),
        h('td', select([['noreply', t('mail.rules.noreply')], ['ignore', t('mail.rules.ignore')]], r.action || 'noreply', { class: 'select-sm', onchange: (e) => { r.action = e.target.value; drawRules(); } })),
        h('td', r.action === 'ignore' ? h('span.muted', '–') : select(projOpts, r.project || '', { class: 'select-sm', onchange: (e) => { r.project = e.target.value; } })),
        h('td', h('button.btn-icon.small', { type: 'button', title: t('app.delete'), onclick: () => { rules.splice(i, 1); drawRules(); } }, icon('trash'))))))) : h('p.muted', t('mail.rules.none')),
    h('div.actions',
      h('button.btn.btn-subtle', { type: 'button', onclick: () => { rules.push({ pattern: '', action: 'noreply', project: '' }); drawRules(); rulesHost.querySelector('tbody tr:last-child input')?.focus(); } }, icon('plus'), t('mail.rules.add')),
      h('button.btn.btn-primary', {
        type: 'button',
        onclick: async () => {
          const clean = rules.map((r) => ({ pattern: String(r.pattern || '').trim().toLowerCase(), action: r.action || 'noreply', project: r.action === 'ignore' ? '' : (r.project || '') }));
          const bad = clean.find((r) => !r.pattern || !/@|\*/.test(r.pattern));
          if (bad) { toast(t('mail.rules.invalid'), 'error'); return; }
          rules = clean.filter((r) => r.pattern);
          s['imap.senderRules'] = JSON.stringify(rules);
          await saveKeys(s, ['imap.senderRules']);
          drawRules();
        },
      }, t('app.save'))));
  const drawSupp = (list) => mount(suppHost, list.length
    ? h('table.data',
      h('thead', h('tr', h('th', t('mail.supp.address')), h('th', t('mail.supp.reason')), h('th', t('mail.supp.until')), h('th', ''))),
      h('tbody', list.map((x) => h('tr',
        h('td', x.address), h('td.muted', x.reason || '–'), h('td', { title: fmtDate(x.until) }, fmtDate(x.until)),
        h('td', h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => { try { drawSupp((await api.admin.releaseSuppression(x.address)).suppressions); } catch (e) { toast(e.message, 'error'); } } }, t('mail.supp.release')))))))
    : h('p.muted', t('mail.supp.none')));
  api.admin.suppressions().then((r) => drawSupp(r.suppressions)).catch((e) => mount(suppHost, h('p.error-text', e.message)));
  drawRules();
  return h('section.panel',
    h('h2', t('mail.loop.title')),
    h('p.muted', t('mail.loop.intro')),
    h('h3', t('mail.rules.title')),
    h('p.muted.small', t('mail.rules.hint')),
    rulesHost,
    h('h3', t('mail.supp.title')),
    h('p.muted.small', t('mail.supp.hint')),
    suppHost);
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
      field(t('ldap.nestedGroups'), bindCheck(s, 'ldap.nestedGroups')),
      field(t('ldap.peopleSearch'), bindCheck(s, 'ldap.peopleSearch'), t('ldap.peopleSearchHint'))),
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
      field(t('sso.adIdClaim'), bindInput(s, 'oidc.adIdClaim', { placeholder: 'onprem_sid' }), t('sso.adIdClaimHint')),
      field(t('sso.mfaAcr'), bindInput(s, 'oidc.mfaAcr', { placeholder: 'mfa, 2' }), t('sso.mfaAcrHint')),
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
      st.lastError ? h('span.block.error-text', st.lastError) : null,
      st.recentSkipped?.length ? h('details.skipped-list', h('summary', t('mail.skippedTitle', { n: st.recentSkipped.length })),
        h('table.data', h('tbody', st.recentSkipped.map((x) => h('tr',
          h('td', { style: { whiteSpace: 'nowrap' } }, relTime(x.at)), h('td', x.from || '—'), h('td', x.subject || '—'),
          h('td', t(`mail.skip.${x.reason}`)))))),
        st.recentSkipped.some((x) => x.reason === 'automated') ? h('p', t('mail.skipAutomatedHint')) : null) : null);
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
      h('h3', t('survey.adminTitle')),
      h('p.muted.small', t('survey.adminHint')),
      field(t('survey.enabled'), bindCheck(s, 'survey.enabled')),
      field(t('survey.days'), bindInput(s, 'survey.days', { type: 'number', min: 1, max: 90 })),
      h('div.grid-2', field(t('mail.testTo'), testTo), h('div.field.field-btn', h('button.btn', {
        type: 'button',
        onclick: async () => { const r = await api.admin.testSmtp(pick(s, 'smtp.'), testTo.value); showResult(smtpRes, r.ok, r.ok ? t('mail.testSent') : r.error); },
      }, icon('mail'), t('mail.sendTest')))),
      smtpRes,
      saveBar(() => saveKeys(s, ['smtp.', 'notify.', 'survey.']))));
  body.append(loopPanel(s));
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
    backupPanel(body, sys));
}

function backupPanel(body, sys) {
  const keep = h('input.num', { type: 'number', min: 1, max: 100, step: 1, value: sys.backupKeep, 'aria-label': t('system.backupKeep') });
  const saveKeep = h('button.btn', {
    type: 'button',
    onclick: async () => {
      const n = Math.round(Number(keep.value));
      if (!(n >= 1 && n <= 100)) { toast(t('system.backupKeepRange'), 'error'); keep.focus(); return; }
      try { await api.admin.saveSettings({ 'backup.keep': n }); toast(t('app.saved'), 'success'); systemPage(body); }
      catch (e) { toast(e.message, 'error'); }
    },
  }, t('app.save'));
  keep.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKeep.click(); });
  const remove = async (b) => {
    if (!confirm(t('system.backupDeleteConfirm', { name: b.name }))) return;
    try { await api.admin.deleteBackup(b.name); toast(t('system.backupDeleted'), 'success'); systemPage(body); }
    catch (e) { toast(e.message, 'error'); }
  };
  return h('section.panel',
    h('div.section-head', h('h2', t('system.backups')),
      h('button.btn', { type: 'button', onclick: async () => { try { const r = await api.admin.backup(); toast(t('system.backupDone', r), 'success'); systemPage(body); } catch (e) { toast(e.message, 'error'); } } }, icon('download'), t('system.backupNow'))),
    h('p.muted', t('system.backupHint')),
    h('div.field',
      h('label', { for: 'backup-keep' }, t('system.backupKeep')),
      h('div.inline-row', Object.assign(keep, { id: 'backup-keep' }), saveKeep),
      h('div.hint', t('system.backupKeepHint'))),
    sys.backups.length
      ? h('div.table-wrap', h('table.data.backup-table',
        h('thead', h('tr', h('th', t('system.backupName')), h('th', t('system.backupKind')), h('th', t('system.backupDate')), h('th.num', t('system.backupSize')), h('th', ''))),
        h('tbody', sys.backups.map((b) => h('tr',
          h('td.mono', b.name), h('td', t(`system.kind.${b.kind}`)), h('td', fmtDate(b.time)), h('td.num', fmtSize(b.size)),
          h('td', h('button.btn-icon.small', { type: 'button', title: t('system.backupDelete'), 'aria-label': t('system.backupDelete'), onclick: () => remove(b) }, icon('trash')))))),
        h('tfoot', h('tr', h('td', { colspan: 3 }, t('system.backupTotal', { n: sys.backups.length })), h('td.num', fmtSize(sys.backupsSize)), h('td', '')))))
      : h('p.muted', '—'));
}

