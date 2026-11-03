// Anmeldung und Ersteinrichtung
import { api } from '../api.js';
import { h, mount, field, icon, select, toast, richText } from '../dom.js';
import { t, getLang, setLang } from '../i18n.js';
import { state, navigate, reloadBase, route } from '../app.js';
import { brandLogo, brandTitle } from '../brand.js';

function langSwitch() {
  return h('div.lang-switch',
    ['de', 'en'].map((l) => h('button', {
      type: 'button', class: getLang() === l ? 'active' : '',
      onclick: () => { try { localStorage.setItem('helfi.lang', l); } catch { /* egal */ } setLang(l); route(); },
    }, l.toUpperCase())));
}

export function authFrame(...children) {
  return h('div.auth-page',
    h('div.auth-card',
      h('div.auth-brand', brandLogo(40), brandTitle()),
      ...children),
    langSwitch(),
    h('a.auth-home', { href: 'https://helfi.space', target: '_blank', rel: 'noopener noreferrer' }, 'helfi.space'));
}

async function finishLogin(user) {
  state.user = user;
  state.boot = await api.bootstrap();
  if (user.language) setLang(user.language);
  await reloadBase();
  navigate('/', { replace: true });
}

/** Wiederherstellungscodes anzeigen (nur einmal sichtbar) */
export function recoveryCodesBox(codes) {
  const text = codes.join('\n');
  return h('div.recovery',
    h('p', t('mfa.recoveryIntro')),
    h('ul.recovery-codes', codes.map((c) => h('li.mono', c))),
    h('div.actions',
      h('button.btn', { type: 'button', onclick: () => navigator.clipboard?.writeText(text).then(() => toast(t('mfa.copied'))) }, icon('copy'), t('mfa.copy')),
      h('a.btn', { href: URL.createObjectURL(new Blob([`Helfi.Space – ${t('mfa.recoveryTitle')}\n\n${text}\n`], { type: 'text/plain' })), download: 'helfi-wiederherstellungscodes.txt' }, icon('download'), t('mfa.download'))));
}

/** Zweiter Schritt der Anmeldung: Code eingeben oder 2FA erstmals einrichten */
async function renderMfaStep(root, step) {
  const err = h('div.form-error', { role: 'alert', hidden: true });
  const codeInput = h('input.code-input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, pattern: '[0-9]{6}', required: true, placeholder: '123456' });
  const recoveryInput = h('input.mono', { autocomplete: 'off', placeholder: 'abcd-efgh', hidden: true });
  let useRecovery = false;
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, t('mfa.verify'));
  let qrBox = null;

  if (step === 'enroll') {
    try {
      const info = await api.mfaEnrollInfo();
      qrBox = h('div.mfa-setup',
        h('p', t('mfa.enrollIntro')),
        h('img.qr', { src: info.qr, alt: t('mfa.qrAlt'), width: 180, height: 180 }),
        h('details', h('summary', t('mfa.manualKey')), h('code.mono.secret', info.secret.replace(/(.{4})/g, '$1 ').trim())));
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
    }
  }

  const toggle = step === 'code' ? h('button.link', {
    type: 'button',
    onclick: () => {
      useRecovery = !useRecovery;
      codeInput.hidden = useRecovery; codeInput.required = !useRecovery;
      recoveryInput.hidden = !useRecovery; recoveryInput.required = useRecovery;
      toggle.textContent = useRecovery ? t('mfa.useApp') : t('mfa.useRecovery');
      (useRecovery ? recoveryInput : codeInput).focus();
    },
  }, t('mfa.useRecovery')) : null;

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        const r = await api.mfaVerify(useRecovery ? recoveryInput.value : codeInput.value);
        if (r.recoveryCodes) {
          // Nach der Ersteinrichtung: Codes zeigen, dann weiter
          return mount(root, authFrame(h('div', h('h1', t('mfa.enabledTitle')), recoveryCodesBox(r.recoveryCodes),
            h('button.btn.btn-primary.btn-block', { type: 'button', onclick: () => finishLogin(r.user) }, t('mfa.continue')))));
        }
        if (r.usedRecovery) toast(t('mfa.recoveryUsed'));
        await finishLogin(r.user);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        if (ex.code === 'err.mfaExpired') { setTimeout(() => { history.replaceState({}, '', '/login'); renderLogin(root); }, 2500); }
        codeInput.value = '';
        codeInput.focus();
      } finally { btn.disabled = false; }
    },
  },
  h('h1', step === 'enroll' ? t('mfa.enrollTitle') : t('mfa.codeTitle')),
  err,
  qrBox,
  h('p.muted', step === 'enroll' ? t('mfa.enrollCodeHint') : t('mfa.codeHint')),
  codeInput, recoveryInput,
  btn,
  toggle ? h('div.center', toggle) : null,
  h('div.center', h('a.link', { href: '/login', onclick: (e) => { e.preventDefault(); history.replaceState({}, '', '/login'); renderLogin(root); } }, t('mfa.back'))));
  codeInput.addEventListener('input', () => { if (/^\d{6}$/.test(codeInput.value)) form.requestSubmit(); });
  mount(root, authFrame(form));
  setTimeout(() => codeInput.focus(), 0);
}

