// Canned responses: save frequent replies and insert them into the comment field.
// owner_id NULL = for all agents (maintained by admins only), otherwise personal.
import { HttpError, notFound, forbidden, str, int } from './lib/http.js';

export const MAX_PERSONAL = 200;
export const MAX_SHARED = 500;

export function createCanned(db) {
  const out = (r, user) => ({
    id: r.id, title: r.title, body: r.body, shared: r.owner_id === null, mine: r.owner_id === user.id, updatedAt: r.updated_at,
  });

  /** Shared templates plus the user's own, sorted by title. */
  function list(user) {
    return db.prepare('SELECT * FROM canned_responses WHERE owner_id IS NULL OR owner_id=? ORDER BY lower(title), id')
      .all(user.id).map((r) => out(r, user));
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
    const info = db.prepare('INSERT INTO canned_responses(title,body,owner_id,created_by) VALUES(?,?,?,?)')
      .run(title, body, shared ? null : user.id, user.id);
    return out(db.prepare('SELECT * FROM canned_responses WHERE id=?').get(info.lastInsertRowid), user);
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
    db.prepare(`UPDATE canned_responses SET title=?, body=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(v.title ?? r.title, v.body ?? r.body, r.id);
    return out(db.prepare('SELECT * FROM canned_responses WHERE id=?').get(r.id), user);
  }

  function remove(user, id) {
    const r = editable(user, id);
    db.prepare('DELETE FROM canned_responses WHERE id=?').run(r.id);
  }

  return { list, create, update, remove };
}
