// "Me" tab: account (name/email and password for local accounts), two-factor sign-in, language,
// install as app, news, desktop view, sign out – plus the news and two-factor pages.
import { THEMES, getTheme, setTheme } from '/js/theme.js';
import { api } from '/js/api.js';
import { h, icon, avatar, fmtDate, toast } from '/js/dom.js';
import { t, getLang } from '/js/i18n.js';
import { state } from '/js/state.js';
import { coffeeBox } from '/js/coffee.js';
import { setUiPref, desktopUrlFor } from '/js/uimode.js';
import { setLanguage, signOut, reloadBase } from '../main.js';
import { listRow, emptyState, skeletonList } from '../ui.js';
import { openSheet } from '../sheet.js';
import { rerender, dataChanged } from '../router.js';
import { mfaSetupSteps, recoveryCodesView } from '../mfa.js';
import { passkeySupported, passkeysHere, passkeyAdd, passkeyCancelled, defaultPasskeyName } from '/js/passkey.js';
import { isStandalone, isIos, canPromptInstall, promptInstall, onInstallChange } from '../pwa.js';

/** Switch to the desktop UI for good (saved preference; the desktop user menu offers the way back) */
export function switchToDesktop(path = location.pathname) {
  setUiPref('desktop');
  location.assign(desktopUrlFor(path, ''));
}

const group = (title, ...rows) => h('section.m-group', title ? h('h2.m-group-title', title) : null, h('div.m-group-rows', ...rows));
let fid = 0;
const fieldEl = (label, input, hint) => {
  input.id = input.id || `me-${++fid}`;
  return h('div.m-field', h('label', { for: input.id }, label), input, hint ? h('div.m-field-hint', hint) : null);
};

export function renderMe(page) {
  page.title(t('m.tab.me'));
  const u = state.user;
  const langBtn = (l, label) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(getLang() === l), class: getLang() === l ? 'active' : '',
    onclick: () => { if (getLang() !== l) setLanguage(l); },
  }, label);
  const local = u.source === 'local';
  const mfaOn = !!state.boot?.mfa?.enabled;
  const installed = isStandalone();

  page.body.replaceChildren(
    h('div.m-profile',
      avatar(u, 'xl'),
      h('div.m-profile-name', u.displayName),
      h('div.m-profile-sub', [t(`role.${u.role}`), u.email].filter(Boolean).join(' · '))),
    group(t('m.me.account'),
      local ? listRow({ icon: 'user', label: t('profile.personal'), hint: u.email || u.displayName, onClick: openPersonal, trailing: icon('chevron-right', 'm-row-chevron') }) : null,
      local && u.hasPassword ? listRow({ icon: 'key', label: t('profile.changePassword'), onClick: openPassword, trailing: icon('chevron-right', 'm-row-chevron') }) : null,
      local ? null : h('div.m-row.m-row-static', h('span.m-row-icon', icon('user')),
        h('span.m-row-text', h('span.m-row-label', t('profile.personal')), h('span.m-row-hint', t(u.source === 'email' ? 'profile.personalContact' : 'profile.personalExternal')))),
      listRow({
        icon: 'shield', label: t('mfa.title'), href: '/m/me/2fa',
        trailing: h(`span.m-status-chip${mfaOn ? '.on' : ''}`, mfaOn ? t('mfa.statusOn') : t('mfa.statusOff')),
      }),
      // Passkeys: sign in with Face ID/Touch ID (local and AD accounts; SSO signs in at the provider)
      state.boot?.auth?.passkeys && ['local', 'ldap'].includes(u.source)
        ? listRow({ icon: 'passkey', label: t('passkey.title'), hint: t('m.passkey.rowHint'), href: '/m/me/passkeys' }) : null),
    group(t('app.language'),
      h('div.m-row.m-row-static',
        h('div.m-segmented', { role: 'radiogroup', 'aria-label': t('app.language') }, langBtn('de', 'Deutsch'), langBtn('en', 'English')))),
    // Colour theme: system / light / dark (applied at once, remembered with the account)
    group(t('theme.title'),
      h('div.m-row.m-row-static',
        h('div.m-segmented.m-theme', { role: 'radiogroup', 'aria-label': t('theme.title') }, ...THEMES.map((th) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(getTheme() === th), class: getTheme() === th ? 'active' : '', 'data-theme-choice': th,
          onclick: async () => { await setTheme(th); renderMe(page); },
        }, t(`theme.${th}`)))))),
    group(null,
      listRow({
        icon: 'smartphone', label: installed ? t('m.app.installedTitle') : t('m.app.install'), hint: installed ? t('m.app.installedHint') : t('m.app.installHint'),
        onClick: openInstall, trailing: icon('chevron-right', 'm-row-chevron'),
      }),
      listRow({ icon: 'info', label: t('news.title'), href: '/m/news' }),
      // Installed app: no way into the desktop UI (no address bar there to come back)
      installed ? null : listRow({ icon: 'monitor', label: t('m.me.desktop'), hint: t('m.me.desktopHint'), onClick: () => switchToDesktop('/m/me') })),
    group(null,
      listRow({ icon: 'logout', label: t('app.logout'), danger: true, onClick: () => signOut() })),
    h('p.m-version', `Helfi.Space ${state.boot.app.version} · `, h('a', { href: state.boot.app.sourceUrl, target: '_blank', rel: 'noopener noreferrer', title: t('app.sourceTitle') }, t('app.source'))),
    // Support link for the developer – admins only
    u.role === 'admin' ? h('div.m-coffee', coffeeBox({ stacked: true })) : null);
  // Shown again after a change (e.g. two-factor switched on): draw anew
  page.refresh = async () => renderMe(page);
}

