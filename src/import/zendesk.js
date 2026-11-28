// Import from Zendesk (REST API v2, email + API token): adapter for the common import (./core.js).
// Groups become projects; the first public comment is the description, all others are comments
// (private ones stay internal); tags become labels; archived tickets come via the incremental export.
import { createSourceHttp, SourceError } from './http.js';

const MAX_PAGES = 20000;

export const ZENDESK_STATUS = { new: 'new', open: 'indeterminate', pending: 'waiting', hold: 'waiting', solved: 'done', closed: 'done' };

/** c.baseUrl: https://firma.zendesk.com · c.email + c.token (API token) */
export function zendeskAdapter(c) {
  const auth = `Basic ${Buffer.from(`${c.email || ''}/token:${c.token || ''}`).toString('base64')}`;
  const { base, basePath, json, download, sameOrigin } = createSourceHttp({ baseUrl: c.baseUrl, headers: () => ({ Authorization: auth }), verifyTls: c.verifyTls, caPem: c.caPem });
  const api = '/api/v2';
  const nextPath = (url) => { const u = new URL(url); return u.origin === base.origin ? `${u.pathname.slice(basePath.length)}${u.search}` : null; };

  const userCache = new Map();
  async function users(ids) {
    const missing = [...new Set(ids.filter((id) => id && !userCache.has(id)))];
    for (let i = 0; i < missing.length; i += 100) {
      const r = await json(`${api}/users/show_many.json?ids=${missing.slice(i, i + 100).join(',')}`);
      for (const u of r?.users || []) userCache.set(u.id, { email: u.email || '', name: u.name || u.email || '', ref: `zd${u.id}`, role: u.role });
      for (const id of missing.slice(i, i + 100)) if (!userCache.has(id)) userCache.set(id, null);
    }
  }
  const user = (id) => userCache.get(id) || null;

  let all = null;
  async function allTickets() {
    if (all) return all;
    const out = [];
    // Incremental export (admins): also archived tickets. Otherwise the normal list.
    try {
      let path = `${api}/incremental/tickets/cursor.json?start_time=0`;
      for (let pages = 0; path && pages < MAX_PAGES; pages++) {
        const r = await json(path);
        out.push(...(r?.tickets || []));
        if (r?.end_of_stream || !r?.after_cursor) break;
        path = `${api}/incremental/tickets/cursor.json?cursor=${encodeURIComponent(r.after_cursor)}`;
      }
    } catch (e) {
      if (e.status !== 403) throw e;
      out.length = 0;
      let path = `${api}/tickets.json?page[size]=100&sort=id`;
      for (let pages = 0; path && pages < MAX_PAGES; pages++) {
        const r = await json(path);
        out.push(...(r?.tickets || []));
        path = r?.meta?.has_more && r?.links?.next ? nextPath(r.links.next) : null;
      }
    }
    const seen = new Map();
    for (const t of out) if (t && t.status !== 'deleted') seen.set(t.id, t); // the export may list a ticket twice: latest wins
    all = [...seen.values()].sort((a, b) => a.id - b.id);
    return all;
  }
  let groups = null;
  async function groupNames() {
    if (!groups) {
      groups = new Map();
      let path = `${api}/groups.json?page[size]=100`;
      for (let pages = 0; path && pages < 1000; pages++) {
        const r = await json(path);
        for (const g of r?.groups || []) groups.set(String(g.id), g.name);
        path = r?.meta?.has_more && r?.links?.next ? nextPath(r.links.next) : null;
      }
    }
    return groups;
  }
  const groupKey = (t) => (t.group_id ? String(t.group_id) : '*');

  async function comments(id) {
    const out = [];
    let path = `${api}/tickets/${id}/comments.json?page[size]=100`;
    for (let pages = 0; path && pages < 1000; pages++) {
      const r = await json(path);
      out.push(...(r?.comments || []));
      path = r?.meta?.has_more && r?.links?.next ? nextPath(r.links.next) : null;
    }
    return out;
  }

  // ---------- Help Center: categories (the choice), sections (category of the article), articles ----------
  async function hcList(path, key) {
    const out = [];
    for (let n = 0, next = path; next && n < MAX_PAGES; n++) {
      const r = await json(next);
      out.push(...(r?.[key] || []));
      next = r?.next_page ? nextPath(r.next_page) : null;
    }
    return out;
  }
  let hcLocales = null;
  async function locales() {
    if (!hcLocales) {
      const r = await json(`${api}/help_center/locales.json`);
      hcLocales = { list: (r?.locales || []).map(String), def: String(r?.default_locale || r?.locales?.[0] || 'en-us') };
    }
    return hcLocales;
  }
  const hcCache = new Map();
  const hcOnce = (k, fn) => { if (!hcCache.has(k)) hcCache.set(k, fn()); return hcCache.get(k); };
  const loc = async (language) => { const l = await locales(); return language && l.list.includes(language) ? language : l.def; };
  const categories = (l) => hcOnce(`c:${l}`, () => hcList(`${api}/help_center/${encodeURIComponent(l)}/categories.json?per_page=100`, 'categories'));
  const sections = (l) => hcOnce(`s:${l}`, () => hcList(`${api}/help_center/${encodeURIComponent(l)}/sections.json?per_page=100`, 'sections'));
  const articles = (l) => hcOnce(`a:${l}`, () => hcList(`${api}/help_center/${encodeURIComponent(l)}/articles.json?per_page=100&sort_by=created_at&sort_order=asc`, 'articles'));
  // Who may see an article: everyone / signed-in users → public, agents only ("staff") → internal
  const staffSegments = () => hcOnce('seg', async () => {
    try { return new Set((await hcList(`${api}/help_center/user_segments.json?per_page=100`, 'user_segments')).filter((x) => x.user_type === 'staff').map((x) => x.id)); } catch (e) { if (e.status === 401) throw e; return null; }
  });

  const kb = {
    async spaces() {
      const l = await locales();
      const [cats, secs, arts] = await Promise.all([categories(l.def), sections(l.def), articles(l.def)]);
      const catOfSection = new Map(secs.map((x) => [x.id, x.category_id]));
      return cats.map((cat) => ({
        key: String(cat.id), name: cat.name, count: arts.filter((a) => catOfSection.get(a.section_id) === cat.id).length,
        languages: l.list.map((code) => ({ code, name: code })),
      }));
    },
    async *articles(key, { language = null } = {}) {
      const l = await loc(language);
      const [secs, arts, staff] = await Promise.all([sections(l), articles(l), staffSegments()]);
      const secById = new Map(secs.map((x) => [x.id, x]));
      const path = (id) => { const parts = []; const seen = new Set(); for (let x = secById.get(id); x && !seen.has(x.id); x = secById.get(x.parent_section_id)) { seen.add(x.id); parts.unshift(x.name); } return parts.join(' / '); };
      const mine = arts.filter((a) => String(secById.get(a.section_id)?.category_id) === String(key));
      await users(mine.map((a) => a.author_id));
      for (const a of mine) {
        let atts = null;
        const files = async () => (atts ||= (await hcList(`${api}/help_center/articles/${a.id}/attachments.json?per_page=100`, 'article_attachments')));
        yield {
          extId: `article:${a.id}`,
          title: a.title || a.name || String(a.id),
          html: a.body || '',
          parentExtId: null,
          category: path(a.section_id).slice(0, 60),
          visibility: a.user_segment_id && (staff === null || staff.has(a.user_segment_id)) ? 'internal' : 'public',
          draft: !!a.draft,
          created: a.created_at,
          updated: a.edited_at && a.edited_at > (a.updated_at || '') ? a.edited_at : a.updated_at,
          author: user(a.author_id),
          linkKeys: [`zendesk-article:${a.id}`],
          url: a.html_url || null,
          async image(src) {
            // pictures uploaded to the article: by the attachment id (also on a custom help center domain)
            const m = /\/article_attachments\/(\d+)/.exec(src);
            if (m) {
              const f = (await files()).find((x) => String(x.id) === m[1]);
              if (f?.content_url) return { ref: `zd-att:${f.id}`, filename: f.file_name, load: (max) => download(f.content_url, max) };
            }
            return sameOrigin(src);
          },
          link(href) {
            const m = /\/articles\/(\d+)/.exec(href);
            return m ? { key: `zendesk-article:${m[1]}`, url: /^https?:/i.test(href) ? href : null } : null;
          },
          attachments: async () => (await files()).map((f) => ({
            extId: String(f.id), ref: `zd-att:${f.id}`, filename: f.file_name, mime: f.content_type, size: Number(f.size) || 0, created: f.created_at,
            load: (max) => download(f.content_url, max),
          })),
        };
      }
    },
  };

  return {
    kb,
    kind: 'zendesk',
    sourceId: `zendesk:${base.host}${basePath}`,
    host: base.host,
    ticketSource: 'import',
    keyPrefix: 'Z',
    async info() {
      const me = (await json(`${api}/users/me.json`))?.user;
      if (!me || !me.id) throw new SourceError('Anmeldung beim Quellsystem fehlgeschlagen (E-Mail/API-Token prüfen).', 401);
      return { title: 'Zendesk', version: '', user: me.name || me.email || '' };
    },
    async projects() {
      const [names, tks] = await Promise.all([groupNames(), allTickets()]);
      const count = new Map();
      for (const t of tks) count.set(groupKey(t), (count.get(groupKey(t)) || 0) + 1);
      return [...count].map(([k, n]) => ({ key: k, name: k === '*' ? 'Zendesk' : (names.get(k) || `#${k}`), suggestKey: k === '*' ? 'Zendesk' : (names.get(k) || 'ZD'), count: n }))
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
        statuses.set(String(t.status || ''), ZENDESK_STATUS[t.status] || 'indeterminate');
        types.add(String(t.type || ''));
      }
      return { statuses: [...statuses].map(([name, category]) => ({ name, category })), types: [...types], counts };
    },
    async count(key) { return (await allTickets()).filter((t) => groupKey(t) === String(key)).length; },
    async *tickets(key, options = {}) {
      for (const t of await allTickets()) {
        if (groupKey(t) !== String(key)) continue;
        let list;
        try {
          list = (await comments(t.id)).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
          await users([t.requester_id, t.submitter_id, t.assignee_id, ...list.map((x) => x.author_id)]);
        } catch (e) {
          if (e.status === 401 || e.status === 403) throw e;
          yield { extId: String(t.id), extKey: `#${t.id}`, fetchError: e }; // counted as failed, import goes on
          continue;
        }
        const first = list.find((x) => x.public !== false); // a private first comment must not become the visible description
        const done = t.status === 'solved' || t.status === 'closed';
        yield {
          extId: String(t.id),
          extKey: `#${t.id}`,
          number: Number(t.id),
          title: t.subject || t.raw_subject || (first?.plain_body || '').split('\n')[0].slice(0, 120),
          description: first ? String(first.plain_body ?? first.body ?? '').trim() : '',
          typeName: String(t.type || ''),
          statusName: String(t.status || ''),
          statusCategory: ZENDESK_STATUS[t.status] || 'indeterminate',
          priorityName: String(t.priority || ''),
          labels: t.tags || [],
          due: t.due_at ? String(t.due_at).slice(0, 10) : null,
          created: t.created_at,
          updated: t.updated_at,
          resolved: done ? t.updated_at : null,
          reporter: user(t.requester_id),
          assignee: user(t.assignee_id),
          comments: async () => list.filter((x) => x !== first).map((x) => ({
            extId: String(x.id), author: user(x.author_id), body: String(x.plain_body ?? x.body ?? '').trim() || '📎', internal: x.public === false, created: x.created_at,
          })),
          attachments: options.attachments === false ? null : async () => list.flatMap((x) => (x.attachments || []).filter((a) => !(a.inline && Number(a.size) < 50 * 1024)).map((a) => ({
            extId: String(a.id), filename: a.file_name, mime: a.content_type, size: Number(a.size) || 0, created: x.created_at, author: user(x.author_id),
            internal: x.public === false, commentExtId: x === first ? null : String(x.id),
            load: (maxBytes) => download(a.content_url, maxBytes),
          }))),
        };
      }
    },
  };
}
