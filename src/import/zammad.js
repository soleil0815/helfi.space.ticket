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
  const { base, basePath, json, download, sameOrigin } = createSourceHttp({ baseUrl: c.baseUrl, headers: () => ({ Authorization: auth }), verifyTls: c.verifyTls, caPem: c.caPem });
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

  // ---------- Knowledge base: categories and answers (POST /knowledge_bases/init, then one answer with its text) ----------
  let kbInit = null;
  async function kbAssets() {
    if (!kbInit) kbInit = json(`${api}/knowledge_bases/init`, { method: 'POST', body: {} }).then((r) => r || {});
    return kbInit;
  }
  let localeCodes = null;
  async function locales() {
    if (!localeCodes) {
      localeCodes = new Map();
      try { for (const l of (await json(`${api}/locales`)) || []) localeCodes.set(l.id, { code: l.locale, name: l.name || l.locale }); } catch (e) { if (e.status === 401) throw e; }
    }
    return localeCodes;
  }
  const values = (o) => Object.values(o || {});

  // Root categories are the choice (each can go into its own project); subcategories become the category of the article
  function kbTree(a) {
    const cats = values(a.KnowledgeBaseCategory);
    const catById = new Map(cats.map((x) => [x.id, x]));
    const rootOf = (id) => { let x = catById.get(id); const seen = new Set(); while (x && x.parent_id && catById.has(x.parent_id) && !seen.has(x.id)) { seen.add(x.id); x = catById.get(x.parent_id); } return x || null; };
    const localesOf = (kbId) => values(a.KnowledgeBaseLocale).filter((l) => l.knowledge_base_id === kbId).sort((x, y) => Number(!!y.primary) - Number(!!x.primary));
    return { cats, catById, rootOf, localesOf };
  }
  const pickFor = (want) => (list) => list.find((t) => t.kb_locale_id === want) || list[0] || null;

  const kb = {
    async spaces() {
      const a = await kbAssets();
      const loc = await locales();
      const { cats, rootOf, localesOf } = kbTree(a);
      const answers = values(a.KnowledgeBaseAnswer);
      return cats.filter((x) => !x.parent_id).map((root) => {
        const mine = localesOf(root.knowledge_base_id);
        const title = pickFor(mine[0]?.id)(values(a.KnowledgeBaseCategoryTranslation).filter((t) => t.category_id === root.id))?.title;
        return {
          key: `cat:${root.id}`, name: title || `#${root.id}`, count: answers.filter((x) => rootOf(x.category_id)?.id === root.id).length,
          languages: mine.map((l) => ({ code: String(l.id), name: loc.get(l.system_locale_id)?.name || loc.get(l.system_locale_id)?.code || String(l.id) })),
        };
      });
    },
    async *articles(key, { language = null } = {}) {
      const a = await kbAssets();
      const rootId = Number(String(key).replace(/^cat:/, ''));
      const { catById, rootOf, localesOf } = kbTree(a);
      const root = catById.get(rootId);
      if (!root) return;
      const kbId = root.knowledge_base_id;
      const kbLocales = localesOf(kbId);
      const want = language && kbLocales.some((l) => String(l.id) === String(language)) ? Number(language) : kbLocales[0]?.id;
      const pick = pickFor(want);
      const catTitle = (id) => pick(values(a.KnowledgeBaseCategoryTranslation).filter((t) => t.category_id === id))?.title || '';
      // Category path below the chosen root "Child / Grandchild" as the category of the article
      const catPath = (id) => {
        const parts = []; const seen = new Set();
        for (let x = catById.get(id); x && x.id !== rootId && !seen.has(x.id); x = catById.get(x.parent_id)) { seen.add(x.id); parts.unshift(catTitle(x.id)); }
        return parts.filter(Boolean).join(' / ').slice(0, 60);
      };
      const answers = values(a.KnowledgeBaseAnswer).filter((x) => rootOf(x.category_id)?.id === rootId).sort((x, y) => x.id - y.id);
      for (const ans of answers) {
        const tr = pick(values(a.KnowledgeBaseAnswerTranslation).filter((t) => t.answer_id === ans.id));
        if (!tr) continue;
        let detail;
        try { detail = await json(`${api}/knowledge_bases/${kbId}/answers/${ans.id}?include_contents=${tr.id}`); } catch (e) {
          if (e.status === 401 || e.status === 403) throw e;
          yield { extId: String(ans.id), title: tr.title, fetchError: e };
          continue;
        }
        const content = values(detail?.assets?.KnowledgeBaseAnswerTranslationContent).find((x) => x.id === tr.content_id) || {};
        const full = detail?.assets?.KnowledgeBaseAnswer?.[String(ans.id)] || ans;
        const files = [...(full.attachments || []), ...(content.attachments || [])].filter((f, i, arr) => arr.findIndex((g) => g.id === f.id) === i);
        yield {
          extId: `answer:${ans.id}`,
          title: tr.title,
          html: content.body || '',
          parentExtId: null,
          category: catPath(ans.category_id),
          visibility: full.published_at ? 'public' : 'internal',
          draft: !full.published_at && !full.internal_at,
          archived: !!full.archived_at,
          created: full.created_at || tr.created_at,
          updated: [full.updated_at, tr.updated_at].filter(Boolean).sort().pop() || null,
          author: await user(tr.created_by_id),
          linkKeys: [`zammad-answer:${ans.id}`],
          image: (src) => {
            const so = sameOrigin(src);
            const m = /\/attachments\/(\d+)/.exec(src);
            const f = m ? files.find((x) => String(x.id) === m[1]) : null;
            return so && f ? { ...so, filename: f.filename } : so;
          },
          link: (href) => {
            const m = /knowledge_base\/\d+\/[a-z-]+\/answer\/(\d+)|\/answers?\/(\d+)(?:[/?#]|$)/i.exec(href);
            return m ? { key: `zammad-answer:${m[1] || m[2]}`, url: /^https?:/i.test(href) ? href : null } : null;
          },
          attachments: async () => files.map((f) => {
            const so = sameOrigin(f.url || `${api}/attachments/${f.id}`);
            return { extId: String(f.id), ref: so?.ref || `id:${f.id}`, filename: f.filename, mime: f.preferences?.['Content-Type'] || f.preferences?.['Mime-Type'] || '', size: Number(f.size) || 0, load: (max) => so ? so.load(max) : download(`${api}/attachments/${f.id}`, max) };
          }),
        };
      }
    },
  };

  return {
    kb,
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
        let articles;
        try { articles = (await json(`${api}/ticket_articles/by_ticket/${tk.id}`)) || []; } catch (e) {
          if (e.status === 401 || e.status === 403) throw e;
          yield { extId: String(tk.id), extKey: `#${tk.number}`, fetchError: e }; // counted as failed, import goes on
          continue;
        }
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