// ---------- Name and email (local accounts, as in the desktop profile) ----------
function openPersonal() {
  const u = state.user;
  const name = h('input', { value: u.displayName, maxLength: 120, required: true, autocomplete: 'name' });
  const email = h('input', { type: 'email', value: u.email || '', maxLength: 254, autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', disabled: !!u.selfRegistered });
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const pwRow = fieldEl(t('profile.currentPassword'), pw, t('profile.emailNeedsPassword'));
  const sync = () => { const changed = email.value.trim().toLowerCase() !== (u.email || '').toLowerCase(); pwRow.hidden = !changed; pw.required = changed; };
  email.addEventListener('input', sync);
  sync();
  const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
  const btn = h('button.m-btn.m-btn-primary', { type: 'submit', form: 'm-personal' }, t('app.save'));
  const form = h('form#m-personal.m-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (!name.value.trim()) { name.focus(); return; }
      btn.disabled = true;
      try {
        const patch = { displayName: name.value.trim(), email: email.value.trim() };
        if (!pwRow.hidden) patch.currentPassword = pw.value;
        const r = await api.updateMe(patch);
        Object.assign(state.user, r.user);
        await reloadBase().catch(() => {});
        toast(t('app.saved'), 'success');
        sheet.close();
        rerender();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    },
  }, err, fieldEl(t('users.displayName'), name), fieldEl(t('users.email'), email, t(u.selfRegistered ? 'profile.emailFixed' : 'profile.emailHint')), pwRow);
  const sheet = openSheet({ title: t('profile.personal'), content: form, footer: [h('button.m-btn', { type: 'button', onclick: () => sheet.close() }, t('app.cancel')), btn] });
}

// ---------- Password (local accounts with a password) ----------
function openPassword() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10 });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10 });
  const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
  const btn = h('button.m-btn.m-btn-primary', { type: 'submit', form: 'm-password' }, t('app.save'));
  const form = h('form#m-password.m-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (pw.value !== pw2.value) { err.textContent = t('setup.passwordMismatch'); err.hidden = false; pw2.focus(); return; }
      btn.disabled = true;
      try {
        await api.updateMe({ currentPassword: cur.value, newPassword: pw.value });
        toast(t('m.me.passwordChanged'), 'success');
        sheet.close();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    },
  }, err, fieldEl(t('profile.currentPassword'), cur), fieldEl(t('profile.newPassword'), pw, t('m.me.passwordHint')), fieldEl(t('setup.password2'), pw2));
  const sheet = openSheet({ title: t('profile.changePassword'), content: form, footer: [h('button.m-btn', { type: 'button', onclick: () => sheet.close() }, t('app.cancel')), btn] });
}

// ---------- Install as app ----------
function openInstall() {
  const body = h('div.m-install');
  const step = (n, ...text) => h('li.m-step', h('span.m-step-n', { 'aria-hidden': 'true' }, String(n)), h('div.m-step-body', h('p', ...text)));
  const draw = () => {
    if (isStandalone()) {
      body.replaceChildren(h('div.m-alert.m-alert-success', icon('check'), h('span', t('m.app.installedText'))));
      return;
    }
    const ios = h('section.m-install-os', { 'data-os': 'ios' }, h('h3', t('m.app.iosTitle')),
      h('ol.m-steps.m-steps-compact',
        step(1, t('m.app.ios1')),
        step(2, t('m.app.ios2a'), ' ', h('span.m-kbd', icon('share')), ' ', t('m.app.ios2b')),
        step(3, h('strong', t('m.app.ios3')), ' ', t('m.app.ios3b')),
        step(4, t('m.app.ios4'))));
    const android = h('section.m-install-os', { 'data-os': 'android' }, h('h3', t('m.app.androidTitle')),
      canPromptInstall() ? h('button.m-btn.m-btn-primary.m-btn-block.m-install-btn', {
        type: 'button', onclick: async () => { if (await promptInstall()) toast(t('m.app.installing'), 'success'); draw(); },
      }, icon('download'), t('m.app.installNow')) : null,
      h('ol.m-steps.m-steps-compact',
        step(1, t('m.app.android1')),
        step(2, t('m.app.android2a'), ' ', h('span.m-kbd', '⋮'), ' ', t('m.app.android2b')),
        step(3, h('strong', t('m.app.android3')), ' ', t('m.app.android3b'))));
    body.replaceChildren(
      h('p.m-muted', t('m.app.intro')),
      ...(isIos() ? [ios, android] : [android, ios]),
      h('p.m-sheet-note', icon('lock'), h('span', t('m.app.privacy'))));
  };
  draw();
  const off = onInstallChange(draw);
  openSheet({ title: t('m.app.install'), content: body, className: 'm-sheet-install', onClose: off });
}

