// Eigenes Profil: Sprache, Kennwort (lokale Konten)
import { api } from '../api.js';
import { h, mount, avatar, field, select, toast, icon } from '../dom.js';
import { recoveryCodesBox } from './auth.js';
import { t } from '../i18n.js';
import { state, setLanguage, reloadBase } from '../app.js';
import { templatesPanel } from './canned.js';

export function renderProfile(content) {
  const u = state.user;
  const lang = select([['', t('profile.languageAuto')], ['de', 'Deutsch'], ['en', 'English']], u.language || '', {
    onchange: (e) => setLanguage(e.target.value || null),
  });

  let pwForm = null;
  if (u.source === 'local' && u.hasPassword) {
    const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10 });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10 });
    pwForm = h('form.panel', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (pw.value !== pw2.value) return toast(t('setup.passwordMismatch'), 'error');
        try {
          await api.updateMe({ currentPassword: cur.value, newPassword: pw.value });
          toast(t('app.saved'), 'success');
          e.target.reset();
        } catch (ex) { toast(ex.message, 'error'); }
      },
    }, h('h2', t('profile.changePassword')),
    field(t('profile.currentPassword'), cur),
    h('div.grid-2', field(t('profile.newPassword'), pw), field(t('setup.password2'), pw2)),
    h('button.btn.btn-primary', { type: 'submit' }, t('app.save')));
  }

  // Name und E-Mail: lokale Konten selbst, sonst kommen sie aus AD/SSO
  let personal;
  if (u.source === 'local') {
    const name = h('input', { value: u.displayName, maxLength: 120, required: true, autocomplete: 'name' });
    const email = h('input', { type: 'email', value: u.email || '', maxLength: 254, autocomplete: 'email' });
    const pwField = h('input', { type: 'password', autocomplete: 'current-password' });
    const pwRow = field(t('profile.currentPassword'), pwField, t('profile.emailNeedsPassword'));
    const syncPw = () => { const changed = email.value.trim().toLowerCase() !== (u.email || '').toLowerCase(); pwRow.hidden = !changed; pwField.required = changed; };
    email.addEventListener('input', syncPw);
    personal = h('form.panel', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const patch = { displayName: name.value.trim(), email: email.value.trim() };
          if (!pwRow.hidden) patch.currentPassword = pwField.value;
          const r = await api.updateMe(patch);
          Object.assign(state.user, r.user);
          toast(t('app.saved'), 'success');
          await reloadBase();
        } catch (ex) { toast(ex.message, 'error'); }
      },
    }, h('h2', t('profile.personal')),
    h('div.grid-2', field(t('users.displayName'), name), field(t('users.email'), email, t('profile.emailHint'))),
    pwRow,
    h('button.btn.btn-primary', { type: 'submit' }, t('app.save')));
    syncPw();
  } else {
    personal = h('section.panel', h('h2', t('profile.personal')), h('p.muted', t(u.source === 'email' ? 'profile.personalContact' : 'profile.personalExternal')));
  }

  const mfaPanel = h('section.panel', h('h2', t('mfa.title')), h('div.loading', t('app.loading')));
  drawMfa(mfaPanel);

  mount(content,
    h('div.page-head', h('h1', t('profile.title'))),
    h('section.panel.profile-card',
      avatar(u, 'xl'),
      h('div',
        h('h2', u.displayName),
        h('div.muted', u.username, u.email ? ` · ${u.email}` : ''),
        h('div.profile-tags', h('span.badge', t(`role.${u.role}`)), h('span.badge', t(`profile.source.${u.source}`))))),
    personal,
    h('section.panel', h('h2', t('app.language')), field(t('app.language'), lang)),
    mfaPanel,
    pwForm,
    state.isAgent ? (() => { const tp = templatesPanel({ shared: false }); tp.id = 'templates'; return tp; })() : null,
  );
  if (location.hash === '#templates') setTimeout(() => document.getElementById('templates')?.scrollIntoView({ behavior: 'smooth' }), 50);
}

