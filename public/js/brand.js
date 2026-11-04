// Branding: logo and title from the settings, colours via /brand.css
import { h } from './dom.js';
import { state } from './state.js';

const version = () => state.boot?.brand?.logo || 'default';
export const logoUrl = () => `/brand/logo?v=${encodeURIComponent(version())}`;

/** Logo at a fixed height; wide company logos keep their aspect ratio */
export function brandLogo(height) {
  return h('img.brand-logo', { src: logoUrl(), alt: '', height, style: { height: `${height}px` } });
}

/** Title next to the logo (can be turned off if the logo already contains the name) */
export function brandTitle() {
  if (state.boot?.brand?.logo && state.boot.brand.showTitle === false) return null;
  return h('span', state.boot?.app?.title || 'Helfi.Space');
}

/** After a change, apply colours and favicon without reloading */
export function refreshBrandAssets() {
  const css = document.querySelector('link[href^="/brand.css"]');
  if (css) css.href = `/brand.css?t=${Date.now()}`;
  const fav = document.querySelector('link[rel="icon"]');
  if (fav) fav.href = logoUrl();
}
