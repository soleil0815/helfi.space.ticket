// Anmeldung und Ersteinrichtung
import { api } from '../api.js';
import { h, mount, field, icon, select } from '../dom.js';
import { t, getLang, setLang } from '../i18n.js';
import { state, navigate, reloadBase, route } from '../app.js';

function langSwitch() {
  return h('div.lang-switch',
    ['de', 'en'].map((l) => h('button', {
      type: 'button', class: getLang() === l ? 'active' : '',
      onclick: () => { try { localStorage.setItem('helfi.lang', l); } catch { /* egal */ } setLang(l); route(); },
    }, l.toUpperCase())));
}

function authFrame(...children) {
  return h('div.auth-page',
    h('div.auth-card',
      h('div.auth-brand', h('img', { src: '/logo.svg', alt: '', width: 40, height: 40 }), h('span', state.boot.app.title || 'Helfi.Space')),
      ...children),
    langSwitch());
}

export function renderLogin(root) {
  const params = new URLSearchParams(location.search);
  const oidc = state.boot.auth.oidc;
  if (oidc?.autoRedirect && !params.has('error') && !params.has('local')) {
    location.href = '/auth/oidc/start';
    return;
  }
  const err = h('div.form-error', { role: 'alert', hidden: !params.get('error') }, params.get('error') ? t(`login.err.${params.get('error')}`) : '');
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
        state.user = r.user;
        state.boot = await api.bootstrap();
        if (r.user.language) setLang(r.user.language);
        await reloadBase();
        navigate('/', { replace: true });
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
  h('h1', t('login.title')),
  err,
  field(t('login.username'), user, state.boot.auth.ldap ? t('login.usernameHint') : null),
  field(t('login.password'), pass),
  btn,
  oidc ? [h('div.divider', h('span', t('login.or'))), h('a.btn.btn-block.btn-sso', { href: '/auth/oidc/start' }, icon('key'), oidc.label)] : null,
  );
  mount(root, authFrame(form));
  setTimeout(() => user.focus(), 0);
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
