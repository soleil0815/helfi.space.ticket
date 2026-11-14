// Mobile sign-in: user name/password, SSO, error from ?error=, two-factor code step.
import { api } from '/js/api.js';
import { takeIdleNote } from '/js/idle.js';
import { h, icon, toast } from '/js/dom.js';
import { t, getLang, setLang } from '/js/i18n.js';
import { state } from '/js/state.js';
import { brandLogo, brandTitle } from '/js/brand.js';
import { loginIntro, loginUserLabel, loginUserHint, accountLinks } from '/js/logintext.js';
import { replaceUrl } from '../router.js';
import { signedIn } from '../main.js';
import { mfaSetupSteps } from '../mfa.js';
import { passkeysHere, conditionalSupported, passkeySignIn, passkeyCancelled } from '/js/passkey.js';

// Waiting passkey suggestion in the user name field: aborted before anything else uses WebAuthn
let pkWait = null;
const stopPasskeyWait = () => { pkWait?.abort(); pkWait = null; };

function frame(page, ...children) {
  const langs = h('div.m-login-lang', { role: 'group', 'aria-label': t('app.language') },
    ['de', 'en'].map((l) => h('button', {
      type: 'button', class: getLang() === l ? 'active' : '', 'aria-pressed': String(getLang() === l),
      onclick: () => { try { localStorage.setItem('helfi.lang', l); } catch { /* ignore */ } setLang(l); renderLogin(page); },
    }, l === 'de' ? 'Deutsch' : 'English')));
  page.body.replaceChildren(h('div.m-login',
    h('div.m-login-brand', brandLogo(48), h('div.m-login-name', brandTitle())),
    h('div.m-login-card', ...children),
    langs,
    state.boot?.app?.sourceUrl ? h('a.m-login-source', { href: state.boot.app.sourceUrl, target: '_blank', rel: 'noopener noreferrer', title: t('app.sourceTitle') }, t('app.source')) : null));
  document.title = `${t('login.submit')} – ${state.boot?.app?.title || 'Helfi.Space'}`;
}

const fieldEl = (label, input, hint) => {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div.m-field', h('label', { for: id }, label), input, hint ? h('div.m-field-hint', hint) : null);
};

export function renderLogin(page) {
  stopPasskeyWait();
  const params = new URLSearchParams(location.search);
  const step = params.get('mfa');
  if (step === 'code' || step === 'enroll') {
    replaceUrl('/m/login');
    return step === 'code' ? renderCode(page) : renderEnroll(page);
  }
  const oidc = state.boot.auth.oidc;
  // Signed out for inactivity: show it (and do not sign in again silently via SSO)
  const idleNote = takeIdleNote();
  if (oidc?.autoRedirect && !idleNote && !params.has('error') && !params.has('local')) {
    location.href = '/auth/oidc/start';
    return;
  }
  const idleHint = idleNote ? h('div.m-alert.m-alert-info', { role: 'status' }, icon('clock'), h('span', t('idle.signedOut'))) : null;
  const error = params.get('error');
  const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: !error }, error ? t(`login.err.${error}`) : '');
  const mfaHint = state.boot.mfa && !state.boot.mfa.internal && state.boot.mfa.mode !== 'off'
    ? h('div.m-alert.m-alert-info', icon('shield'), h('span', t('mfa.externalHint'))) : null;
  const passkeys = passkeysHere(state.boot.auth.passkeys);
  const user = h('input', { name: 'username', autocomplete: passkeys ? 'username webauthn' : 'username', required: true, autocapitalize: 'off', autocorrect: 'off', spellcheck: false, enterkeyhint: 'next' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, enterkeyhint: 'go' });
  const btn = h('button.m-btn.m-btn-primary.m-btn-block', { type: 'submit' }, t('login.submit'));

  const form = h('form.m-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.hidden = true;
      try {
        const r = await api.login(user.value, pass.value);
        stopPasskeyWait();
        if (r.mfa === 'code') return renderCode(page);
        if (r.mfa) return renderEnroll(page);
        await signedIn(r.user);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        pass.value = '';
        pass.focus();
      } finally { btn.disabled = false; }
    },
  },
  ...loginIntro(state.boot.login),
  idleHint,
  mfaHint,
  err,
  fieldEl(loginUserLabel(state.boot.login) || t('login.username'), user, loginUserHint(state.boot.auth)),
  fieldEl(t('login.password'), pass),
  btn,
  passkeys || oidc ? h('div.m-divider', h('span', t('login.or'))) : null,
  passkeys ? h('button.m-btn.m-btn-block.m-btn-passkey', { type: 'button', 'data-passkey-login': '', onclick: () => passkeyButton() }, icon('passkey'), t('passkey.signIn')) : null,
  oidc ? h('a.m-btn.m-btn-block.m-btn-sso', { href: '/auth/oidc/start' }, icon('key'), oidc.label) : null,
  accountLinks(state.boot.auth, 'div.m-login-links', 'a.m-link'));
  if (error) replaceUrl('/m/login');
  const showErr = (ex) => { err.textContent = ex.message; err.hidden = false; };
  const done = async (user) => { stopPasskeyWait(); await signedIn(user); };
  let pkFails = 0;
  async function passkeyButton() {
    stopPasskeyWait();
    err.hidden = true;
    try { const r = await passkeySignIn(); await done(r.user); }
    catch (ex) { if (!passkeyCancelled(ex)) showErr(ex); waitForPasskey(); }
  }
  // Suggest passkeys above the keyboard / in the user name field (iPhone, Android)
  async function waitForPasskey() {
    if (!passkeys || !(await conditionalSupported()) || !document.contains(form)) return;
    stopPasskeyWait();
    const ctl = new AbortController();
    pkWait = ctl;
    const renew = setTimeout(() => { if (pkWait === ctl) waitForPasskey(); }, 4 * 60 * 1000);
    try { const r = await passkeySignIn({ conditional: true, signal: ctl.signal }); clearTimeout(renew); await done(r.user); }
    catch (ex) {
      clearTimeout(renew);
      if (ctl.signal.aborted) return;
      if (!passkeyCancelled(ex)) {
        if (!ex.status) return; // browser refused (e.g. security error): no message, no retry
        showErr(ex);
        if (++pkFails >= 3) return;
      }
      if (pkWait === ctl) { pkWait = null; setTimeout(() => { if (!pkWait && document.contains(form)) waitForPasskey(); }, 1000); }
    }
  }
  frame(page, form);
  waitForPasskey();
}