export function renderLogin(root) {
  const params = new URLSearchParams(location.search);
  if (params.get('mfa') === 'code' || params.get('mfa') === 'enroll') {
    const step = params.get('mfa');
    history.replaceState({}, '', '/login');
    return renderMfaStep(root, step);
  }
  const oidc = state.boot.auth.oidc;
  if (oidc?.autoRedirect && !params.has('error') && !params.has('local')) {
    location.href = '/auth/oidc/start';
    return;
  }
  const err = h('div.form-error', { role: 'alert', hidden: !params.get('error') }, params.get('error') ? t(`login.err.${params.get('error')}`) : '');
  const mfaHint = state.boot.mfa && !state.boot.mfa.internal && state.boot.mfa.mode !== 'off'
    ? h('div.hint-box', icon('shield'), h('div', t('mfa.externalHint'))) : null;
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: false });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, t('login.submit'));

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.hidden = true;
      try {
        const r = await api.login(user.value, pass.value);
        if (r.mfa) return renderMfaStep(root, r.mfa);
        await finishLogin(r.user);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        pass.value = '';
        pass.focus();
      } finally {
        btn.disabled = false;
      }
    },
  },
  ...loginIntro(state.boot.login),
  mfaHint,
  err,
  field(loginUserLabel(state.boot.login) || t('login.username'), user, state.boot.auth.ldap ? t('login.usernameHint') : null),
  field(t('login.password'), pass),
  btn,
  oidc ? [h('div.divider', h('span', t('login.or'))), h('a.btn.btn-block.btn-sso', { href: '/auth/oidc/start' }, icon('key'), oidc.label)] : null,
  );
  mount(root, authFrame(form));
  setTimeout(() => user.focus(), 0);
}

/** Eigener Text der Anmeldeseite in der passenden Sprache (Englisch fällt auf Deutsch zurück). */
function pickLang(obj) {
  if (!obj) return '';
  return (getLang() === 'en' && obj.en) ? obj.en : (obj.de || obj.en || '');
}
export function loginUserLabel(login) { return pickLang(login?.userLabel).trim(); }

/** Überschrift und Begrüßungstext (Text ohne HTML, **fett**, Links/Mailadressen anklickbar). */
export function loginIntro(login) {
  const title = String(login?.title || '').trim();
  const text = pickLang(login?.text).trim();
  if (!title && !text) return [h('h1', t('login.title'))];
  return [
    title ? h('h1.login-custom-title', title) : h('h1', t('login.title')),
    text ? h('div.login-intro', richText(text)) : null,
  ];
}

export function renderSetup(root) {
  const params = new URLSearchParams(location.search);
  const token = h('input', { required: true, autocomplete: 'off', value: params.get('token') || '', spellcheck: false });
  const username = h('input', { required: true, value: 'admin', autocomplete: 'username', minLength: 2, maxLength: 64 });
  const displayName = h('input', { value: 'Administrator' });
  const email = h('input', { type: 'email', autocomplete: 'email' });
  const pw = h('input', { type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
  const pKey = h('input', { required: true, value: 'IT', maxLength: 10, pattern: '[A-Za-z][A-Za-z0-9]{1,9}', style: { textTransform: 'uppercase' } });
  const pName = h('input', { required: true, value: getLang() === 'de' ? 'IT-Helpdesk' : 'IT Helpdesk' });
  const lang = select([['de', 'Deutsch'], ['en', 'English']], getLang(), { onchange: (e) => { setLang(e.target.value); renderSetup(root); } });
  const err = h('div.form-error', { role: 'alert', hidden: true });
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, t('setup.submit'));

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (pw.value !== pw2.value) { err.textContent = t('setup.passwordMismatch'); err.hidden = false; return; }
      btn.disabled = true;
      try {
        const r = await api.setup({
          token: token.value.trim(), username: username.value.trim(), displayName: displayName.value.trim(), email: email.value.trim(),
          password: pw.value, language: lang.value, projectKey: pKey.value.trim().toUpperCase(), projectName: pName.value.trim(),
        });
        state.user = r.user;
        state.boot = await api.bootstrap();
        await reloadBase();
        navigate('/admin/ldap', { replace: true });
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    },
  },
  h('h1', t('setup.title')),
  h('p.muted', t('setup.intro')),
  err,
  field(t('app.language'), lang),
  field(t('setup.token'), token, t('setup.tokenHint')),
  h('h3', t('setup.admin')),
  h('div.grid-2', field(t('login.username'), username), field(t('setup.displayName'), displayName)),
  field(t('setup.email'), email),
  h('div.grid-2', field(t('setup.password'), pw), field(t('setup.password2'), pw2)),
  h('h3', t('setup.project')),
  h('div.grid-2', field(t('setup.projectKey'), pKey, t('setup.projectKeyHint')), field(t('setup.projectName'), pName)),
  btn,
  );
  if (location.pathname !== '/setup') history.replaceState({}, '', '/setup' + location.search);
  mount(root, authFrame(form));
}
