// Pictures inside the app: a tap on an attached or embedded image opens it in a full-screen sheet
// instead of a new browser page – installed as an app there is no address bar and no way back from
// such a page. Back gesture, ✕, Esc or swiping down close it (like every sheet). Tap = zoom in/out.
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { openSheet } from './sheet.js';

// Ticket attachments (also images embedded in descriptions and replies) and knowledge base images
const IMAGE_HREF = /^\/api\/(attachments\/\d+|kb\/images\/[A-Za-z0-9_-]{16,64})$/;

/** Image address of a link around a picture in the app, or null (other links, downloads, foreign pages) */
export function imageHref(a) {
  if (!a || !a.querySelector?.('img')) return null;
  let url;
  try { url = new URL(a.getAttribute('href') || '', location.href); } catch { return null; }
  if (url.origin !== location.origin || url.search || !IMAGE_HREF.test(url.pathname)) return null;
  return url.pathname;
}

export function openImage(src, name = '') {
  const img = h('img.m-image-view-img', { src, alt: name });
  const frame = h('div.m-image-view', { onclick: () => frame.classList.toggle('zoomed') }, img);
  const download = src.startsWith('/api/attachments/')
    ? h('a.m-btn.m-btn-ghost', { href: `${src}?download=1`, download: name || '' }, icon('download'), t('m.image.download'))
    : null;
  return openSheet({ title: name || t('m.image.title'), className: 'm-sheet-image', content: frame, footer: download });
}

/** One listener for the whole app: image links open the viewer */
export function setupImageViewer(root = document) {
  root.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    const src = imageHref(a);
    if (!src) return;
    e.preventDefault();
    const name = a.getAttribute('aria-label')?.replace(/\s*\([^)]*\)\s*$/, '') || a.querySelector('img')?.getAttribute('alt') || '';
    openImage(src, name);
  }, true);
}
