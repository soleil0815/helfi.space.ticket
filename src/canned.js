// Canned responses: save frequent replies and insert them into the comment field.
// owner_id NULL = shared, otherwise personal. Shared ones optionally belong to a project (project_id):
// then only that project's agents see them.
// Who maintains shared ones: admins all of them; the lead and the deputy of a project those of their own
// project (like the service catalog). "For everyone" (no project) stays with the admins.
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

  /** Projects whose shared templates this person maintains: admins all, leads/deputies their own (not archived) */
  function manageable(user) {
    if (!user) return [];
    if (user.role === 'admin') return db.prepare('SELECT id, key, name FROM projects WHERE archived=0 ORDER BY name').all();
    return db.prepare('SELECT id, key, name FROM projects WHERE archived=0 AND (lead_id=? OR deputy_id=?) ORDER BY name').all(user.id, user.id);
  }
  const managedIds = (user) => new Set(manageable(user).map((p) => p.id));
  /** May change this shared template: admins always, leads/deputies only those of their projects */
  const canEditShared = (user, r, ids = managedIds(user)) => user.role === 'admin' || (!!r.project_id && ids.has(r.project_id));

  /** Shared templates (for everyone or one of the user's projects) plus the user's own, sorted by title. */
  function list(user) {
    const ids = managedIds(user);
    return db.prepare(`${SELECT} WHERE c.owner_id IS NULL OR c.owner_id=? ORDER BY lower(c.title), c.id`)
      .all(user.id).filter((r) => r.owner_id !== null || !r.project_id || agentOn(user, r.project_id) || ids.has(r.project_id))
      .map((r) => ({ ...out(r, user), canEdit: r.owner_id !== null || canEditShared(user, r, ids) }));
  }
  /** Project of a shared template: empty = for everyone (admins only); leads/deputies only their own projects */
  function projectOf(user, data) {
    const pid = int(data.projectId) || null;
    if (pid && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(pid)) throw new HttpError(400, 'err.badRequest', 'project');
    if (user.role !== 'admin' && (!pid || !managedIds(user).has(pid))) throw forbidden();
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
    if (shared && user.role !== 'admin' && !manageable(user).length) throw forbidden();
    const { title, body } = input(data);
    const projectId = shared ? projectOf(user, data) : null;
    const n = shared
      ? db.prepare('SELECT COUNT(*) n FROM canned_responses WHERE owner_id IS NULL').get().n
      : db.prepare('SELECT COUNT(*) n FROM canned_responses WHERE owner_id=?').get(user.id).n;
    if (n >= (shared ? MAX_SHARED : MAX_PERSONAL)) throw new HttpError(400, 'err.tooManyTemplates');
    const info = db.prepare('INSERT INTO canned_responses(title,body,owner_id,created_by,project_id) VALUES(?,?,?,?,?)')
      .run(title, body, shared ? null : user.id, user.id, projectId);
    return one(info.lastInsertRowid, user);
  }

  /** Personal ones only by the owner, shared ones by admins and the project's lead/deputy. Other users' personal ones are invisible (404). */
  function editable(user, id) {
    const r = db.prepare('SELECT * FROM canned_responses WHERE id=?').get(int(id) || 0);
    if (!r || (r.owner_id !== null && r.owner_id !== user.id)) throw notFound();
    if (r.owner_id === null && !canEditShared(user, r)) throw forbidden();
    return r;
  }

  function update(user, id, data) {
    const r = editable(user, id);
    const v = input(data, true);
    const projectId = r.owner_id === null && data.projectId !== undefined ? projectOf(user, data) : r.project_id;
    db.prepare(`UPDATE canned_responses SET title=?, body=?, project_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(v.title ?? r.title, v.body ?? r.body, projectId, r.id);
    return one(r.id, user);
  }

  function remove(user, id) {
    const r = editable(user, id);
    db.prepare('DELETE FROM canned_responses WHERE id=?').run(r.id);
  }

  return { list, create, update, remove, manageable };
}
