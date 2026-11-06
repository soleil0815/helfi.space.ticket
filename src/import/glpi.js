// Import from GLPI (legacy REST API apirest.php, GLPI 9.5 – 11): adapter for the common import (./core.js).
// Entities become projects; followups and tasks become comments (private ones stay internal),
// solutions become public comments; documents of the ticket and of its followups come along.
import { convert as htmlToText } from 'html-to-text';
import { createSourceHttp, SourceError } from './http.js';

const PAGE = 100;
const MAX_PAGES = 20000;

export const GLPI_STATUS = { 1: ['New', 'new'], 2: ['Processing (assigned)', 'indeterminate'], 3: ['Processing (planned)', 'indeterminate'], 4: ['Pending', 'waiting'], 5: ['Solved', 'done'], 6: ['Closed', 'done'] };
const GLPI_TYPE = { 1: 'Incident', 2: 'Request' };
const GLPI_PRIORITY = { 1: 'Very low', 2: 'Low', 3: 'Medium', 4: 'High', 5: 'Very high', 6: 'Major' };

/** GLPI stores HTML with entities ("&lt;p&gt;…"): decode once, then turn into text */
export function glpiText(v) {
  let s = String(v ?? '');
  if (/&lt;\/?[a-z]/i.test(s)) s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
  if (!/<\/?[a-z]/i.test(s)) return s.trim(); // no tags → plain text (simple test, linear on any input)
  return htmlToText(s, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { hideLinkHrefIfSameAsText: true } }] }).trim();
}

/** "2025-03-01 08:00:00" (server time) → ISO */
const glpiDate = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(String(v || '').trim());
  return m ? new Date(`${m[1]}T${m[2]}`).toISOString() : (v || null);
};