async function drawMfa(panel) {
  const st = await api.mfaStatus();
  const codeField = () => h('input.code-input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 9, placeholder: '123456' });
  const where = h('p.muted.small', icon(st.network.internal ? 'check' : 'globe'), ' ',
    t(st.network.internal ? 'mfa.youAreInternal' : 'mfa.youAreExternal', { ip: st.network.ip }));
  const modeText = { off: t('mfa.modeOffInfo'), external: t('mfa.modeExternalInfo'), always: t('mfa.modeAlwaysInfo'), internal: t('mfa.modeInternalInfo') }[st.mode];

  // SSO zählt immer als zweiter Faktor: hier nichts einzurichten
  if (st.sso === 'always' && !st.enabled) {
    return mount(panel, h('h2', t('mfa.title')), h('p', t('mfa.ssoInfo')), where);
  }
  // Nur wenn der Anbieter MFA meldet: Hinweis, Einrichtung bleibt möglich
  const ssoNote = st.sso === 'confirmed' && !st.enabled ? h('p', t('mfa.ssoInfoConfirmed')) : null;

  if (!st.enabled) {
    const start = h('button.btn.btn-primary', {
      type: 'button', disabled: !st.canSetup,
      onclick: async () => {
        try {
          const info = await api.mfaSetup();
          const input = codeField();
          const err = h('div.form-error', { hidden: true });
          mount(panel, h('h2', t('mfa.title')),
            h('ol.mfa-steps', h('li', t('mfa.step1')), h('li', t('mfa.step2')), h('li', t('mfa.step3'))),
            h('img.qr', { src: info.qr, alt: t('mfa.qrAlt'), width: 180, height: 180 }),
            h('details', h('summary', t('mfa.manualKey')), h('code.mono.secret', info.secret.replace(/(.{4})/g, '$1 ').trim())),
            err,
            h('div.inline-form', input, h('button.btn.btn-primary', {
              type: 'button',
              onclick: async () => {
                try {
                  const r = await api.mfaEnable(input.value.trim());
                  state.boot = await api.bootstrap();
                  mount(panel, h('h2', t('mfa.enabledTitle')), recoveryCodesBox(r.recoveryCodes),
                    h('button.btn.btn-primary', { type: 'button', onclick: () => drawMfa(panel) }, t('mfa.done')));
                } catch (e) { err.textContent = e.message; err.hidden = false; }
              },
            }, t('mfa.activate'))));
          input.focus();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, icon('shield'), t('mfa.setup'));
    return mount(panel, h('h2', t('mfa.title')),
      h('p', h('span.badge', t('mfa.statusOff')), ' ', modeText),
      ssoNote,
      where,
      st.canSetup ? null : h('div.hint-box', icon('info'), h('div', t('mfa.setupOnlyInternal'))),
      start);
  }

  const action = (labelKey, fn) => {
    const input = codeField();
    const err = h('div.form-error', { hidden: true });
    return h('details', h('summary', t(labelKey)),
      h('p.muted.small', t('mfa.confirmWithCode')), err,
      h('div.inline-form', input, h('button.btn', {
        type: 'button',
        onclick: async () => { try { await fn(input.value.trim()); } catch (e) { err.textContent = e.message; err.hidden = false; } },
      }, t('app.ok'))));
  };

  mount(panel, h('h2', t('mfa.title')),
    h('p', h('span.badge.badge-ok', icon('check'), t('mfa.statusOn')), ' ', modeText),
    h('p.muted', t('mfa.recoveryLeft', { n: st.recoveryCodesLeft })),
    where,
    action('mfa.newRecovery', async (code) => {
      const r = await api.mfaNewRecovery(code);
      mount(panel, h('h2', t('mfa.recoveryTitle')), recoveryCodesBox(r.recoveryCodes), h('button.btn.btn-primary', { type: 'button', onclick: () => drawMfa(panel) }, t('mfa.done')));
    }),
    action('mfa.disable', async (code) => { await api.mfaDisable(code); toast(t('mfa.disabled')); drawMfa(panel); }));
}
