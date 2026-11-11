// Reminder for forgotten tickets: once a day the project lead (no lead: the admins) gets one mail listing
// the project's open tickets that nobody has taken on for X days – so tickets created in Helfi.Space are
// noticed even if nobody looks in every day. Off by default (reminder.unassignedDays = 0).
import { log } from '../lib/log.js';

const DAY = 86400000;
const MAX_LIST = 30;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minutesOf = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2])) : 8 * 60; };

export function createReminders(db, settings, { mailer, users, baseUrl, t }) {
  const getMeta = db.prepare('SELECT value FROM meta WHERE key=?');
  const setMeta = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const metaKey = (projectId) => `reminder.unassigned.${projectId}`;

  /** Open, unassigned tickets of a project created at least `days` days ago (oldest first). */
  function forgotten(projectId, days, nowMs = Date.now()) {
    const before = new Date(nowMs - days * DAY).toISOString();
    return db.prepare(`SELECT t.id, t.number, t.title, t.created_at, p.key project_key FROM tickets t JOIN projects p ON p.id=t.project_id
      WHERE t.project_id=? AND t.status<>'done' AND t.assignee_id IS NULL AND t.created_at<=? ORDER BY t.created_at, t.id`).all(projectId, before);
  }

  /** Who gets the mail: the project lead, otherwise all active admins with an address. */
  function recipients(project) {
    const lead = project.lead_id ? users.byId(project.lead_id) : null;
    if (lead?.active && lead.email) return [lead];
    return db.prepare("SELECT * FROM users WHERE role='admin' AND active=1 AND email IS NOT NULL AND email<>''").all();
  }

  function mailFor(user, project, list, days, nowMs) {
    const lang = user.language || settings.get('general.defaultLanguage');
    const app = settings.get('general.title') || 'Helfi.Space';
    const lines = list.slice(0, MAX_LIST).map((r) => {
      const age = Math.max(days, Math.floor((nowMs - Date.parse(r.created_at)) / DAY));
      return t(lang, 'mail.reminder.line', { key: `${r.project_key}-${r.number}`, title: r.title, days: age, link: `${baseUrl}/browse/${r.project_key}-${r.number}` });
    });
    if (list.length > MAX_LIST) lines.push(t(lang, 'mail.reminder.more', { n: list.length - MAX_LIST }));
    const vars = {
      app, n: list.length, days, project: project.name, key: project.key,
      list: lines.join('\n'),
      link: `${baseUrl}/issues?project=${encodeURIComponent(project.key)}&assignee=none&status=unresolved`,
    };
    return { to: user.email, subject: t(lang, list.length === 1 ? 'mail.reminder.subjectOne' : 'mail.reminder.subject', vars), text: t(lang, 'mail.reminder.body', vars) };
  }

  /**
   * Sends due reminders. Normally once per project and day from the configured time on (weekdays only
   * if set); force = right away and regardless of the day (button "Check now"). Returns { mails, projects }.
   */
  async function check({ now = new Date(), force = false } = {}) {
    const days = Math.round(Number(settings.get('reminder.unassignedDays')) || 0);
    const out = { mails: 0, projects: 0 };
    if (days <= 0 || !mailer?.enabled?.()) return out;
    if (!force) {
      if (settings.get('reminder.weekdaysOnly') && (now.getDay() === 0 || now.getDay() === 6)) return out;
      if (now.getHours() * 60 + now.getMinutes() < minutesOf(settings.get('reminder.time'))) return out;
    }
    const today = ymd(now);
    for (const project of db.prepare('SELECT * FROM projects WHERE archived=0 ORDER BY key').all()) {
      if (!force && getMeta.get(metaKey(project.id))?.value === today) continue;
      // Checked for today – also when there is nothing to report, so there is at most one mail a day
      setMeta.run(metaKey(project.id), today);
      const list = forgotten(project.id, days, now.getTime());
      if (!list.length) continue;
      out.projects++;
      for (const user of recipients(project)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await mailer.send(mailFor(user, project, list, days, now.getTime()))) out.mails++;
        } catch (e) { log.warn('Reminder mail failed', { project: project.key, error: e.message }); }
      }
    }
    if (out.mails) log.info(`Reminder for unassigned tickets: ${out.mails} mail(s) for ${out.projects} project(s)`);
    return out;
  }

  let timer = null;
  function start(everyMs = 15 * 60 * 1000) {
    clearInterval(timer);
    timer = setInterval(() => { check().catch((e) => log.warn('Reminder check failed', { error: e.message })); }, everyMs);
    timer.unref?.();
  }

  return { check, forgotten, start, stop: () => clearInterval(timer) };
}