// ---------- Passkeys ----------
export async function renderPasskeys(page) {
  page.title(t('passkey.title'));
  page.body.replaceChildren(skeletonList(1));
  await draw();

  async function draw() {
    let st;
    try { st = await api.passkeys(); } catch (e) { page.body.replaceChildren(h('div.m-alert.m-alert-error', e.message)); return; }
    const intro = h('p.m-intro', t('passkey.intro'));
    if (!st.available) {
      page.body.replaceChildren(intro, h('div.m-alert.m-alert-info', icon('info'), h('span', t(`passkey.reason.${st.reason}`))));
      return;
    }
    const rows = st.passkeys.map((p) => listRow({
      icon: 'passkey', label: p.name,
      hint: [p.lastUsedAt ? t('passkey.lastUsed', { date: fmtDate(p.lastUsedAt) }) : t('passkey.neverUsed'), p.synced ? t('passkey.synced') : null].filter(Boolean).join(' · '),
      onClick: () => openPasskey(p),
    }));
    let add;
    if (!passkeySupported()) add = h('div.m-alert.m-alert-info', icon('info'), h('span', t('passkey.unsupported')));
    else if (!passkeysHere(state.boot.auth.passkeys)) add = h('div.m-alert.m-alert-info', icon('info'), h('span', t('passkey.wrongHost', { host: state.boot.auth.passkeys })));
    else if (!st.canAdd) add = h('div.m-alert.m-alert-info', icon('info'), h('span', t('passkey.addOnlyInternal')));
    else {
      const btn = h('button.m-btn.m-btn-primary.m-btn-block', {
        type: 'button', 'data-passkey-add': '',
        onclick: async () => {
          btn.disabled = true;
          try { await passkeyAdd(defaultPasskeyName()); toast(t('passkey.added')); await draw(); }
          catch (e) { if (!passkeyCancelled(e)) toast(e.message, 'error'); }
          finally { btn.disabled = false; }
        },
      }, icon('passkey'), t('passkey.add'));
      add = h('div.m-passkey-add', btn, h('p.m-muted.m-small', t('m.passkey.addHint')));
    }
    page.body.replaceChildren(intro,
      rows.length ? group(null, ...rows) : h('p.m-muted.m-passkey-none', t('passkey.none')),
      add);
  }

  function openPasskey(p) {
    const name = h('input', { value: p.name, maxLength: 60, required: true });
    const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
    const sheet = openSheet({
      title: p.name,
      content: h('form#m-passkey.m-form', {
        onsubmit: async (e) => {
          e.preventDefault();
          if (!name.value.trim()) return;
          try { await api.passkeyRename(p.id, name.value.trim()); sheet.close(); await draw(); } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        },
      },
      err,
      fieldEl(t('passkey.name'), name, t('passkey.created', { date: fmtDate(p.createdAt, false) })),
      h('button.m-btn.m-btn-primary.m-btn-block', { type: 'submit' }, t('app.save')),
      h('button.m-btn.m-btn-block.m-btn-danger', {
        type: 'button', 'data-passkey-remove': '',
        onclick: async () => {
          if (!confirm(t('passkey.removeConfirm', { name: p.name }))) return;
          try { await api.passkeyRemove(p.id); sheet.close(); toast(t('passkey.removed')); await draw(); } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        },
      }, t('passkey.remove'))),
    });
  }
}

