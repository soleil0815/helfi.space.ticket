// Volltextsuche für Tickets (SQLite FTS5, Trigramme: findet auch Wortteile).
// Spalten: title · public_text (Beschreibung, öffentliche Antworten, Anhänge, Stichwörter)
//          internal_text (interne Notizen – nur für Bearbeiter) · people (Melder, Bearbeiter, Antwortende)
// Änderungen markieren Trigger in search_dirty; vor jeder Suche wird nachgezogen.

const MAX_HITS = 5000;
const SNIPPET = 160;

/** Suchtext zerlegen: Wörter, "genaue Folge", -ausschließen */
export function parseQuery(q) {
  const terms = [];
  for (const m of String(q || '').matchAll(/(-?)"([^"]*)"|(-?)([^\s"]+)/g)) {
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
  const ins = db.prepare('INSERT INTO ticket_fts(rowid, title, public_text, internal_text, people) VALUES(?,?,?,?,?)');
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
      join([t.description, ...comments.filter((c) => !c.internal).map((c) => c.body), ...files.filter((f) => !f.internal).map((f) => f.filename), t.labels.replace(/,/g, ' ')]),
      join([...comments.filter((c) => c.internal).map((c) => c.body), ...files.filter((f) => f.internal).map((f) => f.filename)]),
      join([t.r_name, t.r_email, t.r_user, t.reporter_name, t.reporter_email, t.a_name, t.a_email, t.a_user,
        ...new Set(comments.filter((c) => !c.internal).flatMap((c) => [c.u_name, c.author_name, c.author_email]))]));
  }

  /** ausstehende Änderungen in den Index übernehmen (beim Start: alle Tickets) */
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
   * Treffer für einen Suchtext → { ids: [id …] nach Relevanz, terms: positive Suchbegriffe } oder null (nichts Suchbares).
   * internal: interne Notizen mit durchsuchen (nur Bearbeiter).
   */
  function find(q, { internal = false } = {}) {
    const terms = parseQuery(q);
    const pos = terms.filter((x) => !x.neg);
    if (!pos.length) return null;
    flush();
    const long = (x) => x.text.length >= 3; // Trigramme brauchen mindestens drei Zeichen
    const cols = internal ? 'title, public_text, internal_text, people' : 'title, public_text, people';
    const all = `(${cols.split(', ').map((c) => `f.${c}`).join(" || ' ' || ")})`;
    const where = []; const args = [];
    const ftsPos = pos.filter(long).map((x) => ftsQuote(x.text));
    const ftsNeg = terms.filter((x) => x.neg && long(x)).map((x) => ftsQuote(x.text));
    if (ftsPos.length) {
      let expr = ftsPos.join(' AND ');
      for (const n of ftsNeg) expr = `(${expr}) NOT ${n}`;
      where.push('ticket_fts MATCH ?');
      args.push(internal ? expr : `{title public_text people} : (${expr})`);
    } else {
      for (const n of ftsNeg) { where.push(`${all} NOT LIKE ? ESCAPE '\\'`); args.push(likeEsc(n.slice(1, -1).replace(/""/g, '"'))); }
    }
    // kurze Begriffe (z. B. „2“) als Teiltext
    for (const x of terms.filter((y) => !long(y))) { where.push(`${all} ${x.neg ? 'NOT ' : ''}LIKE ? ESCAPE '\\'`); args.push(likeEsc(x.text)); }
    const order = ftsPos.length ? `ORDER BY bm25(ticket_fts, 10.0, 2.0, ${internal ? '1.5' : '0.0'}, 3.0)` : 'ORDER BY f.rowid DESC';
    const rows = db.prepare(`SELECT f.rowid id FROM ticket_fts f WHERE ${where.join(' AND ')} ${order} LIMIT ${MAX_HITS}`).all(...args);
    return { ids: rows.map((r) => r.id), terms: pos.map((x) => x.text) };
  }

  /** Wo steht der Treffer? Ausschnitt aus Beschreibung, Antwort oder Anhang, wenn der Titel nicht alles erklärt */
  function snippet(ticketId, terms, { internal = false } = {}) {
    const low = terms.map((x) => x.toLowerCase());
    const t = getTicket.get(ticketId);
    if (!t || low.every((x) => t.title.toLowerCase().includes(x))) return null;
    // Ausschnitt rund um den ersten Treffer (Leerraum zusammengefasst)
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
      if (hit(c.body)) return { source: c.internal ? 'internal' : 'comment', author: c.u_name || c.author_name || c.author_email || null, text: cut(c.body) };
    }
    for (const f of getFiles.all(ticketId)) {
      if (f.internal && !internal) continue;
      if (hit(f.filename)) return { source: 'attachment', text: f.filename };
    }
    return null;
  }

  return { flush, find, snippet, reindex };
}
