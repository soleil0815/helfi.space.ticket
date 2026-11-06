// Import from other ticket systems as a background job – the part that is the same for every source.
// Each source (Jira, Zammad, Znuny/OTRS, CSV …) provides an adapter that delivers projects,
// statuses/types for the mapping and the tickets in a common shape (see importTicket).
// - Projects are created (or merged into existing ones), ticket numbers stay the same where possible
// - Comments (internal ones stay internal) and attachments
// - Importing again updates already imported tickets instead of creating duplicates
// - NO emails are sent during the import
import { MAX_COMPONENTS } from '../components.js';
import { normalizeLabels } from '../tickets.js';
import { log } from '../lib/log.js';
import { HttpError } from '../lib/http.js';
import { SourceError } from './http.js';

export const STATUS_TARGETS = ['open', 'in_progress', 'waiting', 'done'];
export const TYPE_TARGETS = ['incident', 'request', 'task', 'question'];
// Numbers above this (e.g. date-based ticket numbers like 20261106100001) are not kept
export const MAX_KEPT_NUMBER = 9_999_999;

/** Suggested status mapping from status name and category (new | indeterminate | done | waiting) */
export function suggestStatus(name, category) {
  if (category === 'waiting') return 'waiting';
  if (/wait|warte|pending|hold|feedback|rückmeldung|blocked|blockiert|kunde|customer/i.test(name || '')) return 'waiting';
  if (category === 'done') return 'done';
  if (category === 'new') return 'open';
  if (category === 'indeterminate') return 'in_progress';
  return 'open';
}

export function suggestType(name) {
  const n = String(name || '');
  if (/bug|incident|störung|fehler|problem|defect|outage|ausfall/i.test(n)) return 'incident';
  if (/question|frage/i.test(n)) return 'question';
  if (/task|aufgabe|story|epic|sub-?task|teilaufgabe|change|änderung|improvement|verbesserung/i.test(n)) return 'task';
  return 'request';
}

export function mapPriority(name) {
  // Words only: numbers mean different things (Zammad "2 normal", Znuny "2 low")
  const n = String(name || '').toLowerCase();
  if (/very high|sehr hoch|highest|blocker|critical|kritisch|höchste|urgent|dringend/.test(n)) return 'highest';
  if (/normal|medium|mittel/.test(n)) return 'medium';
  if (/high|major|hoch/.test(n)) return 'high';
  if (/lowest|low|minor|trivial|niedrig|gering/.test(n)) return 'low';
  return 'medium';
}

/** "IT-123" / "Service Desk" → target project key (uppercase letters/digits, starts with a letter, 2–10 characters) */
export function sanitizeProjectKey(key, prefix = 'J') {
  let k = String(key || '').toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]/.test(k)) k = `${prefix}${k}`;
  return k.slice(0, 10).padEnd(2, 'X');
}

