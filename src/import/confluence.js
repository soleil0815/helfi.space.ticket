// Knowledge articles from Confluence (Cloud: REST API v2 with email + API token; Data Center/Server:
// REST API with a personal access token or user/password). Spaces become the choice, pages become
// articles (page tree kept), attachments of a page become pictures in the text or attached files.
// The "storage format" (XHTML with ac:/ri: elements for macros, pictures and page links) is turned
// into plain HTML first (storageToHtml), then into the text format of the knowledge base.
import { parseHTML } from 'linkedom';
import { createSourceHttp, SourceError } from './http.js';
import { escapeHtml } from './kb-html.js';

const MAX_PAGES = 100000;

// Macros: info boxes, code, expandable sections … – everything else becomes a visible note
const PANEL_MACROS = { info: 'info', panel: 'info', note: 'warning', warning: 'warning', tip: 'tip' };
const EMOTICONS = {
  smile: '🙂', sad: '🙁', cheeky: '😛', laugh: '😄', wink: '😉', 'thumbs-up': '👍', 'thumbs-down': '👎',
  information: 'ℹ️', tick: '✅', cross: '❌', warning: '⚠️', plus: '➕', minus: '➖', question: '❓',
  'light-on': '💡', 'light-off': '💡', 'yellow-star': '⭐', 'red-star': '⭐', 'green-star': '⭐', 'blue-star': '⭐', heart: '❤️', 'broken-heart': '💔',
};
const NOTE = {
  de: (name) => `[Confluence-Makro „${name}“ nicht übernommen]`,
  en: (name) => `[Confluence macro "${name}" not imported]`,
};

/** Key under which a page link is found: space + title (Confluence links pages by title) */
export const pageKey = (space, title) => `page:${String(space || '').toLowerCase()}:${String(title || '').trim().toLowerCase()}`;
export const attKey = (pageId, filename) => `att:${pageId}:${String(filename || '').trim()}`;

/**
 * Storage format → HTML.
 * ctx.space: space key of the page, ctx.pageId, ctx.lang ('de' | 'en'), ctx.baseUrl for absolute links.
 * Pictures of attachments: <img src="confluence-att:<filename>">, pictures by URL keep the URL;
 * page links: <a href="confluence-page:<space>:<title>">, links to attachments: <a href="confluence-att:<filename>">.
 */
