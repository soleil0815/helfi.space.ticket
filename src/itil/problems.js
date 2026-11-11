// Problem management: root cause, workaround, known error; affected incidents via "causes".
import { HttpError, forbidden } from '../lib/http.js';
import { isAgent, agentOn } from '../auth/session.js';

export function createProblems(db, tickets, fields) {
  /** Create a problem from an incident and link it */
  function fromIncident(user, key, { title } = {}) {
    if (!isAgent(user)) throw forbidden();
    const inc = tickets.load(user, key);
    if (!agentOn(user, inc.project_id)) throw forbidden();
    const p = tickets.create(user, { title: title || inc.title, type: 'problem', projectId: inc.project_id, priority: inc.priority, description: '' }, { source: 'web' });
    db.transaction(() => {
      db.prepare("INSERT INTO ticket_links(from_id,to_id,kind,created_by) VALUES(?,?,'causes',?)").run(p.id, inc.id, user.id);
      tickets.logActivity(p.id, user.id, 'linked', 'causes:out', null, `${inc.project_key}-${inc.number}`);
      tickets.logActivity(inc.id, user.id, 'linked', 'causes:in', null, p.key);
    })();
    return p;
  }

  /** Problems causing an incident (for the notice in the incident) */
  function causesOf(ticketId, user = null) {
    return db.prepare("SELECT l.from_id id, t.project_id FROM ticket_links l JOIN tickets t ON t.id=l.from_id WHERE l.to_id=? AND l.kind='causes' AND t.type='problem'")
      .all(ticketId).filter((r) => !user || agentOn(user, r.project_id)).map((r) => {
        const t = tickets.ticketOut(tickets.rawById(r.id));
        const f = fields.read(r.id, 'problem');
        return { key: t.key, title: t.title, status: t.status, workaround: f.workaround, knownError: f.knownError };
      });
  }

  function knownErrors(user = null) {
    return db.prepare("SELECT t.id, t.project_id FROM tickets t JOIN ticket_fields f ON f.ticket_id=t.id AND f.name='knownError' AND f.value='1' WHERE t.type='problem' ORDER BY t.updated_at DESC")
      .all().filter((r) => !user || agentOn(user, r.project_id)).map((r) => {
        const t = tickets.ticketOut(tickets.rawById(r.id));
        return { key: t.key, title: t.title, status: t.status, ...fields.read(r.id, 'problem') };
      });
  }

  tickets.addDetailExtra((user, row) => {
    if (!agentOn(user, row.project_id)) return {};
    const out = {};
    if (row.type !== 'problem') { const c = causesOf(row.id, user); if (c.length) out.problems = c; }
    if (row.type === 'problem') out.affectedCount = db.prepare("SELECT COUNT(*) n FROM ticket_links l JOIN tickets t ON t.id=l.to_id WHERE l.from_id=? AND l.kind='causes' AND t.status<>'done'").get(row.id).n;
    return out;
  });

  return { fromIncident, causesOf, knownErrors, assertProblem: (row) => { if (row.type !== 'problem') throw new HttpError(400, 'err.badRequest'); } };
}
