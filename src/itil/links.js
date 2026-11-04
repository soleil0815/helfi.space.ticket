// Links between tickets: relates to, duplicate, blocks, causes, subtask.
// Stored directed (from → to); the reverse direction is derived when displaying.
import { HttpError, notFound, forbidden, str } from '../lib/http.js';
import { isAgent } from '../auth/session.js';

// kind: meaning from the point of view of "from"
export const LINK_KINDS = ['relates', 'duplicates', 'blocks', 'causes', 'parent'];
export const MAX_LINKS = 50;

export function createLinks(db, tickets) {
  const keyOf = (row) => `${row.project_key}-${row.number}`;

  function list(ticketId) {
    const rows = db.prepare(`SELECT l.id, l.kind, l.from_id, l.to_id FROM ticket_links l
      WHERE l.from_id=? OR l.to_id=? ORDER BY l.id`).all(ticketId, ticketId);
    return rows.map((l) => {
      const out = l.from_id === ticketId;
      const other = tickets.rawById(out ? l.to_id : l.from_id);
      if (!other) return null;
      const t = tickets.ticketOut(other);
      return {
        id: l.id, kind: l.kind, direction: out ? 'out' : 'in',
        ticket: { id: t.id, key: t.key, title: t.title, status: t.status, type: t.type, priority: t.priority, assignee: t.assignee },
      };
    }).filter(Boolean);
  }

  /** Would from → to as "parent" create a cycle? (to is already an ancestor of from) */
  function wouldCycle(fromId, toId) {
    const seen = new Set();
    const stack = [fromId];
    const parentOf = db.prepare("SELECT from_id FROM ticket_links WHERE kind='parent' AND to_id=?");
    while (stack.length) {
      const cur = stack.pop();
      if (cur === toId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const r of parentOf.all(cur)) stack.push(r.from_id);
    }
    return false;
  }

  function add(user, keyFrom, { kind, target } = {}) {
    if (!isAgent(user)) throw forbidden();
    if (!LINK_KINDS.includes(kind)) throw new HttpError(400, 'err.badRequest', 'kind');
    const a = tickets.load(user, keyFrom);
    let b;
    try { b = tickets.load(user, str(target, 30).trim()); } catch { throw new HttpError(400, 'err.linkTarget'); }
    if (a.id === b.id) throw new HttpError(400, 'err.linkSelf');
    // "parent" is stored as "a is a subtask of b": parents always come first
    let [from, to, k] = [a, b, kind];
    if (kind === 'parent') [from, to] = [b, a];
    const exists = db.prepare('SELECT 1 FROM ticket_links WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))').get(from.id, to.id, to.id, from.id);
    if (exists) throw new HttpError(409, 'err.linkExists');
    if (k === 'parent') {
      if (db.prepare("SELECT 1 FROM ticket_links WHERE kind='parent' AND to_id=?").get(to.id)) throw new HttpError(409, 'err.linkOneParent');
      if (wouldCycle(from.id, to.id)) throw new HttpError(400, 'err.linkCycle');
    }
    for (const t of [from, to]) {
      if (db.prepare('SELECT COUNT(*) n FROM ticket_links WHERE from_id=? OR to_id=?').get(t.id, t.id).n >= MAX_LINKS) throw new HttpError(400, 'err.linkLimit');
    }
    db.transaction(() => {
      db.prepare('INSERT INTO ticket_links(from_id,to_id,kind,created_by) VALUES(?,?,?,?)').run(from.id, to.id, k, user.id);
      tickets.logActivity(from.id, user.id, 'linked', `${k}:out`, null, keyOf(to));
      tickets.logActivity(to.id, user.id, 'linked', `${k}:in`, null, keyOf(from));
    })();
    return list(a.id);
  }

  function remove(user, key, linkId) {
    if (!isAgent(user)) throw forbidden();
    const a = tickets.load(user, key);
    const l = db.prepare('SELECT * FROM ticket_links WHERE id=? AND (from_id=? OR to_id=?)').get(linkId, a.id, a.id);
    if (!l) throw notFound();
    const from = tickets.rawById(l.from_id);
    const to = tickets.rawById(l.to_id);
    db.transaction(() => {
      db.prepare('DELETE FROM ticket_links WHERE id=?').run(l.id);
      tickets.logActivity(from.id, user.id, 'unlinked', `${l.kind}:out`, keyOf(to), null);
      tickets.logActivity(to.id, user.id, 'unlinked', `${l.kind}:in`, keyOf(from), null);
    })();
    return list(a.id);
  }

  /** Create a subtask: task in the same project, linked */
  function createSubtask(user, key, { title, assigneeId = null } = {}) {
    if (!isAgent(user)) throw forbidden();
    const parent = tickets.load(user, key);
    const t = tickets.create(user, { title, type: 'task', projectId: parent.project_id, priority: parent.priority, assigneeId }, { source: 'web' });
    db.transaction(() => {
      db.prepare("INSERT INTO ticket_links(from_id,to_id,kind,created_by) VALUES(?,?,'parent',?)").run(parent.id, t.id, user.id);
      tickets.logActivity(parent.id, user.id, 'linked', 'parent:out', null, t.key);
      tickets.logActivity(t.id, user.id, 'linked', 'parent:in', null, keyOf(parent));
    })();
    return { ticket: t, links: list(parent.id) };
  }

  // Ticket view: only agents see links
  tickets.addDetailExtra((user, row) => (isAgent(user) ? { links: list(row.id) } : {}));

  return { list, add, remove, createSubtask };
}
