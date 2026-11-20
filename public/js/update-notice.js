// "Version X is available" – for admins, in the administration (desktop) and under "Me" (phone app).
// The server checks GitHub daily (src/update-check.js); here only the notice with the command to update.
import { api } from '/js/api.js';
import { h, icon, toast } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';

/** Command block with a copy button */
function command(text) {
  const copy = h('button.update-copy', {
    type: 'button', title: t('update.copy'), 'aria-label': t('update.copy'),
    onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast(t('update.copied'), 'success'); } catch { /* no clipboard: the text can be selected */ }
    },
  }, icon('copy'));
  return h('div.update-cmd', h('code', text), copy);
}

/**
 * u: { version, installed, notes, pinned } from the server. onChange(): after "Skip this version".
 * Returns null if there is nothing to show.
 */
export function updateNotice(u = state.boot?.update, { onChange } = {}) {
  if (!u) return null;
  const skip = h('button.btn.btn-subtle.small', {
    type: 'button', 'data-update-skip': '',
    onclick: async () => {
      try {
        await api.admin.skipUpdate(u.version);
        if (state.boot) state.boot.update = null;
        box.remove();
        document.querySelectorAll('[data-update-dot]').forEach((d) => d.remove());
        toast(t('update.skipped', u), 'success');
        onChange?.();
      } catch (e) { toast(e.message, 'error'); }
    },
  }, t('update.skip'));
  const box = h('section.update-notice', { 'data-update-notice': '', role: 'status' },
    h('div.update-head', icon('download'),
      h('div',
        h('strong', t('update.available', u)),
        h('div.update-sub', t('update.installed', u), ' · ', h('a', { href: u.notes, target: '_blank', rel: 'noopener noreferrer' }, t('update.notes'))))),
    h('p.update-how', t('update.how')),
    command('./update.sh'),
    u.pinned
      ? h('p.update-how', t('update.pinned', u))
      : h('p.update-how', t('update.manual')),
    command(u.pinned ? `HELFI_VERSION=${u.version}` : 'docker compose pull && docker compose up -d'),
    u.pinned ? command('docker compose pull && docker compose up -d') : null,
    h('div.update-actions', skip));
  return box;
}
