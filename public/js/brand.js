// Erscheinungsbild: Logo und Titel aus den Einstellungen, Farben über /brand.css
import { h } from './dom.js';
import { state } from './app.js';

const version = () => state.boot?.brand?.logo || 'default';
export const logoUrl = () => `/brand/logo?v=${encodeURIComponent(version())}`;

/** Logo in fester Höhe; breite Firmenlogos behalten ihr Seitenverhältnis */
export function brandLogo(height) {
  return h('img.brand-logo', { src: logoUrl(), alt: '', height, style: { height: `${height}px` } });
}

/** Titel neben dem Logo (abschaltbar, wenn das Logo den Namen schon enthält) */
export function brandTitle() {
  if (state.boot?.brand?.logo && state.boot.brand.showTitle === false) return null;
  return h('span', state.boot?.app?.title || 'Helfi.Space');
}

/** Nach einer Änderung Farben und Favicon ohne Neuladen übernehmen */
export function refreshBrandAssets() {
  const css = document.querySelector('link[href^="/brand.css"]');
  if (css) css.href = `/brand.css?t=${Date.now()}`;
  const fav = document.querySelector('link[rel="icon"]');
  if (fav) fav.href = logoUrl();
}
