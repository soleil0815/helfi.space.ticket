// Own profile: language, password (local accounts)
import { api } from '../api.js';
import { h, mount, avatar, field, select, toast, icon, fmtDate } from '../dom.js';
import { passkeySupported, passkeysHere, passkeyAdd, passkeyCancelled, defaultPasskeyName } from '../passkey.js';
import { recoveryCodesBox } from './auth.js';
import { t } from '../i18n.js';
import { state, setLanguage, reloadBase } from '../app.js';
import { templatesPanel } from './canned.js';

export function renderProfile(content) {
  const u = state.user;
  const lang = select([['', t('profile.languageAuto')], ['de', 'Deutsch'], ['en', 'English']], u.language || '', {
    onchange: (e) => setLanguage(e.target.value || null),
  });

  // Activity in the ticket: newest or oldest first (saved in the account, applies on every device)
  const order = select([['newest', t('ticket.order.newest')], ['oldest', t('ticket.order.oldest')]], u.activityOrder || 'newest', {
    'data-activity-order-pref': '',
    onchange: async (e) => {
      const prev = u.activityOrder;
      try { await api.updateMe({ activityOrder: e.target.value }); u.activityOrder = e.target.value; toast(t('app.saved'), 'success'); }
      catch (ex) { e.target.value = prev || 'newest'; toast(ex.message, 'error'); }
    },
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

  // Name and email: set by local accounts themselves, otherwise they come from AD/SSO
  let personal;
  if (u.source === 'local') {
    const name = h('input', { value: u.displayName, maxLength: 120, required: true, autocomplete: 'name' });
    // Self-registered: the confirmed address is the sign-in name (only an admin changes it)
    const email = h('input', { type: 'email', value: u.email || '', maxLength: 254, autocomplete: 'email', disabled: !!u.selfRegistered });
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
    h('div.grid-2', field(t('users.displayName'), name), field(t('users.email'), email, t(u.selfRegistered ? 'profile.emailFixed' : 'profile.emailHint'))),
    pwRow,
    h('button.btn.btn-primary', { type: 'submit' }, t('app.save')));
    syncPw();
  } else {
    personal = h('section.panel', h('h2', t('profile.personal')), h('p.muted', t(u.source === 'email' ? 'profile.personalContact' : 'profile.personalExternal')));
  }

  const mfaPanel = h('section.panel', h('h2', t('mfa.title')), h('div.loading', t('app.loading')));
  drawMfa(mfaPanel);
  // Passkeys: only where they can work for this account (not for SSO accounts, not switched off)
  const pkPanel = h('section.panel', { id: 'passkeys', 'data-passkeys-panel': '', hidden: !state.boot.auth.passkeys || !['local', 'ldap'].includes(u.source) },
    h('h2', t('passkey.title')), h('div.loading', t('app.loading')));
  if (!pkPanel.hidden) drawPasskeys(pkPanel);

  mount(content,
    h('div.page-head', h('h1', t('profile.title'))),
    h('section.panel.profile-card',
      avatar(u, 'xl'),
      h('div',
        h('h2', u.displayName),
        h('div.muted', u.username, u.email ? ` · ${u.email}` : ''),
        h('div.profile-tags', h('span.badge', t(`role.${u.role}`)), h('span.badge', t(`profile.source.${u.source}`))))),
    personal,
    h('section.panel', h('h2', t('profile.display')), field(t('app.language'), lang),
      field(t('profile.activityOrder'), order, t('profile.activityOrderHint'))),
    pkPanel,
    mfaPanel,
    pwForm,
    state.isAgent ? (() => { const tp = templatesPanel({ shared: false }); tp.id = 'templates'; return tp; })() : null,
  );
  if (location.hash === '#templates') setTimeout(() => document.getElementById('templates')?.scrollIntoView({ behavior: 'smooth' }), 50);
}

async function drawPasskeys(panel) {
  let st;
  try { st = await api.passkeys(); } catch (e) { return mount(panel, h('h2', t('passkey.title')), h('div.form-error', e.message)); }
  const head = h('h2', t('passkey.title'));
  const intro = h('p.muted', t('passkey.intro'));
  if (!st.available) {
    if (st.reason === 'off' || st.reason === 'sso' || st.reason === 'noHttps') { panel.hidden = true; return; }
    // AD account without service account: say why (admins get the way to fix it)
    return mount(panel, head, intro, h('div.hint-box', icon('info'), h('div',
      h('p', t(`passkey.reason.${st.reason}`)),
      state.user.role === 'admin' ? h('p', h('a', { href: '/admin/ldap', 'data-link': '' }, t('passkey.adminAdLink'))) : null)));
  }
  const list = st.passkeys.length
    ? h('ul.passkey-list', st.passkeys.map((p) => h('li.passkey-item', { 'data-passkey': p.id },
      h('span.passkey-icon', icon('passkey')),
      h('div.passkey-text',
        h('strong', p.name),
        h('span.muted.small.block', t('passkey.created', { date: fmtDate(new Date(p.createdAt).toISOString(), false) }),
          ' · ', p.lastUsedAt ? t('passkey.lastUsed', { date: fmtDate(new Date(p.lastUsedAt).toISOString()) }) : t('passkey.neverUsed')),
        p.synced ? h('span.badge', { title: t('passkey.syncedHint') }, t('passkey.synced')) : null),
      h('div.passkey-actions',
        h('button.btn.btn-subtle.small', {
          type: 'button',
          onclick: async () => {
            const name = prompt(t('passkey.renamePrompt'), p.name);
            if (name === null || !name.trim()) return;
            try { await api.passkeyRename(p.id, name.trim()); drawPasskeys(panel); } catch (e) { toast(e.message, 'error'); }
          },
        }, t('passkey.rename')),
        h('button.btn.btn-subtle.small', {
          type: 'button', 'data-passkey-remove': '',
          onclick: async () => {
            if (!confirm(t('passkey.removeConfirm', { name: p.name }))) return;
            try { await api.passkeyRemove(p.id); toast(t('passkey.removed')); drawPasskeys(panel); } catch (e) { toast(e.message, 'error'); }
          },
        }, t('passkey.remove'))))))
    : h('p.muted', t('passkey.none'));

  let add = null;
  if (!passkeySupported()) add = h('div.hint-box', icon('info'), h('div', t('passkey.unsupported')));
  else if (!passkeysHere(state.boot.auth.passkeys)) add = h('div.hint-box', icon('info'), h('div', t('passkey.wrongHost', { host: state.boot.auth.passkeys })));
  else if (!st.canAdd) add = h('div.hint-box', icon('info'), h('div', t('passkey.addOnlyInternal')));
  else {
    const name = h('input', { value: defaultPasskeyName(), maxLength: 60, 'aria-label': t('passkey.name'), name: 'passkey-name' });
    const btn = h('button.btn.btn-primary', {
      type: 'button', 'data-passkey-add': '',
      onclick: async () => {
        btn.disabled = true;
        try { await passkeyAdd(name.value.trim()); toast(t('passkey.added'), 'success'); drawPasskeys(panel); }
        catch (e) { if (!passkeyCancelled(e)) toast(e.message, 'error'); }
        finally { btn.disabled = false; }
      },
    }, icon('passkey'), t('passkey.add'));
    add = h('div', field(t('passkey.name'), h('div.inline-form', name, btn), t('passkey.nameHint')));
  }
  mount(panel, head, intro, list, add);
}

async function drawMfa(panel) {
  const st = await api.mfaStatus();
  const codeField = () => h('input.code-input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 9, placeholder: '123456' });
  const where = h('p.muted.small', icon(st.network.internal ? 'check' : 'globe'), ' ',
    t(st.network.internal ? 'mfa.youAreInternal' : 'mfa.youAreExternal', { ip: st.network.ip }));
  const modeText = { off: t('mfa.modeOffInfo'), external: t('mfa.modeExternalInfo'), always: t('mfa.modeAlwaysInfo'), internal: t('mfa.modeInternalInfo') }[st.mode];

  // SSO always counts as a second factor: nothing to set up here
  if (st.sso === 'always' && !st.enabled) {
    return mount(panel, h('h2', t('mfa.title')), h('p', t('mfa.ssoInfo')), where);
  }
  // Only if the provider reports MFA: notice, setup remains possible
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
