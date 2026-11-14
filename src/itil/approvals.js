// Approvals (change, service catalog): one round per request, one decision per person.
import { HttpError, forbidden, str } from '../lib/http.js';

export function createApprovals(db, users) {
  const latestRound = (ticketId) => db.prepare('SELECT MAX(round) r FROM approvals WHERE ticket_id=?').get(ticketId).r || 0;

  /** request a new round; returns the round number */
  function request(ticketId, approverIds) {
    const ids = [...new Set(approverIds.map(Number).filter(Boolean))];
    if (!ids.length) throw new HttpError(400, 'err.noApprovers');
    const round = latestRound(ticketId) + 1;
    const ins = db.prepare('INSERT INTO approvals(ticket_id, approver_id, round) VALUES(?,?,?)');
    db.transaction(() => { for (const id of ids) ins.run(ticketId, id, round); })();
    return round;
  }

  function current(ticketId) {
    const round = latestRound(ticketId);
    if (!round) return { round: 0, items: [] };
    const items = db.prepare(`SELECT a.*, u.display_name name FROM approvals a JOIN users u ON u.id=a.approver_id
      WHERE a.ticket_id=? AND a.round=? ORDER BY a.id`).all(ticketId, round)
      .map((a) => ({ approverId: a.approver_id, name: a.name, decision: a.decision, comment: a.comment, decidedAt: a.decided_at }));
    return { round, items };
  }

  /** Result of the current round: approved | rejected | pending | none */
  function outcome(ticketId, mode = 'any') {
    const { items } = current(ticketId);
    if (!items.length) return 'none';
    if (items.some((a) => a.decision === 'reject')) return 'rejected';
    const yes = items.filter((a) => a.decision === 'approve').length;
    if (mode === 'all' ? yes === items.length : yes > 0) return 'approved';
    return 'pending';
  }

  function decide(user, ticketId, decision, comment = '') {
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'err.badRequest', 'decision');
    const round = latestRound(ticketId);
    const row = db.prepare('SELECT * FROM approvals WHERE ticket_id=? AND round=? AND approver_id=?').get(ticketId, round, user.id);
    if (!row) throw forbidden();
    if (row.decision) throw new HttpError(409, 'err.alreadyDecided');
    db.prepare("UPDATE approvals SET decision=?, comment=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(decision, str(comment, 2000).trim() || null, row.id);
  }

  const isPendingApprover = (ticketId, userId) => !!db.prepare('SELECT 1 FROM approvals WHERE ticket_id=? AND round=? AND approver_id=? AND decision IS NULL')
    .get(ticketId, latestRound(ticketId), userId);

  /** Approver of this ticket in any round (current or earlier) */
  const isApprover = (ticketId, userId) => !!db.prepare('SELECT 1 FROM approvals WHERE ticket_id=? AND approver_id=?').get(ticketId, userId);

  /** Tickets waiting for this person's decision */
  function pendingFor(userId) {
    return db.prepare(`SELECT a.ticket_id FROM approvals a WHERE a.approver_id=? AND a.decision IS NULL
      AND a.round=(SELECT MAX(round) FROM approvals b WHERE b.ticket_id=a.ticket_id)`).all(userId).map((r) => r.ticket_id);
  }

  const approverUsers = (ids) => ids.map((id) => users.byId(Number(id))).filter((u) => u && u.active);

  return { request, current, outcome, decide, isPendingApprover, isApprover, pendingFor, approverUsers };
}
