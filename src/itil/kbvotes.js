// Rating of knowledge articles: "Was this article helpful?" – one vote per account (helpful / not
// helpful), changeable and withdrawable. With "not helpful" an optional note on what was missing,
// visible to agents only. Agents can reset the rating after reworking an article (notes are kept,
// marked as earlier).
import { HttpError, forbidden, str } from '../lib/http.js';
import { isAgent } from '../auth/session.js';
import { createRateLimit } from '../auth/selfservice.js';

const MAX_FEEDBACK_PER_USER = 5; // per article (current round)

export function createKbVotes(db, kb) {
  const limiter = createRateLimit({ limit: 60, windowMs: 10 * 60 * 1000 });
  const take = (user) => { if (!limiter.take(`kbv|${user.id}`)) throw new HttpError(429, 'err.tooManyRequests'); };

  const counts = (articleId) => db.prepare('SELECT COALESCE(SUM(vote=1),0) up, COALESCE(SUM(vote=-1),0) down FROM kb_votes WHERE article_id=?').get(articleId);

  /** Votes of the article and the own vote (1, -1 or 0) */
  function summary(user, articleId) {
    const c = counts(articleId);
    const mine = db.prepare('SELECT vote FROM kb_votes WHERE article_id=? AND user_id=?').get(articleId, user.id)?.vote || 0;
    const out = { up: c.up, down: c.down, mine };
    if (isAgent(user)) out.feedback = db.prepare('SELECT COUNT(*) n FROM kb_feedback WHERE article_id=? AND archived=0').get(articleId).n;
    return out;
  }

  /** All articles at once (list for agents): Map id → { up, down } */
  function all() {
    return new Map(db.prepare('SELECT article_id id, SUM(vote=1) up, SUM(vote=-1) down FROM kb_votes GROUP BY article_id').all().map((r) => [r.id, { up: r.up, down: r.down }]));
  }

  /** vote: 1, -1 or 0 (withdraw) */
  function vote(user, articleId, value) {
    const a = kb.get(user, articleId); // permissions (users: public articles only)
    const v = Number(value);
    if (![1, -1, 0].includes(v)) throw new HttpError(400, 'err.badRequest', 'vote');
    take(user);
    if (v === 0) db.prepare('DELETE FROM kb_votes WHERE article_id=? AND user_id=?').run(a.id, user.id);
    else {
      db.prepare(`INSERT INTO kb_votes(article_id, user_id, vote) VALUES(?,?,?)
        ON CONFLICT(article_id, user_id) DO UPDATE SET vote=excluded.vote, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(a.id, user.id, v);
    }
    return summary(user, a.id);
  }

  /** What was missing – only together with a "not helpful" vote */
  function addFeedback(user, articleId, body) {
    const a = kb.get(user, articleId);
    const text = str(body, 1000).trim();
    if (!text) throw new HttpError(400, 'err.commentEmpty');
    if (db.prepare('SELECT vote FROM kb_votes WHERE article_id=? AND user_id=?').get(a.id, user.id)?.vote !== -1) throw new HttpError(400, 'err.badRequest', 'vote');
    take(user);
    if (db.prepare('SELECT COUNT(*) n FROM kb_feedback WHERE article_id=? AND user_id=? AND archived=0').get(a.id, user.id).n >= MAX_FEEDBACK_PER_USER) throw new HttpError(429, 'err.tooManyRequests');
    db.prepare('INSERT INTO kb_feedback(article_id, user_id, body) VALUES(?,?,?)').run(a.id, user.id, text);
    return summary(user, a.id);
  }

  /** Notes for agents: current and earlier (before a reset) */
  function feedback(user, articleId) {
    if (!isAgent(user)) throw forbidden();
    const a = kb.get(user, articleId);
    const rows = db.prepare(`SELECT f.id, f.body, f.archived, f.created_at, u.display_name, u.username FROM kb_feedback f
      LEFT JOIN users u ON u.id=f.user_id WHERE f.article_id=? ORDER BY f.created_at DESC, f.id DESC LIMIT 500`).all(a.id);
    const out = (r) => ({ id: r.id, body: r.body, createdAt: r.created_at, author: r.display_name || r.username || null });
    return { current: rows.filter((r) => !r.archived).map(out), earlier: rows.filter((r) => r.archived).map(out) };
  }

  /** After reworking: votes to zero, notes are kept as "earlier" */
  function reset(user, articleId) {
    if (!isAgent(user)) throw forbidden();
    const a = kb.get(user, articleId);
    db.transaction(() => {
      db.prepare('DELETE FROM kb_votes WHERE article_id=?').run(a.id);
      db.prepare('UPDATE kb_feedback SET archived=1 WHERE article_id=? AND archived=0').run(a.id);
    })();
    return summary(user, a.id);
  }

  return { summary, all, vote, addFeedback, feedback, reset };
}
