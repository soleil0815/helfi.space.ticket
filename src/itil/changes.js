// Change management: standard/normal/emergency, phases, approval (CAB), calendar, review.
import { HttpError, forbidden, str } from '../lib/http.js';
import { isAgent, agentOn } from '../auth/session.js';
import { log } from '../lib/log.js';

export const PHASES = ['draft', 'approval', 'approved', 'rejected', 'scheduled', 'implementing', 'review', 'closed'];
// Ticket status per phase
const STATUS_OF = { draft: 'open', approval: 'open', approved: 'open', scheduled: 'open', implementing: 'in_progress', review: 'in_progress', rejected: 'done', closed: 'done' };

export function createChanges(db, tickets, fields, approvals, settings, { mailer = null, users = null, baseUrl = '', t = null } = {}) {
  const approverIds = () => String(settings.get('change.approvers') || '').split(/[\s,;]+/).map(Number).filter(Boolean);
  const mode = () => (settings.get('change.approvalMode') === 'all' ? 'all' : 'any');
  const keyOf = (row) => `${row.project_key}-${row.number}`;

  function state(row) {
    const f = fields.read(row.id, 'change');
    return { ...f, phase: f.phase || 'draft', changeType: f.changeType || 'normal' };
  }

  /** allowed next phases */
  function nextPhases(f) {
    const n = {
      draft: f.changeType === 'standard' ? ['scheduled'] : f.changeType === 'emergency' ? ['implementing', 'approval'] : ['approval'],
      approval: [], // decided by the approval
      approved: ['scheduled', 'implementing'],
      rejected: ['draft'],
      scheduled: ['implementing', 'draft'],
      implementing: ['review'],
      review: ['closed'],
      closed: [],
    };
    return n[f.phase] || [];
  }

  function require(f, names) {
    const missing = names.filter((n) => !f[n]);
    if (missing.length) throw new HttpError(400, 'err.changeMissing', missing.join(','));
  }

  function setPhase(user, row, phase, extra = {}) {
    fields.update(user, keyOf(row), { phase, ...extra }, { allowed: ['phase', 'outcome', 'review'] });
    const status = STATUS_OF[phase];
    if (status !== row.status) tickets.update(user, row.id, { status }, { quietResolved: true });
  }

  function transition(user, key, to, { outcome = null, review = null } = {}) {
    if (!isAgent(user)) throw forbidden();
    const row = tickets.load(user, key);
    if (!agentOn(user, row.project_id)) throw forbidden();
    if (row.type !== 'change') throw new HttpError(400, 'err.notChange');
    const f = state(row);
    if (!nextPhases(f).includes(to)) throw new HttpError(400, 'err.changePhase', `${f.phase}→${to}`);
    const base = ['reason', 'risk', 'plannedStart', 'plannedEnd', 'implementationPlan'];
    if (to === 'approval') {
      require(f, [...base, 'backoutPlan']);
      const ids = approvals.approverUsers(approverIds()).map((u) => u.id);
      if (!ids.length) throw new HttpError(400, 'err.noApprovers');
      approvals.request(row.id, ids);
      if (f.phase === 'draft') setPhase(user, row, 'approval');
      notifyApprovers(row, ids);
      return detail(user, key);
    }
    if (to === 'scheduled' || (to === 'implementing' && f.phase === 'draft')) require(f, f.changeType === 'emergency' ? ['implementationPlan', 'backoutPlan'] : base);
    if (to === 'closed') {
      const oc = outcome || f.outcome;
      if (!['successful', 'issues', 'rolledBack'].includes(oc)) throw new HttpError(400, 'err.changeMissing', 'outcome');
      const rv = review !== null ? str(review, 20000).trim() : f.review;
      if (oc !== 'successful' && !rv) throw new HttpError(400, 'err.changeMissing', 'review');
      setPhase(user, row, 'closed', { outcome: oc, review: rv || '' });
      return detail(user, key);
    }
    setPhase(user, row, to);
    return detail(user, key);
  }

  /** Emergency change: obtain approval afterwards (phase stays) */
  function requestLate(user, key) {
    if (!isAgent(user)) throw forbidden();
    const row = tickets.load(user, key);
    if (!agentOn(user, row.project_id)) throw forbidden();
    const f = state(row);
    if (row.type !== 'change' || f.changeType !== 'emergency' || f.phase === 'draft' || approvals.current(row.id).round) throw new HttpError(400, 'err.changePhase');
    const ids = approvals.approverUsers(approverIds()).map((u) => u.id);
    approvals.request(row.id, ids);
    notifyApprovers(row, ids);
    return detail(user, key);
  }

  /**
   * Decision of an approver of the current round (any role – approvers need not work on the change's
   * project). Vote and the resulting phase change happen in one transaction; the phase change is a
   * system step done on the approver's behalf, so it does not need agent rights on the project.
   */
  function decide(user, key, decision, comment) {
    const row = tickets.load(user, key);
    if (row.type !== 'change') throw new HttpError(400, 'err.notChange');
    const result = db.transaction(() => {
      approvals.decide(user, row.id, decision, comment);
      tickets.logActivity(row.id, user.id, 'approval', decision, null, str(comment, 200) || null);
      const f = state(row);
      const res = approvals.outcome(row.id, mode());
      if (f.phase === 'approval' && (res === 'approved' || res === 'rejected')) {
        // Acts as an agent of every project for this step only (own properties: no project limit)
        const system = { ...user, role: 'agent' };
        setPhase(system, tickets.rawById(row.id), res);
        return res;
      }
      return null;
    })();
    if (result) notifyOwner(tickets.rawById(row.id), result);
    return detail(user, key);
  }

  function detail(user, key) {
    const row = tickets.load(user, key);
    return tickets.detail(user, row.id);
  }

  /** Calendar: changes with a planned period, overlaps marked */
  function calendar(fromIso, toIso, user = null) {
    const rows = db.prepare(`SELECT t.id, t.project_id FROM tickets t
      JOIN ticket_fields s ON s.ticket_id=t.id AND s.name='plannedStart' AND s.value<>''
      JOIN ticket_fields e ON e.ticket_id=t.id AND e.name='plannedEnd' AND e.value<>''
      WHERE t.type='change' AND s.value < ? AND e.value > ?`).all(toIso, fromIso).filter((r) => !user || agentOn(user, r.project_id));
    const items = rows.map((r) => {
      const tk = tickets.ticketOut(tickets.rawById(r.id));
      const f = state(tickets.rawById(r.id));
      return { key: tk.key, title: tk.title, assignee: tk.assignee, phase: f.phase, changeType: f.changeType, risk: f.risk, start: f.plannedStart, end: f.plannedEnd };
    }).filter((c) => !['rejected'].includes(c.phase));
    for (const a of items) {
      a.conflicts = items.filter((b) => b !== a && b.phase !== 'closed' && a.phase !== 'closed' && a.start < b.end && b.start < a.end).map((b) => b.key);
    }
    return items.sort((a, b) => a.start.localeCompare(b.start));
  }

  function standardTemplates() {
    try { const l = JSON.parse(settings.get('change.standardTemplates') || '[]'); return Array.isArray(l) ? l.slice(0, 100) : []; } catch { return []; }
  }

  // ---------- Notifications ----------
  async function send(to, subjectKey, bodyKey, row, extra = {}) {
    if (!mailer?.enabled?.() || !t || !to?.email || !to.active) return;
    const lang = to.language || settings.get('general.defaultLanguage');
    const vars = { key: keyOf(row), title: row.title, link: `${baseUrl}/browse/${keyOf(row)}`, app: settings.get('general.title') || 'Helfi.Space', ...extra(lang) };
    await mailer.send({ to: to.email, subject: t(lang, subjectKey, vars), text: t(lang, bodyKey, vars), ticketId: row.id });
  }
  function notifyApprovers(row, ids) {
    for (const id of ids) send(users?.byId(id), 'mail.approval.subject', 'mail.approval.body', row, () => ({})).catch((e) => log.warn('Approval mail failed', { error: e.message }));
  }
  function notifyOwner(row, result) {
    const owner = users?.byId(row.assignee_id || row.reporter_id);
    send(owner, 'mail.approvalResult.subject', 'mail.approvalResult.body', row, (lang) => ({ result: t(lang, `approval.${result}`) }))
      .catch((e) => log.warn('Approval mail failed', { error: e.message }));
  }

  // Plan fields an approver needs to decide (read-only view for approvers without project rights)
  const PLAN_FIELDS = ['changeType', 'risk', 'services', 'plannedStart', 'plannedEnd', 'reason', 'implementationPlan', 'backoutPlan', 'testPlan'];
  const cisOf = db.prepare('SELECT c.name, c.kind FROM ticket_cis x JOIN config_items c ON c.id=x.ci_id WHERE x.ticket_id=? ORDER BY c.name');
  function planOf(row, f) {
    const plan = Object.fromEntries(PLAN_FIELDS.map((n) => [n, f[n] ?? '']));
    // Affected configuration items: name and kind only (no CMDB details, no links into the CMDB)
    plan.cis = cisOf.all(row.id).map((c) => ({ name: c.name, kind: c.kind }));
    return plan;
  }

  tickets.addDetailExtra((user, row) => {
    if (row.type !== 'change') return {};
    const f = state(row);
    if (!agentOn(user, row.project_id)) {
      // Approver (of any round) without rights on the project: phase, approval round (to decide) and
      // the plan read-only – what is needed to decide; no transitions, no review/outcome, no edit
      if (!user || !approvals.isApprover(row.id, user.id)) return {};
      return { change: { phase: f.phase, next: [], approvals: approvals.current(row.id), mode: mode(), canDecide: approvals.isPendingApprover(row.id, user.id), plan: planOf(row, f) } };
    }
    return { change: { phase: f.phase, next: nextPhases(f), approvals: approvals.current(row.id), mode: mode(), canDecide: approvals.isPendingApprover(row.id, user.id) } };
  });

  return { transition, decide, requestLate, calendar, standardTemplates, nextPhases, state };
}
