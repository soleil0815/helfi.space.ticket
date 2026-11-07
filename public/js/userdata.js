// Data of the signed-in account that the browser keeps between pages (unsent drafts of the mobile UI,
// unsaved knowledge article drafts, recently viewed articles and tickets). It must never reach the next account on the same device: everything is
// removed on sign-out (mobile and desktop), when the session expires, and when another account signs
// in. No imports – both UIs use this module.
const UID_KEY = 'helfi.m.uid'; // sessionStorage: account of this tab (drafts of the tab)
const LOCAL_UID_KEY = 'helfi.uid'; // localStorage: account the lists and drafts below belong to
const SESSION_PREFIXES = ['helfi.m.draft.', 'helfi.m.newTicket'];
const RECENT_TICKETS = 'helfi.recentTickets';
const LOCAL_KEYS = ['helfi.m.kbRecent', RECENT_TICKETS, LOCAL_UID_KEY];
// Unsaved knowledge article and template drafts of the desktop editor (views/kb.js)
const LOCAL_PREFIXES = ['helfi.kbdraft.', 'helfi.kbtpl.'];

function clearSession() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k === UID_KEY || SESSION_PREFIXES.some((p) => k.startsWith(p))) sessionStorage.removeItem(k);
  } catch { /* storage blocked */ }
}

function clearLocal() {
  try {
    for (const k of Object.keys(localStorage)) if (LOCAL_KEYS.includes(k) || LOCAL_PREFIXES.some((p) => k.startsWith(p))) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
}

/** Remove all drafts and per-account lists (keeps the "continue after sign-in" address) */
export function clearUserData() {
  clearSession();
  clearLocal();
}

/**
 * The signed-in account: data of another account than before goes. Tab drafts are checked against
 * the account of this tab (sessionStorage), the lists and drafts in localStorage against the account
 * that stored them – a new tab or app start of the same account keeps them.
 */
export function noteUser(id) {
  if (!id) return;
  const uid = String(id);
  try {
    if (sessionStorage.getItem(UID_KEY) !== uid) {
      clearSession();
      sessionStorage.setItem(UID_KEY, uid);
    }
  } catch { /* storage blocked */ }
  try {
    if (localStorage.getItem(LOCAL_UID_KEY) !== uid) {
      clearLocal();
      localStorage.setItem(LOCAL_UID_KEY, uid);
    }
  } catch { /* storage blocked */ }
}

/** Recently opened tickets (search suggestions when the field is empty): newest first, at most 8 */
export function rememberTicket(tk) {
  if (!tk?.key) return;
  try {
    const entry = { key: tk.key, title: String(tk.title || '').slice(0, 200), type: tk.type, status: tk.status };
    const list = recentTickets().filter((x) => x.key !== tk.key);
    localStorage.setItem(RECENT_TICKETS, JSON.stringify([entry, ...list].slice(0, 8)));
  } catch { /* storage blocked */ }
}

export function recentTickets() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_TICKETS) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.key === 'string') : [];
  } catch { return []; }
}
