// Automation rules: "when … (trigger), for tickets that … (conditions), then … (actions)".
// Rules belong to a project (managed by admins and the project's lead/deputy) or to all projects (admins).
// They run after everything that is built in: mail sender rules, component matching (keywords, senders, AI)
// and the fixed status moves (public reply → Waiting, customer reply → Open). So they build on the result
// and never fight with it.
//
// Safety:
// - Every change is written to the ticket history as "Automation: <rule>", every run to the rule's protocol.
// - Loop protection: a rule never reacts to its own changes, chains stop after MAX_DEPTH rules.
// - Time rules act once per phase (e.g. once per stay in "Waiting"), not on every check.
// - Emergency brake: more than MAX_RUNS_PER_HOUR runs switch a rule off and mail the admins.
// - Never deletes anything, internal notes never go out, mails only to users/roles of Helfi.Space,
//   assignment only to a person chosen in the rule (and only if they still work on the project).
import { HttpError, notFound, forbidden, str, int } from './lib/http.js';
import { STATUSES, PRIORITIES, TYPES } from './tickets.js';
import { keywordRegExp, parseList } from './components.js';
import { patternToRegExp } from './mail/rules.js';
import { fillPlaceholders } from '../public/js/placeholders.js';
import { agentOn } from './auth/access.js';
import { log } from './lib/log.js';

export const TRIGGERS = ['created', 'statusChanged', 'customerReplied', 'agentReplied', 'fieldChanged', 'time', 'sla'];
export const TIME_BASES = ['status', 'created', 'activity'];
export const ACTIONS = ['setStatus', 'setPriority', 'setComponent', 'assign', 'reply', 'note', 'notify'];
export const NOTIFY_ROLES = ['lead', 'deputy', 'assignee', 'componentLead'];
export const MAX_RULES = 50; // per project (and for "all projects")
export const MAX_ACTIONS = 10;
export const MAX_DEPTH = 3;
export const MAX_RUNS_PER_HOUR = 200;
const MAX_TEXT = 5000;
const MAX_HOURS = 24 * 365;
const TIME_BATCH = 100; // tickets per time rule and check
const PREVIEW_LIMIT = 50;
const MATCH_TEXT_LIMIT = 5000;
const CHANNELS = ['email', 'web'];

const parseJson = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };
const bad = (field) => new HttpError(400, 'err.automationInvalid', field);
const oneOf = (v, list, field, { optional = false } = {}) => {
  if ((v === undefined || v === null || v === '') && optional) return '';
  if (!list.includes(v)) throw bad(field);
  return v;
};
const listOf = (v, list, field) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(field);
  const out = [...new Set(v)];
  for (const x of out) if (!list.includes(x)) throw bad(field);
  return out;
};

/**
 * Example rules (switched off until someone takes them over). Texts in the language of the person who adds
 * them; placeholders like {kunde}/{customer} are filled per ticket.
 */
export const TEMPLATES = {
  'waiting-remind': {
    trigger: { type: 'time', basis: 'status', status: 'waiting', hours: 7 * 24 },
    conditions: {},
    actions: (L) => [{ type: 'reply', text: L === 'en'
      ? 'Hello {customer},\n\nwe are still waiting for your answer on {ticket} ("{title}"). Could you please get back to us? If everything is settled, a short note is enough.\n\nThank you!'
      : 'Hallo {kunde},\n\nwir warten bei {ticket} („{titel}“) noch auf Ihre Rückmeldung. Könnten Sie sich bitte kurz melden? Wenn sich alles erledigt hat, genügt eine kurze Nachricht.\n\nVielen Dank!' }],
  },
  'waiting-close': {
    trigger: { type: 'time', basis: 'status', status: 'waiting', hours: 14 * 24 },
    conditions: {},
    actions: (L) => [
      { type: 'reply', text: L === 'en'
        ? 'Hello {customer},\n\nas we have not heard from you, we are closing {ticket} ("{title}") now. If the matter is still open, simply reply to this message – the ticket will then be reopened.'
        : 'Hallo {kunde},\n\nda wir nichts mehr von Ihnen gehört haben, schließen wir {ticket} („{titel}“) jetzt. Ist das Anliegen noch aktuell, antworten Sie einfach auf diese Nachricht – dann wird das Ticket wieder geöffnet.' },
      { type: 'setStatus', status: 'done', resolution: 'done' },
    ],
  },
  'urgent-unassigned': {
    trigger: { type: 'time', basis: 'created', status: '', hours: 1 },
    conditions: { priorities: ['highest'], assigned: 'no' },
    actions: (L) => [{ type: 'notify', roles: ['lead', 'deputy'], userIds: [], text: L === 'en'
      ? 'This ticket has the highest priority and nobody has taken it for an hour.'
      : 'Dieses Ticket hat die höchste Priorität und ist seit einer Stunde niemandem zugewiesen.' }],
  },
  'account-priority': {
    trigger: { type: 'created' },
    conditions: { keywords: ['gesperrt', 'passwort', 'kennwort', 'locked out', 'password'] },
    actions: () => [{ type: 'setPriority', priority: 'high' }],
  },
  'no-component': {
    trigger: { type: 'time', basis: 'created', status: '', hours: 4 },
    conditions: { withoutComponent: true },
    actions: (L) => [
      { type: 'note', text: L === 'en' ? 'No component for 4 hours – please assign one.' : 'Seit 4 Stunden ohne Komponente – bitte zuordnen.' },
      { type: 'notify', roles: ['lead'], userIds: [], text: L === 'en' ? 'This ticket has no component yet.' : 'Dieses Ticket hat noch keine Komponente.' },
    ],
  },
};
export const TEMPLATE_KEYS = Object.keys(TEMPLATES);

