// Tickets, projects, comments, attachments, history.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { HttpError, notFound, forbidden, str, isoDate, int } from './lib/http.js';
import { isAgent, agentOn, agentProjects, projectScopeSql } from './auth/session.js';
import { AGENT_OF_PROJECT } from './auth/access.js';
import { userRef } from './users.js';
import { createSearch } from './search.js';
import { log } from './lib/log.js';
import { normalizeMentions } from './mentions.js';
import { createComponents, matchComponent, reasonDetail } from './components.js';

export const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
// How a done ticket ended: solved, rejected (with a reason) or a duplicate of another ticket
export const RESOLUTIONS = ['done', 'rejected', 'duplicate'];
export const TYPES = ['incident', 'request', 'task', 'question', 'problem', 'change'];
// Only agents create problems and changes
export const AGENT_TYPES = ['problem', 'change'];
export const PRIORITIES = ['highest', 'high', 'medium', 'low'];
// Impact × urgency → priority (ITIL)
export const LEVELS = ['high', 'medium', 'low'];
export const PRIORITY_MATRIX = {
  high: { high: 'highest', medium: 'high', low: 'medium' },
  medium: { high: 'high', medium: 'medium', low: 'low' },
  low: { high: 'medium', medium: 'low', low: 'low' },
};

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
export const MAX_PARTICIPANTS = 20;
// Closing as a duplicate follows at most this many closed duplicates to the real original
export const MAX_DUPLICATE_CHAIN = 20;
const MAX_OFFSET = 1e9; // list offset (far beyond any real ticket count)

export { AGENT_OF_PROJECT };

/** Name for people without the agent role: a display name that is just a mail address
 *  (email contacts, mail clients without a name) is shortened to "local@…". */
export function publicName(name) {
  const v = String(name ?? '');
  const at = v.indexOf('@');
  return at > 0 && /^[^\s@]+@[^\s@]+$/.test(v.trim()) ? `${v.trim().slice(0, at)}@…` : v;
}

export function normalizeLabels(v) {
  const arr = Array.isArray(v) ? v : str(v, 2000).split(/[,;\s]+/);
  return [...new Set(arr.map((x) => str(x, 100).trim().toLowerCase().replace(/[^\p{L}\p{N}_.-]/gu, '')).filter(Boolean))].slice(0, 20).join(',');
}

