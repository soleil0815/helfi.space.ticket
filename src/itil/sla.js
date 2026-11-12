// Service level agreements: targets for first response and resolution per priority, in business hours.
// "Waiting" (for the reporter) pauses the resolution clock. Computed on demand from history and comments.
import { log } from '../lib/log.js';
import { agentOn, projectScopeSql } from '../auth/access.js';

export const DEFAULT_TARGETS = {
  highest: { response: 30, resolve: 240 },
  high: { response: 120, resolve: 960 },
  medium: { response: 480, resolve: 2400 },
  low: { response: 960, resolve: 4800 },
};
export const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' };
export const SLA_TYPES = ['incident', 'request', 'question'];
const DAY = 86400000;

const hm = (s, def) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : def; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Calendar from the settings */
export function calendarFrom(hoursJson, holidaysText) {
  let h = DEFAULT_HOURS;
  try { h = { ...DEFAULT_HOURS, ...JSON.parse(hoursJson || '{}') }; } catch { /* default */ }
  const days = new Set((Array.isArray(h.days) ? h.days : DEFAULT_HOURS.days).map(Number).filter((d) => d >= 0 && d <= 6));
  const startMin = hm(h.start, 480);
  const endMin = Math.max(startMin, hm(h.end, 1020));
  const holidays = new Set(String(holidaysText || '').split(/\r?\n/).map((l) => (/^\s*(\d{4}-\d{2}-\d{2})/.exec(l) || [])[1]).filter(Boolean));
  return { days, startMin, endMin, holidays };
}

/** Working window of a day [from, to] in ms or null */
function window(cal, day) {
  if (!cal.days.has(day.getDay()) || cal.holidays.has(ymd(day))) return null;
  const y = day.getFullYear(); const m = day.getMonth(); const d = day.getDate();
  const from = new Date(y, m, d, Math.floor(cal.startMin / 60), cal.startMin % 60).getTime();
  const to = new Date(y, m, d, Math.floor(cal.endMin / 60), cal.endMin % 60).getTime();
  return to > from ? [from, to] : null;
}
const nextDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

/** Business minutes between two points in time */
export function businessMinutes(fromMs, toMs, cal) {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  let day = new Date(fromMs); day = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  for (let i = 0; day.getTime() <= toMs && i < 3700; i++, day = nextDay(day)) {
    const w = window(cal, day);
    if (w) total += Math.max(0, Math.min(w[1], toMs) - Math.max(w[0], fromMs));
  }
  return total / 60000;
}

/** Point in time after "minutes" business minutes from fromMs */
export function addBusinessMinutes(fromMs, minutes, cal) {
  let left = minutes * 60000;
  let day = new Date(fromMs); day = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  for (let i = 0; i < 3700; i++, day = nextDay(day)) {
    const w = window(cal, day);
    if (!w) continue;
    const start = Math.max(w[0], fromMs);
    if (start >= w[1]) continue;
    if (start + left <= w[1]) return start + left;
    left -= w[1] - start;
  }
  return null; // no working day in sight (misconfigured)
}