/** Second step: code from the authenticator app (or a recovery code) */
function renderCode(page) {
  const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
  const code = h('input.m-code', { inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, pattern: '[0-9]{6}', required: true, placeholder: '123456', 'aria-label': t('mfa.codeTitle') });
  const recovery = h('input.m-mono', { autocomplete: 'off', autocapitalize: 'off', spellcheck: false, placeholder: 'abcd-efgh', hidden: true, 'aria-label': t('mfa.useRecovery') });
  let useRecovery = false;
  const btn = h('button.m-btn.m-btn-primary.m-btn-block', { type: 'submit' }, t('mfa.verify'));
  const toggle = h('button.m-link', {
    type: 'button',
    onclick: () => {
      useRecovery = !useRecovery;
      code.hidden = useRecovery; code.required = !useRecovery;
      recovery.hidden = !useRecovery; recovery.required = useRecovery;
      toggle.textContent = useRecovery ? t('mfa.useApp') : t('mfa.useRecovery');
      (useRecovery ? recovery : code).focus();
    },
  }, t('mfa.useRecovery'));
  const form = h('form.m-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        const r = await api.mfaVerify(useRecovery ? recovery.value : code.value);
        if (r.usedRecovery) toast(t('mfa.recoveryUsed'));
        await signedIn(r.user);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        if (ex.code === 'err.mfaExpired') setTimeout(() => renderLogin(page), 2500);
        code.value = '';
        code.focus();
      } finally { btn.disabled = false; }
    },
  },
  h('h1', t('mfa.codeTitle')),
  h('p.m-muted', t('mfa.codeHint')),
  err, code, recovery, btn,
  h('div.m-center', toggle),
  h('div.m-center', h('button.m-link', { type: 'button', onclick: () => renderLogin(page) }, t('mfa.back'))));
  code.addEventListener('input', () => { if (/^\d{6}$/.test(code.value)) form.requestSubmit(); });
  frame(page, form);
  setTimeout(() => code.focus(), 50);
}

/** Two-factor sign-in has to be set up first: right here on the phone (key + app link, QR for another device) */
async function renderEnroll(page) {
  const back = () => h('div.m-center', h('button.m-link', { type: 'button', onclick: () => renderLogin(page) }, t('mfa.back')));
  frame(page, h('div.m-form', h('div.m-spinner', { 'aria-label': t('app.loading') })));
  let info;
  try { info = await api.mfaEnrollInfo(); } catch (ex) {
    frame(page, h('div.m-form', h('h1', t('mfa.enrollTitle')), h('div.m-alert.m-alert-error', { role: 'alert' }, ex.message), back()));
    return;
  }
  let user = null;
  frame(page, h('div.m-form.m-enroll',
    h('div.m-login-icon', icon('shield')),
    h('h1', t('mfa.enrollTitle')),
    h('p.m-muted', t('m.login.enrollText')),
    mfaSetupSteps(info, {
      confirm: async (code) => {
        try {
          const r = await api.mfaVerify(code);
          user = r.user;
          if (!r.recoveryCodes) { await signedIn(r.user); return []; }
          return r.recoveryCodes;
        } catch (ex) {
          if (ex.code === 'err.mfaExpired') setTimeout(() => renderLogin(page), 2500);
          throw ex;
        }
      },
      onDone: () => signedIn(user),
      doneLabel: t('mfa.continue'),
    }),
    back()));
}
