// Canned responses: save frequent replies and insert them into the comment field.
// owner_id NULL = for all agents (maintained by admins only), otherwise personal.
// Shared ones optionally belong to a project (project_id): then only that project's agents see them.
import { HttpError, notFound, forbidden, str, int } from './lib/http.js';
import { agentOn } from './auth/access.js';

export const MAX_PERSONAL = 200;
export const MAX_SHARED = 500;

export function createCanned(db) {
  const SELECT = 'SELECT c.*, p.key p_key, p.name p_name FROM canned_responses c LEFT JOIN projects p ON p.id=c.project_id';
  const out = (r, user) => ({
    id: r.id, title: r.title, body: r.body, shared: r.owner_id === null, mine: r.owner_id === user.id, updatedAt: r.updated_at,
    project: r.project_id ? { id: r.project_id, key: r.p_key, name: r.p_name } : null,
  });
  const one = (id, user) => out(db.prepare(`${SELECT} WHERE c.id=?`).get(id), user);

  /** Shared templates (for everyone or one of the user's projects) plus the user's own, sorted by title. */
  function list(user) {
    return db.prepare(`${SELECT} WHERE c.owner_id IS NULL OR c.owner_id=? ORDER BY lower(c.title), c.id`)
      .all(user.id).filter((r) => r.owner_id !== null || !r.project_id || agentOn(user, r.project_id)).map((r) => out(r, user));
  }
  /** Project of a shared template: empty = for everyone */
  function projectOf(data) {
    const pid = int(data.projectId) || null;
    if (pid && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(pid)) throw new HttpError(400, 'err.badRequest', 'project');
    return pid;
  }

  function input(data, partial = false) {
    const res = {};
    if (!partial || data.title !== undefined) {
      res.title = str(data.title, 100).trim();
      if (!res.title) throw new HttpError(400, 'err.badRequest', 'title');
    }
    if (!partial || data.body !== undefined) {
      res.body = str(data.body, 10000).replace(/\r\n/g, '\n').trimEnd();
      if (!res.body.trim()) throw new HttpError(400, 'err.badRequest', 'body');
    }
    return res;
  }

  function create(user, data) {
    const shared = !!data.shared;
    if (shared && user.role !== 'admin') throw forbidden();
    const { title, body } = input(data);
    const n = shared
      ? db.prepare('SELECT COUNT(*) n FROM canned_responses WHERE owner_id IS NULL').get().n
      : db.prepare('SELECT COUNT(*) n FROM canned_responses WHERE owner_id=?').get(user.id).n;
    if (n >= (shared ? MAX_SHARED : MAX_PERSONAL)) throw new HttpError(400, 'err.tooManyTemplates');
    const info = db.prepare('INSERT INTO canned_responses(title,body,owner_id,created_by,project_id) VALUES(?,?,?,?,?)')
      .run(title, body, shared ? null : user.id, user.id, shared ? projectOf(data) : null);
    return one(info.lastInsertRowid, user);
  }

  /** Personal ones only by the owner, shared ones only by admins. Other users' personal ones are invisible (404). */
  function editable(user, id) {
    const r = db.prepare('SELECT * FROM canned_responses WHERE id=?').get(int(id) || 0);
    if (!r || (r.owner_id !== null && r.owner_id !== user.id)) throw notFound();
    if (r.owner_id === null && user.role !== 'admin') throw forbidden();
    return r;
  }

  function update(user, id, data) {
    const r = editable(user, id);
    const v = input(data, true);
    const projectId = r.owner_id === null && data.projectId !== undefined ? projectOf(data) : r.project_id;
    db.prepare(`UPDATE canned_responses SET title=?, body=?, project_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(v.title ?? r.title, v.body ?? r.body, projectId, r.id);
    return one(r.id, user);
  }

  function remove(user, id) {
    const r = editable(user, id);
    db.prepare('DELETE FROM canned_responses WHERE id=?').run(r.id);
  }

  return { list, create, update, remove };
}
