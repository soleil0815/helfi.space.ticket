// Problem-Management: Ursache, Workaround, bekannter Fehler; betroffene Störungen über „verursacht“.
import { HttpError, forbidden } from '../lib/http.js';
import { isAgent } from '../auth/session.js';

export function createProblems(db, tickets, fields) {
  /** Problem aus einer Störung anlegen und verknüpfen */
  function fromIncident(user, key, { title } = {}) {
    if (!isAgent(user)) throw forbidden();
    const inc = tickets.load(user, key);
    const p = tickets.create(user, { title: title || inc.title, type: 'problem', projectId: inc.project_id, priority: inc.priority, description: '' }, { source: 'web' });
    db.transaction(() => {
      db.prepare("INSERT INTO ticket_links(from_id,to_id,kind,created_by) VALUES(?,?,'causes',?)").run(p.id, inc.id, user.id);
      tickets.logActivity(p.id, user.id, 'linked', 'causes:out', null, `${inc.project_key}-${inc.number}`);
      tickets.logActivity(inc.id, user.id, 'linked', 'causes:in', null, p.key);
    })();
    return p;
  }

  /** Probleme, die eine Störung verursachen (für den Hinweis in der Störung) */
  function causesOf(ticketId) {
    return db.prepare("SELECT l.from_id id FROM ticket_links l JOIN tickets t ON t.id=l.from_id WHERE l.to_id=? AND l.kind='causes' AND t.type='problem'")
      .all(ticketId).map((r) => {
        const t = tickets.ticketOut(tickets.rawById(r.id));
        const f = fields.read(r.id, 'problem');
        return { key: t.key, title: t.title, status: t.status, workaround: f.workaround, knownError: f.knownError };
      });
  }

  function knownErrors() {
    return db.prepare("SELECT t.id FROM tickets t JOIN ticket_fields f ON f.ticket_id=t.id AND f.name='knownError' AND f.value='1' WHERE t.type='problem' ORDER BY t.updated_at DESC")
      .all().map((r) => {
        const t = tickets.ticketOut(tickets.rawById(r.id));
        return { key: t.key, title: t.title, status: t.status, ...fields.read(r.id, 'problem') };
      });
  }

  tickets.addDetailExtra((user, row) => {
    if (!isAgent(user)) return {};
    const out = {};
    if (row.type !== 'problem') { const c = causesOf(row.id); if (c.length) out.problems = c; }
    if (row.type === 'problem') out.affectedCount = db.prepare("SELECT COUNT(*) n FROM ticket_links l JOIN tickets t ON t.id=l.to_id WHERE l.from_id=? AND l.kind='causes' AND t.status<>'done'").get(row.id).n;
    return out;
  });

  return { fromIncident, causesOf, knownErrors, assertProblem: (row) => { if (row.type !== 'problem') throw new HttpError(400, 'err.badRequest'); } };
}
