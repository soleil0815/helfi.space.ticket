// Full-text search for tickets (SQLite FTS5, trigrams: also finds parts of words).
// Columns: title · public_text (description, public replies, attachments, tags)
//          internal_text (internal notes – agents only) · people (reporter, assignee, repliers with
//          addresses and login names – agents only) · people_public (only the names users can see too)
// Changes are marked by triggers in search_dirty; the index is caught up before every search.
import { mentionsAsText } from './mentions.js';

const MAX_HITS = 5000;
const SNIPPET = 160;

/** Split search text: words, "exact phrase", -exclude */
export function parseQuery(q) {
  const terms = [];
  // Control characters (e.g. NUL) break the FTS query → treat as whitespace
  for (const m of String(q || '').replace(/[\u0000-\u001f\u007f]/g, ' ').matchAll(/(-?)"([^"]*)"|(-?)([^\s"]+)/g)) {
    const neg = !!(m[1] || m[3]);
    const text = (m[2] ?? m[4] ?? '').replace(/\s+/g, ' ').trim();
    if (!text || (text === '-' && !m[2])) continue;
    terms.push({ text, neg, phrase: m[2] !== undefined });
    if (terms.length >= 12) break;
  }
  return terms;
}

const ftsQuote = (s) => `"${s.replace(/"/g, '""')}"`;
const likeEsc = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;


