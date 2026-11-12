// Knowledge base: every article belongs to a project. Public articles are read by everyone signed in,
// internal ones only by the project's people (and admins); only the project's people edit, move
// and delete – also public articles. Subpages always have the project of their parent.
import { HttpError, notFound, forbidden, str, int } from '../lib/http.js';
import { isAgent, agentOn, agentProjects } from '../auth/session.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config.js';

/** Markdown text of an article as plain text (for summary and search) */
export function plainText(md) {
  return String(md || '')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^:::\s*\w*\s*$/gm, ' ')
    .replace(/^\s{0,6}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/^-{3,}\s*$/gm, ' ')
    .replace(/(\*\*|__|\+\+|~~|`|\*)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Images: detect the file type from the first bytes, never from what the browser claims
export function imageType(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}
const IMG_TOKEN = /\/api\/kb\/images\/([A-Za-z0-9_-]{16,64})/g;

const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'ein', 'eine', 'nicht', 'mit', 'im', 'in', 'am', 'an', 'auf', 'ist', 'the', 'and', 'or', 'a', 'an', 'not', 'is', 'to', 'of', 'mein', 'meine', 'my', 'geht', 'kein', 'keine']);

export function createKb(db, tickets) {
  /** Works on the project: admins always; articles without a project (none existed) only admins */
  const member = (user, projectId) => !!user && isAgent(user) && agentOn(user, projectId);
  const canRead = (user, a) => a.visibility === 'public' || member(user, a.project_id);
  const raw = (id) => db.prepare('SELECT * FROM kb_articles WHERE id=?').get(int(id) || 0);
  /** Project for a new top-level article when none was chosen: the user's first one, for admins the default project */
  function fallbackProject(user) {
    const mine = agentProjects(user);
    if (Array.isArray(mine) && mine.length) return mine[0];
    const def = db.prepare("SELECT value FROM settings WHERE key='general.defaultProject'").get()?.value;
    let key = '';
    try { key = JSON.parse(def || '""'); } catch { /* not set */ }
    return db.prepare('SELECT id FROM projects WHERE key=? AND archived=0').get(String(key || ''))?.id
      ?? db.prepare('SELECT MIN(id) id FROM projects WHERE archived=0').get()?.id ?? null;
  }
  /** Project (and with it the whole subtree below the article) changes – subpages inherit */
  const setSubtreeProject = (id, projectId) => db.prepare(`WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT a.id FROM kb_articles a JOIN sub ON a.parent_id=sub.id)
    UPDATE kb_articles SET project_id=? WHERE id IN (SELECT id FROM sub)`).run(id, projectId);
  const out = (a, withBody = true) => ({
    id: a.id, title: a.title, ...(withBody ? { body: a.body } : { excerpt: plainText(a.body).slice(0, 180) }),
    visibility: a.visibility, category: a.category, views: a.views, updatedAt: a.updated_at, createdAt: a.created_at,
    author: a.u_name || null, sourceTicket: a.t_key || null, version: a.version ?? undefined, parentId: a.parent_id ?? null,
    project: a.project_id ? { id: a.project_id, key: a.pj_key, name: a.pj_name } : null,
  });
  const SELECT = `SELECT a.*, u.display_name u_name, (p.key || '-' || t.number) t_key, pj.key pj_key, pj.name pj_name,
    (SELECT MAX(version) FROM kb_versions v WHERE v.article_id=a.id) version FROM kb_articles a
    LEFT JOIN projects pj ON pj.id=a.project_id
    LEFT JOIN users u ON u.id=COALESCE(a.updated_by, a.created_by)
    LEFT JOIN tickets t ON t.id=a.source_ticket_id LEFT JOIN projects p ON p.id=t.project_id`;

  const words = (q) => [...new Set(String(q || '').toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 8);

  /** Search: matches in the title count more than in the text */
  function search(user, q = '', { category = '', project = '', limit = 50 } = {}) {
    const rows = db.prepare(`${SELECT} WHERE (? OR a.visibility='public') ${category ? 'AND a.category=?' : ''} ${project ? 'AND pj.key=?' : ''} ORDER BY a.updated_at DESC`)
      .all(isAgent(user) ? 1 : 0, ...(category ? [category] : []), ...(project ? [project] : [])).filter((a) => canRead(user, a));
    const w = words(q);
    if (!w.length) return rows.slice(0, limit).map((a) => out(a, false));
    return rows.map((a) => {
      const ti = a.title.toLowerCase(); const bo = a.body.toLowerCase();
      const score = w.reduce((s, x) => s + (ti.includes(x) ? 3 : 0) + (bo.includes(x) ? 1 : 0), 0);
      return [score, a];
    }).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]).slice(0, limit).map(([, a]) => out(a, false));
  }

  function get(user, id, { count = false } = {}) {
    const a = db.prepare(`${SELECT} WHERE a.id=?`).get(int(id) || 0);
    if (!a || !canRead(user, a)) throw notFound();
    if (count) db.prepare('UPDATE kb_articles SET views=views+1 WHERE id=?').run(a.id);
    const t = treeIndex(user);
    // Path only via visible ancestors; only visible subpages
    const path = []; for (let p = t.parentOf(a.id); p; p = t.parentOf(p)) path.unshift({ id: p, title: t.byId.get(p).title });
    const children = t.childrenOf(a.id).map((c) => ({ id: c.id, title: c.title, visibility: c.visibility }));
    return { ...out(a), parentId: t.parentOf(a.id), path, children, canEdit: member(user, a.project_id) };
  }

  // ---------- Page tree ----------
  /** Visible articles with "effective" parent: nearest visible ancestor (users do not see internal pages) */
  function treeIndex(user) {
    const all = db.prepare('SELECT id, title, parent_id, visibility, category, updated_at, project_id FROM kb_articles').all();
    const rawById = new Map(all.map((x) => [x.id, x]));
    const byId = new Map(all.filter((x) => canRead(user, x)).map((x) => [x.id, x]));
    const parentOf = (id) => {
      const seen = new Set();
      for (let p = rawById.get(id)?.parent_id; p && !seen.has(p); p = rawById.get(p)?.parent_id) { seen.add(p); if (byId.has(p)) return p; }
      return null;
    };
    const kids = new Map();
    for (const x of byId.values()) { const p = parentOf(x.id); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(x); }
    for (const list of kids.values()) list.sort((a, b) => a.title.localeCompare(b.title, 'de'));
    return { byId, parentOf, childrenOf: (id) => kids.get(id) || [] };
  }
  /** whole tree for navigation: [{ id, title, visibility, children: […] }] */
  function tree(user) {
    const t = treeIndex(user);
    // projectId/canEdit: the editor offers only pages of the user's projects as parent
    const build = (id, depth) => t.childrenOf(id).map((x) => ({
      id: x.id, title: x.title, visibility: x.visibility, projectId: x.project_id, canEdit: member(user, x.project_id),
      children: depth < 20 ? build(x.id, depth + 1) : [],
    }));
    return build(null, 0);
  }
  /** Article with all (visible) subpages in reading order – for printing */
  function bundle(user, id) {
    const root = get(user, id);
    const t = treeIndex(user);
    const out2 = [{ ...root, depth: 0 }];
    const walk = (pid, depth) => { for (const c of t.childrenOf(pid)) { if (out2.length >= 200) return; out2.push({ ...get(user, c.id), depth }); walk(c.id, depth + 1); } };
    walk(root.id, 1);
    return out2;
  }
  /** only change the position in the tree (dragging in the page tree) – no new version */
  function move(user, id, parentId) {
    const a = editable(user, id);
    relocate(user, a, parentId);
    return get(user, id);
  }
  /** Article the user may change (else 404 if invisible, 403 if only readable) */
  function editable(user, id) {
    get(user, id);
    const a = raw(id);
    if (!member(user, a.project_id)) throw forbidden();
    return a;
  }
  /** New position in the tree; under another project's page the article (and its subpages) takes that project */
  function relocate(user, a, parentId, projectId = undefined) {
    const parent = checkParent(user, a.id, parentId);
    let target = a.project_id;
    if (parent) target = raw(parent).project_id;
    else if (projectId !== undefined && int(projectId)) target = int(projectId);
    if (target !== a.project_id) {
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(target)) throw new HttpError(400, 'err.kbProject');
      if (!member(user, target)) throw forbidden();
    }
    db.transaction(() => {
      if (parent !== a.parent_id) db.prepare('UPDATE kb_articles SET parent_id=? WHERE id=?').run(parent, a.id);
      if (target !== a.project_id) setSubtreeProject(a.id, target);
    })();
  }
  /** validate new parent: must exist and be the user's to write into, must not be the article itself or one of its descendants */
  function checkParent(user, id, parentId) {
    if (!parentId) return null;
    const p = db.prepare('SELECT id, project_id, visibility FROM kb_articles WHERE id=?').get(int(parentId));
    if (!p || !canRead(user, p)) throw new HttpError(400, 'err.kbParent');
    if (!member(user, p.project_id)) throw forbidden();
    if (id) {
      const seen = new Set();
      for (let x = p.id; x; x = db.prepare('SELECT parent_id FROM kb_articles WHERE id=?').get(x)?.parent_id) {
        if (x === int(id) || seen.has(x)) throw new HttpError(400, 'err.kbParentLoop');
        seen.add(x);
      }
    }
    return p.id;
  }

  function clean(data) {
    const title = str(data.title, 200).trim();
    if (!title) throw new HttpError(400, 'err.titleRequired');
    const visibility = data.visibility === 'public' ? 'public' : 'internal';
    return { title, body: str(data.body, 100000), visibility, category: str(data.category, 60).trim() };
  }

  function create(user, data) {
    if (!isAgent(user)) throw forbidden();
    const d = clean(data);
    let source = null;
    if (data.sourceTicket) source = tickets.load(user, data.sourceTicket).id;
    const parent = checkParent(user, null, data.parentId);
    // Subpages inherit the parent's project; otherwise the chosen one (or the user's first)
    const projectId = parent ? raw(parent).project_id : (int(data.projectId) || fallbackProject(user));
    if (!projectId || !db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new HttpError(400, 'err.kbProject');
    if (!member(user, projectId)) throw forbidden();
    const id = db.prepare('INSERT INTO kb_articles(title, body, visibility, category, source_ticket_id, created_by, updated_by, parent_id, project_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(d.title, d.body, d.visibility, d.category, source, user.id, user.id, parent, projectId).lastInsertRowid;
    if (source) tickets.logActivity(source, user.id, 'kbCreated', null, null, `KB-${id}`);
    addVersion(id, d, user, str(data.note, 200).trim());
    claimImages(id, d.body);
    return get(user, id);
  }

  function update(user, id, data) {
    if (!isAgent(user)) throw forbidden();
    const a = editable(user, id);
    const cur = get(user, id);
    const d = clean(data);
    // Moving within the tree or to another project is not a content change → no version
    if ('parentId' in data || 'projectId' in data) relocate(user, a, 'parentId' in data ? data.parentId : a.parent_id, data.projectId);
    // saved unchanged → no new version, no new date
    if (d.title === cur.title && d.body === cur.body && d.category === cur.category && d.visibility === cur.visibility) return get(user, id);
    db.transaction(() => {
      db.prepare("UPDATE kb_articles SET title=?, body=?, visibility=?, category=?, updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .run(d.title, d.body, d.visibility, d.category, user.id, int(id));
      addVersion(int(id), d, user, str(data.note, 200).trim());
    })();
    claimImages(int(id), d.body);
    return get(user, id);
  }

  // ---------- Versions ----------
  function addVersion(articleId, d, user, note = '') {
    const next = (db.prepare('SELECT MAX(version) v FROM kb_versions WHERE article_id=?').get(articleId).v || 0) + 1;
    db.prepare('INSERT INTO kb_versions(article_id, version, title, body, category, visibility, note, author_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(articleId, next, d.title, d.body, d.category, d.visibility, note, user.id);
    return next;
  }
  const versionOut = (v, withBody) => ({
    version: v.version, title: v.title, category: v.category, visibility: v.visibility, note: v.note, author: v.u_name || null, createdAt: v.created_at,
    size: v.body.length, ...(withBody ? { body: v.body } : {}),
  });
  /** History of an article (agents only) */
  function versions(user, id) {
    editable(user, id);
    return db.prepare('SELECT v.*, u.display_name u_name FROM kb_versions v LEFT JOIN users u ON u.id=v.author_id WHERE v.article_id=? ORDER BY v.version DESC')
      .all(int(id)).map((v) => versionOut(v, false));
  }
  function version(user, id, nr) {
    editable(user, id);
    const v = db.prepare('SELECT v.*, u.display_name u_name FROM kb_versions v LEFT JOIN users u ON u.id=v.author_id WHERE v.article_id=? AND v.version=?').get(int(id), int(nr) || 0);
    if (!v) throw notFound();
    return versionOut(v, true);
  }
  /** Restore an older version – as a new version, the history stays complete */
  function restore(user, id, nr) {
    const v = version(user, id, nr);
    return update(user, id, { title: v.title, body: v.body, category: v.category, visibility: v.visibility, note: `↩ ${v.version}` });
  }

  // ---------- Templates (custom ones; the built-in ones live in the UI) ----------
  const tplOut = (x) => ({ id: x.id, title: x.title, description: x.description, body: x.body, author: x.u_name || null, updatedAt: x.updated_at });
  function templates(user) {
    if (!isAgent(user)) throw forbidden();
    return db.prepare('SELECT t.*, u.display_name u_name FROM kb_templates t LEFT JOIN users u ON u.id=COALESCE(t.updated_by, t.created_by) ORDER BY t.title').all().map(tplOut);
  }
  function template(user, id) {
    if (!isAgent(user)) throw forbidden();
    const x = db.prepare('SELECT t.*, u.display_name u_name FROM kb_templates t LEFT JOIN users u ON u.id=COALESCE(t.updated_by, t.created_by) WHERE t.id=?').get(int(id) || 0);
    if (!x) throw notFound();
    return tplOut(x);
  }
  function saveTemplate(user, id, data) {
    if (!isAgent(user)) throw forbidden();
    const title = str(data.title, 120).trim();
    if (!title) throw new HttpError(400, 'err.titleRequired');
    const vals = [title, str(data.description, 300).trim(), str(data.body, 100000)];
    if (id) {
      template(user, id);
      db.prepare("UPDATE kb_templates SET title=?, description=?, body=?, updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(...vals, user.id, int(id));
      return template(user, id);
    }
    const nid = db.prepare('INSERT INTO kb_templates(title, description, body, created_by, updated_by) VALUES(?,?,?,?,?)').run(...vals, user.id, user.id).lastInsertRowid;
    return template(user, nid);
  }
  function removeTemplate(user, id) {
    template(user, id);
    db.prepare('DELETE FROM kb_templates WHERE id=?').run(int(id));
  }

  function remove(user, id) {
    editable(user, id);
    const imgs = db.prepare('SELECT token FROM kb_images WHERE article_id=?').all(int(id));
    db.transaction(() => {
      // Subpages move up one level
      const parent = db.prepare('SELECT parent_id FROM kb_articles WHERE id=?').get(int(id)).parent_id;
      db.prepare('UPDATE kb_articles SET parent_id=? WHERE parent_id=?').run(parent ?? null, int(id));
      db.prepare('DELETE FROM kb_articles WHERE id=?').run(int(id));
    })();
    for (const i of imgs) dropImage(i.token);
  }

  // ---------- Images ----------
  const imgDir = path.join(paths.attachments, 'kb');
  const imgPath = (token) => path.join(imgDir, token);
  function dropImage(token) {
    db.prepare('DELETE FROM kb_images WHERE token=?').run(token);
    fs.rmSync(imgPath(token), { force: true });
  }
  /** Images that appear in the text now belong to this article */
  function claimImages(articleId, body) {
    const tokens = [...new Set([...String(body).matchAll(IMG_TOKEN)].map((m) => m[1]))];
    const st = db.prepare('UPDATE kb_images SET article_id=? WHERE token=? AND article_id IS NULL');
    for (const tk of tokens) st.run(articleId, tk);
  }
  /** Upload (agents); unsaved drafts expire after two days */
  function addImage(user, { tmpPath, filename }) {
    if (!isAgent(user)) throw forbidden();
    const head = Buffer.alloc(16);
    const fd = fs.openSync(tmpPath, 'r');
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    const type = imageType(head);
    if (!type) throw new HttpError(400, 'err.kbImageType');
    fs.mkdirSync(imgDir, { recursive: true });
    const token = crypto.randomBytes(18).toString('base64url');
    try { fs.renameSync(tmpPath, imgPath(token)); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(tmpPath, imgPath(token)); fs.rmSync(tmpPath, { force: true });
    }
    const size = fs.statSync(imgPath(token)).size;
    db.prepare('INSERT INTO kb_images(token, filename, mime, size, created_by) VALUES(?,?,?,?,?)')
      .run(token, str(filename, 200).replace(/[\\/\0\r\n]/g, '_') || `bild.${type.ext}`, type.mime, size, user.id);
    for (const old of db.prepare("SELECT token FROM kb_images WHERE article_id IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')").all()) dropImage(old.token);
    return { url: `/api/kb/images/${token}`, token };
  }
  /** Serve an image: internal articles and drafts for agents only */
  function imageFile(user, token) {
    const i = db.prepare('SELECT i.*, a.visibility, a.project_id FROM kb_images i LEFT JOIN kb_articles a ON a.id=i.article_id WHERE i.token=?').get(str(token, 80));
    if (!i) throw notFound();
    // Drafts (not saved yet): agents; otherwise whoever may read the article
    if (i.article_id ? !canRead(user, i) : !isAgent(user)) throw notFound();
    return { path: imgPath(i.token), mime: i.mime, filename: i.filename };
  }

  function categories(user, { project = '' } = {}) {
    const n = new Map();
    const rows = db.prepare(`SELECT a.category, a.visibility, a.project_id FROM kb_articles a LEFT JOIN projects p ON p.id=a.project_id WHERE a.category<>'' ${project ? 'AND p.key=?' : ''}`).all(...(project ? [project] : []));
    for (const a of rows) if (canRead(user, a)) n.set(a.category, (n.get(a.category) || 0) + 1);
    return [...n].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([name, count]) => ({ name, count }));
  }
  /** Projects with articles the user can read (filter in the list) and those the user may write into */
  function projects(user) {
    const seen = new Map();
    for (const a of db.prepare('SELECT a.visibility, a.project_id, p.key, p.name FROM kb_articles a JOIN projects p ON p.id=a.project_id').all()) {
      if (canRead(user, a) && !seen.has(a.project_id)) seen.set(a.project_id, { id: a.project_id, key: a.key, name: a.name });
    }
    const writable = isAgent(user) ? db.prepare('SELECT id, key, name FROM projects WHERE archived=0 ORDER BY name').all().filter((p) => member(user, p.id)) : [];
    return { projects: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)), writable };
  }
  /** May change the article (comments marked done, rating notes, versions) */
  const canEdit = (user, id) => { try { editable(user, id); return true; } catch { return false; } };

  /** Suggestion for a new knowledge article from a ticket */
  function draftFromTicket(user, key) {
    if (!isAgent(user)) throw forbidden();
    const row = tickets.load(user, key);
    if (!agentOn(user, row.project_id)) throw forbidden();
    const lastReply = db.prepare(`SELECT c.body FROM comments c JOIN users u ON u.id=c.author_id WHERE c.ticket_id=? AND c.internal=0 AND (u.role IN ('agent','admin') OR u.id IN (SELECT user_id FROM project_agents pa WHERE pa.project_id=(SELECT project_id FROM tickets WHERE id=c.ticket_id))) ORDER BY c.created_at DESC LIMIT 1`).get(row.id);
    const f = row.type === 'problem' ? db.prepare("SELECT name, value FROM ticket_fields WHERE ticket_id=? AND name IN ('rootCause','workaround')").all(row.id) : [];
    const field = (n) => f.find((x) => x.name === n)?.value || '';
    const parts = [];
    if (row.description) parts.push(row.description.trim());
    if (field('rootCause')) parts.push(`**Ursache / Cause:** ${field('rootCause')}`);
    if (field('workaround')) parts.push(`**Workaround:** ${field('workaround')}`);
    if (lastReply) parts.push(`**Lösung / Solution:**\n${lastReply.body.trim()}`);
    return { title: row.title, body: parts.join('\n\n'), sourceTicket: `${row.project_key}-${row.number}`, projectId: row.project_id };
  }

  return { search, get, tree, bundle, move, create, update, remove, categories, projects, canEdit, draftFromTicket, addImage, imageFile, versions, version, restore, templates, template, saveTemplate, removeTemplate };
}