export function createTickets(db, users) {
  // Full-text search: catch up the index at startup (after an update once for all tickets)
  const search = createSearch(db);
  try {
    const t0 = Date.now(); const n = search.flush();
    if (n > 100) log.info(`Search index built: ${n} tickets in ${Date.now() - t0} ms`);
  } catch (e) { log.warn('Search index could not be built', { error: e.message }); }
  const events = new EventEmitter();
  const components = createComponents(db, users);
  // Fire events only after the current transaction has completed
  const emitLater = (name, payload) => setImmediate(() => events.emit(name, payload));
  // Project rights: an agent limited to projects is an agent only for tickets of those projects –
  // for every other ticket they are a normal user (sees it only as reporter/participant/approver)
  const projectOf = (ticketId) => db.prepare('SELECT project_id FROM tickets WHERE id=?').get(ticketId)?.project_id;
  const agentFor = (user, row) => !!user && agentOn(user, row.project_id);

  // ---------- Projects ----------
  /** Project lead: an existing account (no email contact), otherwise 400 instead of a foreign key error */
  function validLead(id) {
    if (id === null || id === undefined || id === '') return null;
    const n = int(id);
    const u = n ? users.byId(n) : null;
    if (!u || u.source === 'email') throw new HttpError(400, 'err.badRequest', 'leadId');
    return n;
  }
  /** Lead and deputy work on the project's tickets (source 'lead' / 'deputy') */
  function syncLead(projectId, leadId, source = 'lead') {
    db.prepare('DELETE FROM project_agents WHERE project_id=? AND source=?').run(projectId, source);
    if (leadId) db.prepare('INSERT OR IGNORE INTO project_agents(project_id, user_id, source) VALUES(?,?,?)').run(projectId, leadId, source);
  }

  const projects = {
    /** user (optional): only the projects this agent works on */
    list(includeArchived = false, user = null) {
      const ps = user ? projectScopeSql(user, 'p.id') : { sql: '1', args: [] };
      return db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM tickets t WHERE t.project_id=p.id AND t.status<>'done') open_count,
        (SELECT COUNT(*) FROM tickets t WHERE t.project_id=p.id) ticket_count
        FROM projects p WHERE ${includeArchived ? '1' : 'archived=0'} AND ${ps.sql} ORDER BY name`).all(...ps.args).map(projectOut);
    },
    /** For admins: Map projectId → { agentGroup, lead, deputy: { id, displayName } | null, memberCount } */
    peopleSummary() {
      const out = new Map();
      for (const p of db.prepare(`SELECT p.id, p.agent_group, p.lead_id, u.display_name lead_name, p.deputy_id, d.display_name deputy_name,
          (SELECT COUNT(*) FROM project_agents pa WHERE pa.project_id=p.id AND pa.source='manual') members
        FROM projects p LEFT JOIN users u ON u.id=p.lead_id LEFT JOIN users d ON d.id=p.deputy_id`).all()) {
        out.set(p.id, {
          agentGroup: p.agent_group || '', memberCount: p.members,
          lead: p.lead_id ? { id: p.lead_id, displayName: p.lead_name } : null,
          deputy: p.deputy_id ? { id: p.deputy_id, displayName: p.deputy_name } : null,
        });
      }
      return out;
    },
    get(idOrKey) {
      const p = db.prepare('SELECT * FROM projects WHERE id=? OR key=?').get(int(idOrKey) || 0, str(idOrKey, 20));
      return p || null;
    },
    create({ key, name, description = '', leadId = null }) {
      key = str(key, 20).trim().toUpperCase();
      if (!KEY_RE.test(key)) throw new HttpError(400, 'err.projectKey');
      if (db.prepare('SELECT 1 FROM projects WHERE key=?').get(key)) throw new HttpError(409, 'err.projectKeyTaken');
      const lead = validLead(leadId);
      const info = db.prepare('INSERT INTO projects(key,name,description,lead_id) VALUES(?,?,?,?)')
        .run(key, str(name, 120) || key, str(description, 2000), lead);
      syncLead(info.lastInsertRowid, lead);
      return projectOut(db.prepare('SELECT * FROM projects WHERE id=?').get(info.lastInsertRowid));
    },
    update(id, { name, description, leadId, deputyId, archived }) {
      const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
      if (!p) throw notFound();
      const lead = leadId !== undefined ? validLead(leadId) : p.lead_id;
      const deputy = deputyId !== undefined ? validLead(deputyId) : p.deputy_id;
      db.transaction(() => {
        db.prepare('UPDATE projects SET name=?, description=?, lead_id=?, archived=? WHERE id=?').run(
          name !== undefined ? (str(name, 120).trim() || p.name) : p.name,
          description !== undefined ? str(description, 2000) : p.description,
          lead,
          archived !== undefined ? (archived ? 1 : 0) : p.archived,
          id,
        );
        if (lead !== p.lead_id) syncLead(id, lead);
        if (deputy !== p.deputy_id) {
          db.prepare('UPDATE projects SET deputy_id=? WHERE id=?').run(deputy, id);
          syncLead(id, deputy, 'deputy');
        }
      })();
      return projectOut(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
    },
    /**
     * Delete a project. Tickets are never deleted (records): a project with tickets can only be
     * deleted if they are moved to another project (moveTo) – otherwise archive it.
     * The last project always remains. Returns { key, moved, target }.
     */
    remove(user, id, { moveTo = null } = {}) {
      const p = db.prepare('SELECT * FROM projects WHERE id=?').get(int(id) || 0);
      if (!p) throw notFound();
      if (db.prepare('SELECT COUNT(*) n FROM projects WHERE id<>?').get(p.id).n === 0) throw new HttpError(400, 'err.lastProject');
      const ticketRows = db.prepare('SELECT id FROM tickets WHERE project_id=? ORDER BY number').all(p.id);
      let target = null;
      if (ticketRows.length) {
        if (!moveTo) throw new HttpError(400, 'err.projectHasTickets');
        target = projects.get(moveTo);
        if (!target || target.id === p.id) throw new HttpError(400, 'err.badRequest', 'moveTo');
        if (target.archived) throw new HttpError(400, 'err.projectArchived');
      }
      db.transaction(() => {
        for (const { id: tid } of ticketRows) moveToProject(rawById(tid), target, user ? user.id : null);
        db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
      })();
      return { key: p.key, moved: ticketRows.length, target: target ? target.key : null };
    },
  };

  function projectOut(p) {
    return { id: p.id, key: p.key, name: p.name, description: p.description, leadId: p.lead_id, archived: !!p.archived, openCount: p.open_count ?? undefined, ticketCount: p.ticket_count ?? undefined };
  }

  // ---------- Tickets ----------
  const SELECT = `SELECT t.*, p.key project_key, p.name project_name,
      a.display_name a_name, a.username a_username, a.email a_email, cmp.name c_name,
      r.display_name r_name, r.username r_username, r.email r_email,
      (SELECT COUNT(*) FROM comments c WHERE c.ticket_id=t.id) comment_count,
      (SELECT COUNT(*) FROM comments c WHERE c.ticket_id=t.id AND c.internal=0) public_comment_count,
      (SELECT dp.key || '-' || d.number FROM tickets d JOIN projects dp ON dp.id=d.project_id WHERE d.id=t.duplicate_of) d_key
    FROM tickets t JOIN projects p ON p.id=t.project_id
    LEFT JOIN users a ON a.id=t.assignee_id
    LEFT JOIN users r ON r.id=t.reporter_id
    LEFT JOIN components cmp ON cmp.id=t.component_id`;

  /** agent=false: view of reporter/participant/approver; viewerId = who is viewing (own details visible) */
  function ticketOut(t, agent = true, viewerId = null) {
    // Reporter's address/login name only for agents and the reporter themselves
    const own = agent || (viewerId != null && t.reporter_id === viewerId);
    return {
      id: t.id,
      key: `${t.project_key}-${t.number}`,
      projectId: t.project_id,
      projectKey: t.project_key,
      projectName: t.project_name,
      number: t.number,
      title: t.title,
      description: t.description,
      type: t.type,
      status: t.status,
      priority: t.priority,
      labels: t.labels ? t.labels.split(',') : [],
      impact: t.impact || null,
      urgency: t.urgency || null,
      major: !!t.major,
      // Component: internal assignment aid, agents only
      component: agent && t.component_id ? { id: t.component_id, name: t.c_name } : null,
      dueDate: t.due_date,
      source: t.source,
      rank: t.rank,
      assignee: t.assignee_id ? { id: t.assignee_id, displayName: t.a_name, username: agent ? t.a_username : undefined, email: agent ? (t.a_email || '') : undefined } : null,
      reporter: t.reporter_id
        ? { id: t.reporter_id, displayName: own ? t.r_name : publicName(t.r_name), username: own ? t.r_username : undefined, email: own ? (t.r_email || t.reporter_email || '') : undefined }
        : (t.reporter_email || t.reporter_name ? { id: null, displayName: agent ? (t.reporter_name || t.reporter_email) : (publicName(t.reporter_name) || '—'), email: agent ? (t.reporter_email || '') : undefined } : null),
      commentCount: agent ? t.comment_count : t.public_comment_count,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      resolvedAt: t.resolved_at,
      resolution: t.status === 'done' ? (t.resolution || 'done') : null,
      duplicateOf: t.status === 'done' && t.resolution === 'duplicate' && t.d_key ? t.d_key : null,
    };
  }


  /**
   * Set the component from outside the normal update (AI): history entry "classified" with the
   * source. Nobody is assigned (the component's person is for information only).
   * userId: who accepted a suggestion (null = automatic). Returns the ticket (agent view).
   */
  function applyComponent(ticketId, componentId, { kind = 'ai', detail = '', userId = null, backfill = false } = {}) {
    let row = rawById(ticketId);
    if (!row) throw notFound();
    // A component of another project (mail routing, AI over all projects): the ticket moves there
    const any = components.activeById(componentId);
    if (!any) throw new HttpError(400, 'err.badRequest', 'componentId');
    const target = any.projectId !== row.project_id ? projects.get(any.projectId) : null;
    const component = components.forProject(any.projectId, componentId);
    db.transaction(() => {
      if (target) {
        moveToProject(row, target, userId);
        // The assignee must work on the new project
        if (row.assignee_id && !isAssignable(row.assignee_id, target.id)) {
          db.prepare('UPDATE tickets SET assignee_id=NULL WHERE id=?').run(row.id);
          logActivity(row.id, userId, 'changed', 'assignee', row.a_name, null);
        }
        row = rawById(row.id);
      }
      // Only the component and the history entry – nobody is ever assigned automatically (the
      // component's person is shown for information; the project's agents take tickets themselves).
      // Sorting existing tickets afterwards: the "updated" time stays (lists keep their order).
      if (backfill) db.prepare('UPDATE tickets SET component_id=? WHERE id=?').run(component.id, row.id);
      else db.prepare("UPDATE tickets SET component_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(component.id, row.id);
      logActivity(row.id, userId, 'classified', kind, detail, component.name);
    })();
    return ticketOut(rawById(row.id));
  }

  /** Assign only to active agents/admins – of this project (projectId) */
  function isAssignable(id, projectId) {
    const u = users.byId(Number(id));
    return !!u && u.active === 1 && (u.role === 'agent' || u.role === 'admin') && agentOn(u, projectId);
  }

  function rawById(id) { return db.prepare(`${SELECT} WHERE t.id=?`).get(id); }

  /** Get a ticket by ID or key ("HS-12"), with permission check. */
  function load(user, idOrKey) {
    let row;
    const m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(str(idOrKey, 30));
    if (m) row = db.prepare(`${SELECT} WHERE p.key=? AND t.number=?`).get(m[1].toUpperCase(), Number(m[2]));
    else row = rawById(int(idOrKey) || 0);
    if (!row) throw notFound();
    if (user && !canSee(user, row)) throw notFound();
    return row;
  }

  const participantStmt = db.prepare('SELECT 1 FROM ticket_participants WHERE ticket_id=? AND user_id=?');
  function isParticipant(ticketId, userId) {
    return !!userId && !!participantStmt.get(ticketId, userId);
  }

  /** Reporter or request participant ("customer" of the request) */
  function isCustomer(user, row) {
    return !!user && (row.reporter_id === user.id || isParticipant(row.id, user.id));
  }

  // Approvers (e.g. managers for catalog requests) see the ticket like a participant
  const approverStmt = db.prepare('SELECT 1 FROM approvals WHERE ticket_id=? AND approver_id=?');
  function canSee(user, row) {
    return agentFor(user, row) || isCustomer(user, row) || (!!user && !!approverStmt.get(row.id, user.id));
  }

  /** WHERE clause of the ticket list (also used to count saved filters) */
  function listFilter(user, f, { ids } = {}) {
    const where = [];
    const args = [];
    // Internal pre-selection (e.g. "my open approvals"), never from the query string
    if (Array.isArray(ids)) { where.push('t.id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(ids)); }
    const own = '(t.reporter_id=? OR t.id IN (SELECT ticket_id FROM ticket_participants WHERE user_id=?) OR t.id IN (SELECT ticket_id FROM approvals WHERE approver_id=?))';
    const scope = agentProjects(user); // null = all projects
    if (!isAgent(user)) {
      where.push(own);
      args.push(user.id, user.id, user.id);
    } else if (scope !== null) {
      // Agent of some projects: their tickets there, plus their own requests anywhere (as a user)
      const ps = projectScopeSql(user);
      where.push(`(${ps.sql} OR ${own})`);
      args.push(...ps.args, user.id, user.id, user.id);
    }
    if (f.project) { where.push('(p.key=? OR p.id=?)'); args.push(String(f.project).toUpperCase(), Number(f.project) || 0); }
    // Archived projects are hidden from the agents' lists; a user's own requests stay visible
    else if (scope === null && isAgent(user)) where.push('p.archived=0');
    else if (isAgent(user)) {
      // their projects: active ones only; own requests elsewhere stay visible (as for users)
      const ps = projectScopeSql(user);
      where.push(`(p.archived=0 OR NOT ${ps.sql})`);
      args.push(...ps.args);
    }
    if (f.status) {
      const st = String(f.status).split(',').filter((s) => STATUSES.includes(s) || s === 'unresolved');
      if (st.includes('unresolved')) where.push("t.status<>'done'");
      const real = st.filter((s) => s !== 'unresolved');
      if (real.length) { where.push(`t.status IN (${real.map(() => '?').join(',')})`); args.push(...real); }
    }
    if (f.resolution && RESOLUTIONS.includes(f.resolution)) { where.push("t.status='done' AND COALESCE(t.resolution,'done')=?"); args.push(f.resolution); }
    if (f.type && TYPES.includes(f.type)) { where.push('t.type=?'); args.push(f.type); }
    if (f.priority && PRIORITIES.includes(f.priority)) { where.push('t.priority=?'); args.push(f.priority); }
    if (f.assignee === 'me') { where.push('t.assignee_id=?'); args.push(user.id); }
    else if (f.assignee === 'none') where.push('t.assignee_id IS NULL');
    else if (f.assignee) { where.push('t.assignee_id=?'); args.push(Number(f.assignee) || 0); }
    if (f.reporter === 'me') { where.push('t.reporter_id=?'); args.push(user.id); }
    if (f.mentioned === 'me') { where.push('t.id IN (SELECT ticket_id FROM comment_mentions WHERE user_id=?)'); args.push(user.id); }
    if (f.participant === 'me') { where.push('t.id IN (SELECT ticket_id FROM ticket_participants WHERE user_id=?)'); args.push(user.id); }
    // Components are only shown to agents (ticketOut): no filter for users, it would reveal them
    const comp = isAgent(user) ? f.component : null;
    if (comp && scope !== null) { const ps = projectScopeSql(user); where.push(ps.sql); args.push(...ps.args); }
    if (comp === 'none') where.push('t.component_id IS NULL');
    else if (comp) { where.push('t.component_id=?'); args.push(int(comp) || 0); }
    if (f.label) { where.push("(','||t.labels||',') LIKE ?"); args.push(`%,${String(f.label).toLowerCase()},%`); }
    if (f.overdue === '1' || f.overdue === 1 || f.overdue === true) where.push("t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date < date('now')");
    const rd = int(f.resolvedDays);
    if (rd && rd > 0 && rd <= 3660) { where.push("t.resolved_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now',?)"); args.push(`-${rd} days`); }
    let hits = null;
    if (f.q) {
      const q = String(f.q).trim().slice(0, 300);
      const km = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(q);
      if (km) { where.push('(p.key=? AND t.number=?)'); args.push(km[1].toUpperCase(), Number(km[2])); }
      else if (isAgent(user) && scope !== null) {
        // Internal notes only count for tickets of their own projects – elsewhere they are a user
        const inner = search.find(q, { internal: true });
        const outer = search.find(q, { internal: false });
        if (inner || outer) {
          const ps = projectScopeSql(user);
          const ids = [...new Set([...(inner?.ids || []), ...(outer?.ids || [])])];
          hits = { ids, terms: (inner || outer).terms, capped: !!(inner?.capped || outer?.capped) };
          where.push(`((t.id IN (SELECT value FROM json_each(?)) AND ${ps.sql}) OR t.id IN (SELECT value FROM json_each(?)))`);
          args.push(JSON.stringify(inner?.ids || []), ...ps.args, JSON.stringify(outer?.ids || []));
        }
      } else {
        hits = search.find(q, { internal: isAgent(user) });
        if (hits) { where.push('t.id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(hits.ids)); }
      }
    }
    return { where, args, hits };
  }

  /** Number of tickets for list filters (without sorting/limit) */
  function count(user, f = {}, opts = {}) {
    const { where, args } = listFilter(user, f, opts);
    return db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args).n;
  }

  /**
   * Ticket list. f.limit (default 500, max 2000) and f.offset page through it;
   * opts.ids restricts to these ticket ids, opts.all returns every match (for filters computed afterwards).
   */
  function list(user, f = {}, opts = {}) {
    const { where, args, hits } = listFilter(user, f, opts);
    const sorts = {
      // Each ends on a unique column: with LIMIT/OFFSET, equal values could otherwise swap between pages
      updated: 't.updated_at DESC, t.id DESC', created: 't.created_at DESC, t.id DESC',
      priority: "CASE t.priority WHEN 'highest' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.updated_at DESC, t.id DESC",
      key: 'p.key, t.number DESC', rank: 't.rank, t.id',
      status: "CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END, t.updated_at DESC, t.id DESC",
    };
    const lim = int(f.limit);
    const limit = opts.all ? -1 : lim && lim > 0 ? Math.min(lim, 2000) : 500;
    // Clamped: a huge number would end up as 1e+24 in the SQL (error 500)
    const off = opts.all ? 0 : Math.min(MAX_OFFSET, Math.max(0, int(f.offset) || 0));
    // Search: default "best matches first" (order from the index), otherwise as selected
    const relevance = hits && (!f.sort || f.sort === 'relevance');
    const order = sorts[f.sort] || sorts.updated;
    let rows = db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${relevance ? '' : `ORDER BY ${order} LIMIT ${limit} OFFSET ${off}`}`).all(...args);
    if (relevance) {
      const pos = new Map(hits.ids.map((id, i) => [id, i]));
      rows = rows.sort((a, b) => pos.get(a.id) - pos.get(b.id));
      if (limit > 0) rows = rows.slice(off, off + limit);
    }
    const out = rows.map((r) => ticketOut(r, agentFor(user, r), user.id));
    if (hits) {
      // Match location for the first results (description, reply, attachment)
      out.slice(0, 100).forEach((tk) => { const m = search.snippet(tk.id, hits.terms, { internal: agentOn(user, tk.projectId) }); if (m) tk.match = m; });
      out.searchTerms = hits.terms;
      if (hits.capped) out.searchCapped = true;
    }
    return out;
  }

  function logActivity(ticketId, userId, action, field = null, oldV = null, newV = null) {
    db.prepare('INSERT INTO activity(ticket_id,user_id,action,field,old_value,new_value) VALUES(?,?,?,?,?,?)')
      .run(ticketId, userId, action, field, oldV === null ? null : String(oldV), newV === null ? null : String(newV));
  }

  function create(user, data, { source = 'web', reporterEmail = null, reporterName = null, reporterId, messageId = null, notifyReporter = false } = {}) {
    // An agent creates the ticket for someone else (e.g. a request that came in by phone or another mailbox)
    const onBehalf = !!user && reporterId !== undefined && reporterId !== null && reporterId !== user.id;
    const title = str(data.title, 255).trim();
    if (!title) throw new HttpError(400, 'err.titleRequired');
    let project = data.projectId ? projects.get(data.projectId) : null;
    if (!project || project.archived) project = db.prepare('SELECT * FROM projects WHERE archived=0 ORDER BY id LIMIT 1').get();
    if (!project) throw new HttpError(400, 'err.noProject');
    const agent = !!user && agentOn(user, project.id);
    // For someone else only as an agent of this project (a fallback project may not be theirs)
    if (onBehalf && !agent) throw forbidden();
    const id = db.transaction(() => {
      // Component: chosen by an agent, otherwise by the rules (sender pattern, keywords)
      let component = null;
      let match = null;
      if (agent && data.componentId) component = components.forProject(project.id, data.componentId);
      else {
        const sender = reporterEmail || (reporterId !== undefined ? (reporterId ? users.byId(reporterId)?.email : null) : user?.email) || '';
        match = matchComponent(components.active(project.id), { title, description: str(data.description, 100000), sender });
        if (match) component = match.component;
      }
      // Assigned only by hand (an agent who picks someone) – never automatically
      const assigneeId = agent && int(data.assigneeId) && isAssignable(int(data.assigneeId), project.id) ? int(data.assigneeId) : null;
      const number = db.prepare('UPDATE projects SET next_number=next_number+1 WHERE id=? RETURNING next_number-1 n').get(project.id).n;
      const minRank = db.prepare("SELECT COALESCE(MIN(rank),0) r FROM tickets WHERE project_id=? AND status='open'").get(project.id).r;
      const info = db.prepare(`INSERT INTO tickets(project_id,number,title,description,type,status,priority,reporter_id,reporter_email,reporter_name,assignee_id,labels,due_date,source,rank,component_id)
        VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?)`).run(
        project.id, number, title, str(data.description, 100000),
        TYPES.includes(data.type) && (agent || !AGENT_TYPES.includes(data.type)) ? data.type : 'request',
        PRIORITIES.includes(data.priority) ? data.priority : 'medium',
        reporterId !== undefined ? reporterId : (user ? user.id : null),
        reporterEmail, reporterName,
        assigneeId,
        normalizeLabels(data.labels),
        agent ? isoDate(data.dueDate) : null,
        source, minRank - 1, component ? component.id : null,
      );
      logActivity(info.lastInsertRowid, user ? user.id : null, 'created');
      if (onBehalf) logActivity(info.lastInsertRowid, user.id, 'createdFor', null, null, users.byId(reporterId)?.display_name || '');
      // History: which rule decided (kind = keywords/sender, detail = words or pattern)
      if (match) logActivity(info.lastInsertRowid, null, 'classified', match.kind, reasonDetail(match), component.name);
      return info.lastInsertRowid;
    })();
    const t = ticketOut(rawById(id));
    emitLater('created', { ticket: messageId ? { ...t, sourceMessageId: messageId } : t, user, onBehalf, notifyReporter: onBehalf && notifyReporter });
    if (t.assignee) emitLater('assigned', { ticket: t, user });
    return t;
  }

  /** opts.quietResolved: no "Resolved" mail to everyone (e.g. when a reply goes out at the same time);
   *  the 'resolved' event still fires (with quiet: true), the reporter only gets the rating links. */
  function update(user, idOrKey, data, opts = {}) {
    const row = load(user, idOrKey);
    const agent = agentFor(user, row);
    const isReporter = row.reporter_id === user.id;
    if (!agent && !isReporter) throw forbidden();

    const changes = {};
    const allowedForReporter = new Set(['title', 'description']);
    const set = (field, column, value) => {
      if (!agent && !allowedForReporter.has(field)) return;
      if (String(row[column] ?? '') !== String(value ?? '')) changes[column] = { field, old: row[column], new: value };
    };
    if (data.title !== undefined) {
      const tt = str(data.title, 255).trim();
      if (!tt) throw new HttpError(400, 'err.titleRequired');
      set('title', 'title', tt);
    }
    if (data.description !== undefined) set('description', 'description', str(data.description, 100000));
    if (data.type !== undefined && TYPES.includes(data.type)) set('type', 'type', data.type);
    if (data.status !== undefined && STATUSES.includes(data.status)) set('status', 'status', data.status);
    if (data.priority !== undefined && PRIORITIES.includes(data.priority)) set('priority', 'priority', data.priority);
    // Project change first: the assignee must be an agent of the (new) project
    let target = null;
    if (data.projectId !== undefined && agent) {
      target = projects.get(data.projectId);
      // Into any active project – a ticket in the wrong place goes where it belongs (also to a project
      // the agent does not work on; they then see it like any other foreign ticket)
      if (!target || target.archived) throw notFound();
    }
    const finalProject = target ? target.id : row.project_id;
    if (data.assigneeId !== undefined) {
      const aid = data.assigneeId ? int(data.assigneeId) : null;
      if (data.assigneeId && !aid) throw new HttpError(400, 'err.badRequest', 'assigneeId');
      if (aid && !isAssignable(aid, finalProject)) throw new HttpError(400, 'err.badRequest');
      set('assignee', 'assignee_id', aid);
    } else if (agent && target && target.id !== row.project_id && row.assignee_id && !isAssignable(row.assignee_id, target.id)) {
      // Moved to a project the assignee does not work on: nobody assigned there
      set('assignee', 'assignee_id', null);
    }
    if (data.labels !== undefined) set('labels', 'labels', normalizeLabels(data.labels));
    for (const f of ['impact', 'urgency']) {
      if (data[f] === undefined) continue;
      if (data[f] && !LEVELS.includes(data[f])) throw new HttpError(400, 'err.badRequest', f);
      set(f, f, data[f] || null);
    }
    // Priority from the matrix once both are known and impact/urgency changes
    if ((changes.impact || changes.urgency) && data.priority === undefined) {
      const imp = changes.impact ? changes.impact.new : row.impact;
      const urg = changes.urgency ? changes.urgency.new : row.urgency;
      if (imp && urg) set('priority', 'priority', PRIORITY_MATRIX[imp][urg]);
    }
    if (data.major !== undefined) set('major', 'major', data.major ? 1 : 0);
    if (data.dueDate !== undefined) {
      const d = data.dueDate ? isoDate(data.dueDate) : null;
      if (data.dueDate && !d) throw new HttpError(400, 'err.badRequest', 'dueDate');
      set('dueDate', 'due_date', d);
    }
    // Project change: new number in the target project
    if (target && target.id !== row.project_id) changes.project_id = { field: 'project', old: row.project_key, new: target.key, target };
    if (data.componentId !== undefined && agent) {
      // Component of the (new) project; empty = none. After a project change the old one is cleared anyway.
      const pid = changes.project_id ? changes.project_id.target.id : row.project_id;
      const cid = data.componentId ? components.forProject(pid, data.componentId).id : null;
      if (changes.project_id) { if (cid) changes.component_id = { field: 'component', old: null, new: cid }; }
      else set('component', 'component_id', cid);
    }

    const rankChanged = agent && typeof data.rank === 'number' && Number.isFinite(data.rank) && Math.abs(data.rank) < 1e12 && data.rank !== row.rank;
    if (!Object.keys(changes).length && !rankChanged) return ticketOut(row, agent, user.id);

    db.transaction(() => {
      for (const [col, c] of Object.entries(changes)) {
        if (col === 'project_id') { moveToProject(row, c.target, user.id); continue; }
        db.prepare(`UPDATE tickets SET ${col}=? WHERE id=?`).run(c.new, row.id);
        const show = (v) => (col === 'assignee_id' ? (v ? users.byId(v)?.display_name : null)
          : col === 'component_id' ? (v ? db.prepare('SELECT name FROM components WHERE id=?').get(v)?.name : null) : v);
        // Description: keep old and new version in the history (record of changes);
        // the texts are only delivered on request (descriptionVersion), not with every ticket
        if (col === 'description') logActivity(row.id, user.id, 'changed', 'description', c.old ?? '', c.new ?? '');
        else logActivity(row.id, user.id, 'changed', c.field, show(c.old), show(c.new));
      }
      if (changes.status) {
        db.prepare('UPDATE tickets SET resolved_at=? WHERE id=?').run(changes.status.new === 'done' ? new Date().toISOString() : null, row.id);
        // Resolution: set when done (default "done"), cleared when reopened
        if (changes.status.new === 'done') {
          db.prepare('UPDATE tickets SET resolution=?, duplicate_of=? WHERE id=?').run(opts.resolution || 'done', opts.duplicateOf || null, row.id);
          if (opts.resolution && opts.resolution !== 'done') logActivity(row.id, user.id, 'resolution', opts.resolution, null, opts.duplicateKey || null);
        } else db.prepare('UPDATE tickets SET resolution=NULL, duplicate_of=NULL WHERE id=?').run(row.id);
      }
      if (rankChanged) db.prepare('UPDATE tickets SET rank=? WHERE id=?').run(Number(data.rank), row.id);
      if (changes.description) {
        claimInlineImages(row.id, changes.description.new, user.id);
        // After editing the text applies – the formatted mail version no longer matches it
        db.prepare('DELETE FROM mail_html WHERE ticket_id=? AND comment_id IS NULL').run(row.id);
      }
      if (Object.keys(changes).length) db.prepare("UPDATE tickets SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(row.id);
    })();

    const t = ticketOut(rawById(row.id));
    const result = agentOn(user, t.projectId) ? t : ticketOut(rawById(row.id), false, user.id);
    if (changes.assignee_id && t.assignee && t.assignee.id !== user.id) emitLater('assigned', { ticket: t, user });
    // Always emit (e.g. satisfaction survey); quiet only suppresses the separate "Resolved" mail
    if (changes.status && changes.status.new === 'done') emitLater('resolved', { ticket: t, user, quiet: !!opts.quietResolved, resolution: opts.resolution || 'done' });
    if (changes.priority) events.emit('priorityChanged', { ticketId: row.id });
    if (changes.component_id) events.emit('componentChanged', { ticketId: row.id, componentId: changes.component_id.new, userId: user.id });
    return result;
  }

  /**
   * Close a ticket as rejected (reason required) or as a duplicate of another ticket (reason
   * optional, a standard note otherwise). The reason goes out as a reply to reporter and
   * participants – instead of the "Resolved" mail; no satisfaction survey. A duplicate is linked
   * with its original ("duplicates"); optionally reporter and participants join the original.
   * Also possible for tickets that are done already (changes the resolution).
   */
  function resolveAs(user, idOrKey, { resolution, reason = '', duplicateOf = null, addToOriginal = false, note = null } = {}) {
    if (!isAgent(user)) throw forbidden();
    if (!['rejected', 'duplicate'].includes(resolution)) throw new HttpError(400, 'err.badRequest', 'resolution');
    const row = load(user, idOrKey);
    if (!agentFor(user, row)) throw forbidden();
    const text = str(reason, 100000).trim();
    let original = null;
    if (resolution === 'rejected' && !text) throw new HttpError(400, 'err.rejectReasonRequired');
    if (resolution === 'duplicate') {
      try { original = load(user, str(duplicateOf, 30).trim().toUpperCase()); } catch { throw new HttpError(400, 'err.duplicateTarget'); }
      if (original.id === row.id) throw new HttpError(400, 'err.duplicateTarget');
      // The original is itself a closed duplicate: follow the chain to the ticket where the request is
      // really handled (so nobody is sent to a closed ticket); reaching this ticket again = cycle
      for (let depth = 0; original.resolution === 'duplicate' && original.duplicate_of; depth++) {
        if (original.duplicate_of === row.id || depth >= MAX_DUPLICATE_CHAIN) throw new HttpError(400, 'err.duplicateCycle');
        try { original = load(user, original.duplicate_of); } catch { throw new HttpError(400, 'err.duplicateTarget'); }
      }
      if (original.id === row.id) throw new HttpError(400, 'err.duplicateCycle');
    }
    const originalKey = original ? `${original.project_key}-${original.number}` : null;
    // The standard note in the reporter's language (it is a reply to them); null → default language
    const body = text || (note ? note(originalKey, row.reporter_id ? users.byId(row.reporter_id)?.language || null : null) : '');
    db.transaction(() => {
      if (original) {
        if (!db.prepare("SELECT 1 FROM ticket_links WHERE kind='duplicates' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))").get(row.id, original.id, original.id, row.id)) {
          db.prepare("INSERT INTO ticket_links(from_id, to_id, kind, created_by) VALUES(?,?,'duplicates',?)").run(row.id, original.id, user.id);
          logActivity(row.id, user.id, 'linked', 'duplicates:out', null, originalKey);
          logActivity(original.id, user.id, 'linked', 'duplicates:in', null, `${row.project_key}-${row.number}`);
        }
        if (addToOriginal) {
          // Reporter and participants (with an account) follow the original from now on
          const people = [row.reporter_id, ...db.prepare('SELECT user_id FROM ticket_participants WHERE ticket_id=?').all(row.id).map((r) => r.user_id)]
            .filter((id) => id && id !== original.reporter_id);
          for (const id of [...new Set(people)]) {
            const u = users.byId(id);
            if (!u || !u.active || isParticipant(original.id, id) || db.prepare('SELECT COUNT(*) n FROM ticket_participants WHERE ticket_id=?').get(original.id).n >= MAX_PARTICIPANTS) continue;
            db.prepare('INSERT INTO ticket_participants(ticket_id,user_id,added_by) VALUES(?,?,?)').run(original.id, id, user.id);
            logActivity(original.id, user.id, 'participantAdded', null, null, u.display_name);
          }
        }
      }
    })();
    if (body) addComment(user, row.id, { body, format: 'md' }, { resolutionReply: true });
    if (row.status === 'done') {
      // already done: only the resolution changes
      db.transaction(() => {
        // The link to a previous original no longer applies (it was set when closing as its duplicate)
        if (row.duplicate_of && row.duplicate_of !== original?.id) {
          const old = db.prepare("DELETE FROM ticket_links WHERE kind='duplicates' AND from_id=? AND to_id=?").run(row.id, row.duplicate_of);
          if (old.changes) {
            const prev = rawById(row.duplicate_of);
            const prevKey = prev ? `${prev.project_key}-${prev.number}` : null;
            logActivity(row.id, user.id, 'unlinked', 'duplicates:out', prevKey, null);
            if (prev) logActivity(prev.id, user.id, 'unlinked', 'duplicates:in', `${row.project_key}-${row.number}`, null);
          }
        }
        db.prepare("UPDATE tickets SET resolution=?, duplicate_of=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(resolution, original?.id || null, row.id);
      })();
      logActivity(row.id, user.id, 'resolution', resolution, row.resolution || 'done', originalKey);
      db.prepare('DELETE FROM ticket_ratings WHERE ticket_id=? AND rating IS NULL').run(row.id);
      return ticketOut(rawById(row.id));
    }
    return update(user, row.id, { status: 'done' }, { quietResolved: true, resolution, duplicateOf: original?.id || null, duplicateKey: originalKey });
  }

  /**
   * Change the reporter (agents): e.g. when the ticket was created for oneself by mistake.
   * A previous reporter with an account keeps access as a request participant; the new
   * reporter is no longer listed as a participant.
   */
  function setReporter(user, idOrKey, target, { notify = false } = {}) {
    const row = load(user, idOrKey);
    if (!agentFor(user, row)) throw forbidden();
    if (!target || !target.active) throw new HttpError(400, 'err.badRequest', 'reporter');
    if (row.reporter_id === target.id) return ticketOut(row);
    const old = row.reporter_id ? users.byId(row.reporter_id) : null;
    const oldName = old ? old.display_name : (row.reporter_name || row.reporter_email || null);
    db.transaction(() => {
      db.prepare("UPDATE tickets SET reporter_id=?, reporter_email=NULL, reporter_name=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(target.id, row.id);
      db.prepare('DELETE FROM ticket_participants WHERE ticket_id=? AND user_id=?').run(row.id, target.id);
      logActivity(row.id, user.id, 'changed', 'reporter', oldName, target.display_name);
      if (old && old.active && old.source !== 'email' && !agentFor(old, row) && !isParticipant(row.id, old.id)) {
        db.prepare('INSERT INTO ticket_participants(ticket_id,user_id,added_by) VALUES(?,?,?)').run(row.id, old.id, user.id);
        logActivity(row.id, user.id, 'participantAdded', null, null, old.display_name);
      }
    })();
    const t = ticketOut(rawById(row.id));
    if (notify) emitLater('reporterChanged', { ticket: t, user });
    return t;
  }

  /** Move a ticket to another project: new number there, old number in the history (call within a transaction). */
  function moveToProject(row, target, userId) {
    if (row.project_id === target.id) return;
    const number = db.prepare('UPDATE projects SET next_number=next_number+1 WHERE id=? RETURNING next_number-1 n').get(target.id).n;
    db.prepare("UPDATE tickets SET project_id=?, number=?, component_id=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(target.id, number, row.id);
    logActivity(row.id, userId, 'changed', 'project', `${row.project_key}-${row.number}`, `${target.key}-${number}`);
    // Components belong to a project: the old one does not apply in the target project
    if (row.component_id) logActivity(row.id, userId, 'changed', 'component', row.c_name, null);
  }

  // ---------- Comments ----------
  function comments(user, ticketId) {
    const agent = !!user && agentOn(user, projectOf(ticketId));
    return db.prepare(`SELECT c.*, u.display_name u_name, u.username u_username FROM comments c LEFT JOIN users u ON u.id=c.author_id
      WHERE c.ticket_id=? ${agent ? '' : 'AND c.internal=0'} ORDER BY c.created_at, c.id`).all(ticketId).map((c) => ({
      id: c.id,
      body: c.body,
      format: c.format === 'md' ? 'md' : 'text',
      internal: !!c.internal,
      source: c.source,
      createdAt: c.created_at,
      // Login name/address only for agents and the author themselves (self-registered: login name = private address)
      author: c.author_id
        ? { id: c.author_id, displayName: agent || c.author_id === user?.id ? c.u_name : publicName(c.u_name), username: agent || c.author_id === user?.id ? c.u_username : undefined }
        : agent ? { id: null, displayName: c.author_name || c.author_email || '?', email: c.author_email } : { id: null, displayName: publicName(c.author_name) || '?' },
    }));
  }

  /** system: notice from Helfi.Space itself (e.g. delivery failure) – always internal, reopens nothing. */
  function addComment(user, idOrKey, { body, internal = false, attachmentIds = [], format = 'text' }, { source = 'web', authorEmail = null, authorName = null, skipPermission = false, system = false, resolutionReply = false } = {}) {
    const row = skipPermission ? load(null, idOrKey) : load(user, idOrKey);
    const text = str(body, 100000).trim();
    if (!text) throw new HttpError(400, 'err.badRequest');
    const agent = agentFor(user, row);
    const isInternal = system || (agent && internal) ? 1 : 0;
    // @-mentions only from agents on the web; internal notes only reach agents, replies also
    // the people who can see the ticket anyway. Everything else stays plain text "@Name".
    const canMention = !!agent && !system && source !== 'email';
    const mention = normalizeMentions(text, {
      getUser: (id) => users.byId(id),
      allowed: (u) => canMention && u.active === 1 && (agentFor(u, row) || (!isInternal && canSee(u, row))),
    });
    const info = db.transaction(() => {
      // md: written with the formatting toolbar (web only – mails and system notes stay plain text)
      const fmt = format === 'md' && source !== 'email' && !system ? 'md' : 'text';
      const r = db.prepare('INSERT INTO comments(ticket_id,author_id,author_email,author_name,body,internal,source,format) VALUES(?,?,?,?,?,?,?,?)')
        .run(row.id, user ? user.id : null, authorEmail, authorName, mention.text, isInternal, source, fmt);
      const addMention = db.prepare('INSERT OR IGNORE INTO comment_mentions(comment_id,ticket_id,user_id,seen_at) VALUES(?,?,?,?)');
      // Mentioning oneself counts as already seen
      for (const id of mention.ids) addMention.run(r.lastInsertRowid, row.id, id, id === user?.id ? new Date().toISOString() : null);
      if (user && source !== 'email') {
        claimInlineImages(row.id, mention.text, user.id, r.lastInsertRowid);
        claimDrafts(row.id, attachmentIds, user.id, r.lastInsertRowid);
      }
      db.prepare("UPDATE tickets SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(row.id);
      // Reply from the reporter to a waiting/resolved ticket → reopen
      const fromCustomer = !system && !agent && (user ? isCustomer(user, row) : true);
      if (fromCustomer && (row.status === 'waiting' || row.status === 'done')) {
        db.prepare("UPDATE tickets SET status='open', resolved_at=NULL, resolution=NULL, duplicate_of=NULL WHERE id=?").run(row.id);
        logActivity(row.id, user ? user.id : null, 'changed', 'status', row.status, 'open');
      }
      return r;
    })();
    const ticket = ticketOut(rawById(row.id));
    const comment = comments({ role: 'admin' }, row.id).find((c) => c.id === info.lastInsertRowid);
    // resolutionReply: the reason of a rejection/duplicate – replaces the "Resolved" mail (see smtp.js)
    emitLater('commented', { ticket, comment, user, internal: !!isInternal, resolutionReply: !!resolutionReply });
    const others = mention.ids.filter((id) => id !== user?.id);
    if (others.length) emitLater('mentioned', { ticket, comment, user, internal: !!isInternal, userIds: others });
    return comment;
  }

  /**
   * Adopt images embedded in the text (![name](/api/attachments/ID)): drafts of this ticket
   * uploaded by the person themselves become visible and – for comments – are assigned to the
   * comment (internal note → image stays internal).
   */
  function claimInlineImages(ticketId, text, userId, commentId = null) {
    const ids = [...String(text || '').matchAll(/\]\(\/api\/attachments\/(\d+)\)/g)].map((m) => Number(m[1]));
    if (!ids.length || !userId) return;
    const stmt = db.prepare('UPDATE attachments SET draft=0, comment_id=COALESCE(?, comment_id) WHERE id=? AND ticket_id=? AND draft=1 AND uploaded_by=?');
    for (const id of ids) stmt.run(commentId, id, ticketId, userId);
  }

  /** Files picked for a reply (draft uploads of this person on this ticket) belong to the comment. */
  function claimDrafts(ticketId, ids, userId, commentId) {
    if (!Array.isArray(ids) || !ids.length) return;
    const stmt = db.prepare('UPDATE attachments SET draft=0, comment_id=? WHERE id=? AND ticket_id=? AND draft=1 AND uploaded_by=?');
    for (const id of ids) if (Number.isInteger(id) && id > 0) stmt.run(commentId, id, ticketId, userId);
  }

  // ---------- Attachments ----------
  function attachments(ticketId) {
    return db.prepare('SELECT id, filename, mime, size, comment_id, created_at FROM attachments WHERE ticket_id=? AND draft=0 AND inline=0 ORDER BY id').all(ticketId)
      .map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, commentId: a.comment_id, createdAt: a.created_at }));
  }

  function addAttachment(ticketId, { filename, mime, buffer, tmpPath, size, createdAt }, userId = null, commentId = null, { silent = false, draft = false, inline = false } = {}) {
    const dir = path.join(paths.attachments, String(ticketId));
    fs.mkdirSync(dir, { recursive: true });
    const storage = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const target = path.join(dir, storage);
    if (buffer) fs.writeFileSync(target, buffer);
    else {
      try { fs.renameSync(tmpPath, target); }
      catch (e) {
        if (e.code !== 'EXDEV') throw e;
        // different file system (e.g. /tmp in the container, /data mounted)
        fs.copyFileSync(tmpPath, target);
        fs.rmSync(tmpPath, { force: true });
      }
    }
    const safeName = String(filename || 'datei').replace(/[\\/\0\r\n]/g, '_').slice(0, 200);
    const info = db.prepare("INSERT INTO attachments(ticket_id,comment_id,filename,mime,size,storage_name,uploaded_by,created_at,draft,inline) VALUES(?,?,?,?,?,?,?,COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')),?,?)")
      .run(ticketId, commentId, safeName, String(mime || 'application/octet-stream').slice(0, 100), size ?? buffer.length, storage, userId, createdAt || null, draft ? 1 : 0, inline ? 1 : 0);
    if (commentId === null && !silent && !draft && !inline) logActivity(ticketId, userId, 'attached', null, null, safeName);
    return info.lastInsertRowid;
  }

  function attachmentFile(user, attId) {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(attId);
    if (!a) throw notFound();
    const row = load(user, a.ticket_id); // permissions
    const agent = agentFor(user, row);
    if (a.draft && !agent && a.uploaded_by !== user.id) throw notFound();
    if (a.comment_id && !agent) {
      const c = db.prepare('SELECT internal FROM comments WHERE id=?').get(a.comment_id);
      if (c?.internal) throw notFound();
    }
    return { ...a, agent, path: path.join(paths.attachments, String(a.ticket_id), a.storage_name) };
  }

  function deleteAttachment(user, attId) {
    const a = attachmentFile(user, attId);
    if (!a.agent && a.uploaded_by !== user.id) throw forbidden();
    db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
    fs.rmSync(a.path, { force: true });
    logActivity(a.ticket_id, user.id, 'detached', null, a.filename, null);
  }

  // ---------- Unsent uploads (drafts) ----------
  // Pasted images (draft=1 via the text) and files picked for a reply wait as drafts until the
  // text or comment claims them. Unclaimed ones are discarded by their uploader or after a day.
  const DRAFT_MAX_AGE_MS = 24 * 3600 * 1000;
  const removeFile = (a) => fs.rmSync(path.join(paths.attachments, String(a.ticket_id), a.storage_name), { force: true });

  /** Pending drafts of one person on one ticket (limit per upload) */
  function pendingDrafts(ticketId, userId) {
    return db.prepare('SELECT COUNT(*) n FROM attachments WHERE ticket_id=? AND uploaded_by=? AND draft=1').get(ticketId, userId).n;
  }

  /** Discard one's own unclaimed draft (removed chip, discarded reply). No history entry: it was never visible. */
  function discardDraft(user, attId) {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(attId);
    if (!a) throw notFound();
    load(user, a.ticket_id); // the ticket must be visible to this person
    if (!a.draft || a.uploaded_by !== user.id) throw forbidden();
    db.prepare('DELETE FROM attachments WHERE id=? AND draft=1').run(a.id);
    removeFile(a);
  }

  /** Delete drafts older than a day (daily job). Returns the number removed. */
  function purgeDrafts(now = Date.now()) {
    const cutoff = new Date(now - DRAFT_MAX_AGE_MS).toISOString();
    const old = db.prepare('SELECT id, ticket_id, storage_name FROM attachments WHERE draft=1 AND created_at < ?').all(cutoff);
    const del = db.prepare('DELETE FROM attachments WHERE id=? AND draft=1');
    for (const a of old) { del.run(a.id); removeFile(a); }
    return old.length;
  }

  // ---------- Request participants ----------
  /** Participant list. Email addresses only for agents (or one's own). */
  function participants(ticketId, viewer = null) {
    const agent = !viewer || agentOn(viewer, projectOf(ticketId));
    return db.prepare(`SELECT u.id, u.display_name, u.username, u.email, u.source, p.created_at FROM ticket_participants p
      JOIN users u ON u.id=p.user_id WHERE p.ticket_id=? ORDER BY p.created_at, u.display_name`).all(ticketId)
      .map((u) => ({
        id: u.id, displayName: agent || viewer?.id === u.id ? u.display_name : publicName(u.display_name), username: agent ? u.username : undefined,
        email: agent || viewer?.id === u.id ? (u.email || '') : undefined, contact: u.source === 'email', addedAt: u.created_at,
      }));
  }

  /**
   * Add a participant.
   * Web: agents (user or any address) and reporter/participants (existing accounts only,
   *      no free addresses – otherwise notifications to strangers could be triggered).
   * system: from emails (CC) – the caller checks permissions.
   */
  function addParticipant(user, idOrKey, { userId, email } = {}, { system = false, notify = true } = {}) {
    const row = system ? load(null, idOrKey) : load(user, idOrKey);
    const agent = !system && agentFor(user, row);
    if (!system && !agent && !isCustomer(user, row)) throw forbidden();
    let target = null;
    if (userId) {
      target = users.byId(int(userId) || 0);
      if (!target || !target.active) throw new HttpError(400, 'err.badRequest', 'userId');
      if (!system && !agent && target.source === 'email') throw forbidden();
    } else if (email) {
      if (!system && !agent) throw forbidden();
      const e = str(email, 254).trim().toLowerCase();
      if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(e)) throw new HttpError(400, 'err.badRequest', 'email');
      target = users.byEmail(e) || users.contactForEmail(e, '');
      if (!target.active) throw new HttpError(400, 'err.badRequest', 'email');
    } else throw new HttpError(400, 'err.badRequest');

    if (target.id === row.reporter_id || isParticipant(row.id, target.id)) return { added: false, participants: participants(row.id, user) };
    const count = db.prepare('SELECT COUNT(*) n FROM ticket_participants WHERE ticket_id=?').get(row.id).n;
    if (count >= MAX_PARTICIPANTS) throw new HttpError(400, 'err.tooManyParticipants');
    db.transaction(() => {
      db.prepare('INSERT INTO ticket_participants(ticket_id,user_id,added_by) VALUES(?,?,?)').run(row.id, target.id, user ? user.id : null);
      logActivity(row.id, user ? user.id : null, 'participantAdded', null, null, target.display_name);
    })();
    if (notify) emitLater('participantAdded', { ticket: ticketOut(rawById(row.id)), participant: target, user });
    return { added: true, participants: participants(row.id, user) };
  }

  /** Remove a participant: agents, reporter or the person themselves. */
  function removeParticipant(user, idOrKey, userId) {
    const row = load(user, idOrKey);
    const target = users.byId(int(userId) || 0);
    if (!target || !isParticipant(row.id, target.id)) throw notFound();
    if (!agentFor(user, row) && row.reporter_id !== user.id && target.id !== user.id) throw forbidden();
    db.transaction(() => {
      db.prepare('DELETE FROM ticket_participants WHERE ticket_id=? AND user_id=?').run(row.id, target.id);
      logActivity(row.id, user.id, 'participantRemoved', null, target.display_name, null);
    })();
    // Whoever removes themselves no longer sees the ticket afterwards
    return { participants: canSee(user, row) ? participants(row.id, user) : [] };
  }

  /** Recipients of notifications to "customers": reporter and participants (active, with address). */
  function customerRecipients(ticketId) {
    const t = db.prepare('SELECT reporter_id, reporter_email, reporter_name FROM tickets WHERE id=?').get(ticketId);
    if (!t) return [];
    const out = [];
    const seen = new Set();
    const push = (id, email, name) => {
      const e = String(email || '').trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      out.push({ id, email: e, displayName: name || e });
    };
    const rep = t.reporter_id ? users.byId(t.reporter_id) : null;
    if (rep) { if (rep.active) push(rep.id, rep.email, rep.display_name); } else push(null, t.reporter_email, t.reporter_name);
    for (const u of db.prepare(`SELECT u.* FROM ticket_participants p JOIN users u ON u.id=p.user_id
      WHERE p.ticket_id=? AND u.active=1 ORDER BY p.created_at`).all(ticketId)) push(u.id, u.email, u.display_name);
    return out;
  }

  function activity(ticketId) {
    return db.prepare(`SELECT a.*, u.display_name u_name FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE ticket_id=? ORDER BY a.created_at, a.id`)
      .all(ticketId).map((a) => {
        const desc = a.field === 'description' && a.action === 'changed';
        return {
          id: a.id, action: a.action, field: a.field,
          oldValue: desc ? null : a.old_value, newValue: desc ? null : a.new_value,
          hasText: desc && a.old_value !== null,
          createdAt: a.created_at, user: a.user_id ? { id: a.user_id, displayName: a.u_name } : null,
        };
      });
  }

  /** Old and new version of the description for a history entry (agents only, like the history) */
  function descriptionVersion(user, idOrKey, activityId) {
    const row = load(user, idOrKey);
    if (!agentFor(user, row)) throw forbidden();
    const a = db.prepare("SELECT a.*, u.display_name u_name FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.ticket_id=? AND a.action='changed' AND a.field='description'")
      .get(int(activityId) || 0, row.id);
    if (!a || a.old_value === null) throw notFound();
    return { old: a.old_value, new: a.new_value ?? '', createdAt: a.created_at, user: a.user_id ? { id: a.user_id, displayName: a.u_name } : null };
  }

  // ---------- HTML mails ----------
  function saveMailHtml(ticketId, commentId, html, blocked = 0) {
    db.prepare('INSERT INTO mail_html(ticket_id, comment_id, html, blocked) VALUES(?,?,?,?)').run(ticketId, commentId, html, blocked);
  }
  /** HTML for the description (commentId null) or a comment – with the same permissions as the text */
  function mailHtml(user, idOrKey, commentId = null) {
    const row = load(user, idOrKey);
    if (commentId) {
      const c = db.prepare('SELECT internal FROM comments WHERE id=? AND ticket_id=?').get(commentId, row.id);
      if (!c || (c.internal && !agentFor(user, row))) throw notFound();
    }
    const m = db.prepare(`SELECT html, blocked FROM mail_html WHERE ticket_id=? AND ${commentId ? 'comment_id=?' : 'comment_id IS NULL'}`)
      .get(...(commentId ? [row.id, commentId] : [row.id]));
    if (!m) throw notFound();
    return m;
  }

  // Extensions (links, SLA, change …) attach their own fields to the ticket view
  const detailExtras = [];
  function addDetailExtra(fn) { detailExtras.push(fn); }

  function detail(user, idOrKey) {
    const row = load(user, idOrKey);
    const extra = Object.assign({}, ...detailExtras.map((fn) => fn(user, row) || {}));
    const mentionsMe = new Set(db.prepare('SELECT comment_id FROM comment_mentions WHERE ticket_id=? AND user_id=?').all(row.id, user.id).map((r) => r.comment_id));
    if (mentionsMe.size) markMentionsSeen(user, row.id);
    const htmlFor = new Set(db.prepare('SELECT comment_id FROM mail_html WHERE ticket_id=?').all(row.id).map((r) => r.comment_id ?? 0));
    const agent = agentFor(user, row);
    return {
      ...ticketOut(row, agent, user.id),
      agentView: agent, // the client shows the agent tools only for tickets of the agent's projects
      // who may get the ticket: agents of its project
      ...(agent ? { assignableIds: db.prepare(`SELECT u.id FROM users u WHERE u.active=1 AND ${AGENT_OF_PROJECT}`).all(row.project_id).map((r) => r.id) } : {}),
      descriptionHtml: htmlFor.has(0),
      participants: participants(row.id, user),
      canManageParticipants: agent || row.reporter_id === user.id || isParticipant(row.id, user.id),
      comments: comments(user, row.id).map((c) => ({ ...c, hasHtml: htmlFor.has(c.id), mentionsMe: mentionsMe.has(c.id) || undefined })),
      attachments: attachments(row.id).filter((a) => agent || !a.commentId || !db.prepare('SELECT internal FROM comments WHERE id=?').get(a.commentId)?.internal),
      activity: agent ? activity(row.id) : [],
      ...extra,
    };
  }

  // ---------- @-mentions ----------
  function markMentionsSeen(user, ticketId) {
    db.prepare("UPDATE comment_mentions SET seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ticket_id=? AND user_id=? AND seen_at IS NULL").run(ticketId, user.id);
  }

  /** Tickets (IDs) with mentions of this person that they have not opened since. */
  function unseenMentionTickets(user, ticketIds = null) {
    const rows = db.prepare('SELECT DISTINCT ticket_id FROM comment_mentions WHERE user_id=? AND seen_at IS NULL').all(user.id);
    const set = new Set(rows.map((r) => r.ticket_id));
    return ticketIds ? new Set(ticketIds.filter((id) => set.has(id))) : set;
  }

  /**
   * Who can be mentioned in this ticket: active agents; for replies (not internal) also
   * reporter, participants and approvers – nobody who could not see the ticket anyway.
   */
  function mentionCandidates(user, idOrKey, { q = '', internal = false } = {}) {
    const row = load(user, idOrKey);
    if (!agentFor(user, row)) throw forbidden();
    const needle = str(q, 60).trim().toLowerCase();
    const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const match = needle ? "AND (lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(u.username) LIKE ? ESCAPE '\\')" : '';
    const margs = needle ? [like, like] : [];
    // Agents of this project only (others would not see the ticket – as agents)
    const agents = db.prepare(`SELECT u.id, u.display_name, u.username, u.role FROM users u
      WHERE u.active=1 AND ${AGENT_OF_PROJECT} ${match}
      ORDER BY lower(u.display_name) LIMIT 30`).all(row.project_id, ...margs);
    let customers = [];
    if (!internal) {
      customers = db.prepare(`SELECT u.id, u.display_name, u.username, u.role FROM users u
        WHERE u.active=1 AND NOT ${AGENT_OF_PROJECT} ${match} AND (u.id=? OR u.id IN (SELECT user_id FROM ticket_participants WHERE ticket_id=?)
          OR u.id IN (SELECT approver_id FROM approvals WHERE ticket_id=?)) ORDER BY lower(u.display_name) LIMIT 20`).all(row.project_id, ...margs, row.reporter_id || 0, row.id, row.id);
    }
    const out = (u, kind) => ({ id: u.id, displayName: u.display_name || u.username, kind });
    // Ticket people first (reporter, assignee), then everyone else
    const first = (x) => (x.id === row.reporter_id || x.id === row.assignee_id ? 0 : 1);
    return [...customers.map((u) => out(u, 'customer')), ...agents.map((u) => out(u, 'agent'))]
      .sort((a, b) => first(a) - first(b))
      .slice(0, 12);
  }

  /** Counts for the sidebar queues (one query, active projects only; unknown project → 0). */
  function queueCounts(user, projectKey = null) {
    let p = projectKey ? (projects.get(projectKey) || { id: 0 }) : null;
    if (p && !agentOn(user, p.id)) p = { id: 0 };
    const ps = projectScopeSql(user);
    const r = db.prepare(`SELECT
        SUM(t.status<>'done') open,
        SUM(t.status<>'done' AND t.assignee_id=?) mine,
        SUM(t.status<>'done' AND t.assignee_id IS NULL) unassigned,
        SUM(t.status='waiting') waiting,
        SUM(t.status='done' AND t.resolved_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) recent,
        COUNT(*) total,
        SUM(t.status<>'done' AND t.type='request') requests,
        SUM(t.status<>'done' AND t.type='incident') incidents
      FROM tickets t JOIN projects pr ON pr.id=t.project_id
      WHERE pr.archived=0 AND ${ps.sql} ${p ? 'AND t.project_id=?' : ''}`).get(user.id, ...ps.args, ...(p ? [p.id] : []));
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0]));
  }

  /** Summary of one project (also an archived one if explicitly selected) or of all active ones. */
  function summary(user, projectKey = null) {
    const p = projectKey ? projects.get(projectKey) : null;
    if (projectKey && (!p || !agentOn(user, p.id))) throw notFound();
    const ps = projectScopeSql(user);
    const where = p ? 't.project_id=?' : `pr.archived=0 AND ${ps.sql}`;
    const a = p ? [p.id] : ps.args;
    const one = (sql) => db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN projects pr ON pr.id=t.project_id WHERE ${where} AND ${sql}`).get(...a).n;
    const group = (col, cond) => Object.fromEntries(db.prepare(`SELECT t.${col} k, COUNT(*) n FROM tickets t JOIN projects pr ON pr.id=t.project_id
      WHERE ${where} AND ${cond} GROUP BY t.${col}`).all(...a).map((x) => [x.k, x.n]));
    const urgent = db.prepare(`${SELECT} WHERE ${p ? 't.project_id=?' : `p.archived=0 AND ${ps.sql}`} AND t.status<>'done'
      ORDER BY CASE t.priority WHEN 'highest' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        CASE WHEN t.due_date IS NOT NULL AND t.due_date < date('now') THEN 0 ELSE 1 END, t.created_at LIMIT 8`).all(...a);
    return {
      project: p ? projectOut(p) : null,
      counts: {
        open: one("t.status<>'done'"),
        created7: one("t.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
        resolved7: one("t.status='done' AND t.resolved_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
        overdue: one("t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date < date('now')"),
        unassigned: one("t.status<>'done' AND t.assignee_id IS NULL"),
      },
      byStatus: { ...Object.fromEntries(STATUSES.map((x) => [x, 0])), ...group('status', '1=1') },
      byType: { ...Object.fromEntries(TYPES.map((x) => [x, 0])), ...group('type', "t.status<>'done'") },
      byPriority: { ...Object.fromEntries(PRIORITIES.map((x) => [x, 0])), ...group('priority', "t.status<>'done'") },
      urgent: urgent.map((r) => ticketOut(r, agentFor(user, r), user.id)),
    };
  }

  /** Open tickets of one type (changes, problems) in active projects of the agent (optionally one project) */
  function openOfType(user, type, projectKey = null) {
    const ps = projectScopeSql(user);
    return db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.type=? AND t.status<>'done' AND p.archived=0 AND ${ps.sql} ${projectKey ? 'AND p.key=?' : ''}`)
      .get(type, ...ps.args, ...(projectKey ? [String(projectKey).toUpperCase()] : [])).n;
  }

  function stats(user) {
    // like the queues: active projects only
    const ps = projectScopeSql(user);
    const mine = db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.archived=0 AND ${ps.sql} AND assignee_id=? AND status<>'done'`).get(...ps.args, user.id).n;
    const unassigned = db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.archived=0 AND ${ps.sql} AND assignee_id IS NULL AND status<>'done'`).get(...ps.args).n;
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare(`SELECT status, COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.archived=0 AND ${ps.sql} GROUP BY status`).all(...ps.args)) byStatus[r.status] = r.n;
    return { mine, unassigned, byStatus };
  }

  return {
    search,
    events, projects, components, list, count, load, detail, addDetailExtra, create, update, addComment, saveMailHtml, mailHtml, comments,
    addAttachment, attachmentFile, deleteAttachment, discardDraft, purgeDrafts, pendingDrafts, ticketOut, rawById, logActivity, stats, userRef,
    applyComponent, resolveAs, descriptionVersion, participants, addParticipant, setReporter, mentionCandidates, unseenMentionTickets, markMentionsSeen, removeParticipant, isParticipant, customerRecipients, moveToProject, queueCounts, openOfType, summary,
  };
}
