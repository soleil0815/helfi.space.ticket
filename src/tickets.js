// Tickets, Projekte, Kommentare, Anhänge, Verlauf.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { HttpError, notFound, forbidden, str, isoDate, int } from './lib/http.js';
import { isAgent } from './auth/session.js';
import { userRef } from './users.js';

export const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
export const TYPES = ['incident', 'request', 'task', 'question'];
export const PRIORITIES = ['highest', 'high', 'medium', 'low'];

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
export const MAX_PARTICIPANTS = 20;

export function normalizeLabels(v) {
  const arr = Array.isArray(v) ? v : str(v, 2000).split(/[,;\s]+/);
  return [...new Set(arr.map((x) => str(x, 100).trim().toLowerCase().replace(/[^\p{L}\p{N}_.-]/gu, '')).filter(Boolean))].slice(0, 20).join(',');
}

export function createTickets(db, users) {
  const events = new EventEmitter();
  // Ereignisse erst nach Abschluss der laufenden Transaktion auslösen
  const emitLater = (name, payload) => setImmediate(() => events.emit(name, payload));

  // ---------- Projekte ----------
  /** Projektleitung: nur bestehende Benutzer, sonst 400 statt Fremdschlüssel-Fehler */
  function validLead(id) {
    if (id === null || id === undefined || id === '') return null;
    const n = int(id);
    if (!n || !users.byId(n)) throw new HttpError(400, 'err.badRequest', 'leadId');
    return n;
  }

  const projects = {
    list(includeArchived = false) {
      return db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM tickets t WHERE t.project_id=p.id AND t.status<>'done') open_count
        FROM projects p ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY name`).all().map(projectOut);
    },
    get(idOrKey) {
      const p = db.prepare('SELECT * FROM projects WHERE id=? OR key=?').get(int(idOrKey) || 0, str(idOrKey, 20));
      return p || null;
    },
    create({ key, name, description = '', leadId = null }) {
      key = str(key, 20).trim().toUpperCase();
      if (!KEY_RE.test(key)) throw new HttpError(400, 'err.projectKey');
      if (db.prepare('SELECT 1 FROM projects WHERE key=?').get(key)) throw new HttpError(409, 'err.projectKeyTaken');
      const info = db.prepare('INSERT INTO projects(key,name,description,lead_id) VALUES(?,?,?,?)')
        .run(key, str(name, 120) || key, str(description, 2000), validLead(leadId));
      return projectOut(db.prepare('SELECT * FROM projects WHERE id=?').get(info.lastInsertRowid));
    },
    update(id, { name, description, leadId, archived }) {
      const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
      if (!p) throw notFound();
      db.prepare('UPDATE projects SET name=?, description=?, lead_id=?, archived=? WHERE id=?').run(
        name !== undefined ? (str(name, 120).trim() || p.name) : p.name,
        description !== undefined ? str(description, 2000) : p.description,
        leadId !== undefined ? validLead(leadId) : p.lead_id,
        archived !== undefined ? (archived ? 1 : 0) : p.archived,
        id,
      );
      return projectOut(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
    },
  };

  function projectOut(p) {
    return { id: p.id, key: p.key, name: p.name, description: p.description, leadId: p.lead_id, archived: !!p.archived, openCount: p.open_count ?? undefined };
  }

  // ---------- Tickets ----------
  const SELECT = `SELECT t.*, p.key project_key, p.name project_name,
      a.display_name a_name, a.username a_username, a.email a_email,
      r.display_name r_name, r.username r_username, r.email r_email,
      (SELECT COUNT(*) FROM comments c WHERE c.ticket_id=t.id) comment_count,
      (SELECT COUNT(*) FROM comments c WHERE c.ticket_id=t.id AND c.internal=0) public_comment_count
    FROM tickets t JOIN projects p ON p.id=t.project_id
    LEFT JOIN users a ON a.id=t.assignee_id
    LEFT JOIN users r ON r.id=t.reporter_id`;

  function ticketOut(t, agent = true) {
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
      dueDate: t.due_date,
      source: t.source,
      rank: t.rank,
      assignee: t.assignee_id ? { id: t.assignee_id, displayName: t.a_name, username: agent ? t.a_username : undefined, email: agent ? (t.a_email || '') : undefined } : null,
      reporter: t.reporter_id
        ? { id: t.reporter_id, displayName: t.r_name, username: t.r_username, email: t.r_email || t.reporter_email || '' }
        : (t.reporter_email || t.reporter_name ? { id: null, displayName: t.reporter_name || t.reporter_email, email: t.reporter_email || '' } : null),
      commentCount: agent ? t.comment_count : t.public_comment_count,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      resolvedAt: t.resolved_at,
    };
  }

  /** Zuweisen nur an aktive Bearbeiter/Admins */
  function isAssignable(id) {
    const u = users.byId(Number(id));
    return !!u && u.active === 1 && (u.role === 'agent' || u.role === 'admin');
  }

  function rawById(id) { return db.prepare(`${SELECT} WHERE t.id=?`).get(id); }

  /** Ticket per ID oder Schlüssel ("HS-12") holen, mit Rechteprüfung. */
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

  /** Melder oder Anfrage-Teilnehmer ("Kunde" der Anfrage) */
  function isCustomer(user, row) {
    return !!user && (row.reporter_id === user.id || isParticipant(row.id, user.id));
  }

  function canSee(user, row) {
    return isAgent(user) || isCustomer(user, row);
  }

  function list(user, f = {}) {
    const where = [];
    const args = [];
    if (!isAgent(user)) {
      where.push('(t.reporter_id=? OR t.id IN (SELECT ticket_id FROM ticket_participants WHERE user_id=?))');
      args.push(user.id, user.id);
    }
    if (f.project) { where.push('(p.key=? OR p.id=?)'); args.push(String(f.project).toUpperCase(), Number(f.project) || 0); }
    else where.push('p.archived=0');
    if (f.status) {
      const st = String(f.status).split(',').filter((s) => STATUSES.includes(s) || s === 'unresolved');
      if (st.includes('unresolved')) where.push("t.status<>'done'");
      const real = st.filter((s) => s !== 'unresolved');
      if (real.length) { where.push(`t.status IN (${real.map(() => '?').join(',')})`); args.push(...real); }
    }
    if (f.type && TYPES.includes(f.type)) { where.push('t.type=?'); args.push(f.type); }
    if (f.priority && PRIORITIES.includes(f.priority)) { where.push('t.priority=?'); args.push(f.priority); }
    if (f.assignee === 'me') { where.push('t.assignee_id=?'); args.push(user.id); }
    else if (f.assignee === 'none') where.push('t.assignee_id IS NULL');
    else if (f.assignee) { where.push('t.assignee_id=?'); args.push(Number(f.assignee) || 0); }
    if (f.reporter === 'me') { where.push('t.reporter_id=?'); args.push(user.id); }
    if (f.participant === 'me') { where.push('t.id IN (SELECT ticket_id FROM ticket_participants WHERE user_id=?)'); args.push(user.id); }
    if (f.label) { where.push("(','||t.labels||',') LIKE ?"); args.push(`%,${String(f.label).toLowerCase()},%`); }
    if (f.q) {
      const q = String(f.q).trim();
      const km = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(q);
      if (km) { where.push('(p.key=? AND t.number=?)'); args.push(km[1].toUpperCase(), Number(km[2])); }
      else {
        const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
        where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR t.reporter_email LIKE ? ESCAPE '\\')");
        args.push(like, like, like);
      }
    }
    const sorts = {
      updated: 't.updated_at DESC', created: 't.created_at DESC', priority: "CASE t.priority WHEN 'highest' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.updated_at DESC",
      key: 'p.key, t.number DESC', rank: 't.rank, t.id', status: "CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END, t.updated_at DESC",
    };
    const order = sorts[f.sort] || sorts.updated;
    const lim = int(f.limit);
    const limit = lim && lim > 0 ? Math.min(lim, 2000) : 500;
    const rows = db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit}`).all(...args);
    return rows.map((r) => ticketOut(r, isAgent(user)));
  }

  function logActivity(ticketId, userId, action, field = null, oldV = null, newV = null) {
    db.prepare('INSERT INTO activity(ticket_id,user_id,action,field,old_value,new_value) VALUES(?,?,?,?,?,?)')
      .run(ticketId, userId, action, field, oldV === null ? null : String(oldV), newV === null ? null : String(newV));
  }

  function create(user, data, { source = 'web', reporterEmail = null, reporterName = null, reporterId, messageId = null } = {}) {
    const title = str(data.title, 255).trim();
    if (!title) throw new HttpError(400, 'err.titleRequired');
    let project = data.projectId ? projects.get(data.projectId) : null;
    if (!project || project.archived) project = db.prepare('SELECT * FROM projects WHERE archived=0 ORDER BY id LIMIT 1').get();
    if (!project) throw new HttpError(400, 'err.noProject');
    const agent = isAgent(user);
    const id = db.transaction(() => {
      const number = db.prepare('UPDATE projects SET next_number=next_number+1 WHERE id=? RETURNING next_number-1 n').get(project.id).n;
      const minRank = db.prepare("SELECT COALESCE(MIN(rank),0) r FROM tickets WHERE project_id=? AND status='open'").get(project.id).r;
      const info = db.prepare(`INSERT INTO tickets(project_id,number,title,description,type,status,priority,reporter_id,reporter_email,reporter_name,assignee_id,labels,due_date,source,rank)
        VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?)`).run(
        project.id, number, title, str(data.description, 100000),
        TYPES.includes(data.type) ? data.type : 'request',
        PRIORITIES.includes(data.priority) ? data.priority : 'medium',
        reporterId !== undefined ? reporterId : (user ? user.id : null),
        reporterEmail, reporterName,
        agent && int(data.assigneeId) && isAssignable(int(data.assigneeId)) ? int(data.assigneeId) : null,
        normalizeLabels(data.labels),
        agent ? isoDate(data.dueDate) : null,
        source, minRank - 1,
      );
      logActivity(info.lastInsertRowid, user ? user.id : null, 'created');
      return info.lastInsertRowid;
    })();
    const t = ticketOut(rawById(id));
    emitLater('created', { ticket: messageId ? { ...t, sourceMessageId: messageId } : t, user });
    if (t.assignee) emitLater('assigned', { ticket: t, user });
    return t;
  }

  function update(user, idOrKey, data) {
    const row = load(user, idOrKey);
    const agent = isAgent(user);
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
    if (data.assigneeId !== undefined) {
      const aid = data.assigneeId ? int(data.assigneeId) : null;
      if (data.assigneeId && !aid) throw new HttpError(400, 'err.badRequest', 'assigneeId');
      if (aid && !isAssignable(aid)) throw new HttpError(400, 'err.badRequest');
      set('assignee', 'assignee_id', aid);
    }
    if (data.labels !== undefined) set('labels', 'labels', normalizeLabels(data.labels));
    if (data.dueDate !== undefined) {
      const d = data.dueDate ? isoDate(data.dueDate) : null;
      if (data.dueDate && !d) throw new HttpError(400, 'err.badRequest', 'dueDate');
      set('dueDate', 'due_date', d);
    }
    if (data.projectId !== undefined && agent) {
      // Projektwechsel: neue Nummer im Zielprojekt
      const target = projects.get(data.projectId);
      if (!target || target.archived) throw notFound();
      if (target.id !== row.project_id) changes.project_id = { field: 'project', old: row.project_key, new: target.key, target };
    }

    const rankChanged = agent && typeof data.rank === 'number' && Number.isFinite(data.rank) && Math.abs(data.rank) < 1e12 && data.rank !== row.rank;
    if (!Object.keys(changes).length && !rankChanged) return ticketOut(row, agent);

    db.transaction(() => {
      for (const [col, c] of Object.entries(changes)) {
        if (col === 'project_id') {
          const number = db.prepare('UPDATE projects SET next_number=next_number+1 WHERE id=? RETURNING next_number-1 n').get(c.target.id).n;
          db.prepare('UPDATE tickets SET project_id=?, number=? WHERE id=?').run(c.target.id, number, row.id);
          logActivity(row.id, user.id, 'changed', 'project', `${row.project_key}-${row.number}`, `${c.target.key}-${number}`);
          continue;
        }
        db.prepare(`UPDATE tickets SET ${col}=? WHERE id=?`).run(c.new, row.id);
        const show = (v) => (col === 'assignee_id' ? (v ? users.byId(v)?.display_name : null) : v);
        // Beschreibungstexte nicht doppelt im Verlauf speichern
        if (col === 'description') logActivity(row.id, user.id, 'changed', 'description');
        else logActivity(row.id, user.id, 'changed', c.field, show(c.old), show(c.new));
      }
      if (changes.status) {
        db.prepare('UPDATE tickets SET resolved_at=? WHERE id=?').run(changes.status.new === 'done' ? new Date().toISOString() : null, row.id);
      }
      if (rankChanged) db.prepare('UPDATE tickets SET rank=? WHERE id=?').run(Number(data.rank), row.id);
      if (Object.keys(changes).length) db.prepare("UPDATE tickets SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(row.id);
    })();

    const t = ticketOut(rawById(row.id));
    const result = agent ? t : ticketOut(rawById(row.id), false);
    if (changes.assignee_id && t.assignee && t.assignee.id !== user.id) emitLater('assigned', { ticket: t, user });
    if (changes.status && changes.status.new === 'done') emitLater('resolved', { ticket: t, user });
    return result;
  }

  function remove(user, idOrKey) {
    const row = load(user, idOrKey);
    if (user.role !== 'admin') throw forbidden();
    db.transaction(() => {
      // Import-Zuordnungen mitlöschen – IDs können wiederverwendet werden, sonst würde ein
      // erneuter Jira-Import ein fremdes Ticket überschreiben
      db.prepare("DELETE FROM import_map WHERE kind='comment' AND local_id IN (SELECT id FROM comments WHERE ticket_id=?)").run(row.id);
      db.prepare("DELETE FROM import_map WHERE kind='attachment' AND local_id IN (SELECT id FROM attachments WHERE ticket_id=?)").run(row.id);
      db.prepare("DELETE FROM import_map WHERE kind='issue' AND local_id=?").run(row.id);
      db.prepare('DELETE FROM tickets WHERE id=?').run(row.id);
    })();
    fs.rmSync(path.join(paths.attachments, String(row.id)), { recursive: true, force: true });
  }

  // ---------- Kommentare ----------
  function comments(user, ticketId) {
    const agent = isAgent(user);
    return db.prepare(`SELECT c.*, u.display_name u_name, u.username u_username FROM comments c LEFT JOIN users u ON u.id=c.author_id
      WHERE c.ticket_id=? ${agent ? '' : 'AND c.internal=0'} ORDER BY c.created_at, c.id`).all(ticketId).map((c) => ({
      id: c.id,
      body: c.body,
      internal: !!c.internal,
      source: c.source,
      createdAt: c.created_at,
      author: c.author_id ? { id: c.author_id, displayName: c.u_name, username: c.u_username } : { id: null, displayName: c.author_name || c.author_email || '?', email: c.author_email },
    }));
  }

  function addComment(user, idOrKey, { body, internal = false }, { source = 'web', authorEmail = null, authorName = null, skipPermission = false } = {}) {
    const row = skipPermission ? load(null, idOrKey) : load(user, idOrKey);
    const text = str(body, 100000).trim();
    if (!text) throw new HttpError(400, 'err.badRequest');
    const agent = user && isAgent(user);
    const isInternal = agent && internal ? 1 : 0;
    const info = db.transaction(() => {
      const r = db.prepare('INSERT INTO comments(ticket_id,author_id,author_email,author_name,body,internal,source) VALUES(?,?,?,?,?,?,?)')
        .run(row.id, user ? user.id : null, authorEmail, authorName, text, isInternal, source);
      db.prepare("UPDATE tickets SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(row.id);
      // Antwort des Meldenden auf ein wartendes/erledigtes Ticket → wieder öffnen
      const fromCustomer = !agent && (user ? isCustomer(user, row) : true);
      if (fromCustomer && (row.status === 'waiting' || row.status === 'done')) {
        db.prepare("UPDATE tickets SET status='open', resolved_at=NULL WHERE id=?").run(row.id);
        logActivity(row.id, user ? user.id : null, 'changed', 'status', row.status, 'open');
      }
      return r;
    })();
    const ticket = ticketOut(rawById(row.id));
    const comment = comments({ role: 'admin' }, row.id).find((c) => c.id === info.lastInsertRowid);
    emitLater('commented', { ticket, comment, user, internal: !!isInternal });
    return comment;
  }

  // ---------- Anhänge ----------
  function attachments(ticketId) {
    return db.prepare('SELECT id, filename, mime, size, comment_id, created_at FROM attachments WHERE ticket_id=? ORDER BY id').all(ticketId)
      .map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, commentId: a.comment_id, createdAt: a.created_at }));
  }

  function addAttachment(ticketId, { filename, mime, buffer, tmpPath, size, createdAt }, userId = null, commentId = null, { silent = false } = {}) {
    const dir = path.join(paths.attachments, String(ticketId));
    fs.mkdirSync(dir, { recursive: true });
    const storage = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const target = path.join(dir, storage);
    if (buffer) fs.writeFileSync(target, buffer);
    else {
      try { fs.renameSync(tmpPath, target); }
      catch (e) {
        if (e.code !== 'EXDEV') throw e;
        // anderes Dateisystem (z. B. /tmp im Container, /data eingebunden)
        fs.copyFileSync(tmpPath, target);
        fs.rmSync(tmpPath, { force: true });
      }
    }
    const safeName = String(filename || 'datei').replace(/[\\/\0\r\n]/g, '_').slice(0, 200);
    const info = db.prepare("INSERT INTO attachments(ticket_id,comment_id,filename,mime,size,storage_name,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')))")
      .run(ticketId, commentId, safeName, String(mime || 'application/octet-stream').slice(0, 100), size ?? buffer.length, storage, userId, createdAt || null);
    if (commentId === null && !silent) logActivity(ticketId, userId, 'attached', null, null, safeName);
    return info.lastInsertRowid;
  }

  function attachmentFile(user, attId) {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(attId);
    if (!a) throw notFound();
    load(user, a.ticket_id); // Rechte
    if (a.comment_id && !isAgent(user)) {
      const c = db.prepare('SELECT internal FROM comments WHERE id=?').get(a.comment_id);
      if (c?.internal) throw notFound();
    }
    return { ...a, path: path.join(paths.attachments, String(a.ticket_id), a.storage_name) };
  }

  function deleteAttachment(user, attId) {
    const a = attachmentFile(user, attId);
    if (!isAgent(user) && a.uploaded_by !== user.id) throw forbidden();
    db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
    fs.rmSync(a.path, { force: true });
    logActivity(a.ticket_id, user.id, 'detached', null, a.filename, null);
  }

  // ---------- Anfrage-Teilnehmer ----------
  /** Teilnehmerliste. E-Mail-Adressen nur für Bearbeiter (bzw. die eigene). */
  function participants(ticketId, viewer = null) {
    const agent = !viewer || isAgent(viewer);
    return db.prepare(`SELECT u.id, u.display_name, u.username, u.email, u.source, p.created_at FROM ticket_participants p
      JOIN users u ON u.id=p.user_id WHERE p.ticket_id=? ORDER BY p.created_at, u.display_name`).all(ticketId)
      .map((u) => ({
        id: u.id, displayName: u.display_name, username: agent ? u.username : undefined,
        email: agent || viewer?.id === u.id ? (u.email || '') : undefined, contact: u.source === 'email', addedAt: u.created_at,
      }));
  }

  /**
   * Teilnehmer hinzufügen.
   * Web: Bearbeiter (Benutzer oder beliebige Adresse) und Melder/Teilnehmer (nur bestehende Konten,
   *      keine freien Adressen – sonst ließen sich Benachrichtigungen an Fremde auslösen).
   * system: aus E-Mails (CC) – Rechte prüft der Aufrufer.
   */
  function addParticipant(user, idOrKey, { userId, email } = {}, { system = false, notify = true } = {}) {
    const row = system ? load(null, idOrKey) : load(user, idOrKey);
    const agent = !system && isAgent(user);
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

  /** Teilnehmer entfernen: Bearbeiter, Melder oder die Person selbst. */
  function removeParticipant(user, idOrKey, userId) {
    const row = load(user, idOrKey);
    const target = users.byId(int(userId) || 0);
    if (!target || !isParticipant(row.id, target.id)) throw notFound();
    if (!isAgent(user) && row.reporter_id !== user.id && target.id !== user.id) throw forbidden();
    db.transaction(() => {
      db.prepare('DELETE FROM ticket_participants WHERE ticket_id=? AND user_id=?').run(row.id, target.id);
      logActivity(row.id, user.id, 'participantRemoved', null, target.display_name, null);
    })();
    // Wer sich selbst entfernt, sieht das Ticket danach nicht mehr
    return { participants: canSee(user, row) ? participants(row.id, user) : [] };
  }

  /** Empfänger für Benachrichtigungen an "Kunden": Melder und Teilnehmer (aktiv, mit Adresse). */
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
      .all(ticketId).map((a) => ({ id: a.id, action: a.action, field: a.field, oldValue: a.old_value, newValue: a.new_value, createdAt: a.created_at, user: a.user_id ? { id: a.user_id, displayName: a.u_name } : null }));
  }

  function detail(user, idOrKey) {
    const row = load(user, idOrKey);
    return {
      ...ticketOut(row, isAgent(user)),
      participants: participants(row.id, user),
      canManageParticipants: isAgent(user) || row.reporter_id === user.id || isParticipant(row.id, user.id),
      comments: comments(user, row.id),
      attachments: attachments(row.id).filter((a) => isAgent(user) || !a.commentId || !db.prepare('SELECT internal FROM comments WHERE id=?').get(a.commentId)?.internal),
      activity: isAgent(user) ? activity(row.id) : [],
    };
  }

  function stats(user) {
    const mine = db.prepare("SELECT COUNT(*) n FROM tickets WHERE assignee_id=? AND status<>'done'").get(user.id).n;
    const unassigned = db.prepare("SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.archived=0 AND assignee_id IS NULL AND status<>'done'").get().n;
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.archived=0 GROUP BY status').all()) byStatus[r.status] = r.n;
    return { mine, unassigned, byStatus };
  }

  return {
    events, projects, list, load, detail, create, update, remove, addComment, comments,
    addAttachment, attachmentFile, deleteAttachment, ticketOut, rawById, logActivity, stats, userRef,
    participants, addParticipant, removeParticipant, isParticipant, customerRecipients,
  };
}
