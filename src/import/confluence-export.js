// Knowledge articles from a Confluence space export (Space tools → Export → HTML, a ZIP file) – for
// Confluence installations that are switched off or cannot be reached. One folder per space with
// index.html (the space home) and one HTML file per page; pictures and files under attachments/.
// The page tree comes from the breadcrumbs of each page.
import path from 'node:path';
import crypto from 'node:crypto';
import { parseHTML } from 'linkedom';
import { openZip, ZipError } from '../lib/unzip.js';
import { SourceError } from './http.js';

const MAX_PAGE_HTML = 20 * 1024 * 1024;
// Emoticons are pictures in the export: the common ones become emoji, the rest is left out
const EMOJI = {
  check: '✅', error: '❌', warning: '⚠️', information: 'ℹ️', smile: '🙂', sad: '🙁', wink: '😉', laugh: '😄', tongue: '😛',
  thumbs_up: '👍', thumbs_down: '👎', lightbulb_on: '💡', lightbulb: '💡', star_yellow: '⭐', heart: '❤️', help_16: '❓', add: '➕', forbidden: '⛔',
};
const titleOf = (doc) => {
  const t = doc.querySelector('#title-text')?.textContent || doc.querySelector('title')?.textContent || '';
  // "Space name : Page title"
  const i = t.indexOf(' : ');
  return (i >= 0 ? t.slice(i + 3) : t).replace(/\s+/g, ' ').trim();
};

/**
 * c.file: path of the uploaded ZIP; c.name: original file name (for the source id)
 */