/** c.baseUrl: address of apirest.php, e.g. https://glpi.firma.local/apirest.php */
export function glpiAdapter(c) {
  let session = null;
  const appToken = c.appToken ? { 'App-Token': c.appToken } : {};
  const { base, basePath, json, download } = createSourceHttp({
    baseUrl: c.baseUrl, verifyTls: c.verifyTls, caPem: c.caPem,
    headers: () => (session ? { 'Session-Token': session, ...appToken } : {}),
  });

  async function login() {
    if (session) return session;
    const auth = c.token ? `user_token ${c.token}` : `Basic ${Buffer.from(`${c.username || ''}:${c.password || ''}`).toString('base64')}`;
    const r = await json('/initSession', { headers: { Authorization: auth, ...appToken }, withAuth: false });
    if (!r?.session_token) throw new SourceError('Anmeldung beim Quellsystem fehlgeschlagen (Token prüfen, REST-API in GLPI aktiviert?).', 401);
    session = r.session_token;
    return session;
  }
  const get = async (path) => { await login(); return json(path); };

  /** All items of a list page by page (range=a-b); GLPI answers 400 when the range starts beyond the end */
  async function all(path) {
    const out = [];
    for (let from = 0, pages = 0; pages < MAX_PAGES; pages++, from += PAGE) {
      let list;
      try { list = await get(`${path}${path.includes('?') ? '&' : '?'}range=${from}-${from + PAGE - 1}`); }
      catch (e) { if (e.status === 400 && /RANGE/i.test(e.message)) break; throw e; }
      if (!Array.isArray(list) || !list.length) break;
      out.push(...list);
      if (list.length < PAGE) break;
    }
    return out;
  }
  const sub = async (path) => { try { const r = await get(path); return Array.isArray(r) ? r : []; } catch (e) { if (e.status === 401 || e.status === 403) throw e; return []; } };

  const userCache = new Map();
  async function user(id) {
    if (!id || Number(id) === 0) return null;
    if (!userCache.has(id)) {
      let u = null;
      try { u = await get(`/User/${encodeURIComponent(id)}`); } catch (e) { if (e.status === 401) throw e; }
      let email = '';
      if (u) {
        const mails = await sub(`/User/${encodeURIComponent(id)}/UserEmail`);
        email = (mails.find((m) => Number(m.is_default) === 1) || mails[0])?.email || '';
      }
      userCache.set(id, u ? { email, name: [u.firstname, u.realname].filter(Boolean).join(' ') || u.name || email, username: u.name || '', ref: `g${u.id}` } : null);
    }
    return userCache.get(id);
  }

  let tickets = null;
  async function allTickets() {
    if (!tickets) tickets = (await all('/Ticket?sort=1&order=ASC&expand_dropdowns=false&is_deleted=0')).filter((t) => !Number(t.is_deleted));
    return tickets;
  }
  let entities = null;
  async function entityNames() {
    if (!entities) {
      entities = new Map();
      for (const e of await all('/Entity')) entities.set(String(e.id), e.completename || e.name || `#${e.id}`);
    }
    return entities;
  }
  const statusOf = (t) => GLPI_STATUS[t.status] || [`Status ${t.status}`, 'indeterminate'];
  const docFiles = async (path, commentExtId, internal, author) => {
    const out = [];
    for (const di of await sub(path)) {
      let d = null;
      try { d = await get(`/Document/${encodeURIComponent(di.documents_id)}`); } catch (e) { if (e.status === 401) throw e; }
      if (!d || Number(d.is_deleted)) continue;
      out.push({
        extId: `doc:${d.id}:${commentExtId || 't'}`, filename: d.filename || d.name || `dokument-${d.id}`, mime: d.mime || 'application/octet-stream',
        size: Number(d.filesize) || 0, created: glpiDate(d.date_creation || d.date_mod), author, internal, commentExtId,
        load: (maxBytes) => download(`${base.origin}${basePath}/Document/${encodeURIComponent(d.id)}?alt=media`, maxBytes),
      });
    }
    return out;
  };

  return {
    kind: 'glpi',
    sourceId: `glpi:${base.host}${basePath}`,
    host: base.host,
    ticketSource: 'import',
    keyPrefix: 'G',
    async info() {
      const s = await get('/getFullSession');
      const sess = s?.session || {};
      return { title: 'GLPI', version: sess.glpi_version || '', user: [sess.glpifirstname, sess.glpirealname].filter(Boolean).join(' ') || sess.glpiname || '' };
    },
    async projects() {
      const [names, tks] = await Promise.all([entityNames(), allTickets()]);
      const count = new Map();
      for (const t of tks) count.set(String(t.entities_id), (count.get(String(t.entities_id)) || 0) + 1);
      return [...count].map(([id, n]) => ({ key: id, name: names.get(id) || `#${id}`, suggestKey: String(names.get(id) || 'GLPI').split('>').pop().trim(), count: n }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async inspect(keys) {
      const want = new Set(keys.map(String));
      const statuses = new Map();
      const types = new Set();
      const counts = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const t of await allTickets()) {
        if (!want.has(String(t.entities_id))) continue;
        counts[String(t.entities_id)]++;
        const [name, cat] = statusOf(t);
        statuses.set(name, cat);
        types.add(GLPI_TYPE[t.type] || '');
      }
      return { statuses: [...statuses].map(([name, category]) => ({ name, category })), types: [...types], counts };
    },
    async count(key) { return (await allTickets()).filter((t) => String(t.entities_id) === String(key)).length; },
    async *tickets(key, options = {}) {
      for (const t of await allTickets()) {
        if (String(t.entities_id) !== String(key)) continue;
        const people = await sub(`/Ticket/${t.id}/Ticket_User`);
        const requesterLink = people.find((p) => Number(p.type) === 1);
        const assigneeLink = people.find((p) => Number(p.type) === 2);
        const requester = requesterLink ? ((await user(requesterLink.users_id)) || (requesterLink.alternative_email ? { email: requesterLink.alternative_email, name: requesterLink.alternative_email } : null)) : null;
        const [statusName, category] = statusOf(t);
        let category2 = '';
        if (Number(t.itilcategories_id)) {
          try { const cat = await get(`/ITILCategory/${t.itilcategories_id}`); category2 = cat?.completename || cat?.name || ''; } catch (e) { if (e.status === 401) throw e; }
        }
        yield {
          extId: String(t.id),
          extKey: `#${t.id}`,
          number: Number(t.id),
          title: t.name,
          description: glpiText(t.content),
          typeName: GLPI_TYPE[t.type] || '',
          statusName,
          statusCategory: category,
          priorityName: GLPI_PRIORITY[t.priority] || '',
          labels: category2 ? [category2.split('>').pop().trim().replace(/\s+/g, '-')] : [],
          due: t.time_to_resolve ? glpiDate(t.time_to_resolve)?.slice(0, 10) : null,
          created: glpiDate(t.date || t.date_creation),
          updated: glpiDate(t.date_mod),
          resolved: glpiDate(t.solvedate || t.closedate),
          reporter: requester,
          assignee: assigneeLink ? await user(assigneeLink.users_id) : null,
          comments: async () => {
            const out = [];
            for (const f of await sub(`/Ticket/${t.id}/ITILFollowup`)) {
              out.push({ extId: `fu:${f.id}`, author: await user(f.users_id), body: glpiText(f.content), internal: Number(f.is_private) === 1, created: glpiDate(f.date || f.date_creation) });
            }
            for (const k of await sub(`/Ticket/${t.id}/TicketTask`)) {
              const text = glpiText(k.content);
              out.push({ extId: `task:${k.id}`, author: await user(k.users_id_tech || k.users_id), body: text, internal: Number(k.is_private) === 1, created: glpiDate(k.date || k.date_creation) });
            }
            for (const s of await sub(`/Ticket/${t.id}/ITILSolution`)) {
              out.push({ extId: `sol:${s.id}`, author: await user(s.users_id), body: glpiText(s.content), internal: false, created: glpiDate(s.date_creation) });
            }
            return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
          },
          attachments: options.attachments === false ? null : async () => {
            const files = await docFiles(`/Ticket/${t.id}/Document_Item`, null, false, requester);
            for (const f of await sub(`/Ticket/${t.id}/ITILFollowup`)) {
              files.push(...await docFiles(`/ITILFollowup/${f.id}/Document_Item`, `fu:${f.id}`, Number(f.is_private) === 1, await user(f.users_id)));
            }
            return files;
          },
        };
      }
    },
  };
}
