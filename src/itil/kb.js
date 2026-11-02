// Wissensdatenbank: Artikel intern (nur Bearbeiter) oder öffentlich (alle Angemeldeten).
import { HttpError, notFound, forbidden, str, int } from '../lib/http.js';
import { isAgent } from '../auth/session.js';

const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'ein', 'eine', 'nicht', 'mit', 'im', 'in', 'am', 'an', 'auf', 'ist', 'the', 'and', 'or', 'a', 'an', 'not', 'is', 'to', 'of', 'mein', 'meine', 'my', 'geht', 'kein', 'keine']);

export function createKb(db, tickets) {
  const out = (a, withBody = true) => ({
    id: a.id, title: a.title, ...(withBody ? { body: a.body } : { excerpt: a.body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 180) }),
    visibility: a.visibility, category: a.category, views: a.views, updatedAt: a.updated_at, createdAt: a.created_at,
    author: a.u_name || null, sourceTicket: a.t_key || null,
  });
  const SELECT = `SELECT a.*, u.display_name u_name, (p.key || '-' || t.number) t_key FROM kb_articles a
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
    return get(user, id);
  }

  function update(user, id, data) {
    if (!isAgent(user)) throw forbidden();
    get(user, id);
    const d = clean(data);
    db.prepare("UPDATE kb_articles SET title=?, body=?, visibility=?, category=?, updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(d.title, d.body, d.visibility, d.category, user.id, int(id));
    return get(user, id);
  }

  function remove(user, id) {
    if (!isAgent(user)) throw forbidden();
    get(user, id);
    db.prepare('DELETE FROM kb_articles WHERE id=?').run(int(id));
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

  return { search, get, create, update, remove, categories, draftFromTicket };
}
