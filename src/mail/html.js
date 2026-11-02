// HTML-Mails: bereinigen (nur harmlose Elemente), zitierten Verlauf einklappen, eingebettete Bilder zuordnen.
// Angezeigt wird das Ergebnis zusätzlich in einem abgeschotteten Rahmen mit eigener CSP (siehe viewerDocument).
import sanitizeHtml from 'sanitize-html';

export const MAX_HTML_BYTES = 1024 * 1024;
// Kann aus der Mail selbst nicht entstehen (class ist nicht erlaubt)
const QUOTE_OPEN = '<details class="helfi-quote"><summary></summary>';

const TAGS = [
  'a', 'abbr', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
  'pre', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'tt', 'u', 'ul',
];
const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*[\d.%\s,]+\)$/i, /^[a-z]{3,20}$/i];
const LENGTH = [/^-?\d+(\.\d+)?(px|pt|em|rem|%|cm|mm|in)?$/i, /^auto$/i];
const BOX = [/^(-?\d+(\.\d+)?(px|pt|em|rem|%|cm|mm)?\s*){1,4}$/i, /^auto$/i];
const BORDER = [/^[\w\s.#%(),-]{1,80}$/];
const STYLES = {
  color: COLOR, 'background-color': COLOR, background: [/^(#[0-9a-f]{3,8}|rgba?\([\d.%\s,]+\)|[a-z]{3,20})$/i],
  'font-family': [/^[\w\s"',.-]{1,120}$/], 'font-size': [...LENGTH, /^(xx-|x-)?(small|large)|medium|smaller|larger$/i],
  'font-weight': [/^(normal|bold|bolder|lighter|\d{3})$/i], 'font-style': [/^(normal|italic|oblique)$/i],
  'text-decoration': [/^[a-z\s-]{1,40}$/i], 'text-align': [/^(left|right|center|justify|start|end)$/i],
  'vertical-align': [/^(top|middle|bottom|baseline|text-top|text-bottom|sub|super)$/i], 'line-height': LENGTH,
  'white-space': [/^(normal|nowrap|pre|pre-wrap|pre-line)$/i], 'list-style-type': [/^[a-z-]{1,30}$/i],
  width: LENGTH, height: LENGTH, 'max-width': LENGTH, 'min-width': LENGTH,
  margin: BOX, 'margin-top': LENGTH, 'margin-bottom': LENGTH, 'margin-left': LENGTH, 'margin-right': LENGTH,
  padding: BOX, 'padding-top': LENGTH, 'padding-bottom': LENGTH, 'padding-left': LENGTH, 'padding-right': LENGTH,
  border: BORDER, 'border-top': BORDER, 'border-bottom': BORDER, 'border-left': BORDER, 'border-right': BORDER,
  'border-color': COLOR, 'border-width': BOX, 'border-style': [/^[a-z\s]{1,40}$/i], 'border-collapse': [/^(collapse|separate)$/i],
  'border-radius': BOX, display: [/^(block|inline|inline-block|none|table|table-row|table-cell)$/i],
};

/**
 * Stelle, ab der in einer Antwort-Mail der zitierte Verlauf beginnt (Outlook, Gmail, Apple Mail, Thunderbird).
 * Liefert den Index im Roh-HTML oder -1.
 */
export function quoteStart(html) {
  const markers = [
    /<div[^>]+id=["']?(appendonsend|divRplyFwdMsg|mail-editor-reference-message-container)\b/i,
    /<div[^>]+class=["'][^"']*\b(gmail_quote|moz-cite-prefix|yahoo_quoted|protonmail_quote)\b/i,
    /<blockquote[^>]+type=["']?cite\b/i,
    /-----\s*(Original Message|Ursprüngliche Nachricht|Originalnachricht)\s*-----/i,
  ];
  const hits = markers.map((re) => { const m = re.exec(html); return m ? m.index : -1; }).filter((i) => i > 0);
  if (!hits.length) return -1;
  const i = Math.min(...hits);
  // Textmarke („-----Original Message-----“): ab dem Tag davor schneiden
  if (html[i] !== '<') { const t = html.lastIndexOf('<', i); return t > 0 ? t : i; }
  return i;
}

/**
 * Roh-HTML einer Mail bereinigen.
 * opts.collapseQuote: zitierten Verlauf in <details> einklappen (Antworten).
 * Die Beschriftung des Aufklappers setzt viewerDocument in der Sprache des Betrachters ein.
 * Liefert { html, blocked (Anzahl externer Bilder), cids (verwendete Content-IDs) } oder null, wenn leer/zu groß.
 */
export function sanitizeMailHtml(raw, { collapseQuote = false } = {}) {
  let blocked = 0;
  const cids = new Set();
  const clean = (part) => sanitizeHtml(part, {
    allowedTags: TAGS,
    disallowedTagsMode: 'discard',
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head', 'xml', 'template', 'svg', 'math', 'object', 'iframe'],
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'dir', 'lang', 'title'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      font: ['color', 'face', 'size'],
      td: ['colspan', 'rowspan', 'nowrap'], th: ['colspan', 'rowspan', 'nowrap'],
      table: ['border', 'cellpadding', 'cellspacing'], col: ['span'], colgroup: ['span'],
      ol: ['start', 'type'], details: ['open'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['cid', 'data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    allowedStyles: { '*': STYLES },
    transformTags: {
      a: (tag, attribs) => ({ tagName: 'a', attribs: { ...(attribs.href ? { href: attribs.href } : {}), target: '_blank', rel: 'noopener noreferrer nofollow' } }),
      img: (tag, attribs) => {
        const src = String(attribs.src || '').trim();
        if (/^cid:/i.test(src)) { cids.add(src.slice(4).replace(/^<|>$/g, '').toLowerCase()); return { tagName: 'img', attribs }; }
        if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) return { tagName: 'img', attribs };
        // Bilder aus dem Internet (oft Zählpixel) nie laden
        if (src) blocked++;
        return { tagName: 'span', attribs: {}, text: '' };
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  }).trim();

  const source = String(raw || '');
  let out;
  const q = collapseQuote ? quoteStart(source) : -1;
  if (q > 0) {
    const main = clean(source.slice(0, q));
    const quoted = clean(source.slice(q));
    out = main + (quoted ? `${QUOTE_OPEN}${quoted}</details>` : '');
  } else {
    out = clean(source);
  }
  // Leer (nur Leerraum/Umbrüche) → kein HTML speichern
  const visible = out.replace(/<[^>]*>|&nbsp;|\s/g, '');
  if (!visible && !/<img/i.test(out)) return null;
  if (Buffer.byteLength(out) > MAX_HTML_BYTES) return null;
  return { html: out, blocked, cids: [...cids] };
}

/** cid:-Verweise durch Anhänge ersetzen; nicht gefundene Bilder entfernen. */
export function resolveCids(html, map) {
  return html.replace(/<img\b[^>]*?\ssrc="cid:([^"]+)"[^>]*>/gi, (tag, cid) => {
    const id = map.get(cid.replace(/^<|>$/g, '').toLowerCase());
    return id ? tag.replace(/src="cid:[^"]+"/i, `src="/api/attachments/${id}"`) : '';
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Komplettes Dokument für den Anzeigerahmen (eigene CSP setzt die Route). */
export function viewerDocument(html, { blocked = 0, blockedText = '', quoteText = '', lang = 'de' } = {}) {
  html = html.split(QUOTE_OPEN).join(`<details class="helfi-quote"><summary>${escapeHtml(quoteText)}</summary>`);
  const note = blocked ? `<p class="helfi-blocked">${escapeHtml(blockedText)}</p>` : '';
  return `<!doctype html><html lang="${lang === 'en' ? 'en' : 'de'}"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<style>
html,body{margin:0;padding:0;background:#fff}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans",Ubuntu,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";color:#172B4D;overflow-wrap:anywhere;padding:2px}
img{max-width:100%;height:auto}
table{max-width:100%}
a{color:#0C66E4}
p{margin:0 0 8px}
.helfi-blocked{font-size:12px;color:#626F86;background:#F7F8F9;border-radius:3px;padding:4px 8px;margin:0 0 8px}
.helfi-quote{margin-top:8px}
.helfi-quote>summary{cursor:pointer;color:#626F86;font-size:12px;list-style:none}
.helfi-quote>summary::before{content:"··· "}
.helfi-quote[open]>summary{margin-bottom:8px}
</style></head><body>${note}${html}</body></html>`;
}