export function confluenceExportAdapter(c) {
  let zip = null;
  const open = () => {
    if (!zip) {
      try { zip = openZip(c.file); } catch (e) { throw new SourceError(e instanceof ZipError ? e.message : `ZIP-Datei nicht lesbar: ${e.message}`, 400); }
    }
    return zip;
  };
  const read = (name, max = MAX_PAGE_HTML) => { try { return open().read(name, max); } catch (e) { throw new SourceError(e.message, 400); } };
  const parse = (name) => parseHTML(read(name)?.toString('utf8') || '').document;

  /** Spaces: folders with an index.html (also when the ZIP has one folder level above them) */
  function spaceDirs() {
    const out = [];
    for (const n of open().entries.keys()) {
      if (!/(^|\/)index\.html$/i.test(n)) continue;
      const dir = n.replace(/index\.html$/i, '');
      // a folder of pages: has page files next to index.html
      if ([...open().entries.keys()].some((x) => x.startsWith(dir) && x !== n && /\.html$/i.test(x) && !x.slice(dir.length).includes('/'))) out.push(dir);
    }
    return out.filter((d) => !out.some((o) => o !== d && d.startsWith(o) && d.slice(o.length).split('/').length > 2));
  }
  const pagesIn = (dir) => [...open().entries.keys()].filter((x) => x.startsWith(dir) && /\.html$/i.test(x) && !x.slice(dir.length).includes('/') && !/index\.html$/i.test(x)).sort();
  const keyOfDir = (dir) => dir.replace(/\/$/, '').split('/').pop() || 'SPACE';
  // "Page-title_12345.html" / "12345.html" → 12345 (names are cut first: patterns only on short text)
  const fileId = (name) => { const b = path.posix.basename(name).slice(-200); return (/_(\d{1,20})\.html$/i.exec(b) || /^(\d{1,20})\.html$/i.exec(b))?.[1] || b; };

  return {
    kind: 'confluence',
    // page ids are unique in a Confluence: a newer export of the same space updates the articles
    sourceId: 'confluence-export',
    host: 'export',
    kb: {
      async info() { open(); return { title: c.name ? `Confluence-Export (${c.name})` : 'Confluence-Export', version: '', user: '' }; },
      async spaces() {
        return spaceDirs().map((dir) => {
          const doc = parse(`${dir}index.html`);
          const t = (doc.querySelector('#title-text')?.textContent || doc.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
          // "Space name : Home page" → the space name
          const i = t.indexOf(' : ');
          return { key: dir, name: (i >= 0 ? t.slice(0, i) : t) || keyOfDir(dir), count: pagesIn(dir).length };
        });
      },
      async *articles(dir, { lang = 'de' } = {}) {
        const home = `${dir}index.html`;
        for (const file of pagesIn(dir)) {
          let doc;
          try { doc = parse(file); } catch (e) { yield { extId: `file:${file}`, title: path.posix.basename(file), fetchError: e }; continue; }
          const main = doc.querySelector('#main-content') || doc.querySelector('.wiki-content') || doc.body;
          const html = main?.innerHTML || '';
          // parent: last breadcrumb that is a page (not the space home)
          const crumbs = [...doc.querySelectorAll('#breadcrumbs a, .breadcrumbs a')].map((a) => a.getAttribute('href') || '').filter((h) => /\.html$/i.test(h));
          const parentFile = crumbs.map((h) => path.posix.normalize(path.posix.join(dir, h))).filter((h) => h !== home && h !== file).pop() || null;
          const meta = (doc.querySelector('.page-metadata')?.textContent || '').slice(0, 400).replace(/\s+/g, ' ').trim();
          const author = /(?:Created by|Erstellt von)\s+(.+?)(?:,|\s+(?:last|zuletzt|on|am)\b|$)/i.exec(meta)?.[1]?.trim() || '';
          // attachments listed below the page
          const files = [...doc.querySelectorAll('.greybox a, #attachments ~ * a, .pageSection a')]
            .map((a) => ({ href: a.getAttribute('href') || '', name: a.textContent.trim() }))
            .filter((a) => /^attachments\//.test(a.href))
            .filter((a, i, arr) => arr.findIndex((b) => b.href === a.href) === i);
          const resolve = (src) => path.posix.normalize(path.posix.join(dir, decodeURIComponent(String(src).split(/[?#]/)[0])));
          const entryOf = (src) => { const n = resolve(src); return open().entries.has(n) && n.startsWith(dir) ? n : null; };
          yield {
            extId: `page:${keyOfDir(dir)}:${fileId(file)}`,
            title: titleOf(doc) || path.posix.basename(file, '.html'),
            html: prepare(html),
            parentExtId: parentFile ? `page:${keyOfDir(dir)}:${fileId(parentFile)}` : null,
            category: '',
            visibility: 'internal',
            draft: false,
            created: null,
            updated: null,
            // no reliable date in the export: the content itself tells whether a page changed
            revision: crypto.createHash('sha1').update(html).digest('hex'),
            author: author ? { name: author, email: '' } : null,
            linkKeys: [`file:${file}`],
            image(src) {
              const n = entryOf(src);
              return n ? { ref: `zip:${n}`, filename: path.posix.basename(n), load: (max) => read(n, max) } : null;
            },
            link(href) {
              if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return null;
              const n = resolve(href);
              if (/^attachments\//.test(path.posix.relative(dir, n))) return { fileRef: `zip:${n}` };
              if (/\.html$/i.test(n)) return n === home ? null : { key: `file:${n}` };
              return null;
            },
            attachments: async () => files.map((a) => {
              const n = entryOf(a.href);
              if (!n) return null;
              const en = open().entries.get(n);
              return { extId: n, ref: `zip:${n}`, filename: a.name || path.posix.basename(n), mime: '', size: en.size, load: (max) => read(n, max) };
            }).filter(Boolean),
          };
        }
        void lang;
      },
    },
    close() { zip?.close(); zip = null; },
  };

  /** Rendered Confluence HTML → what the converter understands: task lists, emoticons, expand titles */
  function prepare(html) {
    const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
    const body = document.body;
    for (const ul of body.querySelectorAll('ul.inline-task-list')) {
      ul.classList.add('checklist');
      for (const li of ul.children) if (li.classList.contains('checked')) li.setAttribute('data-checked', 'true');
    }
    for (const img of [...body.querySelectorAll('img.emoticon, img[src*="images/icons/emoticons/"]')]) {
      const name = /emoticons\/([\w-]{1,60})\.\w{1,8}/.exec((img.getAttribute('src') || '').slice(0, 500))?.[1] || '';
      const e = EMOJI[name] || img.getAttribute('data-emoji-fallback') || '';
      img.replaceWith(document.createTextNode(e));
    }
    // icons of macros (info boxes, status) carry no content
    for (const el of [...body.querySelectorAll('span.aui-icon, img[src*="images/icons/"]')]) el.remove();
    for (const ctl of [...body.querySelectorAll('.expand-control')]) {
      const t = ctl.textContent.replace(/\s+/g, ' ').trim();
      const p = document.createElement('p'); const b = document.createElement('strong'); b.textContent = t; p.append(b);
      ctl.replaceWith(p);
    }
    return body.innerHTML;
  }
}
