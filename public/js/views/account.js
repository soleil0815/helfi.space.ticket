// Pages without sign-in: create an account, confirm it (link from the mail), forgot password, set a new one.
// Also used on phones (the mobile UI links here); "To sign-in" reloads, so phones go back to /m/login.
import { api } from '../api.js';
import { h, mount, field, icon } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { state } from '../app.js';
import { authFrame } from './auth.js';

const MIN_PASSWORD = 10;

/** Link back to the sign-in page as a full page load (mobile detection runs again) */
const toLogin = (label = t('account.toLogin')) => h('div.center', h('a.link', { href: '/login' }, label));

/** Token from the address (#…) – then remove it, so it does not stay in the history */
function takeToken() {
  const token = decodeURIComponent(location.hash.slice(1));
  history.replaceState({}, '', location.pathname);
  return token;
}

function done(root, title, text, kind = 'mail') {
  mount(root, authFrame(h('div.account-done',
    h('div.account-done-icon', icon(kind)),
    h('h1', title),
    h('p', text),
    toLogin())));
}

function passwordPair() {
  const pw = h('input', { type: 'password', required: true, minLength: MIN_PASSWORD, maxLength: 1024, autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', required: true, minLength: MIN_PASSWORD, maxLength: 1024, autocomplete: 'new-password' });
  return { pw, pw2, check: () => (pw.value !== pw2.value ? t('setup.passwordMismatch') : null) };
}

const errorBox = () => h('div.form-error', { role: 'alert', hidden: true });
const showError = (el, msg) => { el.textContent = msg; el.hidden = false; };

// ---------- Create an account ----------
export function renderRegister(root) {
  if (!state.boot.auth.register) return mount(root, authFrame(h('div', h('h1', t('account.registerTitle')), h('p', t('account.registerClosed')), toLogin())));
  const name = h('input', { required: true, maxLength: 120, autocomplete: 'name' });
  const email = h('input', { type: 'email', required: true, maxLength: 254, autocomplete: 'email', autocapitalize: 'off', spellcheck: false });
  const { pw, pw2, check } = passwordPair();
  // Not visible for people; bots fill in every field
  const trap = h('input', { name: 'website', tabIndex: -1, autocomplete: 'off', 'aria-hidden': 'true' });
  const err = errorBox();
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, t('account.registerSubmit'));
  const domains = state.boot.auth.domains || [];
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      const bad = check();
      if (bad) return showError(err, bad);
      btn.disabled = true;
      try {
        await api.register({ displayName: name.value.trim(), email: email.value.trim(), password: pw.value, website: trap.value, language: getLang() });
        done(root, t('account.checkMailTitle'), t('account.registerSent', { email: email.value.trim() }));
      } catch (ex) { showError(err, ex.message); btn.disabled = false; }
    },
  },
  h('h1', t('account.registerTitle')),
  h('p.muted', t('account.registerIntro')),
  err,
  field(t('users.displayName'), name),
  field(t('users.email'), email, domains.length ? t('account.domainsHint', { domains: domains.map((d) => `@${d}`).join(', ') }) : t('account.emailHint')),
  h('div.grid-2', field(t('setup.password'), pw), field(t('setup.password2'), pw2)),
  h('div.hp-field', h('label', 'Website', trap)),
  btn,
  toLogin(t('account.haveAccount')));
  mount(root, authFrame(form));
  setTimeout(() => name.focus(), 0);
}

// ---------- Link from the registration mail ----------
export async function renderRegisterConfirm(root) {
  const token = takeToken();
  mount(root, authFrame(h('div.loading', t('app.loading'))));
  try {
    const r = await api.confirmRegistration(token);
    if (r.pending) done(root, t('account.confirmedTitle'), t('account.confirmedPending'), 'clock');
    else done(root, t('account.confirmedTitle'), t('account.confirmedActive'), 'check');
  } catch (ex) {
    mount(root, authFrame(h('div', h('h1', t('account.confirmFailed')), h('div.form-error', { role: 'alert' }, ex.message),
      state.boot.auth.register ? h('div.center', h('a.link', { href: '/register', 'data-link': '' }, t('account.registerAgain'))) : null,
      toLogin())));
  }
}

// ---------- Forgot password ----------
export function renderForgot(root) {
  const email = h('input', { type: 'email', required: true, maxLength: 254, autocomplete: 'email', autocapitalize: 'off', spellcheck: false });
  const err = errorBox();
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, t('account.forgotSubmit'));
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        await api.forgotPassword(email.value.trim(), getLang());
        done(root, t('account.checkMailTitle'), t('account.forgotSent', { email: email.value.trim() }));
      } catch (ex) { showError(err, ex.message); btn.disabled = false; }
    },
  },
  h('h1', t('account.forgotTitle')),
  h('p.muted', t('account.forgotIntro')),
  err,
  field(t('users.email'), email),
  btn,
  toLogin());
  mount(root, authFrame(form));
  setTimeout(() => email.focus(), 0);
}

// ---------- Set a new password (link from the mail) ----------
export function renderReset(root) {
  const token = location.hash ? takeToken() : '';
  const { pw, pw2, check } = passwordPair();
  const err = errorBox();
  const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, t('account.resetSubmit'));
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      const bad = check();
      if (bad) return showError(err, bad);
      btn.disabled = true;
      try {
        await api.resetPassword(token, pw.value);
        done(root, t('account.resetDoneTitle'), t('account.resetDone'), 'check');
      } catch (ex) { showError(err, ex.message); btn.disabled = false; }
    },
  },
  h('h1', t('account.resetTitle')),
  token ? null : h('div.form-error', { role: 'alert' }, t('account.resetNoToken')),
  err,
  field(t('account.newPassword'), pw, t('account.passwordHint')),
  field(t('setup.password2'), pw2),
  btn,
  toLogin());
  if (!token) btn.disabled = true;
  mount(root, authFrame(form));
  setTimeout(() => pw.focus(), 0);
}
