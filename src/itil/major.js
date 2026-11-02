// Major Incident: eine Störung mit vielen Betroffenen. Betroffene Tickets hängen über
// „verursacht“ (Major → Ticket) daran; eine Nachricht geht an alle auf einmal.
import { HttpError, forbidden, str } from '../lib/http.js';
import { isAgent } from '../auth/session.js';

export function createMajor(db, tickets) {
  /** offene Tickets, die der Major Incident verursacht */
  function affected(ticketId) {
    return db.prepare("SELECT t.id FROM ticket_links l JOIN tickets t ON t.id=l.to_id WHERE l.from_id=? AND l.kind='causes' AND t.status<>'done'")
      .all(ticketId).map((r) => r.id);
  }

  /** Nachricht an Melder aller betroffenen Tickets (und des Major Incidents selbst), optional alle erledigen */
  function broadcast(user, key, { body, resolve = false } = {}) {
    if (!isAgent(user)) throw forbidden();
    const major = tickets.load(user, key);
    // Major Incident oder Problem: alle betroffenen Störungen informieren
    if (!major.major && major.type !== 'problem') throw new HttpError(400, 'err.notMajor');
    const text = str(body, 20000).trim();
    if (!text) throw new HttpError(400, 'err.badRequest', 'body');
    const ids = [major.id, ...affected(major.id)];
    let done = 0;
    for (const id of ids) {
      tickets.addComment(user, id, { body: text });
      if (resolve) { tickets.update(user, id, { status: 'done' }, { quietResolved: true }); done++; }
    }
    return { notified: ids.length, resolved: done };
  }

  /** offene Major Incidents (für den Hinweis-Balken der Bearbeiter) */
  function open() {
    return db.prepare("SELECT t.id FROM tickets t WHERE t.major=1 AND t.status<>'done' ORDER BY t.created_at")
      .all().map((r) => { const t = tickets.ticketOut(tickets.rawById(r.id)); return { key: t.key, title: t.title }; });
  }

  tickets.addDetailExtra((user, row) => (isAgent(user) && row.major ? { affectedCount: affected(row.id).length } : {}));

  return { affected, broadcast, open };
}
