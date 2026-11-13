// Formatted comments (the text format of knowledge articles, see public/js/kbdoc.js) for mails:
// mdToText() → readable plain text without markup, mdToHtml() → small, safe HTML part.
// Everything is escaped; only http(s)/mailto links and links into this application are kept.
// All regular expressions are bounded/linear (input comes from users).
import { MENTION_RE } from './mentions.js';

const MAX = 100000;
export const MAIL_BODY = '\u0000HELFI_BODY\u0000'; // placeholder for the formatted text in a mail template

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unescape = (s) => String(s).replace(/\\([\\`*[\]~+|#>\-.:!_()])/g, '$1');

function safeHref(url, baseUrl) {
  const u = String(url || '').trim();
  if (/^https?:\/\/[^\s<>"]+$/i.test(u)) return u;
  if (/^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(u)) return u;
  if (/^\/(?![/\\])[^\s<>"\\]*$/.test(u)) return baseUrl ? `${baseUrl}${u}` : null;
  return null;
}

// ---------- Blocks ----------
const RE_LIST = /^(\s{0,12})([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const RE_FENCE = /^\s{0,3}```/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function parse(md) {
  const lines = String(md || '').slice(0, MAX).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (RE_FENCE.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (/^\s*:::(info|tip|warning)\s*$/.test(l)) {
      const inner = [];
      i++;
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) inner.push(lines[i++]);
      i++;
      blocks.push({ type: 'quote', children: parse(inner.join('\n')) });
      continue;
    }
    const hm = /^(#{1,3})\s+(.*)$/.exec(l);
    if (hm) { blocks.push({ type: 'heading', level: hm[1].length, text: hm[2] }); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (/^\s{0,3}>/.test(l)) {
      const inner = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
      blocks.push({ type: 'quote', children: parse(inner.join('\n')) });
      continue;
    }
    if (l.trim().startsWith('|') && RE_TABLE_SEP.test(lines[i + 1] || '')) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
      const head = cells(l);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (RE_LIST.test(l)) {
      const items = [];
      while (i < lines.length && (RE_LIST.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = RE_LIST.exec(lines[i]);
        if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), check: m[3] === undefined ? null : m[3] !== ' ', text: m[4] });
        else items[items.length - 1].text += `\n${lines[i].trim()}`;
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !RE_FENCE.test(lines[i]) && !/^(#{1,3})\s/.test(lines[i]) && !/^\s{0,3}>/.test(lines[i]) && !(para.length && RE_LIST.test(lines[i]))) para.push(lines[i++]);
    blocks.push({ type: 'para', text: para.join('\n') });
  }
  return blocks;
}

// ---------- Inline ----------
const IMG = /!\[([^\]\n]{0,200})\]\(([^)\s]{1,300})\)/g;
const LINK = /\[((?:\\.|[^\]\\\n]){1,300})\]\(([^)\s]{1,2000})\)/g;

function imageLabel(alt, lang) { const name = String(alt).split('|')[0].trim(); return `[${lang === 'en' ? 'Image' : 'Bild'}${name ? `: ${name}` : ''}]`; }

const ESCAPED = /\\([\\`*[\]~+|#>\-.:!_()])/g;

// Placeholders for kept parts: \u0001N\u0002. Marker characters from the input are removed first
// (otherwise "\u00010\u0002" in a comment would repeat an earlier part).
// eslint-disable-next-line no-control-regex
const noMarks = (s) => String(s).replace(/[\u0001\u0002]/g, '');
/** Insert kept parts; repeat because a part can contain earlier ones (e.g. `code` inside link text) */
function restore(x, tokens) {
  // A part only refers to earlier parts, so this ends after at most tokens.length rounds
  for (let i = 0; i <= tokens.length; i++) {
    // eslint-disable-next-line no-control-regex
    const next = x.replace(/\u0001(\d+)\u0002/g, (m, n) => tokens[Number(n)] ?? '');
    if (next === x) break;
    x = next;
  }
  return x;
}

function inlineText(s, lang, baseUrl = '') {
  const tokens = [];
  const keep = (txt) => `\u0001${tokens.push(txt) - 1}\u0002`;
  const x = noMarks(s)
    .replace(/`([^`\n]{1,2000})`/g, (m, c) => keep(c))
    .replace(ESCAPED, (m, c) => keep(c))
    .replace(MENTION_RE, (m, name) => `@${name}`)
    .replace(IMG, (m, alt) => imageLabel(alt, lang))
    .replace(LINK, (m, text, href) => { const url = /^\/(?![/\\])/.test(href) && baseUrl ? `${baseUrl}${href}` : href; return text === href ? url : `${text} (${url})`; })
    .replace(/\*\*([^*\n]{1,2000})\*\*/g, '$1')
    .replace(/\+\+([^+\n]{1,2000})\+\+/g, '$1')
    .replace(/~~([^~\n]{1,2000})~~/g, '$1')
    .replace(/(^|[^*])\*([^*\s][^*\n]{0,2000}?)\*/g, '$1$2');
  return restore(x, tokens);
}

/** Inline → HTML: escape first, then turn the (escaped) markers into tags */
function inlineHtml(s, o) {
  const tokens = [];
  const keep = (html) => `\u0001${tokens.push(html) - 1}\u0002`;
  let x = noMarks(s)
    .replace(/`([^`\n]{1,2000})`/g, (m, c) => keep(`<code style="background:#f1f2f4;padding:0 3px;border-radius:3px">${esc(c)}</code>`))
    .replace(ESCAPED, (m, c) => keep(esc(c)))
    .replace(MENTION_RE, (m, name) => keep(`<strong>@${esc(name)}</strong>`))
    // o.image(name, src): an embedded image (mail with inline pictures), else the note "[Image: name]"
    .replace(IMG, (m, alt, src) => keep(o.image?.(String(alt).split('|')[0].trim(), src) ?? `<em>${esc(imageLabel(alt, o.lang))}</em>`))
    .replace(LINK, (m, text, href) => {
      const url = safeHref(href, o.baseUrl);
      return url ? keep(`<a href="${esc(url)}">${esc(unescape(text))}</a>`) : m;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<>"')\]]{1,2000}[^\s<>"')\].,;:!?])/g, (m, pre, url) => `${pre}${keep(`<a href="${esc(url)}">${esc(url)}</a>`)}`);
  x = esc(x)
    .replace(/\*\*([^*\n]{1,2000})\*\*/g, '<strong>$1</strong>')
    .replace(/\+\+([^+\n]{1,2000})\+\+/g, '<u>$1</u>')
    .replace(/~~([^~\n]{1,2000})~~/g, '<s>$1</s>')
    .replace(/(^|[^*])\*([^*\s][^*\n]{0,2000}?)\*/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
  return restore(x, tokens);
}

// ---------- Lists (nested by indentation) ----------
function nest(items) {
  const root = { ordered: items[0].ordered, items: [] };
  const stack = [{ indent: items[0].indent, list: root }];
  for (const it of items) {
    while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (it.indent > top.indent && top.list.items.length) {
      const sub = { ordered: it.ordered, items: [] };
      top.list.items[top.list.items.length - 1].children.push(sub);
      stack.push({ indent: it.indent, list: sub });
      top = stack[stack.length - 1];
    }
    top.list.items.push({ ...it, children: [] });
  }
  return root;
}

function listText(list, lang, depth = 0, baseUrl = '') {
  let n = 1;
  return list.items.map((it) => {
    const marker = it.check !== null ? (it.check ? '[x]' : '[ ]') : list.ordered ? `${n++}.` : '-';
    const pad = '  '.repeat(depth);
    const text = inlineText(it.text, lang, baseUrl).split('\n').join(`\n${pad}  `);
    return [`${pad}${marker} ${text}`, ...it.children.map((c) => listText(c, lang, depth + 1, baseUrl))].join('\n');
  }).join('\n');
}

function listHtml(list, o) {
  const tag = list.ordered ? 'ol' : 'ul';
  return `<${tag} style="margin:0 0 12px;padding-left:24px">${list.items.map((it) => `<li>${it.check !== null ? (it.check ? '☑ ' : '☐ ') : ''}${inlineHtml(it.text, o)}${it.children.map((c) => listHtml(c, o)).join('')}</li>`).join('')}</${tag}>`;
}

// ---------- Output ----------
/** Formatted comment → plain text for the text part of a mail (no markup, images as a note) */
export function mdToText(md, lang = 'de', baseUrl = '') {
  const render = (blocks) => blocks.map((b) => {
    if (b.type === 'para' || b.type === 'heading') return inlineText(b.text, lang, baseUrl);
    if (b.type === 'code') return b.text;
    if (b.type === 'hr') return '――――――――';
    if (b.type === 'quote') return render(b.children).split('\n').map((l) => `> ${l}`).join('\n');
    if (b.type === 'list') return listText(nest(b.items), lang, 0, baseUrl);
    if (b.type === 'table') return [b.head, ...b.rows].map((r) => r.map((c) => inlineText(c, lang, baseUrl)).join(' | ')).join('\n');
    return '';
  }).filter((x) => x !== '').join('\n\n');
  return render(parse(md));
}

/** Formatted comment → HTML fragment (inline styles only: mail programs ignore style sheets) */
export function mdToHtml(md, o = {}) {
  const opt = { lang: o.lang || 'de', baseUrl: o.baseUrl || '', image: o.image };
  const P = 'margin:0 0 12px';
  const render = (blocks) => blocks.map((b) => {
    if (b.type === 'para') return `<p style="${P}">${inlineHtml(b.text, opt)}</p>`;
    if (b.type === 'heading') return `<p style="${P};font-weight:bold;font-size:${[0, 18, 16, 15][b.level]}px">${inlineHtml(b.text, opt)}</p>`;
    if (b.type === 'code') return `<pre style="${P};padding:8px 10px;background:#f1f2f4;border-radius:4px;white-space:pre-wrap;font-family:monospace;font-size:13px">${esc(b.text)}</pre>`;
    if (b.type === 'hr') return '<hr style="border:0;border-top:1px solid #dcdfe4;margin:12px 0">';
    if (b.type === 'quote') return `<blockquote style="${P};padding:0 0 0 12px;border-left:3px solid #dcdfe4;color:#44546f">${render(b.children)}</blockquote>`;
    if (b.type === 'list') return listHtml(nest(b.items), opt);
    if (b.type === 'table') {
      const td = 'border:1px solid #dcdfe4;padding:4px 8px;text-align:left';
      return `<table style="${P};border-collapse:collapse"><tr>${b.head.map((c) => `<th style="${td}">${inlineHtml(c, opt)}</th>`).join('')}</tr>${b.rows.map((r) => `<tr>${r.map((c) => `<td style="${td}">${inlineHtml(c, opt)}</td>`).join('')}</tr>`).join('')}</table>`;
    }
    return '';
  }).join('');
  return render(parse(md));
}

/** Plain (unformatted) comment → HTML fragment: text as it is, only images through o.image */
export function plainToHtml(text, o = {}) {
  const tokens = [];
  const keep = (html) => `\u0001${tokens.push(html) - 1}\u0002`;
  const x = noMarks(text).replace(MENTION_RE, (m, name) => `@${name}`)
    .replace(IMG, (m, alt, src) => keep(o.image?.(String(alt).split('|')[0].trim(), src) ?? esc(imageLabel(alt, o.lang || 'de'))));
  return `<p style="margin:0 0 12px;white-space:pre-wrap">${restore(esc(x), tokens)}</p>`;
}

/**
 * Whole mail as HTML: the plain-text template (with MAIL_BODY where the comment goes) is escaped
 * line by line, the formatted comment is put in its place.
 */
export function mailHtml(templateText, bodyHtml) {
  const parts = String(templateText).split(MAIL_BODY);
  const textHtml = (s) => esc(s).replace(/(https?:\/\/[^\s<>&"]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
  const inner = parts.map(textHtml).join(`</div><div style="margin:8px 0 12px">${bodyHtml}</div><div>`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#172b4d"><div>${inner}</div></body></html>`;
}
