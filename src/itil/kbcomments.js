// Comments on knowledge articles: whoever may see the article may comment.
// The article's author and last editor get an email; agents mark comments as done.
import { HttpError, notFound, forbidden, str, int } from '../lib/http.js';
import { isAgent } from '../auth/session.js';
import { log } from '../lib/log.js';
import { mdToText, mdToHtml, mailHtml, MAIL_BODY } from '../markdown.js';

const MAX_PER_ARTICLE = 500;

export function createKbComments(db, kb, { mailer = null, users = null, settings = null, t = null, baseUrl = '' } = {}) {
  const SELECT = `SELECT c.*, u.display_name a_name, u.username a_user, r.display_name r_name FROM kb_comments c
    LEFT JOIN users u ON u.id=c.author_id LEFT JOIN users r ON r.id=c.resolved_by`;
  const out = (c, user) => ({
    id: c.id, body: c.body, format: c.format === 'md' ? 'md' : 'text', createdAt: c.created_at,
    author: c.author_id ? { id: c.author_id, displayName: c.a_name || c.a_user } : null,
    resolved: !!c.resolved, resolvedBy: c.r_name || null, resolvedAt: c.resolved_at,
    canDelete: c.author_id === user.id || user.role === 'admin',
  });

  function list(user, articleId) {
    const a = kb.get(user, articleId); // permissions
    return db.prepare(`${SELECT} WHERE c.article_id=? ORDER BY c.created_at, c.id`).all(a.id).map((c) => out(c, user));
  }

  function add(user, articleId, body, format = 'text') {
    const a = kb.get(user, articleId);
    const text = str(body, 5000).trim();
    if (!text) throw new HttpError(400, 'err.commentEmpty');
    if (db.prepare('SELECT COUNT(*) n FROM kb_comments WHERE article_id=?').get(a.id).n >= MAX_PER_ARTICLE) throw new HttpError(400, 'err.badRequest', 'limit');
    const fmt = format === 'md' ? 'md' : 'text';
    const id = db.prepare('INSERT INTO kb_comments(article_id, author_id, body, format) VALUES(?,?,?,?)').run(a.id, user.id, text, fmt).lastInsertRowid;
    notify(user, a, text, fmt);
    return out(db.prepare(`${SELECT} WHERE c.id=?`).get(id), user);
  }

  const load = (user, cid) => {
    const c = db.prepare(`${SELECT} WHERE c.id=?`).get(int(cid) || 0);
    if (!c) throw notFound();
    kb.get(user, c.article_id); // permissions on the article
    return c;
  };
  function setResolved(user, cid, resolved) {
    if (!isAgent(user)) throw forbidden();
    const c = load(user, cid);
    // Only the article's project people mark comments as done (others may still read and comment public articles)
    if (!kb.canEdit(user, c.article_id)) throw forbidden();
    db.prepare("UPDATE kb_comments SET resolved=?, resolved_by=?, resolved_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=?")
      .run(resolved ? 1 : 0, resolved ? user.id : null, resolved ? 1 : 0, c.id);
    return out(db.prepare(`${SELECT} WHERE c.id=?`).get(c.id), user);
  }
  function remove(user, cid) {
    const c = load(user, cid);
    if (c.author_id !== user.id && user.role !== 'admin') throw forbidden();
    db.prepare('DELETE FROM kb_comments WHERE id=?').run(c.id);
  }

  // Mail to author and last editor (not to the commenter themselves)
  function notify(user, article, text, format = 'text') {
    if (!mailer?.enabled?.() || !t || !users) return;
    const row = db.prepare('SELECT created_by, updated_by FROM kb_articles WHERE id=?').get(article.id);
    const ids = [...new Set([row.created_by, row.updated_by].filter((x) => x && x !== user.id))];
    for (const uid of ids) {
      const to = users.byId(uid);
      if (!to?.active || !to.email || !['agent', 'admin'].includes(to.role)) continue;
      const lang = to.language || settings?.get('general.defaultLanguage') || 'de';
      const vars = { title: article.title, author: user.display_name || user.username, body: (format === 'md' ? mdToText(text, lang, baseUrl) : text).slice(0, 2000), link: `${baseUrl}/kb/${article.id}#comments`, app: settings?.get('general.title') || 'Helfi.Space' };
      const html = format === 'md' ? mailHtml(t(lang, 'mail.kbComment.body', { ...vars, body: MAIL_BODY }), mdToHtml(text, { lang, baseUrl })) : undefined;
      mailer.send({ to: to.email, subject: t(lang, 'mail.kbComment.subject', vars), text: t(lang, 'mail.kbComment.body', vars), html })
        .catch((e) => log.warn('Comment mail failed', { error: e.message }));
    }
  }

  /** open comments per article (for the agents' list) */
  const openCounts = () => new Map(db.prepare('SELECT article_id, COUNT(*) n FROM kb_comments WHERE resolved=0 GROUP BY article_id').all().map((r) => [r.article_id, r.n]));

  return { list, add, setResolved, remove, openCounts };
}