export function createAutomation({ db, tickets, users, settings, mailer = null, t = null, baseUrl = '' }) {
  const appName = () => settings.get('general.title') || 'Helfi.Space';
  const project = (id) => db.prepare('SELECT id, key, name, lead_id, deputy_id, archived FROM projects WHERE id=?').get(id);

  // ---------- Rights ----------
  /** Admins: every project and "all projects"; leads and deputies: their own projects */
  function canManage(user, projectId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (!projectId) return false;
    const p = project(projectId);
    return !!p && !p.archived && (p.lead_id === user.id || p.deputy_id === user.id);
  }
  function manageable(user) {
    if (!user) return [];
    if (user.role === 'admin') return db.prepare('SELECT id, key, name FROM projects WHERE archived=0 ORDER BY name').all();
    return db.prepare('SELECT id, key, name FROM projects WHERE archived=0 AND (lead_id=? OR deputy_id=?) ORDER BY name').all(user.id, user.id);
  }

  // ---------- Checking a rule ----------
  /** Validates and normalises a rule; projectId null = all projects (no components or persons there). */
  function normalize(input, projectId) {
    const name = str(input.name, 100).trim();
    if (!name) throw bad('name');
    const tr = input.trigger && typeof input.trigger === 'object' ? input.trigger : {};
    const trigger = { type: oneOf(tr.type, TRIGGERS, 'trigger') };
    if (trigger.type === 'statusChanged') {
      trigger.from = oneOf(tr.from, STATUSES, 'trigger.from', { optional: true });
      trigger.to = oneOf(tr.to, STATUSES, 'trigger.to', { optional: true });
    }
    if (trigger.type === 'fieldChanged') trigger.field = oneOf(tr.field, ['priority', 'component'], 'trigger.field');
    if (trigger.type === 'sla') trigger.level = oneOf(tr.level, ['warning', 'breached'], 'trigger.level');
    if (trigger.type === 'time') {
      trigger.basis = oneOf(tr.basis, TIME_BASES, 'trigger.basis');
      trigger.status = oneOf(tr.status, STATUSES, 'trigger.status', { optional: trigger.basis !== 'status' });
      const hours = Number(tr.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) throw bad('trigger.hours');
      trigger.hours = hours;
    }

    const c = input.conditions && typeof input.conditions === 'object' ? input.conditions : {};
    const conditions = {};
    const types = listOf(c.types, TYPES, 'conditions.types'); if (types.length) conditions.types = types;
    const prios = listOf(c.priorities, PRIORITIES, 'conditions.priorities'); if (prios.length) conditions.priorities = prios;
    const sts = listOf(c.statuses, STATUSES, 'conditions.statuses'); if (sts.length) conditions.statuses = sts;
    const chans = listOf(c.channels, CHANNELS, 'conditions.channels'); if (chans.length) conditions.channels = chans;
    if (c.assigned !== undefined && c.assigned !== '' && c.assigned !== null) conditions.assigned = oneOf(c.assigned, ['yes', 'no'], 'conditions.assigned');
    if (c.withoutComponent) conditions.withoutComponent = true;
    if (Array.isArray(c.componentIds) && c.componentIds.length) {
      if (!projectId) throw bad('conditions.componentIds');
      const ids = [...new Set(c.componentIds.map((x) => int(x)))];
      for (const id of ids) if (!id || !db.prepare('SELECT 1 FROM components WHERE id=? AND project_id=?').get(id, projectId)) throw bad('conditions.componentIds');
      if (conditions.withoutComponent) throw bad('conditions.componentIds');
      conditions.componentIds = ids;
    }
    const kw = parseList(c.keywords ?? [], { max: 30, maxLen: 60 }); if (kw.length) conditions.keywords = kw;
    const snd = parseList(c.senders ?? [], { max: 20, maxLen: 254 }).filter((s) => !/\s/.test(s)); if (snd.length) conditions.senders = snd;

    if (!Array.isArray(input.actions) || !input.actions.length) throw bad('actions');
    if (input.actions.length > MAX_ACTIONS) throw bad('actions');
    const actions = input.actions.map((a, i) => {
      const f = `actions.${i}`;
      const type = oneOf(a?.type, ACTIONS, f);
      if (type === 'setStatus') {
        const status = oneOf(a.status, STATUSES, f);
        return status === 'done' ? { type, status, resolution: oneOf(a.resolution || 'done', ['done', 'rejected'], f) } : { type, status };
      }
      if (type === 'setPriority') return { type, priority: oneOf(a.priority, PRIORITIES, f) };
      if (type === 'setComponent') {
        const id = int(a.componentId);
        if (!projectId || !id || !db.prepare('SELECT 1 FROM components WHERE id=? AND project_id=? AND archived=0').get(id, projectId)) throw bad(f);
        return { type, componentId: id };
      }
      if (type === 'assign') {
        // Only a person chosen here – and only one who works on the project (no "round robin", no guessing)
        const id = int(a.userId);
        const u = id ? users.byId(id) : null;
        if (!projectId || !u || u.active !== 1 || !['agent', 'admin'].includes(u.role) || !agentOn(u, projectId)) throw bad(f);
        return { type, userId: id };
      }
      const text = str(a.text, MAX_TEXT).trim();
      if (type === 'reply' || type === 'note') {
        if (!text) throw bad(f);
        return { type, text };
      }
      // notify: users and roles of Helfi.Space only – never a typed address
      const roles = listOf(a.roles, NOTIFY_ROLES, f);
      const userIds = [...new Set((Array.isArray(a.userIds) ? a.userIds : []).map((x) => int(x)))];
      for (const id of userIds) {
        const u = id ? users.byId(id) : null;
        if (!u || u.active !== 1 || !['agent', 'admin'].includes(u.role) || (projectId && !agentOn(u, projectId))) throw bad(f);
      }
      if (!roles.length && !userIds.length) throw bad(f);
      return { type, roles, userIds, text };
    });
    // A closing action must come last: nothing should still change a resolved ticket
    const closeAt = actions.findIndex((a) => a.type === 'setStatus' && a.status === 'done');
    if (closeAt >= 0 && actions.slice(closeAt + 1).some((a) => !['notify', 'note'].includes(a.type))) throw bad('actions');
    return { name, trigger, conditions, actions };
  }

  function out(row, withStats = true) {
    const r = {
      id: row.id, projectId: row.project_id, projectKey: row.project_key || null, name: row.name, enabled: !!row.enabled,
      trigger: parseJson(row.trigger, {}), conditions: parseJson(row.conditions, {}), actions: parseJson(row.actions, []),
      template: row.template || null, disabledReason: row.disabled_reason || null, updatedAt: row.updated_at,
    };
    if (withStats) {
      const s = db.prepare("SELECT COUNT(*) n, MAX(created_at) last FROM automation_runs WHERE rule_id=? AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')").get(row.id);
      r.runs30 = s.n; r.lastRun = s.last;
    }
    return r;
  }
  const SELECT = 'SELECT r.*, p.key project_key FROM automation_rules r LEFT JOIN projects p ON p.id=r.project_id';
  function load(user, id) {
    const row = db.prepare(`${SELECT} WHERE r.id=?`).get(int(id));
    if (!row) throw notFound();
    if (!canManage(user, row.project_id)) throw forbidden();
    return row;
  }

  // ---------- Managing ----------
  function list(user, projectId) {
    const pid = projectId ? int(projectId) : null;
    if (projectId !== undefined && projectId !== null && projectId !== '') {
      if (!pid || !canManage(user, pid)) throw forbidden();
      return db.prepare(`${SELECT} WHERE r.project_id=? ORDER BY r.position, r.id`).all(pid).map((r) => out(r));
    }
    if (user.role === 'admin') return db.prepare(`${SELECT} ORDER BY r.project_id IS NOT NULL, p.key, r.position, r.id`).all().map((r) => out(r));
    const ids = manageable(user).map((p) => p.id);
    if (!ids.length) return [];
    return db.prepare(`${SELECT} WHERE r.project_id IN (${ids.map(() => '?').join(',')}) ORDER BY p.key, r.position, r.id`).all(...ids).map((r) => out(r));
  }
  function count(projectId) {
    return db.prepare('SELECT COUNT(*) n FROM automation_rules WHERE project_id IS ?').get(projectId).n;
  }
  function create(user, input) {
    const pid = input.projectId ? int(input.projectId) : null;
    if (input.projectId && !pid) throw bad('projectId');
    if (pid && !project(pid)) throw notFound();
    if (!canManage(user, pid)) throw forbidden();
    if (count(pid) >= MAX_RULES) throw new HttpError(400, 'err.automationTooMany');
    const v = normalize(input, pid);
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM automation_rules WHERE project_id IS ?').get(pid).n;
    // New rules start switched off unless explicitly enabled (the preview comes first)
    const info = db.prepare('INSERT INTO automation_rules(project_id,name,enabled,trigger,conditions,actions,position,template,created_by) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(pid, v.name, input.enabled ? 1 : 0, JSON.stringify(v.trigger), JSON.stringify(v.conditions), JSON.stringify(v.actions), pos,
        TEMPLATE_KEYS.includes(input.template) ? input.template : null, user.id);
    return out(db.prepare(`${SELECT} WHERE r.id=?`).get(info.lastInsertRowid));
  }
  function update(user, id, input) {
    const row = load(user, id);
    const merged = {
      name: input.name ?? row.name,
      trigger: input.trigger ?? parseJson(row.trigger, {}),
      conditions: input.conditions ?? parseJson(row.conditions, {}),
      actions: input.actions ?? parseJson(row.actions, []),
    };
    const v = normalize(merged, row.project_id);
    const enabled = input.enabled === undefined ? row.enabled : (input.enabled ? 1 : 0);
    db.prepare("UPDATE automation_rules SET name=?, trigger=?, conditions=?, actions=?, enabled=?, disabled_reason=CASE WHEN ?=1 THEN NULL ELSE disabled_reason END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(v.name, JSON.stringify(v.trigger), JSON.stringify(v.conditions), JSON.stringify(v.actions), enabled, enabled, row.id);
    return out(db.prepare(`${SELECT} WHERE r.id=?`).get(row.id));
  }
  /** Rules are configuration: they can be deleted (what they did stays in the ticket history) */
  function remove(user, id) {
    const row = load(user, id);
    db.prepare('DELETE FROM automation_rules WHERE id=?').run(row.id);
    return { ok: true };
  }
  function reorder(user, projectId, ids) {
    const pid = projectId ? int(projectId) : null;
    if (!canManage(user, pid)) throw forbidden();
    if (!Array.isArray(ids)) throw bad('ids');
    const own = new Set(db.prepare('SELECT id FROM automation_rules WHERE project_id IS ?').all(pid).map((r) => r.id));
    const st = db.prepare('UPDATE automation_rules SET position=? WHERE id=?');
    db.transaction(() => ids.map((x) => int(x)).filter((x) => own.has(x)).forEach((x, i) => st.run(i + 1, x)))();
    return list(user, pid || undefined);
  }
  function runs(user, id, limit = 100) {
    const row = load(user, id);
    return db.prepare(`SELECT r.*, t.number, p.key FROM automation_runs r LEFT JOIN tickets t ON t.id=r.ticket_id LEFT JOIN projects p ON p.id=t.project_id
      WHERE r.rule_id=? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(row.id, Math.min(500, int(limit) || 100))
      .map((r) => ({ at: r.created_at, event: r.event, ok: !!r.ok, ticketKey: r.key ? `${r.key}-${r.number}` : null, detail: parseJson(r.detail, []) }));
  }
  function templates(lang) {
    const L = lang === 'en' ? 'en' : 'de';
    return TEMPLATE_KEYS.map((key) => ({ key, name: t ? t(L, `automation.tpl.${key}`) : key, trigger: TEMPLATES[key].trigger, conditions: TEMPLATES[key].conditions, actions: TEMPLATES[key].actions(L) }));
  }
  /** Take over an example rule (switched off; the name comes from the client in the user's language) */
  function addTemplate(user, key, { projectId, name, lang }) {
    const tpl = TEMPLATES[key];
    if (!tpl) throw notFound();
    const L = lang === 'en' ? 'en' : 'de';
    if (!str(name, 100).trim() && t) name = t(L, `automation.tpl.${key}`);
    return create(user, { projectId, name, enabled: false, template: key, trigger: tpl.trigger, conditions: tpl.conditions, actions: tpl.actions(L) });
  }

  // ---------- Matching ----------
  function reporterAddress(row) {
    if (row.reporter_email) return String(row.reporter_email).toLowerCase();
    return row.reporter_id ? String(users.byId(row.reporter_id)?.email || '').toLowerCase() : '';
  }
  function conditionsMatch(cond, row) {
    if (cond.types && !cond.types.includes(row.type)) return false;
    if (cond.priorities && !cond.priorities.includes(row.priority)) return false;
    if (cond.statuses && !cond.statuses.includes(row.status)) return false;
    if (cond.channels && !cond.channels.includes(row.source === 'email' ? 'email' : 'web')) return false;
    if (cond.assigned === 'yes' && !row.assignee_id) return false;
    if (cond.assigned === 'no' && row.assignee_id) return false;
    if (cond.withoutComponent && row.component_id) return false;
    if (cond.componentIds && !cond.componentIds.includes(row.component_id)) return false;
    if (cond.keywords) {
      const text = `${String(row.title || '').slice(0, 300)}\n${String(row.description || '').slice(0, MATCH_TEXT_LIMIT)}`;
      if (!cond.keywords.some((w) => keywordRegExp(w).test(text))) return false;
    }
    if (cond.senders) {
      const addr = reporterAddress(row);
      if (!addr || !cond.senders.some((p) => patternToRegExp(p).test(addr))) return false;
    }
    return true;
  }
  function triggerMatches(tr, event) {
    if (tr.type !== event.type) return false;
    if (tr.type === 'statusChanged') return (!tr.from || tr.from === event.from) && (!tr.to || tr.to === event.to);
    if (tr.type === 'fieldChanged') return tr.field === event.field;
    if (tr.type === 'sla') return tr.level === event.level;
    return true;
  }
  function rulesFor(projectId, type) {
    return db.prepare(`SELECT * FROM automation_rules WHERE enabled=1 AND (project_id IS NULL OR project_id=?)
      AND json_extract(trigger,'$.type')=? ORDER BY project_id IS NOT NULL, position, id`).all(projectId, type);
  }

  // ---------- Acting ----------
  /** The automation acts like an admin without an account – every change is labelled with the rule */
  function actor(rule, chain) {
    return { id: null, role: 'admin', username: 'automation', display_name: appName(), displayName: appName(), active: 1, system: true, automation: { ruleId: rule.id, ruleName: rule.name, chain } };
  }

  function recipientsFor(a, row) {
    const p = project(row.project_id);
    const ids = new Set(a.userIds || []);
    for (const role of a.roles || []) {
      if (role === 'lead' && p?.lead_id) ids.add(p.lead_id);
      if (role === 'deputy' && p?.deputy_id) ids.add(p.deputy_id);
      if (role === 'assignee' && row.assignee_id) ids.add(row.assignee_id);
      if (role === 'componentLead' && row.component_id) {
        const c = db.prepare('SELECT lead_id, deputy_id FROM components WHERE id=?').get(row.component_id);
        if (c?.lead_id) ids.add(c.lead_id);
      }
    }
    // Only people who (still) work on the ticket's project – the mail names the ticket and its title
    return [...ids].map((id) => users.byId(id)).filter((u) => u && u.active === 1 && u.email && agentOn(u, row.project_id));
  }
  async function sendNotify(rule, a, ticket, row) {
    if (!mailer?.enabled?.() || !t) return 0;
    let n = 0;
    for (const u of recipientsFor(a, row)) {
      const lang = u.language || settings.get('general.defaultLanguage') || 'de';
      const vars = { key: ticket.key, title: ticket.title, rule: rule.name, app: appName(), link: `${baseUrl}/browse/${ticket.key}`,
        text: a.text ? `${fillPlaceholders(a.text, ticket, { displayName: ticket.assignee?.displayName || appName() })}\n\n` : '' };
      try {
        await mailer.send({ to: u.email, subject: t(lang, 'mail.automation.subject', vars), text: t(lang, 'mail.automation.body', vars), ticketId: row.id });
        n++;
      } catch (e) { log.warn('Automation mail failed', { rule: rule.id, error: e.message }); }
    }
    return n;
  }

  /** One action; returns a protocol entry { type, ok, skipped? } */
  function act(rule, a, row, by, ctx) {
    const key = `${row.project_key}-${row.number}`;
    const fresh = () => tickets.rawById(row.id);
    if (a.type === 'setStatus') {
      const cur = fresh();
      if (cur.status === a.status) return { type: a.type, ok: true, skipped: 'unchanged' };
      if (a.status === 'done') tickets.update(by, key, { status: 'done' }, { resolution: a.resolution || 'done', quietResolved: ctx.replied });
      else tickets.update(by, key, { status: a.status });
      return { type: a.type, ok: true };
    }
    if (a.type === 'setPriority') { tickets.update(by, key, { priority: a.priority }); return { type: a.type, ok: true }; }
    if (a.type === 'setComponent') {
      const c = db.prepare('SELECT 1 FROM components WHERE id=? AND project_id=? AND archived=0').get(a.componentId, fresh().project_id);
      if (!c) return { type: a.type, ok: false, skipped: 'component' };
      tickets.update(by, key, { componentId: a.componentId });
      return { type: a.type, ok: true };
    }
    if (a.type === 'assign') {
      const u = users.byId(a.userId);
      // Not (any more) active or no longer on the project: skip – never someone else
      if (!u || u.active !== 1 || !['agent', 'admin'].includes(u.role) || !agentOn(u, fresh().project_id)) return { type: a.type, ok: false, skipped: 'assignee' };
      tickets.update(by, key, { assigneeId: a.userId });
      return { type: a.type, ok: true };
    }
    if (a.type === 'reply') {
      if (!tickets.customerRecipients(row.id).length) return { type: a.type, ok: false, skipped: 'noCustomer' };
      const tk = tickets.ticketOut(fresh());
      const body = fillPlaceholders(a.text, tk, { displayName: tk.assignee?.displayName || appName() });
      tickets.addComment(by, key, { body, waitForCustomer: false }, { source: 'automation', authorName: rule.name, resolutionReply: ctx.closes });
      ctx.replied = true;
      return { type: a.type, ok: true };
    }
    if (a.type === 'note') {
      const tk = tickets.ticketOut(fresh());
      tickets.addComment(by, key, { body: fillPlaceholders(a.text, tk, { displayName: tk.assignee?.displayName || appName() }), internal: true }, { source: 'automation', authorName: rule.name });
      return { type: a.type, ok: true };
    }
    // notify: sent after the changes (async); the count of recipients is known now
    const to = recipientsFor(a, fresh());
    if (!to.length) return { type: a.type, ok: false, skipped: 'noRecipient' };
    ctx.mails.push(a);
    return { type: a.type, ok: true, recipients: to.length };
  }

  const recordRun = db.prepare('INSERT INTO automation_runs(rule_id,ticket_id,event,ok,detail) VALUES(?,?,?,?,?)');
  function brake(rule) {
    const n = db.prepare("SELECT COUNT(*) n FROM automation_runs WHERE rule_id=? AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(rule.id).n;
    if (n < MAX_RUNS_PER_HOUR) return false;
    db.prepare("UPDATE automation_rules SET enabled=0, disabled_reason='runaway', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(rule.id);
    log.warn('Automation rule switched off: too many runs within an hour', { rule: rule.id, runs: n });
    if (mailer?.enabled?.() && t) {
      for (const u of db.prepare("SELECT * FROM users WHERE role='admin' AND active=1 AND email IS NOT NULL AND email<>''").all()) {
        const lang = u.language || settings.get('general.defaultLanguage') || 'de';
        const vars = { rule: rule.name, runs: n, app: appName(), link: `${baseUrl}/admin/automation` };
        mailer.send({ to: u.email, subject: t(lang, 'mail.automationBrake.subject', vars), text: t(lang, 'mail.automationBrake.body', vars) })
          .catch((e) => log.warn('Automation brake mail failed', { error: e.message }));
      }
    }
    return true;
  }

  /** Runs one rule on one ticket (trigger and conditions already checked) */
  function run(rule, row, eventType, by = null) {
    if (brake(rule)) return null;
    const chain = [...(by?.automation?.chain || []), rule.id];
    const a = actor(rule, chain);
    const actions = parseJson(rule.actions, []);
    const ctx = { replied: false, mails: [], closes: actions.some((x) => x.type === 'setStatus' && x.status === 'done') };
    const done = [];
    tickets.withVia('automation', rule.name, () => {
      for (const x of actions) {
        try { done.push(act(rule, x, tickets.rawById(row.id), a, ctx)); }
        catch (e) { done.push({ type: x.type, ok: false, error: e.code || e.message }); }
      }
    });
    const ok = done.every((d) => d.ok || d.skipped === 'unchanged');
    recordRun.run(rule.id, row.id, eventType, ok ? 1 : 0, JSON.stringify(done));
    if (ctx.mails.length) {
      const tk = tickets.ticketOut(tickets.rawById(row.id));
      const cur = tickets.rawById(row.id);
      Promise.all(ctx.mails.map((m) => sendNotify(rule, m, tk, cur))).catch((e) => log.warn('Automation mail failed', { error: e.message }));
    }
    return done;
  }

  /** An event on a ticket: every enabled rule with this trigger whose conditions fit */
  function handle(event, ticketId, by) {
    try {
      const chain = by?.automation?.chain || [];
      if (chain.length >= MAX_DEPTH) return 0;
      const row = tickets.rawById(ticketId);
      if (!row) return 0;
      const p = project(row.project_id);
      if (!p || p.archived) return 0;
      let n = 0;
      for (const rule of rulesFor(row.project_id, event.type)) {
        if (chain.includes(rule.id)) continue; // a rule never reacts to its own changes
        if (!triggerMatches(parseJson(rule.trigger, {}), event)) continue;
        const cur = tickets.rawById(ticketId); // earlier rules may have changed it
        if (!conditionsMatch(parseJson(rule.conditions, {}), cur)) continue;
        // re-check: an earlier rule in this round may have switched it off (emergency brake)
        if (!db.prepare('SELECT enabled FROM automation_rules WHERE id=?').get(rule.id)?.enabled) continue;
        if (run(rule, cur, event.type, by)) n++;
      }
      return n;
    } catch (e) {
      log.warn('Automation failed', { ticket: ticketId, error: e.message });
      return 0;
    }
  }

  // Events of the ticket layer (after the change is stored; handled outside the caller's call)
  const later = (fn) => (payload) => setImmediate(() => fn(payload));
  tickets.events.on('created', later(({ ticket, user }) => handle({ type: 'created' }, ticket.id, user)));
  tickets.events.on('statusChanged', later(({ ticketId, from, to, actor: by }) => handle({ type: 'statusChanged', from, to }, ticketId, by)));
  tickets.events.on('commented', later(({ ticket, replyKind, user }) => {
    if (replyKind === 'customer') handle({ type: 'customerReplied' }, ticket.id, user);
    else if (replyKind === 'agent') handle({ type: 'agentReplied' }, ticket.id, user);
  }));
  tickets.events.on('priorityChanged', later(({ ticketId, actor: by }) => handle({ type: 'fieldChanged', field: 'priority' }, ticketId, by)));
  tickets.events.on('componentChanged', later(({ ticketId, actor: by }) => handle({ type: 'fieldChanged', field: 'component' }, ticketId, by)));
  tickets.events.on('slaLevel', later(({ ticketId, level }) => handle({ type: 'sla', level }, ticketId, null)));

  // ---------- Time rules ----------
  /** Since when the ticket is in its phase: status change, creation or last activity */
  function sinceSql(basis) {
    if (basis === 'created') return 't.created_at';
    if (basis === 'activity') return 't.updated_at';
    return "COALESCE((SELECT MAX(a.created_at) FROM activity a WHERE a.ticket_id=t.id AND a.action='changed' AND a.field='status'), t.created_at)";
  }
  function timeCandidates(rule, tr, nowMs, limit) {
    const cutoff = new Date(nowMs - tr.hours * 3600 * 1000).toISOString();
    const where = ['p.archived=0'];
    const args = [];
    if (rule.project_id) { where.push('t.project_id=?'); args.push(rule.project_id); }
    if (tr.status) { where.push('t.status=?'); args.push(tr.status); } else where.push("t.status<>'done'");
    return db.prepare(`SELECT * FROM (SELECT t.id, ${sinceSql(tr.basis)} since FROM tickets t JOIN projects p ON p.id=t.project_id WHERE ${where.join(' AND ')})
      WHERE since<=? ORDER BY since LIMIT ?`).all(...args, cutoff, limit);
  }
  const markDone = db.prepare('INSERT OR IGNORE INTO automation_done(rule_id,ticket_id,phase) VALUES(?,?,?)');
  const isDone = db.prepare('SELECT 1 FROM automation_done WHERE rule_id=? AND ticket_id=? AND phase=?');
  function checkTime(nowMs = Date.now()) {
    let n = 0;
    const rules = db.prepare("SELECT * FROM automation_rules WHERE enabled=1 AND json_extract(trigger,'$.type')='time' ORDER BY project_id IS NOT NULL, position, id").all();
    for (const rule of rules) {
      try {
        const tr = parseJson(rule.trigger, {});
        const cond = parseJson(rule.conditions, {});
        // Candidates beyond the batch come in the next check
        for (const c of timeCandidates(rule, tr, nowMs, TIME_BATCH * 5)) {
          if (isDone.get(rule.id, c.id, c.since)) continue;
          const row = tickets.rawById(c.id);
          if (!row || !conditionsMatch(cond, row)) continue;
          if (!db.prepare('SELECT enabled FROM automation_rules WHERE id=?').get(rule.id)?.enabled) break;
          // Mark first: even if an action fails, the rule does not repeat every five minutes
          markDone.run(rule.id, c.id, c.since);
          run(rule, row, 'time');
          if (++n % TIME_BATCH === 0) break;
        }
      } catch (e) { log.warn('Automation time rule failed', { rule: rule.id, error: e.message }); }
    }
    // Phases that ended long ago are no longer needed
    db.prepare("DELETE FROM automation_done WHERE created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-400 days')").run();
    return n;
  }
  let timer = null;
  function start(everyMs = 5 * 60 * 1000) {
    clearInterval(timer);
    timer = setInterval(() => { try { checkTime(); } catch (e) { log.warn('Automation check failed', { error: e.message }); } }, everyMs);
    timer.unref?.();
  }

  // ---------- Preview ----------
  /**
   * What would the rule hit? Changes nothing. Time rules: the tickets it would act on right now (already
   * handled in this phase marked). Other rules: tickets of the last 30 days whose current state fits the
   * conditions (and the target status of a status trigger) – the event itself cannot be replayed.
   */
  function preview(user, input, ruleId = null) {
    let pid = input.projectId ? int(input.projectId) : null;
    let id = null;
    if (ruleId) { const row = load(user, ruleId); pid = row.project_id; id = row.id; }
    else if (!canManage(user, pid)) throw forbidden();
    const v = normalize(input, pid);
    const hits = [];
    let total = 0;
    const push = (row, extra = {}) => {
      total++;
      if (hits.length < PREVIEW_LIMIT) hits.push({ key: `${row.project_key}-${row.number}`, title: row.title, status: row.status, ...extra });
    };
    if (v.trigger.type === 'time') {
      for (const c of timeCandidates({ project_id: pid }, v.trigger, Date.now(), 5000)) {
        const row = tickets.rawById(c.id);
        if (row && conditionsMatch(v.conditions, row)) push(row, { since: c.since, done: !!(id && isDone.get(id, c.id, c.since)) });
      }
    } else {
      const where = ["t.updated_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')", 'p.archived=0'];
      const args = [];
      if (pid) { where.push('t.project_id=?'); args.push(pid); }
      if (v.trigger.type === 'statusChanged' && v.trigger.to) { where.push('t.status=?'); args.push(v.trigger.to); }
      for (const r of db.prepare(`SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC LIMIT 2000`).all(...args)) {
        const row = tickets.rawById(r.id);
        if (row && conditionsMatch(v.conditions, row)) push(row);
      }
    }
    return { kind: v.trigger.type === 'time' ? 'now' : 'last30', total, tickets: hits };
  }

  return { canManage, manageable, normalize, list, create, update, remove, reorder, runs, templates, addTemplate, preview, handle, checkTime, start, conditionsMatch };
}
