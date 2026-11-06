// Import from Zammad (REST API, token or user/password): adapter for the common import (./core.js).
// Groups become projects, the first public article is the description, all other articles are comments
// (internal ones stay internal), attachments of all articles, tags become labels.
import { convert as htmlToText } from 'html-to-text';
import { createSourceHttp, SourceError } from './http.js';

const PER_PAGE = 100;
const MAX_PAGES = 20000;

export function articleText(a) {
  const body = String(a?.body ?? '');
  if (/html/i.test(a?.content_type || '')) {
    return htmlToText(body, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { hideLinkHrefIfSameAsText: true } }] }).trim();
  }
  return body.trim();
}

/** "Anna Agentin <anna@firma.local>" → { name, email } */
export function parseFrom(from) {
  const s = String(from || '').trim().slice(0, 500); // bounded: the pattern below backtracks on long runs of spaces
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (m) return { name: (m[1] || '').trim() || m[2], email: m[2] };
  if (/^[^\s@<>]+@[^\s@<>]+$/.test(s)) return { name: s, email: s };
  return s ? { name: s, email: '' } : null;
}

/** State name → category for the mapping suggestion */
export function zammadCategory(name, typeName = '') {
  const n = `${typeName} ${name}`.toLowerCase();
  if (/pending|warte/.test(n)) return 'waiting';
  if (/closed|merged|removed|geschlossen|zusammengefasst|entfernt/.test(n)) return 'done';
  if (/\bnew\b|\bneu\b/.test(n)) return 'new';
  return 'indeterminate';
}