export function createSla(db, tickets, settings, { mailer = null, users = null, baseUrl = '', t = null } = {}) {
  const enabled = () => !!settings.get('sla.enabled');
  const calendar = () => calendarFrom(settings.get('sla.hours'), settings.get('sla.holidays'));
  const targets = () => { try { return { ...DEFAULT_TARGETS, ...JSON.parse(settings.get('sla.targets') || '{}') }; } catch { return DEFAULT_TARGETS; } };
  const warnAt = () => Math.min(99, Math.max(10, Number(settings.get('sla.warnPercent')) || 80)) / 100;

  // Reply from someone who works on the ticket's project (agents, admins, the project's people)
  const firstReply = db.prepare(`SELECT c.created_at FROM comments c JOIN users u ON u.id=c.author_id
    WHERE c.ticket_id=? AND c.internal=0 AND (u.role IN ('agent','admin') OR u.id IN (SELECT user_id FROM project_agents pa WHERE pa.project_id=(SELECT project_id FROM tickets WHERE id=c.ticket_id))) ORDER BY c.created_at LIMIT 1`);
  const statusChanges = db.prepare("SELECT old_value, new_value, created_at FROM activity WHERE ticket_id=? AND action='changed' AND field='status' ORDER BY created_at, id");
  const reporterWorksHere = db.prepare("SELECT 1 FROM users u WHERE u.id=? AND (u.role IN ('agent','admin') OR u.id IN (SELECT user_id FROM project_agents WHERE project_id=?))");

  function clock(target, elapsed, running, nowMs, cal, warn) {
    const remaining = target - elapsed;
    let state;
    if (!running) state = elapsed <= target ? 'met' : 'missed';
    else if (remaining < 0) state = 'breached';
    else if (elapsed >= target * warn) state = 'warning';
    else state = 'ok';
    const due = running && remaining >= 0 ? addBusinessMinutes(nowMs, remaining, cal) : null;
    return { target, elapsed: Math.round(elapsed), remaining: Math.round(remaining), state, due: due ? new Date(due).toISOString() : null };
  }

  /** SLA of a ticket (raw row) – null if not applicable */
  function forRow(row, nowMs = Date.now()) {
    // Imported tickets (importer writes source='jira'; 'import' for older/other imports) have no SLA
    if (!enabled() || !SLA_TYPES.includes(row.type) || row.source === 'import' || row.source === 'jira') return null;
    // Agents' own tickets (internal work) do not count
    if (row.reporter_id && reporterWorksHere.get(row.reporter_id, row.project_id)) return null;
    const cal = calendar();
    const tg = targets()[row.priority] || DEFAULT_TARGETS.medium;
    const created = Date.parse(row.created_at);
    // First response: first public reply by an agent
    const reply = firstReply.get(row.id);
    const respEnd = reply ? Date.parse(reply.created_at) : nowMs;
    const response = clock(tg.response, businessMinutes(created, respEnd, cal), !reply, nowMs, cal, warnAt());
    // Resolution: time excluding "Waiting" and "Resolved"
    const paused = new Set(['done', ...(settings.get('sla.pauseWaiting') ? ['waiting'] : [])]);
    let status = 'open'; let from = created; let elapsed = 0;
    for (const ch of statusChanges.all(row.id)) {
      const at = Date.parse(ch.created_at);
      if (!paused.has(status)) elapsed += businessMinutes(from, at, cal);
      status = ch.new_value; from = at;
    }
    if (status !== row.status) status = row.status;
    if (!paused.has(status)) elapsed += businessMinutes(from, nowMs, cal);
    const resolve = clock(tg.resolve, elapsed, row.status !== 'done', nowMs, cal, warnAt());
    if (row.status === 'waiting' && resolve.state !== 'breached' && settings.get('sla.pauseWaiting')) resolve.paused = true;
    return { response, resolve };
  }

  /** Summary for lists: the "worst" running state */
  const RANK = { breached: 3, warning: 2, ok: 1, missed: 0, met: 0 };
  function worst(s) {
    if (!s) return null;
    const running = [s.response, s.resolve].filter((c) => ['ok', 'warning', 'breached'].includes(c.state));
    if (!running.length) return { state: s.resolve.state === 'missed' || s.response.state === 'missed' ? 'missed' : 'met' };
    const c = running.sort((a, b) => RANK[b.state] - RANK[a.state] || a.remaining - b.remaining)[0];
    return { state: c.state, remaining: c.remaining, due: c.due, kind: c === s.response ? 'response' : 'resolve', paused: !!c.paused };
  }

  /** Ticket ids whose SLA is at risk; user: only tickets of the agent's projects */
  function atRisk(projectKey = null, user = null) {
    if (!enabled()) return [];
    const ps = user ? projectScopeSql(user) : { sql: '1', args: [] };
    const rows = db.prepare(`SELECT t.*, p.key project_key FROM tickets t JOIN projects p ON p.id=t.project_id
      WHERE t.status<>'done' AND p.archived=0 AND ${ps.sql} ${projectKey ? 'AND p.key=?' : ''}`).all(...ps.args, ...(projectKey ? [String(projectKey).toUpperCase()] : []));
    return rows.filter((r) => ['warning', 'breached'].includes(worst(forRow(r))?.state)).map((r) => r.id);
  }

  // ---------- Warnings: history and mail to the assignee (or project lead), once per level ----------
  const seen = db.prepare('INSERT OR IGNORE INTO sla_events(ticket_id, kind, level) VALUES(?,?,?)');
  function check(nowMs = Date.now()) {
    if (!enabled()) return 0;
    let n = 0;
    const rows = db.prepare("SELECT t.*, p.key project_key, p.lead_id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.status<>'done'").all();
    for (const row of rows) {
      const s = forRow(row, nowMs);
      if (!s) continue;
      for (const kind of ['response', 'resolve']) {
        const level = s[kind].state;
        if (!['warning', 'breached'].includes(level)) continue;
        if (!seen.run(row.id, kind, level).changes) continue;
        n++;
        tickets.logActivity(row.id, null, 'sla', kind, null, level);
        notify(row, kind, level).catch((e) => log.warn('SLA notification failed', { error: e.message }));
      }
    }
    return n;
  }
  async function notify(row, kind, level) {
    if (!mailer?.enabled?.() || !users || !t) return;
    const to = users.byId(row.assignee_id || row.lead_id);
    if (!to?.email || !to.active) return;
    const lang = to.language || settings.get('general.defaultLanguage');
    const vars = { key: `${row.project_key}-${row.number}`, title: row.title, kind: t(lang, `sla.kind.${kind}`), level: t(lang, `sla.level.${level}`), link: `${baseUrl}/browse/${row.project_key}-${row.number}`, app: settings.get('general.title') || 'Helfi.Space' };
    await mailer.send({ to: to.email, subject: t(lang, 'mail.sla.subject', vars), text: t(lang, 'mail.sla.body', vars), ticketId: row.id });
  }
  // If the priority changes, new targets apply – warning levels may be triggered again
  tickets.events.on('priorityChanged', ({ ticketId }) => db.prepare('DELETE FROM sla_events WHERE ticket_id=?').run(ticketId));

  let timer = null;
  function start(everyMs = 5 * 60 * 1000) {
    clearInterval(timer);
    timer = setInterval(() => { try { check(); } catch (e) { log.warn('SLA check failed', { error: e.message }); } }, everyMs);
    timer.unref?.();
  }

  tickets.addDetailExtra((user, row) => {
    if (!user || !agentOn(user, row.project_id)) return {};
    const s = forRow(row);
    return s ? { sla: s } : {};
  });

  return { enabled, forRow, worst, atRisk, check, start, stop: () => clearInterval(timer), calendar, targets };
}
