// Knowledge articles from other systems: HTML → the text format of the knowledge base.
// Uses the same converter as pasting into the editor (public/js/kbdoc.js toMarkdown) on a server-side
// DOM (linkedom), so imported articles look like pasted ones. Pictures are loaded and stored by the
// caller (image), links to other imported articles become placeholders that are resolved once all
// articles are there (link).
import { parseHTML } from 'linkedom';
import { toMarkdown, PANEL_KINDS } from '../../public/js/kbdoc.js';

/** Placeholder for a link to another imported article: /kb/~imp~<key as base64url> */
export const linkPlaceholder = (key) => `/kb/~imp~${Buffer.from(String(key)).toString('base64url')}`;
export const PLACEHOLDER_RE = /\/kb\/~imp~([A-Za-z0-9_-]{1,2000})/g;
export const placeholderKey = (enc) => Buffer.from(enc, 'base64url').toString('utf8');

const MAX_HTML = 5 * 1024 * 1024; // larger articles are cut (and reported) before parsing

/** Common info box classes of help centers (Zendesk, Freshdesk, Confluence HTML) → info/tip/warning. Whole class names only. */
const PANEL_CLASSES = [
  [/^(alert-)?(warning|danger|error|caution)$|^confluence-information-macro-(warning|note)$|^callout-(warning|danger)$/, 'warning'],
  [/^(alert-)?(tip|success)$|^confluence-information-macro-tip$|^callout-tip$/, 'tip'],
  [/^(alert-)?(info|information|note|notice)$|^callout(-info)?$|^confluence-information-macro-information$/, 'info'],
];
function panelKindOf(el) {
  const classes = String(el.getAttribute('class') || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const [re, kind] of PANEL_CLASSES) if (classes.some((c) => re.test(c))) return kind;
  return null;
}

/**
 * @param {string} html
 * @param {object} o
 * @param {(src: string, alt: string) => Promise<string|null>} [o.image] stored picture → /api/kb/images/… (null: leave out)
 * @param {(href: string) => string|null} [o.link] link target: a new href (e.g. a placeholder) or null to keep it
 * @returns {Promise<{ markdown: string, truncated: boolean, droppedImages: number }>}
 */
export async function htmlToMarkdown(html, { image = async () => null, link = () => null } = {}) {
  let src = String(html || '');
  const truncated = src.length > MAX_HTML;
  if (truncated) src = src.slice(0, MAX_HTML);
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${src}</body></html>`);
  const body = document.body;
  // Info boxes of help centers → the box of the knowledge base (kb-panel with info / tip / warning)
  for (const el of [...body.querySelectorAll('div, aside')]) {
    if (el.classList.contains('kb-panel')) continue;
    const kind = panelKindOf(el);
    if (!kind || !el.textContent.trim()) continue;
    el.classList.add('kb-panel');
    el.setAttribute('data-kind', PANEL_KINDS.includes(kind) ? kind : 'info');
  }
  // Pictures: loaded by the caller; what cannot be loaded is left out
  let droppedImages = 0;
  for (const img of [...body.querySelectorAll('img')]) {
    const s = img.getAttribute('src') || '';
    let url = null;
    try { url = s ? await image(s, img.getAttribute('alt') || '') : null; } catch { url = null; }
    if (url) img.setAttribute('src', url);
    else { droppedImages++; img.remove(); }
  }
  for (const a of [...body.querySelectorAll('a[href]')]) {
    const next = link(a.getAttribute('href') || '');
    if (next) a.setAttribute('href', next);
  }
  // trailing spaces (e.g. where a picture was left out) carry no meaning in the text format
  return { markdown: toMarkdown(body).replace(/[ \t]+$/gm, ''), truncated, droppedImages };
}

/** Text of an HTML snippet (titles from help centers can contain entities) */
export function htmlText(s) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${String(s || '').slice(0, 20000)}</body></html>`);
  return document.body.textContent.replace(/\s+/g, ' ').trim();
}

/** Escape text for HTML (when building HTML from plain text, e.g. FAQ fields or code macros) */
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
