// Satisfaction survey: after "Resolved" the reporter rates with 1–5 stars (link in the mail or in the ticket).
import crypto from 'node:crypto';
import { HttpError, notFound, forbidden, str, int, isoDate } from '../lib/http.js';
import { randomToken } from '../lib/crypto.js';
import { isAgent } from '../auth/session.js';

const SKIP_TYPES = new Set(['problem', 'change']); // internal, no reporter in the real sense
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export function createSurvey(db, tickets, settings) {
  const enabled = () => !!settings.get('survey.enabled');
  const days = () => Math.min(Math.max(int(settings.get('survey.days')) || 14, 1), 90);
  const rowOf = (ticketId) => db.prepare('SELECT * FROM ticket_ratings WHERE ticket_id=?').get(ticketId);

  /** On every "Resolved": new survey (an earlier rating no longer counts after reopening) */
  tickets.events.on('resolved', ({ ticket }) => {
    if (!enabled() || SKIP_TYPES.has(ticket.type)) return;
    const raw = tickets.rawById(ticket.id);
    if (!raw || raw.status !== 'done') return;
    db.prepare(`INSERT INTO ticket_ratings(ticket_id, assignee_id) VALUES(?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET token_hash=NULL, assignee_id=excluded.assignee_id, rating=NULL, comment='',
      sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), rated_at=NULL`).run(ticket.id, raw.assignee_id || null);
  });

  /** Token for the mail to the reporter; only the hash is stored */
  function issueToken(ticketId) {
    if (!enabled() || !rowOf(ticketId)) return null;
    const token = randomToken(24);
    db.prepare('UPDATE ticket_ratings SET token_hash=? WHERE ticket_id=?').run(hash(token), ticketId);
    return token;
  }

  const expired = (r) => Date.parse(r.sent_at) + days() * 86400_000 < Date.now();
  function byToken(token) {
    const t = str(token, 100);
    if (!/^[\w-]{20,100}$/.test(t)) throw notFound();
    const r = db.prepare('SELECT * FROM ticket_ratings WHERE token_hash=?').get(hash(t));
    if (!r) throw notFound();
    if (expired(r)) throw new HttpError(410, 'err.surveyExpired');
    return r;
  }

  function store(r, rating, comment, userId) {
    const n = int(rating);
    if (!(n >= 1 && n <= 5)) throw new HttpError(400, 'err.badRequest', 'rating');
    const c = comment === undefined ? r.comment : str(comment, 2000).trim();
    const changed = r.rating !== n;
    db.prepare("UPDATE ticket_ratings SET rating=?, comment=?, rated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ticket_id=?").run(n, c, r.ticket_id);
    if (changed) tickets.logActivity(r.ticket_id, userId, 'rated', null, r.rating, n);
  }

  /** Public page: what is being rated? (key and title only) */
  function publicInfo(token) {
    const r = byToken(token);
    const t = tickets.rawById(r.ticket_id);
    return { key: `${t.project_key}-${t.number}`, title: t.title, rating: r.rating, comment: r.comment, app: settings.get('general.title') || 'Helfi.Space' };
  }
  function rateByToken(token, rating, comment) {
    const r = byToken(token);
    const t = tickets.rawById(r.ticket_id);
    store(r, rating, comment, t.reporter_id || null);
    return publicInfo(token);
  }

  /** Rating in the ticket by the signed-in reporter */
  function rateAsUser(user, key, rating, comment) {
    const row = tickets.load(user, key);
    const r = rowOf(row.id);
    if (!r || row.status !== 'done') throw new HttpError(400, 'err.surveyNotOpen');
    if (row.reporter_id !== user.id) throw forbidden();
    if (expired(r)) throw new HttpError(410, 'err.surveyExpired');
    store(r, rating, comment, user.id);
    return tickets.detail(user, row.id);
  }

  tickets.addDetailExtra((user, row) => {
    const r = rowOf(row.id);
    if (!r) return {};
    if (isAgent(user)) return r.rating ? { rating: { value: r.rating, comment: r.comment, ratedAt: r.rated_at } } : {};
    if (row.reporter_id === user.id && row.status === 'done' && !expired(r)) return { rating: { value: r.rating, comment: r.comment, ratedAt: r.rated_at, open: true } };
    return {};
  });

  /** Evaluation for reports */
  function report({ from, to, project } = {}) {
    const f = isoDate(from) || '0000'; const tt = isoDate(to) ? `${isoDate(to)}T23:59:59.999Z` : '9999';
    const p = project ? tickets.projects.get(String(project).toUpperCase()) : null;
    const rows = db.prepare(`SELECT r.*, t.number, t.title, pr.key project_key, u.display_name a_name FROM ticket_ratings r
      JOIN tickets t ON t.id=r.ticket_id JOIN projects pr ON pr.id=t.project_id LEFT JOIN users u ON u.id=r.assignee_id
      WHERE r.sent_at>=? AND r.sent_at<=? ${p ? 'AND t.project_id=?' : ''} ORDER BY r.rated_at DESC`).all(f, tt, ...(p ? [p.id] : []));
    const rated = rows.filter((r) => r.rating);
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x.rating, 0) / xs.length) * 10) / 10 : null);
    const per = new Map();
    for (const r of rated) {
      const k = r.assignee_id || 0;
      if (!per.has(k)) per.set(k, { name: r.a_name || null, items: [] });
      per.get(k).items.push(r);
    }
    return {
      sent: rows.length, answered: rated.length,
      responseRate: rows.length ? Math.round((rated.length / rows.length) * 100) : null,
      average: avg(rated),
      distribution: [1, 2, 3, 4, 5].map((n) => rated.filter((r) => r.rating === n).length),
      byAssignee: [...per.values()].map((x) => ({ name: x.name, count: x.items.length, average: avg(x.items) })).sort((a, b) => b.count - a.count),
      comments: rated.filter((r) => r.comment).slice(0, 20).map((r) => ({ key: `${r.project_key}-${r.number}`, title: r.title, rating: r.rating, comment: r.comment, ratedAt: r.rated_at })),
    };
  }

  return { enabled, issueToken, publicInfo, rateByToken, rateAsUser, report };
}
