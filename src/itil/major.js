// Major incident: an incident affecting many people. Affected tickets are attached via
// "causes" (major → ticket); one message goes to all of them at once.
import { HttpError, forbidden, str } from '../lib/http.js';
import { isAgent, agentOn } from '../auth/session.js';

export function createMajor(db, tickets) {
  /** open tickets caused by the major incident */
  function affected(ticketId) {
    return db.prepare("SELECT t.id FROM ticket_links l JOIN tickets t ON t.id=l.to_id WHERE l.from_id=? AND l.kind='causes' AND t.status<>'done'")
      .all(ticketId).map((r) => r.id);
  }

  /** Message to the reporters of all affected tickets (and of the major incident itself), optionally resolve all */
  function broadcast(user, key, { body, resolve = false } = {}) {
    if (!isAgent(user)) throw forbidden();
    const major = tickets.load(user, key);
    if (!agentOn(user, major.project_id)) throw forbidden();
    // Major incident or problem: notify all affected incidents
    if (!major.major && major.type !== 'problem') throw new HttpError(400, 'err.notMajor');
    const text = str(body, 20000).trim();
    if (!text) throw new HttpError(400, 'err.badRequest', 'body');
    // Affected tickets of other projects are not this agent's to answer (or to see)
    const ids = [major.id, ...affected(major.id).filter((id) => agentOn(user, tickets.rawById(id)?.project_id))];
    let done = 0;
    for (const id of ids) {
      tickets.addComment(user, id, { body: text });
      if (resolve) { tickets.update(user, id, { status: 'done' }, { quietResolved: true }); done++; }
    }
    return { notified: ids.length, resolved: done };
  }

  /** open major incidents (for the agents' notice bar) – user: only those of their projects */
  function open(user = null) {
    return db.prepare("SELECT t.id, t.project_id FROM tickets t WHERE t.major=1 AND t.status<>'done' ORDER BY t.created_at")
      .all().filter((r) => !user || agentOn(user, r.project_id)).map((r) => { const t = tickets.ticketOut(tickets.rawById(r.id)); return { key: t.key, title: t.title }; });
  }

  tickets.addDetailExtra((user, row) => (agentOn(user, row.project_id) && row.major ? { affectedCount: affected(row.id).length } : {}));

  return { affected, broadcast, open };
}
