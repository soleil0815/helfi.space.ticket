// Reports: statistics per agent (visible to all agents) and created/resolved over time.
import { HttpError } from './lib/http.js';

const DAY = 24 * 3600 * 1000;
export const MAX_RANGE_DAYS = 3 * 366;

/** Period from YYYY-MM-DD (inclusive). Default: the last 30 days. */
export function parseRange({ from, to } = {}, now = new Date()) {
  const day = (v) => {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new HttpError(400, 'err.badRequest', 'date');
    const d = new Date(`${v}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'err.badRequest', 'date');
    return d;
  };
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = day(to) || today;
  const start = day(from) || new Date(end.getTime() - 29 * DAY);
  if (start > end) throw new HttpError(400, 'err.badRequest', 'range');
  const days = Math.round((end - start) / DAY) + 1;
  if (days > MAX_RANGE_DAYS) throw new HttpError(400, 'err.badRequest', 'range');
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    fromIso: start.toISOString(),
    toIso: new Date(end.getTime() + DAY).toISOString(), // exclusive: end of the last day
    days,
  };
}

export function createReports(db) {
  /**
   * Metrics per agent in the period, optionally for one project.
   * - resolved: tickets the person set to "Resolved" (from the history)
   * - openAssigned: currently assigned and not resolved (independent of the period)
   * - touched: tickets they did something on in the period (change or comment)
   * - replies / notes: public replies and internal notes
   * - avgResolutionHours: avg. time from "created" to their "Resolved" (only really solved ones,
   *   not rejected or duplicates)
   */
  function agents(range, projectId = null) {
    const p = projectId ? 'AND t.project_id=?' : '';
    const pa = projectId ? [projectId] : [];
    const r = [range.fromIso, range.toIso, ...pa];
    const resolved = db.prepare(`SELECT a.user_id id, COUNT(DISTINCT a.ticket_id) n,
        AVG(CASE WHEN COALESCE(t.resolution,'done')='done' THEN (julianday(a.created_at) - julianday(t.created_at)) * 24 END) hours
      FROM activity a JOIN tickets t ON t.id=a.ticket_id
      WHERE a.action='changed' AND a.field='status' AND a.new_value='done' AND a.user_id IS NOT NULL
        AND a.created_at>=? AND a.created_at<? ${p} GROUP BY a.user_id`).all(...r);
    const open = db.prepare(`SELECT t.assignee_id id, COUNT(*) n FROM tickets t JOIN projects pr ON pr.id=t.project_id
      WHERE t.status<>'done' AND t.assignee_id IS NOT NULL AND pr.archived=0 ${p} GROUP BY t.assignee_id`).all(...pa);
    const touched = db.prepare(`SELECT id, COUNT(DISTINCT ticket_id) n FROM (
        SELECT a.user_id id, a.ticket_id FROM activity a JOIN tickets t ON t.id=a.ticket_id
          WHERE a.user_id IS NOT NULL AND a.action NOT IN ('created','imported') AND a.created_at>=? AND a.created_at<? ${p}
        UNION
        SELECT c.author_id id, c.ticket_id FROM comments c JOIN tickets t ON t.id=c.ticket_id
          WHERE c.author_id IS NOT NULL AND c.created_at>=? AND c.created_at<? ${p}
      ) GROUP BY id`).all(...r, ...r);
    const comments = db.prepare(`SELECT c.author_id id, SUM(c.internal=0) replies, SUM(c.internal=1) notes
      FROM comments c JOIN tickets t ON t.id=c.ticket_id
      WHERE c.author_id IS NOT NULL AND c.created_at>=? AND c.created_at<? ${p} GROUP BY c.author_id`).all(...r);

    const byId = new Map();
    const row = (id) => {
      if (!byId.has(id)) byId.set(id, { id, resolved: 0, openAssigned: 0, touched: 0, replies: 0, notes: 0, avgResolutionHours: null });
      return byId.get(id);
    };
    // All active agents appear, even with 0
    for (const u of db.prepare("SELECT id FROM users WHERE active=1 AND role IN ('agent','admin')").all()) row(u.id);
    for (const x of resolved) Object.assign(row(x.id), { resolved: x.n, avgResolutionHours: x.hours === null ? null : Math.round(x.hours * 10) / 10 });
    for (const x of open) row(x.id).openAssigned = x.n;
    for (const x of touched) row(x.id).touched = x.n;
    for (const x of comments) Object.assign(row(x.id), { replies: x.replies || 0, notes: x.notes || 0 });

    // Only agents/admins (including former ones if they resolved something in the period) – no reporters
    const users = db.prepare(`SELECT id, display_name, username, role, active FROM users WHERE id IN (${[...byId.keys()].map(() => '?').join(',') || 'NULL'})`).all(...byId.keys());
    return users
      .filter((u) => u.role === 'agent' || u.role === 'admin' || byId.get(u.id).resolved > 0)
      .map((u) => ({ ...byId.get(u.id), displayName: u.display_name, username: u.username, active: !!u.active }))
      .sort((a, b) => b.resolved - a.resolved || b.touched - a.touched || a.displayName.localeCompare(b.displayName));
  }

  /** Created and resolved per day (up to 92 days) or per week (Monday) for longer periods. */
  function series(range, projectId = null) {
    const weekly = range.days > 92;
    const p = projectId ? 'AND t.project_id=?' : '';
    const pa = projectId ? [projectId] : [];
    const bucket = (col) => (weekly
      ? `date(${col}, '-' || ((strftime('%w', ${col}) + 6) % 7) || ' days')`
      : `date(${col})`);
    const created = db.prepare(`SELECT ${bucket('t.created_at')} b, COUNT(*) n FROM tickets t
      WHERE t.created_at>=? AND t.created_at<? ${p} GROUP BY b`).all(range.fromIso, range.toIso, ...pa);
    const resolved = db.prepare(`SELECT ${bucket('a.created_at')} b, COUNT(DISTINCT a.ticket_id) n FROM activity a JOIN tickets t ON t.id=a.ticket_id
      WHERE a.action='changed' AND a.field='status' AND a.new_value='done' AND a.created_at>=? AND a.created_at<? ${p} GROUP BY b`)
      .all(range.fromIso, range.toIso, ...pa);
    const points = [];
    const start = new Date(`${range.from}T00:00:00Z`);
    let d = start;
    if (weekly) d = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * DAY);
    const end = new Date(`${range.to}T00:00:00Z`);
    while (d <= end) {
      points.push({ date: d.toISOString().slice(0, 10), created: 0, resolved: 0 });
      d = new Date(d.getTime() + (weekly ? 7 : 1) * DAY);
    }
    const at = new Map(points.map((x) => [x.date, x]));
    for (const x of created) if (at.has(x.b)) at.get(x.b).created = x.n;
    for (const x of resolved) if (at.has(x.b)) at.get(x.b).resolved = x.n;
    return { unit: weekly ? 'week' : 'day', points };
  }

  /**
   * Tickets created in the period per component (incl. "without component"): total, still open,
   * resolved and the average resolution time of those resolved.
   */
  function byComponent(range, projectId) {
    return db.prepare(`SELECT t.component_id id, c.name, pr.key project_key,
        COUNT(*) total, SUM(t.status<>'done') open, SUM(t.status='done') resolved,
        SUM(t.status='done' AND t.resolution IN ('rejected','duplicate')) rejected,
        -- rejected and duplicates would distort the resolution time: only really solved ones
        AVG(CASE WHEN t.status='done' AND COALESCE(t.resolution,'done')='done' AND t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at)-julianday(t.created_at))*24 END) avg_hours
      FROM tickets t JOIN projects pr ON pr.id=t.project_id LEFT JOIN components c ON c.id=t.component_id
      WHERE t.created_at >= ? AND t.created_at < ? ${projectId ? 'AND t.project_id=?' : 'AND pr.archived=0'}
      GROUP BY t.component_id, pr.key ORDER BY total DESC, c.name`).all(range.fromIso, range.toIso, ...(projectId ? [projectId] : [])).map((r) => ({
      componentId: r.id, name: r.name, projectKey: r.project_key, total: r.total, open: r.open, resolved: r.resolved, rejected: r.rejected || 0,
      avgResolutionHours: r.avg_hours === null ? null : Math.round(r.avg_hours * 10) / 10,
    }));
  }

  function report(query = {}) {
    const range = parseRange(query);
    let projectId = null;
    if (query.project) {
      const pr = db.prepare('SELECT id FROM projects WHERE key=? OR id=?').get(String(query.project).toUpperCase(), Number(query.project) || 0);
      if (!pr) throw new HttpError(404, 'err.notFound');
      projectId = pr.id;
    }
    const s = series(range, projectId);
    const list = agents(range, projectId);
    return {
      range: { from: range.from, to: range.to, days: range.days },
      project: query.project ? String(query.project).toUpperCase() : null,
      totals: {
        created: s.points.reduce((n, x) => n + x.created, 0),
        resolved: s.points.reduce((n, x) => n + x.resolved, 0),
        open: db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN projects pr ON pr.id=t.project_id WHERE t.status<>'done' AND pr.archived=0 ${projectId ? 'AND t.project_id=?' : ''}`).get(...(projectId ? [projectId] : [])).n,
      },
      agents: list,
      series: s,
      components: byComponent(range, projectId),
    };
  }

  return { report };
}