export function storageToHtml(xhtml, ctx = {}) {
  const note = NOTE[ctx.lang === 'en' ? 'en' : 'de'];
  // CDATA (code macros, plain link bodies) is no HTML: escape it before parsing
  // Self-closing ac:/ri: elements (<ri:page … />) are no HTML either: an HTML parser would put what follows inside them
  const src = String(xhtml || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, t) => escapeHtml(t))
    .replace(/<((?:ac|ri):[\w-]+)((?:\s[^<>]*?)?)\s*\/>/g, '<$1$2></$1>');
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${src}</body></html>`);
  const body = document.body;
  const make = (tag, attrs = {}, text = null) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== null) el.textContent = text;
    return el;
  };
  const name = (el) => String(el.localName || el.tagName || '').toLowerCase();
  const childrenNamed = (el, n) => [...el.children].filter((c) => name(c) === n);
  const firstNamed = (el, n) => childrenNamed(el, n)[0] || null;
  const param = (el, n) => childrenNamed(el, 'ac:parameter').find((p) => (p.getAttribute('ac:name') || '') === n)?.textContent?.trim() || '';
  const move = (from, to) => { while (from.firstChild) to.append(from.firstChild); return to; };

  // Parts read by their parent element (parameters, bodies, resource identifiers): not converted on their own
  const DATA = new Set(['ac:parameter', 'ac:rich-text-body', 'ac:plain-text-body', 'ac:link-body', 'ac:plain-text-link-body', 'ac:task', 'ac:task-id', 'ac:task-uuid', 'ac:task-status', 'ac:task-body']);
  const isData = (n) => DATA.has(n) || n.startsWith('ri:');
  // innermost first, so that nested macros are already converted when their parent is
  const all = [...body.querySelectorAll('*')].filter((el) => { const n = name(el); return (n.includes(':') || n === 'time') && !isData(n); }).reverse();
  for (const el of all) {
    if (!el.parentNode) continue;
    const n = name(el);
    if (n === 'ac:structured-macro' || n === 'ac:macro') {
      const macro = String(el.getAttribute('ac:name') || '').toLowerCase();
      const rich = firstNamed(el, 'ac:rich-text-body');
      const plain = firstNamed(el, 'ac:plain-text-body');
      const title = param(el, 'title');
      if (PANEL_MACROS[macro]) {
        const div = make('div', { class: 'kb-panel', 'data-kind': PANEL_MACROS[macro] });
        if (title) { const p = make('p'); p.append(make('strong', {}, title)); div.append(p); }
        if (rich) move(rich, div);
        el.replaceWith(div);
      } else if (macro === 'code' || macro === 'noformat') {
        el.replaceWith(make('pre', {}, plain ? plain.textContent : (rich?.textContent || '')));
      } else if (macro === 'expand' || macro === 'excerpt' || macro === 'section' || macro === 'column' || macro === 'div' || macro === 'details') {
        const wrap = make('div');
        if (macro === 'expand' && title) { const p = make('p'); p.append(make('strong', {}, title)); wrap.append(p); }
        if (rich) move(rich, wrap);
        el.replaceWith(wrap);
      } else if (macro === 'status') {
        el.replaceWith(make('strong', {}, `[${title || param(el, 'colour') || 'Status'}]`));
      } else if (macro === 'anchor' || macro === 'attachments' || macro === 'toc' || macro === 'children' || macro === 'pagetree') {
        // a table of contents / file list exists in the knowledge base anyway – no note needed
        el.remove();
      } else {
        const p = make('p');
        p.append(make('em', {}, note(macro || '?')));
        el.replaceWith(p);
      }
    } else if (n === 'ac:image') {
      const att = firstNamed(el, 'ri:attachment');
      const url = firstNamed(el, 'ri:url');
      const alt = el.getAttribute('ac:alt') || el.getAttribute('ac:title') || '';
      if (att && !firstNamed(att, 'ri:page')) el.replaceWith(make('img', { src: `confluence-att:${att.getAttribute('ri:filename') || ''}`, alt }));
      else if (url) el.replaceWith(make('img', { src: url.getAttribute('ri:value') || '', alt }));
      else el.remove();
    } else if (n === 'ac:link') {
      const page = firstNamed(el, 'ri:page');
      const att = firstNamed(el, 'ri:attachment');
      const user = firstNamed(el, 'ri:user');
      const bodyEl = firstNamed(el, 'ac:link-body') || firstNamed(el, 'ac:plain-text-link-body');
      const anchor = el.getAttribute('ac:anchor') || '';
      let href = null; let text = '';
      if (page) {
        const t = page.getAttribute('ri:content-title') || '';
        href = `confluence-page:${page.getAttribute('ri:space-key') || ctx.space || ''}:${t}`;
        text = t;
      } else if (att) {
        const f = att.getAttribute('ri:filename') || '';
        href = `confluence-att:${f}`; text = f;
      } else if (user) {
        text = user.getAttribute('ri:username') || 'user';
      } else if (anchor) text = anchor;
      const a = href ? make('a', { href }) : make('span');
      if (bodyEl && bodyEl.textContent.trim()) move(bodyEl, a); else a.textContent = text;
      el.replaceWith(a);
    } else if (n === 'ac:task-list') {
      const ul = make('ul', { class: 'checklist' });
      for (const task of childrenNamed(el, 'ac:task')) {
        const li = make('li');
        if ((firstNamed(task, 'ac:task-status')?.textContent || '').trim() === 'complete') li.setAttribute('data-checked', 'true');
        const tb = firstNamed(task, 'ac:task-body');
        if (tb) move(tb, li);
        ul.append(li);
      }
      el.replaceWith(ul);
    } else if (n === 'ac:emoticon') {
      const e = EMOTICONS[el.getAttribute('ac:name') || ''] || el.getAttribute('ac:emoji-fallback') || '';
      el.replaceWith(document.createTextNode(e));
    } else if (n === 'time') {
      el.replaceWith(document.createTextNode(el.getAttribute('datetime') || el.textContent));
    } else if (n === 'ac:placeholder') {
      el.remove();
    } else {
      // layouts (ac:layout, ac:layout-section, ac:layout-cell), adf extensions … → keep the content
      const frag = make('div');
      move(el, frag);
      el.replaceWith(frag);
    }
  }
  // Left over (e.g. a body outside a known macro): keep text bodies, drop the rest
  for (const el of [...body.querySelectorAll('*')].reverse()) {
    const n = name(el);
    if (!isData(n) || !el.parentNode) continue;
    if (n.endsWith('-body')) { const d = make('div'); move(el, d); el.replaceWith(d); } else el.remove();
  }
  return body.innerHTML;
}

/**
 * Adapter for the knowledge import.
 * c.type: 'cloud' (https://firma.atlassian.net/wiki, email + API token) | 'server' (Data Center, token or user/password)
 */
export function confluenceAdapter(c) {
  const cloud = c.type !== 'server';
  const auth = () => (cloud || !c.token
    ? { Authorization: `Basic ${Buffer.from(`${cloud ? c.email || '' : c.username || ''}:${cloud ? c.token || '' : c.password || ''}`).toString('base64')}` }
    : { Authorization: `Bearer ${c.token}` });
  // Cloud: the API lives below /wiki – also accept the address without it
  let baseUrl = String(c.baseUrl || '').slice(0, 500);
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1); // no regular expression on the typed address
  if (cloud && /\.atlassian\.net$/i.test(new URL(baseUrl).host) && !/\/wiki$/i.test(baseUrl)) baseUrl += '/wiki';
  const { base, basePath, json, download, sameOrigin } = createSourceHttp({ baseUrl, headers: auth, verifyTls: c.verifyTls, caPem: c.caPem });
  const host = base.host;
  // "next" links come relative to the site (Cloud: /wiki/api/v2/…) – keep them on this host
  const nextPath = (next) => {
    if (!next) return null;
    const u = new URL(next, `${base.origin}/`);
    if (u.origin !== base.origin) return null;
    const p = `${u.pathname}${u.search}`;
    return p.startsWith(`${basePath}/`) ? p.slice(basePath.length) : p;
  };

  async function* pages(path) {
    let next = path;
    for (let n = 0; next && n < MAX_PAGES; n++) {
      const r = await json(next);
      for (const x of r?.results || []) yield x;
      next = nextPath(r?._links?.next);
    }
  }

  const userCache = new Map();
  async function cloudUser(accountId) {
    if (!accountId) return null;
    if (!userCache.has(accountId)) {
      userCache.set(accountId, json(`/rest/api/user?accountId=${encodeURIComponent(accountId)}`).then((u) => ({ name: u?.displayName || u?.publicName || '', email: u?.email || '' })).catch(() => null));
    }
    return userCache.get(accountId);
  }

  async function countPages(spaceKey) {
    try {
      const r = await json(`/rest/api/search?cql=${encodeURIComponent(`space="${spaceKey.replace(/"/g, '')}" and type=page`)}&limit=0`);
      return Number.isFinite(r?.totalSize) ? r.totalSize : null;
    } catch { return null; }
  }

  const spaceIds = new Map(); // key → id (Cloud v2 works with ids)

  async function attachmentsOf(pageId) {
    const list = [];
    if (cloud) {
      for await (const a of pages(`/api/v2/pages/${encodeURIComponent(pageId)}/attachments?limit=250`)) {
        list.push({ extId: String(a.id), filename: a.title || 'datei', mime: a.mediaType || '', size: Number(a.fileSize) || 0, download: a.downloadLink || a._links?.download || '' });
      }
    } else {
      for await (const a of pages(`/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?limit=100&expand=version`)) {
        list.push({ extId: String(a.id), filename: a.title || 'datei', mime: a.extensions?.mediaType || a.metadata?.mediaType || '', size: Number(a.extensions?.fileSize) || 0, download: a._links?.download || '' });
      }
    }
    // download links are relative to the Confluence address (with /wiki or the context path)
    return list.map((a) => ({ ...a, url: a.download ? new URL(`${basePath}${a.download.startsWith('/') ? '' : '/'}${a.download}`, `${base.origin}/`).href : '' }));
  }

  return {
    kind: 'confluence',
    sourceId: `confluence:${host}${basePath}`,
    host,
    async info() {
      if (cloud) {
        const me = await json('/rest/api/user/current');
        return { title: 'Confluence Cloud', version: '', user: me?.displayName || me?.publicName || '' };
      }
      const [me, sys] = await Promise.all([json('/rest/api/user/current'), json('/rest/applinks/1.0/manifest').catch(() => null)]);
      return { title: 'Confluence', version: sys?.version || '', user: me?.displayName || me?.username || '' };
    },
    kb: {
      async spaces() {
        const out = [];
        const path = cloud ? '/api/v2/spaces?limit=250&type=global&status=current' : '/rest/api/space?limit=100&type=global';
        for await (const s of pages(path)) {
          if (cloud) spaceIds.set(s.key, String(s.id));
          out.push({ key: s.key, name: s.name || s.key });
        }
        for (const s of out) s.count = await countPages(s.key);
        return out;
      },
      async *articles(spaceKey, { lang = 'de' } = {}) {
        const make = async (p, extra) => {
          const xhtml = p.body?.storage?.value;
          let atts = null;
          const files = async () => (atts ||= await attachmentsOf(p.id));
          const html = storageToHtml(xhtml || '', { space: spaceKey, pageId: p.id, lang });
          return {
            extId: String(p.id),
            title: p.title || String(p.id),
            html,
            parentExtId: extra.parentId ? String(extra.parentId) : null,
            category: '',
            visibility: 'internal', // Confluence permissions do not map to "everyone signed in" – reviewed by hand
            draft: false,
            created: extra.created || null,
            updated: extra.updated || null,
            author: extra.author || null,
            linkKeys: [pageKey(spaceKey, p.title)],
            url: extra.url || null,
            // pictures and links inside the page
            async image(src) {
              const m = /^confluence-att:(.+)$/.exec(src);
              if (m) {
                const a = (await files()).find((x) => x.filename === m[1]);
                return a?.url ? { ref: attKey(p.id, a.filename), filename: a.filename, load: (max) => download(a.url, max) } : null;
              }
              return sameOrigin(src);
            },
            link(href) {
              const pm = /^confluence-page:([^:]*):(.*)$/.exec(href);
              if (pm) return { key: pageKey(pm[1] || spaceKey, pm[2]) };
              const am = /^confluence-att:(.+)$/.exec(href);
              if (am) return { fileRef: attKey(p.id, am[1]) };
              return null;
            },
            attachments: async () => (await files()).map((a) => ({
              extId: a.extId, ref: attKey(p.id, a.filename), filename: a.filename, mime: a.mime, size: a.size, load: (max) => download(a.url, max),
            })),
          };
        };
        if (cloud) {
          let id = spaceIds.get(spaceKey);
          if (!id) {
            const r = await json(`/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
            id = r?.results?.[0]?.id ? String(r.results[0].id) : null;
            if (!id) throw new SourceError(`Bereich ${spaceKey} nicht gefunden`, 404);
            spaceIds.set(spaceKey, id);
          }
          for await (const p of pages(`/api/v2/spaces/${encodeURIComponent(id)}/pages?limit=100&status=current&body-format=storage&sort=id`)) {
            const author = await cloudUser(p.authorId || p.ownerId);
            yield await make(p, {
              parentId: p.parentType === 'page' ? p.parentId : null,
              created: p.createdAt, updated: p.version?.createdAt || p.createdAt, author,
              url: p._links?.webui ? `${base.origin}${basePath}${p._links.webui}` : null,
            });
          }
        } else {
          for await (const p of pages(`/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&status=current&limit=50&expand=body.storage,ancestors,version,history`)) {
            const anc = p.ancestors || [];
            const by = p.history?.createdBy || p.version?.by;
            yield await make(p, {
              parentId: anc.length ? anc[anc.length - 1].id : null,
              created: p.history?.createdDate || null, updated: p.version?.when || null,
              author: by ? { name: by.displayName || by.username || '', email: by.email || '' } : null,
              url: p._links?.webui ? `${base.origin}${basePath}${p._links.webui}` : null,
            });
          }
        }
      },
    },
  };
}
