// Wissensdatenbank: Artikel intern (nur Bearbeiter) oder öffentlich (alle Angemeldeten).
import { HttpError, notFound, forbidden, str, int } from '../lib/http.js';
import { isAgent } from '../auth/session.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config.js';

/** Markdown-Text eines Artikels als schlichter Text (für Kurztext und Suche) */
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

// Bilder: Dateityp an den ersten Bytes erkennen, nie an der Angabe des Browsers
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
  const out = (a, withBody = true) => ({
    id: a.id, title: a.title, ...(withBody ? { body: a.body } : { excerpt: plainText(a.body).slice(0, 180) }),
    visibility: a.visibility, category: a.category, views: a.views, updatedAt: a.updated_at, createdAt: a.created_at,
    author: a.u_name || null, sourceTicket: a.t_key || null, version: a.version ?? undefined,
  });
  const SELECT = `SELECT a.*, u.display_name u_name, (p.key || '-' || t.number) t_key,
    (SELECT MAX(version) FROM kb_versions v WHERE v.article_id=a.id) version FROM kb_articles a
    LEFT JOIN users u ON u.id=COALESCE(a.updated_by, a.created_by)
    LEFT JOIN tickets t ON t.id=a.source_ticket_id LEFT JOIN projects p ON p.id=t.project_id`;

  const words = (q) => [...new Set(String(q || '').toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 8);

  /** Suche: Treffer im Titel zählen mehr als im Text */
  function search(user, q = '', { category = '', limit = 50 } = {}) {
    const agent = isAgent(user);
    const rows = db.prepare(`${SELECT} WHERE (? OR a.visibility='public') ${category ? 'AND a.category=?' : ''} ORDER BY a.updated_at DESC`)
      .all(agent ? 1 : 0, ...(category ? [category] : []));
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
    if (!a || (a.visibility !== 'public' && !isAgent(user))) throw notFound();
    if (count) db.prepare('UPDATE kb_articles SET views=views+1 WHERE id=?').run(a.id);
    return out(a);
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
    const id = db.prepare('INSERT INTO kb_articles(title, body, visibility, category, source_ticket_id, created_by, updated_by) VALUES(?,?,?,?,?,?,?)')
      .run(d.title, d.body, d.visibility, d.category, source, user.id, user.id).lastInsertRowid;
    if (source) tickets.logActivity(source, user.id, 'kbCreated', null, null, `KB-${id}`);
    addVersion(id, d, user, str(data.note, 200).trim());
    claimImages(id, d.body);
    return get(user, id);
  }

  function update(user, id, data) {
    if (!isAgent(user)) throw forbidden();
    const cur = get(user, id);
    const d = clean(data);
    // unverändert gespeichert → keine neue Version, kein neues Datum
    if (d.title === cur.title && d.body === cur.body && d.category === cur.category && d.visibility === cur.visibility) return cur;
    db.transaction(() => {
      db.prepare("UPDATE kb_articles SET title=?, body=?, visibility=?, category=?, updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .run(d.title, d.body, d.visibility, d.category, user.id, int(id));
      addVersion(int(id), d, user, str(data.note, 200).trim());
    })();
    claimImages(int(id), d.body);
    return get(user, id);
  }

  // ---------- Versionen ----------
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
  /** Verlauf eines Artikels (nur Bearbeiter) */
  function versions(user, id) {
    if (!isAgent(user)) throw forbidden();
    get(user, id);
    return db.prepare('SELECT v.*, u.display_name u_name FROM kb_versions v LEFT JOIN users u ON u.id=v.author_id WHERE v.article_id=? ORDER BY v.version DESC')
      .all(int(id)).map((v) => versionOut(v, false));
  }
  function version(user, id, nr) {
    if (!isAgent(user)) throw forbidden();
    get(user, id);
    const v = db.prepare('SELECT v.*, u.display_name u_name FROM kb_versions v LEFT JOIN users u ON u.id=v.author_id WHERE v.article_id=? AND v.version=?').get(int(id), int(nr) || 0);
    if (!v) throw notFound();
    return versionOut(v, true);
  }
  /** Ältere Version zurückholen – als neue Version, der Verlauf bleibt vollständig */
  function restore(user, id, nr) {
    const v = version(user, id, nr);
    return update(user, id, { title: v.title, body: v.body, category: v.category, visibility: v.visibility, note: `↩ ${v.version}` });
  }

  // ---------- Vorlagen (eigene; die mitgelieferten stecken in der Oberfläche) ----------
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
    if (!isAgent(user)) throw forbidden();
    get(user, id);
    const imgs = db.prepare('SELECT token FROM kb_images WHERE article_id=?').all(int(id));
    db.prepare('DELETE FROM kb_articles WHERE id=?').run(int(id));
    for (const i of imgs) dropImage(i.token);
  }

  // ---------- Bilder ----------
  const imgDir = path.join(paths.attachments, 'kb');
  const imgPath = (token) => path.join(imgDir, token);
  function dropImage(token) {
    db.prepare('DELETE FROM kb_images WHERE token=?').run(token);
    fs.rmSync(imgPath(token), { force: true });
  }
  /** Bilder, die im Text vorkommen, gehören ab jetzt zu diesem Artikel */
  function claimImages(articleId, body) {
    const tokens = [...new Set([...String(body).matchAll(IMG_TOKEN)].map((m) => m[1]))];
    const st = db.prepare('UPDATE kb_images SET article_id=? WHERE token=? AND article_id IS NULL');
    for (const tk of tokens) st.run(articleId, tk);
  }
  /** Hochladen (Bearbeiter); nicht gespeicherte Entwürfe verfallen nach zwei Tagen */
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
  /** Bild ausliefern: interne Artikel und Entwürfe nur für Bearbeiter */
  function imageFile(user, token) {
    const i = db.prepare('SELECT i.*, a.visibility FROM kb_images i LEFT JOIN kb_articles a ON a.id=i.article_id WHERE i.token=?').get(str(token, 80));
    if (!i) throw notFound();
    if (!isAgent(user) && (!i.article_id || i.visibility !== 'public')) throw notFound();
    return { path: imgPath(i.token), mime: i.mime, filename: i.filename };
  }

  const categories = (user) => db.prepare(`SELECT category, COUNT(*) n FROM kb_articles WHERE category<>'' AND (? OR visibility='public') GROUP BY category ORDER BY category`)
    .all(isAgent(user) ? 1 : 0).map((r) => ({ name: r.category, count: r.n }));

  /** Vorschlag für einen neuen Wissensartikel aus einem Ticket */
  function draftFromTicket(user, key) {
    if (!isAgent(user)) throw forbidden();
    const row = tickets.load(user, key);
    const lastReply = db.prepare(`SELECT c.body FROM comments c JOIN users u ON u.id=c.author_id WHERE c.ticket_id=? AND c.internal=0 AND u.role IN ('agent','admin') ORDER BY c.created_at DESC LIMIT 1`).get(row.id);
    const f = row.type === 'problem' ? db.prepare("SELECT name, value FROM ticket_fields WHERE ticket_id=? AND name IN ('rootCause','workaround')").all(row.id) : [];
    const field = (n) => f.find((x) => x.name === n)?.value || '';
    const parts = [];
    if (row.description) parts.push(row.description.trim());
    if (field('rootCause')) parts.push(`**Ursache / Cause:** ${field('rootCause')}`);
    if (field('workaround')) parts.push(`**Workaround:** ${field('workaround')}`);
    if (lastReply) parts.push(`**Lösung / Solution:**\n${lastReply.body.trim()}`);
    return { title: row.title, body: parts.join('\n\n'), sourceTicket: `${row.project_key}-${row.number}` };
  }

  return { search, get, create, update, remove, categories, draftFromTicket, addImage, imageFile, versions, version, restore, templates, template, saveTemplate, removeTemplate };
}
