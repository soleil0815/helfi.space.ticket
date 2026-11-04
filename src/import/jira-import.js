// Import from Jira (Cloud or Server/Data Center) as a background job.
// - Projects are created (or merged into existing ones), ticket numbers stay the same where possible (IT-123 → IT-123)
// - Comments (internal comments from Jira Service Management stay internal) and attachments
// - Importing again updates already imported tickets instead of creating duplicates
// - NO emails are sent during the import
import { jiraText } from './jira-text.js';
import { createJiraClient, JiraError } from './jira-client.js';
import { normalizeLabels } from '../tickets.js';
import { log } from '../lib/log.js';
import { HttpError } from '../lib/http.js';

export const STATUS_TARGETS = ['open', 'in_progress', 'waiting', 'done'];
export const TYPE_TARGETS = ['incident', 'request', 'task', 'question'];

/** Suggested status mapping from status category and name */
export function suggestStatus(name, category) {
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
  const n = String(name || '').toLowerCase();
  if (/highest|blocker|critical|kritisch|sehr hoch|höchste|urgent|dringend/.test(n)) return 'highest';
  if (/high|major|hoch/.test(n)) return 'high';
  if (/lowest|low|minor|trivial|niedrig|gering/.test(n)) return 'low';
  return 'medium';
}

/** Internal comment? (Jira Service Management "internal comment" or restricted visibility) */
export function isInternalComment(c) {
  if (c.jsdPublic === false) return true;
  if (c.visibility) return true;
  const prop = (c.properties || []).find((p) => p.key === 'sd.public.comment');
  return !!prop?.value?.internal;
}

/** "IT-123" → target project key (uppercase letters/digits, starts with a letter, 2–10 characters) */
export function sanitizeProjectKey(key) {
  let k = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]/.test(k)) k = `J${k}`;
  return k.slice(0, 10).padEnd(2, 'X');
}

