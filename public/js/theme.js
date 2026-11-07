// Colour theme: System (follows the device), Light or Dark. Stored with the account (all devices)
// and on this device (applied before the page is drawn, see theme-init.js).
import { api } from './api.js';
import { state } from './state.js';

export const THEMES = ['system', 'light', 'dark'];
const KEY = 'helfi.theme';

export function getTheme() {
  try { const v = localStorage.getItem(KEY); return THEMES.includes(v) ? v : 'system'; } catch { return 'system'; }
}

/** Apply on this device (no server call) */
export function applyTheme(theme) {
  const v = THEMES.includes(theme) ? theme : 'system';
  try { if (v === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* storage blocked */ }
  if (typeof window.helfiApplyTheme === 'function') window.helfiApplyTheme();
}

/** Choice in the menu: apply right away and remember it with the account */
export async function setTheme(theme) {
  applyTheme(theme);
  if (state.user) {
    state.user.theme = theme;
    try { await api.updateMe({ theme }); } catch { /* stays on this device */ }
  }
}

/** After signing in: the account's choice wins over the device (another device may have changed it) */
export function syncTheme(user) {
  if (user && THEMES.includes(user.theme) && user.theme !== getTheme()) applyTheme(user.theme);
}
