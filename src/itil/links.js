// Links between tickets: relates to, duplicate, blocks, causes, subtask.
// Stored directed (from → to); the reverse direction is derived when displaying.
import { HttpError, notFound, forbidden, str } from '../lib/http.js';
import { isAgent, agentOn } from '../auth/session.js';

// kind: meaning from the point of view of "from"
export const LINK_KINDS = ['relates', 'duplicates', 'blocks', 'causes', 'parent'];
export const MAX_LINKS = 50;

// Words that say nothing about the content (German/English filler, ticket phrases)
const STOP = new Set(`aber alle allem allen aller alles also auch auf aus bei beim bin bis bitte bzw dann das dass dem den der des die dies diese diesem dieser doch dort durch ein eine einem einen einer eines etwas für geht gibt habe haben hallo hat hatte heute hier ich ihr ihre ist jetzt kann kein keine mehr mein meine mit morgen muss nach nicht noch nur oder ohne schon sehr seit sich sie sind über und uns unter vom von vor war wenn werden wie wieder wir wird zum zur danke gruß grüße viele freundlichen problem fehler frage hilfe ticket
about after again also and any are been but can cannot does dont for from get has have hello help her his how its just more not now our please problem issue question thanks that the their there they this was what when where which with would you your`.split(/\s+/));

/** The most telling words of some tickets (title counts double), for "similar tickets" */
export function significantWords(items, max = 8) {
  const score = new Map();
  for (const { title, text } of items) {
    const add = (s, w) => {
      // Parts of compound words count on their own ("Spooler-Fehler" → spooler, fehler)
      for (const m of String(s || '').toLowerCase().matchAll(/[\p{L}\p{N}]{4,}/gu)) {
        const word = m[0];
        if (STOP.has(word) || /^\d+$/.test(word)) continue;
        score.set(word, (score.get(word) || 0) + w);
      }
    };
    add(title, 2);
    add(String(text || '').slice(0, 2000), 1);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

export function createLinks(db, tickets) {
  const keyOf = (row) => `${row.project_key}-${row.number}`;

  /** user (optional): leave out linked tickets of projects the agent does not work on */
  function list(ticketId, user = null) {
    const rows = db.prepare(`SELECT l.id, l.kind, l.from_id, l.to_id FROM ticket_links l
      WHERE l.from_id=? OR l.to_id=? ORDER BY l.id`).all(ticketId, ticketId);
    return rows.map((l) => {
      const out = l.from_id === ticketId;
      const other = tickets.rawById(out ? l.to_id : l.from_id);
      if (!other || (user && !agentOn(user, other.project_id))) return null;
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
    if (!agentOn(user, a.project_id)) throw forbidden();
    try { b = tickets.load(user, str(target, 30).trim()); } catch { throw new HttpError(400, 'err.linkTarget'); }
    if (!agentOn(user, b.project_id)) throw new HttpError(400, 'err.linkTarget');
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
    return list(a.id, user);
  }

  function remove(user, key, linkId) {
    if (!isAgent(user)) throw forbidden();
    const a = tickets.load(user, key);
    if (!agentOn(user, a.project_id)) throw forbidden();
    const l = db.prepare('SELECT * FROM ticket_links WHERE id=? AND (from_id=? OR to_id=?)').get(linkId, a.id, a.id);
    if (!l) throw notFound();
    const from = tickets.rawById(l.from_id);
    const to = tickets.rawById(l.to_id);
    db.transaction(() => {
      db.prepare('DELETE FROM ticket_links WHERE id=?').run(l.id);
      tickets.logActivity(from.id, user.id, 'unlinked', `${l.kind}:out`, keyOf(to), null);
      tickets.logActivity(to.id, user.id, 'unlinked', `${l.kind}:in`, keyOf(from), null);
    })();
    return list(a.id, user);
  }

  /** Create a subtask: task in the same project, linked */
  function createSubtask(user, key, { title, assigneeId = null } = {}) {
    if (!isAgent(user)) throw forbidden();
    const parent = tickets.load(user, key);
    if (!agentOn(user, parent.project_id)) throw forbidden();
    const t = tickets.create(user, { title, type: 'task', projectId: parent.project_id, priority: parent.priority, assigneeId }, { source: 'web' });
    db.transaction(() => {
      db.prepare("INSERT INTO ticket_links(from_id,to_id,kind,created_by) VALUES(?,?,'parent',?)").run(parent.id, t.id, user.id);
      tickets.logActivity(parent.id, user.id, 'linked', 'parent:out', null, t.key);
      tickets.logActivity(t.id, user.id, 'linked', 'parent:in', null, keyOf(parent));
    })();
    return { ticket: t, links: list(parent.id, user) };
  }

  // Ticket view: only agents see links
  tickets.addDetailExtra((user, row) => (agentOn(user, row.project_id) ? { links: list(row.id, user) } : {}));

  /**
   * Suggestions for linking (agents): open problems and major incidents ("possible cause") and
   * tickets with the same striking words in title/description ("similar"). keys = the ticket(s) to
   * link (one ticket or a multi-select); they and tickets already linked to a single one are left out.
   */
  function suggest(user, keys) {
    const rows = [];
    for (const k of keys.slice(0, 50)) {
      try { const r = tickets.load(user, k); if (agentOn(user, r.project_id)) rows.push(r); } catch { /* unknown/invisible: ignore */ }
    }
    const exclude = new Set(rows.map((r) => r.id));
    if (rows.length === 1) for (const l of db.prepare('SELECT from_id, to_id FROM ticket_links WHERE from_id=? OR to_id=?').all(rows[0].id, rows[0].id)) { exclude.add(l.from_id); exclude.add(l.to_id); }
    const brief = (r) => {
      const t = tickets.ticketOut(r);
      return { key: t.key, title: t.title, status: t.status, type: t.type, major: !!t.major, updatedAt: t.updatedAt };
    };
    const mine = (r) => agentOn(user, r.project_id);
    const causes = db.prepare(`SELECT id, project_id FROM tickets WHERE status<>'done' AND (type='problem' OR major=1)
      ORDER BY major DESC, updated_at DESC LIMIT 200`).all()
      .filter((r) => !exclude.has(r.id) && mine(r)).slice(0, 6)
      .map((r) => tickets.rawById(r.id)).filter(Boolean).map(brief);
    const shown = new Set(causes.map((c) => c.key));
    const words = significantWords(rows.map((r) => ({ title: r.title, text: r.description })));
    const similar = tickets.search.similar(words, { limit: 40 })
      .filter((id) => !exclude.has(id))
      .map((id) => tickets.rawById(id)).filter((r) => r && mine(r)).map(brief)
      .filter((t) => !shown.has(t.key)).slice(0, 8);
    return { causes, similar, words };
  }

  return { list, add, remove, createSubtask, suggest };
}
