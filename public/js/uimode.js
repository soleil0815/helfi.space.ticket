// Which UI fits this device: the app-like mobile UI under /m (phones) or the desktop UI.
// Phones get the mobile UI automatically; a saved preference ('helfi.ui') overrides the detection.
// No imports – both UIs load this module before anything is rendered.

export const UI_KEY = 'helfi.ui';

/** Saved preference: 'mobile' | 'desktop' | null (automatic) */
export function getUiPref() {
  try {
    const v = localStorage.getItem(UI_KEY);
    return v === 'mobile' || v === 'desktop' ? v : null;
  } catch { return null; }
}

export function setUiPref(value) {
  try {
    if (value === 'mobile' || value === 'desktop') localStorage.setItem(UI_KEY, value);
    else localStorage.removeItem(UI_KEY);
  } catch { /* private mode etc. – then detection decides */ }
}

/** Phone: touch-only device with a small screen. Tablets (shorter side ≥ 600 px) and desktops are not phones. */
export function isPhone() {
  try {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches
      && Math.min(window.screen.width, window.screen.height) < 600;
  } catch { return false; }
}

/** Should the mobile UI be shown? */
export function wantsMobile() {
  const pref = getUiPref();
  if (pref) return pref === 'mobile';
  return isPhone();
}

/**
 * "?ui=desktop" opens one desktop page without changing the preference (e.g. "Open in desktop view"
 * from the mobile UI). The parameter is removed from the address; true if it was present.
 */
export function takeDesktopOnce() {
  try {
    const url = new URL(location.href);
    if (url.searchParams.get('ui') !== 'desktop') return false;
    url.searchParams.delete('ui');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    return true;
  } catch { return false; }
}

/** Mobile counterpart of a desktop address – null if the page exists only in the desktop UI (admin, reports, …). */
export function mobileUrlFor(pathname, search = '') {
  const q = new URLSearchParams(search);
  if (pathname === '/login') return `/m/login${search}`;
  if (pathname === '/' || pathname === '/my' || pathname === '/requests' || pathname === '/issues') {
    const term = (q.get('q') || '').trim();
    return term ? `/m/tickets?q=${encodeURIComponent(term)}` : '/m/';
  }
  let m = /^\/browse\/([^/]+)$/.exec(pathname);
  if (m) return `/m/t/${m[1]}`;
  if (pathname === '/kb') return '/m/kb';
  m = /^\/kb\/(\d+)$/.exec(pathname);
  if (m) return `/m/kb/${m[1]}`;
  if (pathname === '/news') return '/m/news';
  if (pathname === '/profile') return '/m/me';
  if (pathname === '/catalog') return '/m/new';
  m = /^\/catalog\/(\d+)$/.exec(pathname);
  if (m) return `/m/new/c/${m[1]}`;
  return null;
}

/** Desktop counterpart of a mobile address */
export function desktopUrlFor(pathname, search = '') {
  const p = pathname.replace(/\/+$/, '') || '/m';
  if (p === '/m') return '/';
  if (p === '/m/login') return `/login${search}`;
  if (p === '/m/tickets') return `/issues${search}`;
  let m = /^\/m\/t\/([^/]+)$/.exec(p);
  if (m) return `/browse/${m[1]}`;
  if (p === '/m/kb') return '/kb';
  m = /^\/m\/kb\/(\d+)$/.exec(p);
  if (m) return `/kb/${m[1]}`;
  if (p === '/m/news') return '/news';
  if (p === '/m/me' || p === '/m/me/2fa') return '/profile';
  m = /^\/m\/new\/c\/(\d+)$/.exec(p);
  if (m) return `/catalog/${m[1]}`;
  return '/';
}