export function zammadAdapter(c) {
  const auth = c.token
    ? `Token token=${c.token}`
    : `Basic ${Buffer.from(`${c.username || ''}:${c.password || ''}`).toString('base64')}`;
  const { base, basePath, json, download } = createSourceHttp({ baseUrl: c.baseUrl, headers: () => ({ Authorization: auth }), verifyTls: c.verifyTls, caPem: c.caPem });
  const api = '/api/v1';

  const userCache = new Map();
  async function user(id) {
    if (!id || Number(id) === 1) return null; // 1 = system / nobody
    if (!userCache.has(id)) {
      let u = null;
      try { u = await json(`${api}/users/${encodeURIComponent(id)}`); } catch (e) { if (e.status === 401) throw e; }
      userCache.set(id, u ? { email: u.email || '', name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.login || u.email || '', username: u.login || '', ref: `z${u.id}` } : null);
    }
    return userCache.get(id);
  }

  let all = null; // all tickets (without articles), loaded once per adapter
  async function allTickets() {
    if (all) return all;
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await json(`${api}/tickets?expand=true&page=${page}&per_page=${PER_PAGE}`);
      const list = Array.isArray(r) ? r : (r?.tickets || []);
      out.push(...list.filter((x) => x && typeof x === 'object'));
      if (list.length < PER_PAGE) break;
    }
    all = out.sort((a, b) => a.id - b.id);
    return all;
  }

  let groups = null;
  async function groupList() {
    if (!groups) groups = (await json(`${api}/groups`)) || [];
    return groups;
  }
  const groupKey = (g) => String(g.id);
  const stateName = (tk) => String(tk.state || '');

  let stateTypes = null;
  async function stateCategoryMap() {
    if (stateTypes) return stateTypes;
    stateTypes = new Map();
    try {
      const [states, types] = await Promise.all([json(`${api}/ticket_states`), json(`${api}/ticket_state_types`).catch(() => [])]);
      const typeName = new Map((types || []).map((x) => [x.id, x.name]));
      for (const s of states || []) stateTypes.set(s.name, zammadCategory(s.name, typeName.get(s.state_type_id) || ''));
    } catch (e) { if (e.status === 401) throw e; }
    return stateTypes;
  }

  return {
    kind: 'zammad',
    sourceId: `zammad:${base.host}${basePath}`,
    host: base.host,
    ticketSource: 'import',
    keyPrefix: 'Z',
    async info() {
      const me = await json(`${api}/users/me`);
      let version = '';
      try { version = (await json(`${api}/version`))?.version || ''; } catch { /* admins only */ }
      return { title: 'Zammad', version, user: [me?.firstname, me?.lastname].filter(Boolean).join(' ') || me?.login || me?.email || '' };
    },
    async projects() {
      const [gs, tks] = await Promise.all([groupList(), allTickets()]);
      const count = new Map();
      for (const tk of tks) count.set(String(tk.group_id), (count.get(String(tk.group_id)) || 0) + 1);
      return gs.filter((g) => g.active !== false || count.get(groupKey(g)))
        .map((g) => ({ key: groupKey(g), name: g.name, suggestKey: String(g.name || '').split('::').pop(), count: count.get(groupKey(g)) || 0 }));
    },
    async inspect(keys) {
      const want = new Set(keys.map(String));
      const cats = await stateCategoryMap();
      const statuses = new Map();
      const types = new Set();
      const counts = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const tk of await allTickets()) {
        if (!want.has(String(tk.group_id))) continue;
        counts[String(tk.group_id)]++;
        const s = stateName(tk);
        statuses.set(s, cats.get(s) || zammadCategory(s));
        types.add(String(tk.type || ''));
      }
      return { statuses: [...statuses].map(([name, category]) => ({ name, category })), types: [...types], counts };
    },
    async count(key) { return (await allTickets()).filter((tk) => String(tk.group_id) === String(key)).length; },
    async *tickets(key) {
      const cats = await stateCategoryMap();
      for (const tk of await allTickets()) {
        if (String(tk.group_id) !== String(key)) continue;
        // Articles once per ticket: first public one = description, the rest = comments
        const articles = (await json(`${api}/ticket_articles/by_ticket/${tk.id}`)) || [];
        articles.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
        const first = articles.find((a) => !a.internal);
        const customer = await user(tk.customer_id);
        const fromFirst = first ? parseFrom(first.from) : null;
        let labels = [];
        try { labels = (await json(`${api}/tags?object=Ticket&o_id=${tk.id}`))?.tags || []; } catch (e) { if (e.status === 401) throw e; }
        const authorOf = async (a) => (await user(a.created_by_id)) || parseFrom(a.from) || (a.created_by ? { email: /@/.test(a.created_by) ? a.created_by : '', name: a.created_by } : null);
        const s = stateName(tk);
        yield {
          extId: String(tk.id),
          extKey: `#${tk.number}`,
          number: /^\d+$/.test(String(tk.number)) ? Number(tk.number) : null,
          title: tk.title,
          description: first ? articleText(first) : '',
          typeName: String(tk.type || ''),
          statusName: s,
          statusCategory: cats.get(s) || zammadCategory(s),
          priorityName: String(tk.priority || ''),
          labels,
          due: null,
          created: tk.created_at,
          updated: tk.updated_at,
          resolved: tk.close_at || null,
          reporter: customer || fromFirst,
          assignee: await user(tk.owner_id),
          comments: async () => {
            const out = [];
            for (const a of articles) {
              if (a === first) continue;
              const body = articleText(a) || (a.subject ? String(a.subject) : '');
              if (!body && !(a.attachments || []).length) continue;
              out.push({ extId: String(a.id), author: await authorOf(a), body: body || '📎', internal: !!a.internal, created: a.created_at });
            }
            return out;
          },
          attachments: async () => {
            const out = [];
            for (const a of articles) {
              for (const f of a.attachments || []) {
                const p = f.preferences || {};
                // Small inline images (signatures, logos) are part of the mail text, not a file
                if (/inline/i.test(p['Content-Disposition'] || '') && /^image\//i.test(p['Content-Type'] || p['Mime-Type'] || '') && Number(f.size) < 50 * 1024) continue;
                out.push({
                  extId: `${a.id}:${f.id}`, filename: f.filename, mime: p['Content-Type'] || p['Mime-Type'] || 'application/octet-stream',
                  size: Number(f.size) || 0, created: a.created_at, author: await authorOf(a),
                  internal: !!a.internal, commentExtId: a === first ? null : String(a.id),
                  load: (maxBytes) => download(`${base.origin}${basePath}${api}/ticket_attachment/${tk.id}/${a.id}/${f.id}`, maxBytes),
                });
              }
            }
            return out;
          },
        };
      }
    },
  };
}

export { SourceError };
