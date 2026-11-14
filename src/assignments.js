// Assignments that no longer fit: a ticket that is not done stays assigned only to someone who may
// work on it – an active account that is an agent of the ticket's project (the same rule as
// tickets.isAssignable: admins, legacy agents, and the project's people from project_agents).
// Everyone else (deactivated, removed from the project, lost the AD/SSO group, ticket moved to a
// project they do not work on) is taken off the ticket, which then shows up as unassigned again
// (queues, daily reminder). Closed tickets keep their assignee as a record of who handled them.
import { AGENT_OF_PROJECT } from './auth/access.js';

// "may work on the ticket's project": AGENT_OF_PROJECT with the ticket's project instead of a parameter
const AGENT_OF_TICKET_PROJECT = AGENT_OF_PROJECT.replace('project_id=?', 'project_id=t.project_id');
if (AGENT_OF_TICKET_PROJECT === AGENT_OF_PROJECT) throw new Error('AGENT_OF_PROJECT changed: adjust assignments.js');

/** SQL condition (tickets t, users u = the assignee): this assignment must be released */
export const UNASSIGNABLE_SQL = `t.status<>'done' AND NOT (u.active=1 AND ${AGENT_OF_TICKET_PROJECT})`;

/**
 * Release assignments that no longer fit (see above). Filters (all optional, combined):
 * ticketId, projectId, userId (assignee). actorId: who caused it (null = the system).
 * Each release gets a history entry "assignee: X → –". Returns the released ticket ids.
 * Runs inside the caller's transaction if there is one.
 */
export function releaseUnassignable(db, { ticketId = null, projectId = null, userId = null, actorId = null } = {}) {
  const where = [UNASSIGNABLE_SQL];
  const args = [];
  if (ticketId != null) { where.push('t.id=?'); args.push(Number(ticketId)); }
  if (projectId != null) { where.push('t.project_id=?'); args.push(Number(projectId)); }
  if (userId != null) { where.push('t.assignee_id=?'); args.push(Number(userId)); }
  const rows = db.prepare(`SELECT t.id, u.display_name name FROM tickets t JOIN users u ON u.id=t.assignee_id WHERE ${where.join(' AND ')}`).all(...args);
  if (!rows.length) return [];
  const clear = db.prepare('UPDATE tickets SET assignee_id=NULL WHERE id=?');
  const logIt = db.prepare("INSERT INTO activity(ticket_id,user_id,action,field,old_value,new_value) VALUES(?,?,'changed','assignee',?,NULL)");
  db.transaction(() => {
    for (const r of rows) { clear.run(r.id); logIt.run(r.id, actorId, r.name ?? ''); }
  })();
  return rows.map((r) => r.id);
}