export function createSearch(db) {
  const getTicket = db.prepare(`SELECT t.id, t.title, t.description, t.labels, t.reporter_email, t.reporter_name,
      r.display_name r_name, r.email r_email, r.username r_user, a.display_name a_name, a.email a_email, a.username a_user
    FROM tickets t LEFT JOIN users r ON r.id=t.reporter_id LEFT JOIN users a ON a.id=t.assignee_id WHERE t.id=?`);
  const getComments = db.prepare(`SELECT c.body, c.internal, c.author_name, c.author_email, u.display_name u_name FROM comments c
    LEFT JOIN users u ON u.id=c.author_id WHERE c.ticket_id=? ORDER BY c.id`);
  const getFiles = db.prepare(`SELECT a.filename, COALESCE(c.internal, 0) internal FROM attachments a LEFT JOIN comments c ON c.id=a.comment_id
    WHERE a.ticket_id=? AND a.draft=0`);
  const del = db.prepare('DELETE FROM ticket_fts WHERE rowid=?');
  const ins = db.prepare('INSERT INTO ticket_fts(rowid, title, public_text, internal_text, people, people_public) VALUES(?,?,?,?,?,?)');
  const dirty = db.prepare('SELECT ticket_id FROM search_dirty LIMIT 2000');
  const clean = db.prepare('DELETE FROM search_dirty WHERE ticket_id=?');
  const join = (xs) => xs.filter(Boolean).join('\n');

  function reindex(id) {
    del.run(id);
    const t = getTicket.get(id);
    if (!t) return;
    const comments = getComments.all(id);
    const files = getFiles.all(id);
    ins.run(id, t.title,
      join([t.description, ...comments.filter((c) => !c.internal).map((c) => mentionsAsText(c.body)), ...files.filter((f) => !f.internal).map((f) => f.filename), t.labels.replace(/,/g, ' ')]),
      join([...comments.filter((c) => c.internal).map((c) => mentionsAsText(c.body)), ...files.filter((f) => f.internal).map((f) => f.filename)]),
      join([t.r_name, t.r_email, t.r_user, t.reporter_name, t.reporter_email, t.a_name, t.a_email, t.a_user,
        ...new Set(comments.filter((c) => !c.internal).flatMap((c) => [c.u_name, c.author_name, c.author_email]))]),
      // What users see in the ticket: display names of reporter, assignee and repliers – no addresses
      join([...new Set([t.r_name || t.reporter_name, t.a_name, ...comments.filter((c) => !c.internal).map((c) => c.u_name || c.author_name)])]
        .filter((n) => n && !String(n).includes('@'))));
  }

  /** apply pending changes to the index (at startup: all tickets) */
  function flush() {
    let n = 0;
    for (;;) {
      const ids = dirty.all().map((r) => r.ticket_id);
      if (!ids.length) return n;
      db.transaction(() => { for (const id of ids) { reindex(id); clean.run(id); } })();
      n += ids.length;
    }
  }

  /**
   * Matches for a search text → { ids: [id …] by relevance, terms: positive search terms } or null (nothing searchable).
   * internal: also search internal notes and people (including addresses and login names) – agents only.
   * Users search title, public text and the visible names (people_public); the column "people"
   * also contains email addresses and login names that are not shown to users.
   */
  function find(q, { internal = false } = {}) {
    const terms = parseQuery(q);
    const pos = terms.filter((x) => !x.neg);
    if (!pos.length) return null;
    flush();
    const long = (x) => x.text.length >= 3; // trigrams need at least three characters
    const cols = internal ? 'title, public_text, internal_text, people, people_public' : 'title, public_text, people_public';
    const all = `(${cols.split(', ').map((c) => `f.${c}`).join(" || ' ' || ")})`;
    const where = []; const args = [];
    const ftsPos = pos.filter(long).map((x) => ftsQuote(x.text));
    const ftsNeg = terms.filter((x) => x.neg && long(x)).map((x) => ftsQuote(x.text));
    if (ftsPos.length) {
      let expr = ftsPos.join(' AND ');
      for (const n of ftsNeg) expr = `(${expr}) NOT ${n}`;
      where.push('ticket_fts MATCH ?');
      args.push(internal ? expr : `{title public_text people_public} : (${expr})`);
    } else {
      for (const n of ftsNeg) { where.push(`${all} NOT LIKE ? ESCAPE '\\'`); args.push(likeEsc(n.slice(1, -1).replace(/""/g, '"'))); }
    }
    // short terms (e.g. "2") as substring
    for (const x of terms.filter((y) => !long(y))) { where.push(`${all} ${x.neg ? 'NOT ' : ''}LIKE ? ESCAPE '\\'`); args.push(likeEsc(x.text)); }
    const order = ftsPos.length ? `ORDER BY bm25(ticket_fts, 10.0, 2.0, ${internal ? '1.5, 3.0' : '0.0, 0.0'}, 3.0)` : 'ORDER BY f.rowid DESC';
    let rows;
    try {
      rows = db.prepare(`SELECT f.rowid id FROM ticket_fts f WHERE ${where.join(' AND ')} ${order} LIMIT ${MAX_HITS}`).all(...args);
    } catch (e) {
      // Unexpected input that FTS5 does not understand: no matches instead of a server error
      if (e?.code?.startsWith?.('SQLITE_') || e?.name === 'SqliteError') rows = [];
      else throw e;
    }
    return { ids: rows.map((r) => r.id), terms: pos.map((x) => x.text), capped: rows.length >= MAX_HITS };
  }

  /** Where is the match? Excerpt from description, reply or attachment if the title does not explain it */
  function snippet(ticketId, terms, { internal = false } = {}) {
    const low = terms.map((x) => x.toLowerCase());
    const t = getTicket.get(ticketId);
    if (!t || low.every((x) => t.title.toLowerCase().includes(x))) return null;
    // Excerpt around the first match (whitespace collapsed)
    const cut = (text) => {
      const sx = String(text).replace(/\s+/g, ' ').trim();
      const l = sx.toLowerCase();
      const at = Math.min(...low.map((x) => { const k = l.indexOf(x); return k < 0 ? Infinity : k; }));
      const from = Number.isFinite(at) ? Math.max(0, at - 50) : 0;
      return `${from > 0 ? '…' : ''}${sx.slice(from, from + SNIPPET).trim()}${from + SNIPPET < sx.length ? '…' : ''}`;
    };
    const hit = (text) => { const l = String(text || '').replace(/\s+/g, ' ').toLowerCase(); return low.some((x) => l.includes(x)); };
    if (hit(t.description)) return { source: 'description', text: cut(t.description) };
    for (const c of getComments.all(ticketId)) {
      if (c.internal && !internal) continue;
      if (hit(mentionsAsText(c.body))) return { source: c.internal ? 'internal' : 'comment', author: c.u_name || c.author_name || c.author_email || null, text: cut(mentionsAsText(c.body)) };
    }
    for (const f of getFiles.all(ticketId)) {
      if (f.internal && !internal) continue;
      if (hit(f.filename)) return { source: 'attachment', text: f.filename };
    }
    return null;
  }

  /**
   * Tickets that share words with a text ("similar tickets"): any of the words, best matches first
   * (title counts most). Only public text – the same for every agent. Returns ticket ids.
   */
  function similar(words, { limit = 30, projectId = null, openOnly = false, createdFrom = null, createdTo = null } = {}) {
    const ws = [...new Set(words.map((w) => String(w).trim()).filter((w) => w.length >= 3))].slice(0, 12);
    if (!ws.length) return [];
    flush();
    // Optional conditions on the ticket are applied BEFORE the limit (otherwise the best hits could all
    // be from other projects or done tickets and the fitting ones would never be seen)
    const where = []; const args = [`{title public_text} : (${ws.map(ftsQuote).join(' OR ')})`];
    if (projectId != null) { where.push('t.project_id=?'); args.push(projectId); }
    if (openOnly) where.push("t.status<>'done'");
    if (createdFrom) { where.push('t.created_at>=?'); args.push(createdFrom); }
    if (createdTo) { where.push('t.created_at<=?'); args.push(createdTo); }
    const join = where.length ? `JOIN tickets t ON t.id=f.rowid` : '';
    try {
      return db.prepare(`SELECT f.rowid id FROM ticket_fts f ${join} WHERE ticket_fts MATCH ? ${where.map((w) => `AND ${w}`).join(' ')}
        ORDER BY bm25(ticket_fts, 10.0, 2.0, 0.0, 0.0, 0.0) LIMIT ?`)
        .all(...args, Math.min(200, limit)).map((r) => r.id);
    } catch (e) {
      if (e?.code?.startsWith?.('SQLITE_') || e?.name === 'SqliteError') return [];
      throw e;
    }
  }

  return { flush, find, snippet, reindex, similar };
}
