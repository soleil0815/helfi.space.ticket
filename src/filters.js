// Saved filters: an agent saves the current list filters under a name (personal); admins can
// share one with all agents as a queue. Shown in the sidebar with a count, on phones as chips.
import { HttpError, notFound, forbidden, str, int } from './lib/http.js';

// Only filters of the ticket list – nothing else gets stored or replayed
export const FILTER_KEYS = ['project', 'status', 'type', 'priority', 'assignee', 'reporter', 'participant', 'mentioned', 'label', 'overdue', 'resolvedDays', 'component', 'q', 'sort'];
export const MAX_PER_OWNER = 50;

/** "?status=open&x=1" or object → canonical query string with allowed keys only (sorted) */
export function normalizeQuery(q) {
  let params;
  if (q && typeof q === 'object' && !Array.isArray(q)) params = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, str(v, 300)]));
  else params = new URLSearchParams(str(q, 2000).replace(/^\?/, ''));
  const out = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = (params.get(k) || '').trim().slice(0, 300);
    if (v) out.set(k, v);
  }
  return out.toString();
}

export function createSavedFilters(db, tickets) {
  const isAdmin = (u) => u.role === 'admin';
  const out = (r, user) => ({
    id: r.id, name: r.name, query: r.query, shared: r.owner_id === null, position: r.position,
    canEdit: r.owner_id === null ? isAdmin(user) : r.owner_id === user.id,
  });
  const rows = (user) => db.prepare(`SELECT * FROM saved_filters WHERE owner_id IS NULL OR owner_id=?
    ORDER BY owner_id IS NOT NULL, position, id`).all(user.id);

  function own(user, id) {
    const r = db.prepare('SELECT * FROM saved_filters WHERE id=?').get(int(id) || 0);
    if (!r || (r.owner_id !== null && r.owner_id !== user.id)) throw notFound();
    if (r.owner_id === null && !isAdmin(user)) throw forbidden();
    return r;
  }
  const cleanName = (v) => {
    const n = str(v, 60).trim().replace(/\s+/g, ' ');
    if (!n) throw new HttpError(400, 'err.filterName');
    return n;
  };

  /** Shared queues first, then own filters – each with the current number of tickets */
  function list(user, { counts = true } = {}) {
    return rows(user).map((r) => {
      const f = out(r, user);
      if (counts) {
        try { f.count = tickets.count(user, Object.fromEntries(new URLSearchParams(r.query))); } catch { f.count = null; }
      }
      return f;
    });
  }

  function create(user, { name, query, shared = false }) {
    if (shared && !isAdmin(user)) throw forbidden();
    const owner = shared ? null : user.id;
    const n = db.prepare(`SELECT COUNT(*) n FROM saved_filters WHERE ${owner === null ? 'owner_id IS NULL' : 'owner_id=?'}`).get(...(owner === null ? [] : [owner])).n;
    if (n >= MAX_PER_OWNER) throw new HttpError(400, 'err.tooManyFilters');
    const pos = db.prepare(`SELECT COALESCE(MAX(position),0)+1 p FROM saved_filters WHERE ${owner === null ? 'owner_id IS NULL' : 'owner_id=?'}`).get(...(owner === null ? [] : [owner])).p;
    const info = db.prepare('INSERT INTO saved_filters(owner_id,name,query,position,created_by) VALUES(?,?,?,?,?)')
      .run(owner, cleanName(name), normalizeQuery(query), pos, user.id);
    return out(db.prepare('SELECT * FROM saved_filters WHERE id=?').get(info.lastInsertRowid), user);
  }

  function update(user, id, { name, query }) {
    const r = own(user, id);
    db.prepare('UPDATE saved_filters SET name=?, query=? WHERE id=?')
      .run(name !== undefined ? cleanName(name) : r.name, query !== undefined ? normalizeQuery(query) : r.query, r.id);
    return out(db.prepare('SELECT * FROM saved_filters WHERE id=?').get(r.id), user);
  }

  function remove(user, id) {
    const r = own(user, id);
    db.prepare('DELETE FROM saved_filters WHERE id=?').run(r.id);
    return { ok: true };
  }

  /** New order of the own filters (shared: admins, the shared list) */
  function reorder(user, ids, shared = false) {
    if (shared && !isAdmin(user)) throw forbidden();
    if (!Array.isArray(ids)) throw new HttpError(400, 'err.badRequest', 'ids');
    const mine = db.prepare(`SELECT id FROM saved_filters WHERE ${shared ? 'owner_id IS NULL' : 'owner_id=?'} ORDER BY position, id`).all(...(shared ? [] : [user.id])).map((r) => r.id);
    const wanted = [...new Set(ids.map((x) => int(x)).filter((x) => mine.includes(x)))];
    const order = [...wanted, ...mine.filter((x) => !wanted.includes(x))];
    const stmt = db.prepare('UPDATE saved_filters SET position=? WHERE id=?');
    db.transaction(() => order.forEach((fid, i) => stmt.run(i + 1, fid)))();
    return list(user, { counts: false });
  }

  return { list, create, update, remove, reorder };
}