/** Date → ISO; invalid values → null (instead of aborting the whole ticket) */
export const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** "IT-123", "#31001", "4711" → wanted number (or null) */
export function wantedNumber(key) {
  const n = Number(String(key ?? '').split('-').pop().replace(/^#/, ''));
  return Number.isInteger(n) && n > 0 && n <= MAX_KEPT_NUMBER ? n : null;
}

/**
 * Ticket in the common shape (from an adapter):
 * { extId, extKey, number?, title, description, typeName, statusName, statusCategory, priorityName, labels[], component?, due,
 *   created, updated, resolved, reporter: {email, name}, assignee: {email, name, username, ref},
 *   comments?: async () => [{ extId, author: {email, name}, body, internal, created }],
 *   attachments?: async () => [{ extId, filename, mime, size, created, author, commentExtId?, internal?, load: async (maxBytes) => Buffer }] }
 *
 * Adapter: { sourceId, host, ticketSource ('jira' | 'import'), label,
 *   info() → { title, version, user }, projects() → [{ key, name }], inspect(keys) → { statuses: [{name, category}], types: [name], counts },
 *   count(key) → n | null, tickets(key) → async iterator }
 */
export function createImportCore({ db, tickets, users }) {
  let job = null;

  const mapGet = db.prepare('SELECT local_id, imported_at FROM import_map WHERE source=? AND kind=? AND external_id=?');
  const mapSet = db.prepare(`INSERT INTO import_map(source,kind,external_id,local_id,external_key) VALUES(?,?,?,?,?)
    ON CONFLICT(source,kind,external_id) DO UPDATE SET local_id=excluded.local_id, external_key=excluded.external_key, imported_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  const mapDel = db.prepare('DELETE FROM import_map WHERE source=? AND kind=? AND external_id=?');

  function publicStatus() {
    if (!job) return null;
    const { adapter, promise, ...rest } = job;
    return rest;
  }

  /** Person → local mapping. With email: find an account or create an email contact. */
  function person(p) {
    if (!p) return null;
    const email = String(p.email || '').trim().toLowerCase();
    const name = p.name || email || '?';
    let u = email ? users.byEmail(email) : null;
    if (!u && email && /^[^\s@]+@[^\s@]+$/.test(email)) u = users.contactForEmail(email, name);
    return { id: u?.id ?? null, email: email || null, name };
  }

  /** Component by name in the project; created (without lead) if missing. Null if none given or the limit is reached. */
  function componentFor(projectId, name) {
    const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!n) return null;
    const found = db.prepare('SELECT id FROM components WHERE project_id=? AND name=?').get(projectId, n);
    if (found) return found.id;
    if (db.prepare('SELECT COUNT(*) c FROM components WHERE project_id=?').get(projectId).c >= MAX_COMPONENTS) return null;
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM components WHERE project_id=?').get(projectId).n;
    return db.prepare('INSERT INTO components(project_id,name,position) VALUES(?,?,?)').run(projectId, n, pos).lastInsertRowid;
  }

  const agentCache = new Map();
  function agentFor(p) {
    if (!p) return null;
    const cacheKey = p.ref || p.username || p.email || p.name;
    if (agentCache.has(cacheKey)) return agentCache.get(cacheKey);
    let id = null;
    const email = String(p.email || '').toLowerCase();
    const agents = db.prepare("SELECT * FROM users WHERE active=1 AND role IN ('agent','admin')").all();
    const byMail = email && agents.find((a) => String(a.email || '').toLowerCase() === email);
    if (byMail) id = byMail.id;
    else {
      // Without email (some systems hide it): unique display name or username
      const candidates = agents.filter((a) => (p.name && a.display_name === p.name) || (p.username && a.username.toLowerCase() === String(p.username).toLowerCase()));
      if (candidates.length === 1) id = candidates[0].id;
    }
    agentCache.set(cacheKey, id);
    return id;
  }

  /** Numbers that tickets of this project had before and gave up when moved (determined once per import) */
  const movedCache = new Map();
  function movedAway(project) {
    if (!movedCache.has(project.id)) {
      const prefix = `${project.key}-`;
      const nums = db.prepare("SELECT old_value v FROM activity WHERE field='project' AND substr(old_value, 1, ?)=?").all(prefix.length, prefix)
        .map((r) => Number(r.v.slice(prefix.length))).filter((n) => Number.isInteger(n) && n > 0);
      movedCache.set(project.id, new Set(nums));
    }
    return movedCache.get(project.id);
  }

  async function importTicket(it, project, cfg) {
    const { adapter, statusMap, typeMap, options } = cfg;
    const source = adapter.sourceId;
    const extId = String(it.extId);
    const mapped = mapGet.get(source, 'issue', extId);
    let ticketId = mapped?.local_id ?? null;
    if (ticketId && !db.prepare('SELECT 1 FROM tickets WHERE id=?').get(ticketId)) {
      mapDel.run(source, 'issue', extId); // gone locally → create again
      ticketId = null;
    }

    const reporter = person(it.reporter);
    const assigneeId = agentFor(it.assignee);
    const statusName = it.statusName || '';
    const typeName = it.typeName || '';
    const values = {
      title: String(it.title || it.extKey || '—').slice(0, 255),
      description: String(it.description || '').slice(0, 100000),
      type: typeMap[typeName] || suggestType(typeName),
      status: statusMap[statusName] || suggestStatus(statusName, it.statusCategory),
      priority: mapPriority(it.priorityName),
      labels: normalizeLabels(it.labels || []),
      due: it.due ? String(it.due).slice(0, 10) : null,
      created: iso(it.created) || new Date().toISOString(),
      updated: iso(it.updated) || iso(it.created) || new Date().toISOString(),
      resolved: iso(it.resolved),
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.due || '')) values.due = null;
    if (values.status === 'done' && !values.resolved) values.resolved = values.updated;
    if (values.status !== 'done') values.resolved = null;

    const created = !ticketId;
    // Already imported and unchanged in the source since → do NOT overwrite local changes
    const srcUpdated = iso(it.updated);
    const unchanged = ticketId && mapped?.imported_at && srcUpdated && srcUpdated <= mapped.imported_at;
    if (unchanged) job.counts.unchanged++;
    db.transaction(() => {
      if (unchanged) return;
      // Component by name in the target project (created if missing, without lead – the admin adds that)
      const componentId = componentFor(project.id, it.component);
      if (ticketId) {
        // Record changed fields in the history (like a manual change) so nothing is overwritten without a trace
        const old = db.prepare('SELECT title, description, type, status, priority, labels, due_date, assignee_id, component_id FROM tickets WHERE id=?').get(ticketId);
        const next = { title: values.title, description: values.description, type: values.type, status: values.status, priority: values.priority,
          labels: values.labels, due_date: values.due, assignee_id: assigneeId ?? old.assignee_id, component_id: componentId ?? old.component_id };
        const field = { due_date: 'dueDate', assignee_id: 'assignee', component_id: 'component' };
        const show = (col, v) => (col === 'assignee_id' ? (v ? db.prepare('SELECT display_name n FROM users WHERE id=?').get(v)?.n ?? null : null)
          : col === 'component_id' ? (v ? db.prepare('SELECT name FROM components WHERE id=?').get(v)?.name ?? null : null) : v);
        for (const col of Object.keys(next)) {
          if (String(old[col] ?? '') === String(next[col] ?? '')) continue;
          const [o, n] = col === 'description' ? [null, null] : [show(col, old[col]), show(col, next[col])];
          db.prepare("INSERT INTO activity(ticket_id,user_id,action,field,old_value,new_value) VALUES(?,?,'changed',?,?,?)")
            .run(ticketId, cfg.userId, field[col] || col, o === null ? null : String(o), n === null ? null : String(n));
        }
        db.prepare(`UPDATE tickets SET title=?, description=?, type=?, status=?, priority=?, labels=?, due_date=?, assignee_id=COALESCE(?,assignee_id),
          component_id=COALESCE(?,component_id), updated_at=MAX(updated_at, ?), resolved_at=? WHERE id=?`).run(
          values.title, values.description, values.type, values.status, values.priority, values.labels, values.due,
          assigneeId, componentId, values.updated, values.resolved, ticketId);
      } else {
        // Keep the number if it is free and never used in the target project: do not reuse numbers of
        // moved tickets (history "IT-11 → OPS-3"), otherwise old references would point to a different ticket
        const wanted = it.number !== undefined ? (Number.isInteger(it.number) && it.number > 0 && it.number <= MAX_KEPT_NUMBER ? it.number : null) : wantedNumber(it.extKey);
        let number = wanted && !movedAway(project).has(wanted)
          && !db.prepare('SELECT 1 FROM tickets WHERE project_id=? AND number=?').get(project.id, wanted) ? wanted : null;
        if (number === null) number = db.prepare('UPDATE projects SET next_number=next_number+1 WHERE id=? RETURNING next_number-1 n').get(project.id).n;
        db.prepare('UPDATE projects SET next_number=MAX(next_number, ?) WHERE id=?').run(number + 1, project.id);
        const info = db.prepare(`INSERT INTO tickets(project_id,number,title,description,type,status,priority,reporter_id,reporter_email,reporter_name,
          assignee_id,labels,due_date,source,rank,created_at,updated_at,resolved_at,component_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          project.id, number, values.title, values.description, values.type, values.status, values.priority,
          reporter?.id ?? null, reporter?.email ?? null, reporter?.name ?? null, assigneeId, values.labels, values.due, adapter.ticketSource || 'import',
          new Date(values.created).getTime() / 1e6, values.created, values.updated, values.resolved, componentId);
        ticketId = info.lastInsertRowid;
        const unmapped = it.assignee && !assigneeId ? (it.assignee.name || it.assignee.username || '') : null;
        db.prepare("INSERT INTO activity(ticket_id,user_id,action,old_value,new_value,created_at) VALUES(?,?,'imported',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
          .run(ticketId, cfg.userId, String(it.extKey || extId), unmapped);
      }
      mapSet.run(source, 'issue', extId, ticketId, String(it.extKey || extId));
    })();
    if (!unchanged) job.counts[created ? 'created' : 'updated']++;
    const label = it.extKey || extId;

    if (options.comments && it.comments) {
      for (const c of await it.comments()) {
        if (mapGet.get(source, 'comment', String(c.extId))) continue;
        const author = person(c.author);
        const body = String(c.body || '').slice(0, 100000).trim() || '(leer)';
        db.transaction(() => {
          const info = db.prepare(`INSERT INTO comments(ticket_id,author_id,author_email,author_name,body,internal,source,created_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(ticketId, author?.id ?? null, author?.email ?? null, author?.name ?? null, body,
            c.internal ? 1 : 0, adapter.ticketSource || 'import', iso(c.created) || values.created);
          mapSet.run(source, 'comment', String(c.extId), info.lastInsertRowid, label);
        })();
        job.counts.comments++;
      }
    }

    if (options.attachments && it.attachments) {
      const maxBytes = (options.maxAttachmentMb || 50) * 1024 * 1024;
      for (const a of await it.attachments()) {
        if (mapGet.get(source, 'attachment', String(a.extId))) continue;
        if (a.size > maxBytes) { job.counts.skippedAttachments++; addError(`${label}: Anhang „${a.filename}“ zu groß (${Math.round(a.size / 1048576)} MB)`); continue; }
        // Files of a comment belong to it – those of internal notes stay internal (no comment → skip)
        const commentId = a.commentExtId ? (mapGet.get(source, 'comment', String(a.commentExtId))?.local_id ?? null) : null;
        if (a.internal && !commentId) { job.counts.skippedAttachments++; continue; }
        try {
          const buffer = await a.load(maxBytes);
          if (buffer.length > maxBytes) throw new SourceError('zu groß', 413);
          const author = person(a.author);
          const attId = tickets.addAttachment(ticketId, { filename: String(a.filename || 'datei').slice(0, 255), mime: a.mime, buffer, createdAt: iso(a.created) }, author?.id ?? null, commentId, { silent: true });
          mapSet.run(source, 'attachment', String(a.extId), attId, label);
          job.counts.attachments++;
        } catch (e) {
          job.counts.skippedAttachments++;
          addError(`${label}: Anhang „${a.filename}“: ${e.message}`);
        }
      }
    }
  }

  function addError(msg) {
    job.errors.push(msg);
    if (job.errors.length > 200) job.errors.shift();
    log.warn(`Import: ${msg}`);
  }

  async function run(cfg) {
    const { adapter, projects } = cfg;
    try {
      for (const p of projects) {
        if (job.cancelRequested) break;
        const entry = job.projects.find((x) => x.key === p.key);
        entry.state = 'running';
        let project = tickets.projects.get(p.targetKey);
        if (!project) {
          tickets.projects.create({ key: p.targetKey, name: p.name || p.targetKey, description: `Importiert von ${adapter.host} (${p.name || p.key})` });
          project = tickets.projects.get(p.targetKey);
        }
        try { entry.total = await adapter.count(p.key); } catch { entry.total = null; }
        for await (const it of adapter.tickets(p.key, cfg.options)) {
          if (job.cancelRequested) break;
          job.current = String(it.extKey || it.extId);
          try {
            await importTicket(it, project, cfg);
          } catch (e) {
            job.counts.failed++;
            addError(`${job.current}: ${e.message}`);
            if (e instanceof SourceError && (e.status === 401 || e.status === 403)) throw e;
          }
          entry.done++;
        }
        entry.state = job.cancelRequested ? 'cancelled' : 'done';
      }
      job.state = job.cancelRequested ? 'cancelled' : 'done';
    } catch (e) {
      job.state = 'failed';
      addError(e.message);
    } finally {
      job.current = null;
      job.adapter = null; // do not keep credentials in memory any longer
      job.finishedAt = new Date().toISOString();
      log.info(`Import finished (${job.state})`, job.counts);
    }
  }

  return {
    status: publicStatus,
    running: () => job?.state === 'running',

    /** Test the connection and list projects */
    async connect(adapter, extra = {}) {
      const [info, projects] = await Promise.all([adapter.info(), adapter.projects()]);
      const prefix = adapter.keyPrefix || 'J';
      return {
        ...extra,
        server: { title: info?.title || '', version: info?.version || '', ...(info?.deploymentType ? { deploymentType: info.deploymentType } : {}) },
        user: info?.user || '',
        projects: projects.map((p) => {
          const suggestedKey = sanitizeProjectKey(p.suggestKey || p.key, prefix);
          return { key: String(p.key), name: p.name, count: p.count ?? undefined, suggestedKey, exists: !!tickets.projects.get(suggestedKey) };
        }),
      };
    },

    /** Statuses/types of the selected projects with mapping suggestions */
    async inspect(adapter, projectKeys) {
      const r = await adapter.inspect(projectKeys);
      return {
        statuses: r.statuses.map((s) => ({ name: s.name, category: s.category, suggested: suggestStatus(s.name, s.category) })),
        types: r.types.map((name) => ({ name, suggested: suggestType(name) })),
        counts: r.counts,
      };
    },

    start(adapter, { projects, statusMap = {}, typeMap = {}, options = {} }, userId) {
      if (job && job.state === 'running') throw new HttpError(409, 'err.importRunning');
      if (!Array.isArray(projects) || !projects.length) throw new HttpError(400, 'err.badRequest', 'projects');
      const prefix = adapter.keyPrefix || 'J';
      const clean = projects.slice(0, 500).map((p) => ({ key: String(p.key).slice(0, 200), name: String(p.name || p.key).slice(0, 120), targetKey: sanitizeProjectKey(p.targetKey || p.key, prefix) }));
      const sMap = Object.fromEntries(Object.entries(statusMap).filter(([, v]) => STATUS_TARGETS.includes(v)));
      const tMap = Object.fromEntries(Object.entries(typeMap).filter(([, v]) => TYPE_TARGETS.includes(v)));
      agentCache.clear();
      movedCache.clear();
      job = {
        id: Date.now().toString(36),
        state: 'running',
        source: adapter.sourceId,
        kind: adapter.kind || 'jira',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        current: null,
        cancelRequested: false,
        projects: clean.map((p) => ({ key: p.key, name: p.name, targetKey: p.targetKey, total: null, done: 0, state: 'waiting' })),
        counts: { created: 0, updated: 0, unchanged: 0, comments: 0, attachments: 0, skippedAttachments: 0, failed: 0 },
        errors: [],
        adapter,
      };
      const opts = { comments: options.comments !== false, attachments: options.attachments !== false, maxAttachmentMb: Math.min(1024, Math.max(1, Number(options.maxAttachmentMb) || 50)) };
      const done = run({ adapter, projects: clean, statusMap: sMap, typeMap: tMap, options: opts, userId });
      job.promise = done;
      return publicStatus();
    },

    cancel() { if (job?.state === 'running') job.cancelRequested = true; return publicStatus(); },

    /** For tests: wait for completion */
    async wait() { if (job?.promise) await job.promise; return publicStatus(); },
  };
}
