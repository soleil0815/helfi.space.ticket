// ITIL-Kennzahlen: SLA-Einhaltung, Wiedereröffnungen, Lösung beim ersten Kontakt, Changes je Monat.
import { HttpError } from '../lib/http.js';
import { parseRange } from '../reports.js';

const SERVICE_TYPES = ['incident', 'request', 'question', 'task'];
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

export function createItilReports(db, sla) {
  const projectIdOf = (key) => {
    if (!key) return null;
    const pr = db.prepare('SELECT id FROM projects WHERE key=?').get(String(key).toUpperCase());
    if (!pr) throw new HttpError(404, 'err.notFound');
    return pr.id;
  };
  const statusChanges = db.prepare("SELECT old_value, new_value, created_at FROM activity WHERE ticket_id=? AND action='changed' AND field='status' ORDER BY created_at, id");
  const agentReplies = db.prepare(`SELECT COUNT(*) n FROM comments c JOIN users u ON u.id=c.author_id
    WHERE c.ticket_id=? AND c.internal=0 AND u.role IN ('agent','admin')`);
  const reporterIsAgent = db.prepare("SELECT 1 FROM users WHERE id=? AND role IN ('agent','admin')");

  /**
   * Basis: Tickets (Service-Typen), die im Zeitraum auf „Erledigt“ gesetzt wurden – laut Verlauf.
   * Eigene Tickets der Bearbeiter (interne Arbeit) zählen nicht mit.
   */
  function resolvedInRange(range, projectId) {
    return db.prepare(`SELECT DISTINCT t.* FROM tickets t JOIN activity a ON a.ticket_id=t.id
      WHERE a.action='changed' AND a.field='status' AND a.new_value='done' AND a.created_at>=? AND a.created_at<?
      AND t.type IN (${SERVICE_TYPES.map(() => '?').join(',')}) ${projectId ? 'AND t.project_id=?' : ''}`)
      .all(range.fromIso, range.toIso, ...SERVICE_TYPES, ...(projectId ? [projectId] : []))
      .filter((t) => !(t.reporter_id && reporterIsAgent.get(t.reporter_id)));
  }

  function quality(rows, range) {
    let reopened = 0; let firstContact = 0;
    for (const t of rows) {
      const ch = statusChanges.all(t.id);
      const i = ch.findIndex((c) => c.new_value === 'done' && c.created_at >= range.fromIso && c.created_at < range.toIso);
      const wasReopened = ch.slice(i + 1).some((c) => c.old_value === 'done');
      if (wasReopened) reopened++;
      // Beim ersten Kontakt gelöst: nie wieder geöffnet, nie auf Rückfrage gewartet, höchstens eine Antwort der IT
      const everReopened = ch.some((c) => c.old_value === 'done');
      const waited = ch.some((c) => c.new_value === 'waiting');
      if (!everReopened && !waited && agentReplies.get(t.id).n <= 1) firstContact++;
    }
    return {
      resolved: rows.length,
      reopened, reopenRate: pct(reopened, rows.length),
      firstContact, firstContactRate: pct(firstContact, rows.length),
    };
  }

  function slaCompliance(rows) {
    if (!sla.enabled()) return { enabled: false };
    const byPrio = {};
    const total = { count: 0, responseMet: 0, resolveMet: 0 };
    for (const t of rows) {
      if (t.status !== 'done') continue;
      const s = sla.forRow(t);
      if (!s) continue;
      const p = (byPrio[t.priority] ||= { count: 0, responseMet: 0, resolveMet: 0 });
      for (const x of [p, total]) {
        x.count++;
        if (s.response.state === 'met') x.responseMet++;
        if (s.resolve.state === 'met') x.resolveMet++;
      }
    }
    const rate = (x) => ({ ...x, responseRate: pct(x.responseMet, x.count), resolveRate: pct(x.resolveMet, x.count) });
    return {
      enabled: true, ...rate(total),
      byPriority: ['highest', 'high', 'medium', 'low'].filter((p) => byPrio[p]).map((p) => ({ priority: p, ...rate(byPrio[p]) })),
    };
  }

  /** Changes je Monat (nach Erstellung): Anzahl, Arten, Ergebnis der abgeschlossenen */
  function changes(range, projectId) {
    const rows = db.prepare(`SELECT t.id, t.created_at,
        (SELECT value FROM ticket_fields f WHERE f.ticket_id=t.id AND f.name='changeType') kind,
        (SELECT value FROM ticket_fields f WHERE f.ticket_id=t.id AND f.name='outcome') outcome,
        (SELECT value FROM ticket_fields f WHERE f.ticket_id=t.id AND f.name='phase') phase
      FROM tickets t WHERE t.type='change' AND t.created_at>=? AND t.created_at<? ${projectId ? 'AND t.project_id=?' : ''}`)
      .all(range.fromIso, range.toIso, ...(projectId ? [projectId] : []));
    const months = new Map();
    for (const r of rows) {
      const m = r.created_at.slice(0, 7);
      if (!months.has(m)) months.set(m, { month: m, total: 0, standard: 0, normal: 0, emergency: 0, closed: 0, successful: 0, issues: 0, rolledBack: 0, rejected: 0 });
      const x = months.get(m);
      x.total++;
      if (x[r.kind] !== undefined && ['standard', 'normal', 'emergency'].includes(r.kind)) x[r.kind]++;
      if (r.phase === 'rejected') x.rejected++;
      if (r.outcome && ['successful', 'issues', 'rolledBack'].includes(r.outcome)) { x.closed++; x[r.outcome]++; }
    }
    const list = [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
      .map((x) => ({ ...x, successRate: pct(x.successful, x.closed), emergencyShare: pct(x.emergency, x.total) }));
    const sum = list.reduce((s, x) => { for (const k of ['total', 'emergency', 'closed', 'successful', 'issues', 'rolledBack', 'rejected']) s[k] += x[k]; return s; },
      { total: 0, emergency: 0, closed: 0, successful: 0, issues: 0, rolledBack: 0, rejected: 0 });
    return { months: list, totals: { ...sum, successRate: pct(sum.successful, sum.closed), emergencyShare: pct(sum.emergency, sum.total) } };
  }

  /** Probleme: neu, gelöst, bekannte Fehler, verknüpfte Vorfälle */
  function problems(range, projectId) {
    const p = projectId ? 'AND t.project_id=?' : ''; const pa = projectId ? [projectId] : [];
    const created = db.prepare(`SELECT COUNT(*) n FROM tickets t WHERE t.type='problem' AND t.created_at>=? AND t.created_at<? ${p}`).get(range.fromIso, range.toIso, ...pa).n;
    const resolved = db.prepare(`SELECT COUNT(DISTINCT t.id) n FROM tickets t JOIN activity a ON a.ticket_id=t.id
      WHERE t.type='problem' AND a.action='changed' AND a.field='status' AND a.new_value='done' AND a.created_at>=? AND a.created_at<? ${p}`).get(range.fromIso, range.toIso, ...pa).n;
    const knownErrors = db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN ticket_fields f ON f.ticket_id=t.id AND f.name='knownError' AND f.value='1'
      WHERE t.type='problem' AND t.status<>'done' ${p}`).get(...pa).n;
    const open = db.prepare(`SELECT COUNT(*) n FROM tickets t WHERE t.type='problem' AND t.status<>'done' ${p}`).get(...pa).n;
    return { created, resolved, open, knownErrors };
  }

  function report(query = {}) {
    const range = parseRange(query);
    const projectId = projectIdOf(query.project);
    const rows = resolvedInRange(range, projectId);
    return {
      range: { from: range.from, to: range.to },
      quality: quality(rows, range),
      sla: slaCompliance(rows),
      changes: changes(range, projectId),
      problems: problems(range, projectId),
      majorIncidents: db.prepare(`SELECT COUNT(*) n FROM tickets t WHERE t.major=1 AND t.created_at>=? AND t.created_at<? ${projectId ? 'AND t.project_id=?' : ''}`)
        .get(range.fromIso, range.toIso, ...(projectId ? [projectId] : [])).n,
    };
  }

  return { report };
}