// ---------- Two-factor sign-in ----------
export async function renderMfa(page) {
  page.title(t('mfa.title'));
  page.body.replaceChildren(skeletonList(1));
  await draw();

  async function draw() {
    const st = await api.mfaStatus();
    const modeText = { off: t('mfa.modeOffInfo'), external: t('mfa.modeExternalInfo'), always: t('mfa.modeAlwaysInfo'), internal: t('mfa.modeInternalInfo') }[st.mode];
    const where = h('p.m-muted.m-small', icon(st.network.internal ? 'check' : 'globe'), ' ', t(st.network.internal ? 'mfa.youAreInternal' : 'mfa.youAreExternal', { ip: st.network.ip }));
    const statusCard = (on) => h('div.m-card.m-mfa-status',
      h('div.m-mfa-status-head', h('span.m-row-icon', icon('shield')), h('strong', t('mfa.title')), h('span.spacer'),
        h(`span.m-status-chip${on ? '.on' : ''}`, on ? t('mfa.statusOn') : t('mfa.statusOff'))),
      modeText ? h('p', modeText) : null,
      on ? h('p.m-muted', t('mfa.recoveryLeft', { n: st.recoveryCodesLeft })) : null,
      where);

    if (st.sso === 'always' && !st.enabled) {
      page.body.replaceChildren(statusCard(false), h('div.m-alert.m-alert-info', icon('info'), h('span', t('mfa.ssoInfo'))));
      return;
    }
    if (!st.enabled) {
      const start = h('button.m-btn.m-btn-primary.m-btn-block.m-mfa-start', {
        type: 'button', disabled: !st.canSetup,
        onclick: async () => {
          start.disabled = true;
          try {
            const info = await api.mfaSetup();
            page.body.replaceChildren(
              h('p.m-intro', t('m.mfa.intro')),
              mfaSetupSteps(info, {
                confirm: async (code) => (await api.mfaEnable(code)).recoveryCodes,
                onDone: async () => { await refreshBoot(); draw().catch((e) => toast(e.message, 'error')); },
              }));
            page.scroll.scrollTop = 0;
          } catch (e) { toast(e.message, 'error'); start.disabled = false; }
        },
      }, icon('shield'), t('mfa.setup'));
      page.body.replaceChildren(
        statusCard(false),
        st.sso === 'confirmed' ? h('div.m-alert.m-alert-info', icon('info'), h('span', t('mfa.ssoInfoConfirmed'))) : null,
        st.canSetup ? h('p.m-intro', t('m.mfa.startText')) : h('div.m-alert.m-alert-info', icon('info'), h('span', t('mfa.setupOnlyInternal'))),
        start);
      return;
    }
    const withCode = (title, run) => () => {
      const code = h('input.m-code', { inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 9, placeholder: '123456', 'aria-label': t('m.mfa.codeLabel') });
      const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
      const ok = h('button.m-btn.m-btn-primary', { type: 'submit', form: 'm-mfa-code' }, t('app.ok'));
      const form = h('form#m-mfa-code.m-form', {
        onsubmit: async (e) => {
          e.preventDefault();
          if (!code.value.trim()) { code.focus(); return; }
          ok.disabled = true; err.hidden = true;
          try { await run(code.value.trim(), sheet); } catch (ex) { err.textContent = ex.message; err.hidden = false; ok.disabled = false; code.value = ''; code.focus(); }
        },
      }, h('p.m-muted', t('mfa.confirmWithCode')), err, code);
      const sheet = openSheet({ title, content: form, footer: [h('button.m-btn', { type: 'button', onclick: () => sheet.close() }, t('app.cancel')), ok] });
      setTimeout(() => code.focus(), 320);
    };
    page.body.replaceChildren(
      statusCard(true),
      group(null,
        listRow({
          icon: 'refresh', label: t('mfa.newRecovery'), onClick: withCode(t('mfa.newRecovery'), async (code, sheet) => {
            const r = await api.mfaNewRecovery(code);
            sheet.close();
            page.body.replaceChildren(recoveryCodesView(r.recoveryCodes, { onDone: () => draw().catch((e) => toast(e.message, 'error')) }));
            page.scroll.scrollTop = 0;
          }),
        }),
        listRow({
          icon: 'close', label: t('mfa.disable'), danger: true, onClick: withCode(t('mfa.disable'), async (code, sheet) => {
            await api.mfaDisable(code);
            sheet.close();
            toast(t('mfa.disabled'));
            await refreshBoot();
            await draw();
          }),
        })));
  }
}

async function refreshBoot() {
  dataChanged();
  try { state.boot = await api.bootstrap(); } catch { /* keep the old one */ }
}

const newsText = (i) => (getLang() === 'en' ? i.en : i.de) || i.de || i.en || '';

export async function renderNews(page) {
  page.title(t('news.title'));
  page.body.replaceChildren(skeletonList(2));
  const { entries } = await api.news();
  if (state.boot.news) { state.boot.news = null; api.newsSeen().catch(() => { /* next time */ }); }
  page.body.replaceChildren(
    h('p.m-intro', t('news.intro')),
    ...(entries.length
      ? entries.map((e) => h('section.m-card.m-news',
        h('h2', `Helfi.Space ${e.version}`, e.date ? h('span.m-muted', fmtDate(e.date, false)) : null),
        h('ul', e.items.map((i) => h('li', newsText(i))))))
      : [emptyState('info', t('news.none'))]));
}
