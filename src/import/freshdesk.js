// Import from Freshdesk (REST API v2, API key): adapter for the common import (./core.js).
// Groups become projects; the ticket description stays the description, conversations become
// comments (private notes stay internal); tags become labels.
import { convert as htmlToText } from 'html-to-text';
import { createSourceHttp, SourceError } from './http.js';

const PER_PAGE = 100;
const MAX_PAGES = 300; // Freshdesk limits list pagination (300 × 100 tickets)

// Standard statuses; custom ones (6 and up) appear as "Status 6" and are mapped by hand
export const FRESHDESK_STATUS = { 2: ['Open', 'new'], 3: ['Pending', 'waiting'], 4: ['Resolved', 'done'], 5: ['Closed', 'done'] };
const FRESHDESK_PRIORITY = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

const text = (plain, html) => {
  const p = String(plain ?? '').trim();
  if (p) return p;
  const h = String(html ?? '');
  return h ? htmlToText(h, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }).trim() : '';
};

/** c.baseUrl: https://firma.freshdesk.com · c.token: API key */
export function freshdeskAdapter(c) {
  const auth = `Basic ${Buffer.from(`${c.token || ''}:X`).toString('base64')}`;
  const { base, basePath, json, download, sameOrigin } = createSourceHttp({ baseUrl: c.baseUrl, headers: () => ({ Authorization: auth }), verifyTls: c.verifyTls, caPem: c.caPem });
  const api = '/api/v2';

  const people = new Map();
  async function person(id) {
    if (!id) return null;
    if (!people.has(id)) {
      let p = null;
      for (const path of [`${api}/contacts/${id}`, `${api}/agents/${id}`]) {
        try {
          const r = await json(path);
          const x = r?.contact || r;
          if (x) { p = { email: x.email || '', name: x.name || x.email || '', ref: `fd${id}` }; break; }
        } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
      }
      people.set(id, p);
    }
    return people.get(id);
  }

  let all = null;
  async function allTickets() {
    if (all) return all;
    const out = [];
    // Without updated_since the list only returns the last 30 days
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await json(`${api}/tickets?per_page=${PER_PAGE}&page=${page}&updated_since=2000-01-01T00:00:00Z&order_by=created_at&order_type=asc`);
      if (!Array.isArray(list) || !list.length) break;
      out.push(...list);
      if (list.length < PER_PAGE) break;
    }
    all = out.sort((a, b) => a.id - b.id);
    return all;
  }
  let groups = null;
  async function groupNames() {
    if (!groups) {
      groups = new Map();
      for (let page = 1; page <= 50; page++) {
        const list = await json(`${api}/groups?per_page=100&page=${page}`);
        if (!Array.isArray(list) || !list.length) break;
        for (const g of list) groups.set(String(g.id), g.name);
        if (list.length < 100) break;
      }
    }
    return groups;
  }
  const groupKey = (t) => (t.group_id ? String(t.group_id) : '*');
  const statusOf = (t) => FRESHDESK_STATUS[t.status] || [`Status ${t.status}`, 'indeterminate'];

  async function conversations(id) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const list = await json(`${api}/tickets/${id}/conversations?per_page=${PER_PAGE}&page=${page}`);
      if (!Array.isArray(list) || !list.length) break;
      out.push(...list);
      if (list.length < PER_PAGE) break;
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  }
  const file = (a, created, author, internal, commentExtId) => ({
    extId: String(a.id), filename: a.name, mime: a.content_type, size: Number(a.size) || 0, created, author, internal, commentExtId,
    load: (maxBytes) => download(a.attachment_url, maxBytes),
  });

  // ---------- Solutions: categories (the choice), folders (category of the article), articles ----------
  async function pagesOf(path) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await json(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(list) || !list.length) break;
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }
  const solCache = new Map();
  const once = (k, fn) => { if (!solCache.has(k)) solCache.set(k, fn()); return solCache.get(k); };
  const solCategories = () => once('cats', () => json(`${api}/solutions/categories`).then((r) => (Array.isArray(r) ? r : [])));
  /** All folders of a category, subfolders included (older accounts have no subfolders: 404 → none) */
  const foldersOf = (catId) => once(`f:${catId}`, async () => {
    const out = [];
    const walk = async (list, parents) => {
      for (const f of list) {
        out.push({ ...f, path: [...parents, f.name] });
        let subs = [];
        try { subs = await json(`${api}/solutions/folders/${f.id}/subfolders`); } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
        if (Array.isArray(subs) && subs.length && parents.length < 5) await walk(subs, [...parents, f.name]);
      }
    };
    await walk((await json(`${api}/solutions/categories/${catId}/folders`)) || [], []);
    return out;
  });
  const articlesOf = (folderId) => once(`a:${folderId}`, () => pagesOf(`${api}/solutions/folders/${folderId}/articles`));
  // Folder visibility: 1 all users, 2 signed-in users → public; agents, companies, segments → internal
  const PUBLIC_VISIBILITY = new Set([1, 2]);
  // Pictures in articles are often stored on Freshdesk's file hosts (no credentials needed, none sent)
  const FD_FILE_HOST = /(^|\.)freshdesk\.com$|(^|\.)freshworks\.com$/i;
  function fdImage(src) {
    const own = sameOrigin(src);
    if (own) return own;
    let u; try { u = new URL(src); } catch { return null; }
    const s3 = /^s3[.-][\w.-]*amazonaws\.com$/i.test(u.hostname) && /\/cdn\.freshdesk\.com\//.test(u.pathname);
    if (u.protocol !== 'https:' || !(FD_FILE_HOST.test(u.hostname) || s3)) return null;
    return { ref: `url:${u.hostname}${u.pathname}`, filename: decodeURIComponent(u.pathname.split('/').pop() || 'bild'), load: (max) => download(u.href, max) };
  }

  const kb = {
    async spaces() {
      const cats = await solCategories();
      const out = [];
      for (const cat of cats) {
        let count = 0;
        try { for (const f of await foldersOf(cat.id)) count += (await articlesOf(f.id)).length; } catch (e) { if (e.status === 401 || e.status === 403) throw e; count = null; }
        out.push({ key: String(cat.id), name: cat.name, count });
      }
      return out;
    },
    async *articles(key) {
      for (const f of await foldersOf(key)) {
        for (const a of await articlesOf(f.id)) {
          const files = a.attachments || [];
          yield {
            extId: `article:${a.id}`,
            title: a.title || String(a.id),
            html: a.description || '',
            parentExtId: null,
            category: f.path.join(' / ').slice(0, 60),
            visibility: PUBLIC_VISIBILITY.has(Number(f.visibility)) ? 'public' : 'internal',
            draft: Number(a.status) === 1,
            created: a.created_at,
            updated: a.updated_at,
            author: await person(a.agent_id),
            linkKeys: [`freshdesk-article:${a.id}`],
            image: (src) => fdImage(src),
            link(href) {
              const m = /\/solutions\/articles\/(\d+)/.exec(href);
              return m ? { key: `freshdesk-article:${m[1]}`, url: /^https?:/i.test(href) ? href : null } : null;
            },
            attachments: async () => files.map((x) => {
              const im = fdImage(x.attachment_url);
              return { extId: String(x.id), ref: im?.ref || `fd-att:${x.id}`, filename: x.name, mime: x.content_type, size: Number(x.size) || 0, created: x.created_at, load: (max) => download(x.attachment_url, max) };
            }),
          };
        }
      }
    },
  };

  return {
    kb,
    kind: 'freshdesk',
    sourceId: `freshdesk:${base.host}${basePath}`,
    host: base.host,
    ticketSource: 'import',
    keyPrefix: 'F',
    async info() {
      const me = await json(`${api}/agents/me`);
      if (!me) throw new SourceError('Anmeldung beim Quellsystem fehlgeschlagen (API-Schlüssel prüfen).', 401);
      return { title: 'Freshdesk', version: '', user: me.contact?.name || me.contact?.email || '' };
    },
    async projects() {
      const [names, tks] = await Promise.all([groupNames(), allTickets()]);
      const count = new Map();
      for (const t of tks) count.set(groupKey(t), (count.get(groupKey(t)) || 0) + 1);
      return [...count].map(([k, n]) => ({ key: k, name: k === '*' ? 'Freshdesk' : (names.get(k) || `#${k}`), suggestKey: k === '*' ? 'Freshdesk' : (names.get(k) || 'FD'), count: n }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async inspect(keys) {
      const want = new Set(keys.map(String));
      const statuses = new Map();
      const types = new Set();
      const counts = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const t of await allTickets()) {
        if (!want.has(groupKey(t))) continue;
        counts[groupKey(t)]++;
        const [name, cat] = statusOf(t);
        statuses.set(name, cat);
        types.add(String(t.type || ''));
      }
      return { statuses: [...statuses].map(([name, category]) => ({ name, category })), types: [...types], counts };
    },
    async count(key) { return (await allTickets()).filter((t) => groupKey(t) === String(key)).length; },
    async *tickets(key, options = {}) {
      for (const meta of await allTickets()) {
        if (groupKey(meta) !== String(key)) continue;
        let t; let conv;
        try {
          t = (await json(`${api}/tickets/${meta.id}`)) || meta; // with description and attachments
          conv = await conversations(t.id);
        } catch (e) {
          if (e.status === 401 || e.status === 403) throw e;
          yield { extId: String(meta.id), extKey: `#${meta.id}`, fetchError: e }; // counted as failed, import goes on
          continue;
        }
        const [statusName, category] = statusOf(t);
        const reporter = await person(t.requester_id);
        yield {
          extId: String(t.id),
          extKey: `#${t.id}`,
          number: Number(t.id),
          title: t.subject,
          description: text(t.description_text, t.description),
          typeName: String(t.type || ''),
          statusName,
          statusCategory: category,
          priorityName: FRESHDESK_PRIORITY[t.priority] || '',
          labels: t.tags || [],
          due: t.due_by ? String(t.due_by).slice(0, 10) : null,
          created: t.created_at,
          updated: t.updated_at,
          resolved: category === 'done' ? (t.stats?.resolved_at || t.stats?.closed_at || t.updated_at) : null,
          reporter,
          assignee: await person(t.responder_id),
          comments: async () => {
            const out = [];
            for (const x of conv) {
              const body = text(x.body_text, x.body);
              if (!body && !(x.attachments || []).length) continue;
              out.push({ extId: String(x.id), author: await person(x.user_id), body: body || '📎', internal: x.private === true, created: x.created_at });
            }
            return out;
          },
          attachments: options.attachments === false ? null : async () => {
            const out = (t.attachments || []).map((a) => file(a, t.created_at, reporter, false, null));
            for (const x of conv) {
              const author = await person(x.user_id);
              for (const a of x.attachments || []) out.push(file(a, x.created_at, author, x.private === true, String(x.id)));
            }
            return out;
          },
        };
      }
    },
  };
}