/** Date from Jira → ISO; invalid values → null (instead of aborting the whole issue) */
export const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function createJiraImporter({ db, tickets, users }) {
  let job = null;

  const mapGet = db.prepare('SELECT local_id, imported_at FROM import_map WHERE source=? AND kind=? AND external_id=?');
  const mapSet = db.prepare(`INSERT INTO import_map(source,kind,external_id,local_id,external_key) VALUES(?,?,?,?,?)
    ON CONFLICT(source,kind,external_id) DO UPDATE SET local_id=excluded.local_id, external_key=excluded.external_key, imported_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  const mapDel = db.prepare('DELETE FROM import_map WHERE source=? AND kind=? AND external_id=?');

  function publicStatus() {
    if (!job) return null;
    const { client, promise, ...rest } = job;
    return rest;
  }

  /** Jira person → local mapping. With email: find an account or create an email contact. */
  function person(p) {
    if (!p) return null;
    const email = String(p.emailAddress || '').trim().toLowerCase();
    const name = p.displayName || p.name || email || '?';
    let u = email ? users.byEmail(email) : null;
    if (!u && email && /@/.test(email)) u = users.contactForEmail(email, name);
    return { id: u?.id ?? null, email: email || null, name };
  }

  const agentCache = new Map();
  function agentFor(p) {
    if (!p) return null;
    const cacheKey = p.accountId || p.key || p.name || p.emailAddress;
    if (agentCache.has(cacheKey)) return agentCache.get(cacheKey);
    let id = null;
    const email = String(p.emailAddress || '').toLowerCase();
    const agents = db.prepare("SELECT * FROM users WHERE active=1 AND role IN ('agent','admin')").all();
    const byMail = email && agents.find((a) => String(a.email || '').toLowerCase() === email);
    if (byMail) id = byMail.id;
    else {
      // Without email (Jira Cloud often hides it): unique display name or username
      const candidates = agents.filter((a) => a.display_name === p.displayName || (p.name && a.username.toLowerCase() === String(p.name).toLowerCase()));
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

  async function importIssue(issue, project, cfg) {
    const { client, statusMap, typeMap, options } = cfg;
    const f = issue.fields || {};
    const source = client.sourceId;
    const mapped = mapGet.get(source, 'issue', String(issue.id));
    let ticketId = mapped?.local_id ?? null;
    if (ticketId && !db.prepare('SELECT 1 FROM tickets WHERE id=?').get(ticketId)) {
      mapDel.run(source, 'issue', String(issue.id)); // deleted locally → create again
      ticketId = null;
    }

    const reporter = person(f.reporter || f.creator);
    const assigneeId = agentFor(f.assignee);
    const statusName = f.status?.name || '';
    const values = {
      title: String(f.summary || issue.key).slice(0, 255),
      description: jiraText(f.description).slice(0, 100000),
      type: typeMap[f.issuetype?.name] || suggestType(f.issuetype?.name),
      status: statusMap[statusName] || suggestStatus(statusName, f.status?.statusCategory?.key),
      priority: mapPriority(f.priority?.name),
      labels: normalizeLabels(f.labels || []),
      due: f.duedate ? String(f.duedate).slice(0, 10) : null,
      created: iso(f.created) || new Date().toISOString(),
      updated: iso(f.updated) || iso(f.created) || new Date().toISOString(),
      resolved: iso(f.resolutiondate),
    };
    if (values.status === 'done' && !values.resolved) values.resolved = values.updated;
    if (values.status !== 'done') values.resolved = null;

    const created = !ticketId;
    // Already imported and unchanged in Jira since → do NOT overwrite local changes
    const jiraUpdated = iso(f.updated);
    const unchanged = ticketId && mapped?.imported_at && jiraUpdated && jiraUpdated <= mapped.imported_at;
    if (unchanged) {
      job.counts.unchanged++;
    }
    db.transaction(() => {
      if (unchanged) return;
      if (ticketId) {
        // Record changed fields in the history (like a manual change) so nothing is overwritten without a trace
        const old = db.prepare('SELECT title, description, type, status, priority, labels, due_date, assignee_id FROM tickets WHERE id=?').get(ticketId);
        const next = { title: values.title, description: values.description, type: values.type, status: values.status, priority: values.priority,
          labels: values.labels, due_date: values.due, assignee_id: assigneeId ?? old.assignee_id };
        const field = { due_date: 'dueDate', assignee_id: 'assignee' };
        const show = (col, v) => (col === 'assignee_id' ? (v ? db.prepare('SELECT display_name n FROM users WHERE id=?').get(v)?.n ?? null : null) : v);
        for (const col of Object.keys(next)) {
          if (String(old[col] ?? '') === String(next[col] ?? '')) continue;
          const [o, n] = col === 'description' ? [null, null] : [show(col, old[col]), show(col, next[col])];
          db.prepare("INSERT INTO activity(ticket_id,user_id,action,field,old_value,new_value) VALUES(?,?,'changed',?,?,?)")
            .run(ticketId, cfg.userId, field[col] || col, o === null ? null : String(o), n === null ? null : String(n));
        }
        db.prepare(`UPDATE tickets SET title=?, description=?, type=?, status=?, priority=?, labels=?, due_date=?, assignee_id=COALESCE(?,assignee_id),
          updated_at=MAX(updated_at, ?), resolved_at=? WHERE id=?`).run(
          values.title, values.description, values.type, values.status, values.priority, values.labels, values.due,
          assigneeId, values.updated, values.resolved, ticketId);
      } else {
        // Keep the number from Jira if it is free and never used in the target project: do not reuse numbers of
        // moved tickets (history "IT-11 → OPS-3"), otherwise old references would point to a different ticket
        const wanted = Number(String(issue.key).split('-').pop());
        let number = Number.isInteger(wanted) && wanted > 0 && !movedAway(project).has(wanted)
          && !db.prepare('SELECT 1 FROM tickets WHERE project_id=? AND number=?').get(project.id, wanted) ? wanted : null;
        if (number === null) number = db.prepare('UPDATE projects SET next_number=next_number+1 WHERE id=? RETURNING next_number-1 n').get(project.id).n;
        db.prepare('UPDATE projects SET next_number=MAX(next_number, ?) WHERE id=?').run(number + 1, project.id);
        const info = db.prepare(`INSERT INTO tickets(project_id,number,title,description,type,status,priority,reporter_id,reporter_email,reporter_name,
          assignee_id,labels,due_date,source,rank,created_at,updated_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'jira',?,?,?,?)`).run(
          project.id, number, values.title, values.description, values.type, values.status, values.priority,
          reporter?.id ?? null, reporter?.email ?? null, reporter?.name ?? null, assigneeId, values.labels, values.due,
          new Date(values.created).getTime() / 1e6, values.created, values.updated, values.resolved);
        ticketId = info.lastInsertRowid;
        const unmapped = f.assignee && !assigneeId ? (f.assignee.displayName || f.assignee.name || '') : null;
        db.prepare("INSERT INTO activity(ticket_id,user_id,action,old_value,new_value,created_at) VALUES(?,?,'imported',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
          .run(ticketId, cfg.userId, issue.key, unmapped);
      }
      mapSet.run(source, 'issue', String(issue.id), ticketId, issue.key);
    })();
    if (!unchanged) job.counts[created ? 'created' : 'updated']++;

    if (options.comments) {
      const comments = await client.comments(issue.id);
      for (const c of comments) {
        if (mapGet.get(source, 'comment', String(c.id))) continue;
        const author = person(c.author);
        const body = jiraText(c.body).slice(0, 100000) || '(leer)';
        db.transaction(() => {
          const info = db.prepare(`INSERT INTO comments(ticket_id,author_id,author_email,author_name,body,internal,source,created_at)
            VALUES(?,?,?,?,?,?,'jira',?)`).run(ticketId, author?.id ?? null, author?.email ?? null, author?.name ?? null, body,
            isInternalComment(c) ? 1 : 0, iso(c.created) || values.created);
          mapSet.run(source, 'comment', String(c.id), info.lastInsertRowid, issue.key);
        })();
        job.counts.comments++;
      }
    }

    if (options.attachments) {
      const maxBytes = (options.maxAttachmentMb || 50) * 1024 * 1024;
      for (const a of f.attachment || []) {
        if (mapGet.get(source, 'attachment', String(a.id))) continue;
        if (a.size > maxBytes) { job.counts.skippedAttachments++; addError(`${issue.key}: Anhang „${a.filename}“ zu groß (${Math.round(a.size / 1048576)} MB)`); continue; }
        try {
          const buffer = await client.download(a.content, maxBytes);
          const author = person(a.author);
          const attId = tickets.addAttachment(ticketId, { filename: a.filename, mime: a.mimeType, buffer, createdAt: iso(a.created) }, author?.id ?? null, null, { silent: true });
          mapSet.run(source, 'attachment', String(a.id), attId, issue.key);
          job.counts.attachments++;
        } catch (e) {
          job.counts.skippedAttachments++;
          addError(`${issue.key}: Anhang „${a.filename}“: ${e.message}`);
        }
      }
    }
  }

  function addError(msg) {
    job.errors.push(msg);
    if (job.errors.length > 200) job.errors.shift();
    log.warn(`Jira import: ${msg}`);
  }

  async function run(cfg) {
    const { client, projects } = cfg;
    try {
      for (const p of projects) {
        if (job.cancelRequested) break;
        const entry = job.projects.find((x) => x.key === p.key);
        entry.state = 'running';
        let project = tickets.projects.get(p.targetKey);
        if (!project) {
          tickets.projects.create({ key: p.targetKey, name: p.name || p.targetKey, description: `Importiert von ${client.host} (${p.key})` });
          project = tickets.projects.get(p.targetKey);
        }
        try { entry.total = await client.countIssues(p.key); } catch { entry.total = null; }
        for await (const issue of client.issues(p.key)) {
          if (job.cancelRequested) break;
          job.current = issue.key;
          try {
            await importIssue(issue, project, cfg);
          } catch (e) {
            job.counts.failed++;
            addError(`${issue.key}: ${e.message}`);
            if (e instanceof JiraError && (e.status === 401 || e.status === 403)) throw e;
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
      job.client = null; // do not keep credentials in memory any longer
      job.finishedAt = new Date().toISOString();
      log.info(`Jira import finished (${job.state})`, job.counts);
    }
  }

  return {
    status: publicStatus,

    /** Test the connection and list projects */
    async connect(conn) {
      const client = createJiraClient(conn);
      const [info, me, projects] = await Promise.all([client.serverInfo(), client.myself(), client.projects()]);
      return {
        type: client.type,
        server: { title: info?.serverTitle || '', version: info?.version || '', deploymentType: info?.deploymentType || '' },
        user: me?.displayName || me?.name || me?.emailAddress || '',
        projects: projects.map((p) => ({ ...p, suggestedKey: sanitizeProjectKey(p.key), exists: !!tickets.projects.get(sanitizeProjectKey(p.key)) })),
      };
    },

    /** Statuses/types of the selected projects with mapping suggestions */
    async inspect(conn, projectKeys) {
      const client = createJiraClient(conn);
      const statuses = new Map();
      const types = new Set();
      const counts = {};
      for (const key of projectKeys) {
        const r = await client.projectStatuses(key);
        for (const s of r.statuses) statuses.set(s.name, s.category);
        r.types.forEach((x) => types.add(x));
        try { counts[key] = await client.countIssues(key); } catch { counts[key] = null; }
      }
      return {
        statuses: [...statuses].map(([name, category]) => ({ name, category, suggested: suggestStatus(name, category) })),
        types: [...types].map((name) => ({ name, suggested: suggestType(name) })),
        counts,
      };
    },

    start(conn, { projects, statusMap = {}, typeMap = {}, options = {} }, userId) {
      if (job && job.state === 'running') throw new HttpError(409, 'err.importRunning');
      if (!Array.isArray(projects) || !projects.length) throw new HttpError(400, 'err.badRequest', 'projects');
      const client = createJiraClient(conn);
      const clean = projects.map((p) => ({ key: String(p.key), name: String(p.name || p.key).slice(0, 120), targetKey: sanitizeProjectKey(p.targetKey || p.key) }));
      const sMap = Object.fromEntries(Object.entries(statusMap).filter(([, v]) => STATUS_TARGETS.includes(v)));
      const tMap = Object.fromEntries(Object.entries(typeMap).filter(([, v]) => TYPE_TARGETS.includes(v)));
      agentCache.clear();
      movedCache.clear();
      job = {
        id: Date.now().toString(36),
        state: 'running',
        source: client.sourceId,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        current: null,
        cancelRequested: false,
        projects: clean.map((p) => ({ key: p.key, targetKey: p.targetKey, total: null, done: 0, state: 'waiting' })),
        counts: { created: 0, updated: 0, unchanged: 0, comments: 0, attachments: 0, skippedAttachments: 0, failed: 0 },
        errors: [],
        client,
      };
      const opts = { comments: options.comments !== false, attachments: options.attachments !== false, maxAttachmentMb: Number(options.maxAttachmentMb) || 50 };
      const done = run({ client, projects: clean, statusMap: sMap, typeMap: tMap, options: opts, userId });
      job.promise = done;
      return publicStatus();
    },

    cancel() { if (job?.state === 'running') job.cancelRequested = true; return publicStatus(); },

    /** For tests: wait for completion */
    async wait() { if (job?.promise) await job.promise; return publicStatus(); },
  };
}
