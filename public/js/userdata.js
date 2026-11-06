// Data of the signed-in account that the browser keeps between pages (unsent drafts of the mobile UI,
// recently viewed articles). It must never reach the next account on the same device: everything is
// removed on sign-out (mobile and desktop), when the session expires, and when another account signs
// in. No imports – both UIs use this module.
const UID_KEY = 'helfi.m.uid';
const SESSION_PREFIXES = ['helfi.m.draft.', 'helfi.m.newTicket'];
const RECENT_TICKETS = 'helfi.recentTickets';
const LOCAL_KEYS = ['helfi.m.kbRecent', RECENT_TICKETS];

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
