// Hint on the start page (desktop and phone app): "Sign in faster – set up a passkey".
// Only for people without a passkey, on a device that can add one right here (the server decides the rest:
// account type, network, setting, "later"/"never"). One check per sign-in, not per page.
import { h, icon, toast } from './dom.js';
import { t } from './i18n.js';
import { api } from './api.js';
import { state } from './state.js';
import { passkeysHere, passkeyAdd, passkeyCancelled, defaultPasskeyName } from './passkey.js';

let cache = null; // { userId, promise<boolean> }

/** Show the hint for the signed-in person? */
export function passkeyHintWanted() {
  const u = state.user;
  if (!u || !['local', 'ldap'].includes(u.source) || !passkeysHere(state.boot?.auth?.passkeys)) return Promise.resolve(false);
  if (cache?.userId !== u.id) cache = { userId: u.id, promise: api.passkeys().then((s) => !!s.prompt).catch(() => false) };
  return cache.promise;
}
const done = () => { if (cache) cache.promise = Promise.resolve(false); };

/**
 * The hint box. mobile: stacked buttons for the phone app.
 */
export function passkeyHint({ mobile = false } = {}) {
  const p = mobile ? 'm-' : '';
  const busy = (on) => box.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  const close = () => { done(); box.remove(); };
  const snooze = async (action) => {
    busy(true);
    try { await api.passkeyPrompt(action); close(); toast(t(action === 'never' ? 'passkey.hintNeverDone' : 'passkey.hintLaterDone')); }
    catch (e) { busy(false); toast(e.message, 'error'); }
  };
  const box = h(`div.${p}passkey-hint`, { role: 'region', 'aria-label': t('passkey.hintTitle'), 'data-passkey-hint': '' },
    h(`span.${p}passkey-hint-icon`, icon('passkey')),
    h(`div.${p}passkey-hint-text`,
      h('strong', t('passkey.hintTitle')),
      h('p', t('passkey.hintText'))),
    h(`div.${p}passkey-hint-actions`,
      h(mobile ? 'button.m-btn.m-btn-primary' : 'button.btn.btn-primary', {
        type: 'button', 'data-passkey-hint-add': '',
        onclick: async () => {
          busy(true);
          try { await passkeyAdd(defaultPasskeyName()); close(); toast(t('passkey.added'), 'success'); }
          catch (e) { busy(false); if (!passkeyCancelled(e)) toast(e.message, 'error'); }
        },
      }, icon('passkey'), t('passkey.hintAdd')),
      h(mobile ? 'button.m-btn' : 'button.btn.btn-subtle', { type: 'button', 'data-passkey-hint-later': '', onclick: () => snooze('later') }, t('passkey.hintLater')),
      h(mobile ? 'button.m-btn.m-btn-ghost' : 'button.btn.btn-subtle', { type: 'button', 'data-passkey-hint-never': '', onclick: () => snooze('never') }, t('passkey.hintNever'))));
  return box;
}

/** Put the hint at the top of a container once the check says so */
export async function attachPasskeyHint(container, opts) {
  if (!(await passkeyHintWanted())) return false;
  if (!container.isConnected || container.querySelector('[data-passkey-hint]')) return false;
  container.prepend(passkeyHint(opts));
  return true;
}
