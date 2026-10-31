// Eigenes Profil: Sprache, Kennwort (lokale Konten)
import { api } from '../api.js';
import { h, mount, avatar, field, select, toast } from '../dom.js';
import { t } from '../i18n.js';
import { state, setLanguage } from '../app.js';

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

  mount(content,
    h('div.page-head', h('h1', t('profile.title'))),
    h('section.panel.profile-card',
      avatar(u, 'xl'),
      h('div',
        h('h2', u.displayName),
        h('div.muted', u.username, u.email ? ` · ${u.email}` : ''),
        h('div.profile-tags', h('span.badge', t(`role.${u.role}`)), h('span.badge', t(`profile.source.${u.source}`))))),
    h('section.panel', h('h2', t('app.language')), field(t('app.language'), lang)),
    pwForm,
  );
}
