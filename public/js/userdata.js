// Data of the signed-in account that the browser keeps between pages (unsent drafts of the mobile UI,
// recently viewed articles). It must never reach the next account on the same device: everything is
// removed on sign-out (mobile and desktop), when the session expires, and when another account signs
// in. No imports – both UIs use this module.
const UID_KEY = 'helfi.m.uid';
const SESSION_PREFIXES = ['helfi.m.draft.', 'helfi.m.newTicket'];
const LOCAL_KEYS = ['helfi.m.kbRecent'];

/** Remove all drafts and per-account lists (keeps the "continue after sign-in" address) */
export function clearUserData() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k === UID_KEY || SESSION_PREFIXES.some((p) => k.startsWith(p))) sessionStorage.removeItem(k);
  } catch { /* storage blocked */ }
  try { for (const k of LOCAL_KEYS) localStorage.removeItem(k); } catch { /* storage blocked */ }
}

/** The account in this tab: another one than before → the old account's data goes */
export function noteUser(id) {
  if (!id) return;
  try {
    const prev = sessionStorage.getItem(UID_KEY);
    if (prev !== String(id)) {
      clearUserData();
      sessionStorage.setItem(UID_KEY, String(id));
    }
  } catch { /* storage blocked */ }
}
