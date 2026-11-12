// Portal for users: "my requests" at a glance and the departments (projects shown in the portal)
// with their service offerings and public articles. Agents and admins may open it too.
import { notFound, str } from './lib/http.js';

// Choices in the project dialog – unknown values fall back to the defaults
export const PORTAL_ICONS = ['monitor', 'home', 'file', 'sliders', 'users', 'mail', 'book', 'key', 'server', 'globe', 'shield', 'smartphone', 'coffee', 'star'];
export const PORTAL_COLORS = ['blue', 'orange', 'green', 'purple', 'red'];

export function createPortal(db, { catalog, kb }) {
  const dept = (p, counts = {}) => ({
    key: p.key, name: p.name, description: p.portal_desc || '', intro: p.portal_intro || '',
    icon: PORTAL_ICONS.includes(p.portal_icon) ? p.portal_icon : 'inbox',
    color: PORTAL_COLORS.includes(p.portal_color) ? p.portal_color : 'blue',
    ...counts,
  });
  const shown = () => db.prepare('SELECT * FROM projects WHERE archived=0 AND portal_show=1 ORDER BY portal_sort, lower(name)').all();

  /** Start page: counters and the latest of the user's own requests, plus the departments */
  function overview(user) {
    const c = db.prepare(`SELECT SUM(status IN ('open','in_progress')) active, SUM(status='waiting') waiting, SUM(status='done') done
      FROM tickets WHERE reporter_id=?`).get(user.id);
    const recent = db.prepare(`SELECT t.number, t.title, t.status, t.updated_at, p.key, p.name FROM tickets t JOIN projects p ON p.id=t.project_id
      WHERE t.reporter_id=? ORDER BY (t.status='done'), t.updated_at DESC LIMIT 5`).all(user.id)
      .map((r) => ({ key: `${r.key}-${r.number}`, title: r.title, status: r.status, project: r.name, updatedAt: r.updated_at }));
    const offers = new Map();
    for (const x of catalog.list(user)) if (x.project) offers.set(x.project.key, (offers.get(x.project.key) || 0) + 1);
    const articles = new Map();
    for (const a of kb.search(user, '', { limit: 100000 })) if (a.visibility === 'public' && a.project) articles.set(a.project.key, (articles.get(a.project.key) || 0) + 1);
    return {
      counts: { active: c.active || 0, waiting: c.waiting || 0, done: c.done || 0 },
      recent,
      departments: shown().map((p) => dept(p, { offers: offers.get(p.key) || 0, articles: articles.get(p.key) || 0 })),
    };
  }

  /** One department: its offerings and its public articles */
  function department(user, key) {
    const p = db.prepare('SELECT * FROM projects WHERE key=? AND archived=0 AND portal_show=1').get(str(key, 20).toUpperCase());
    if (!p) throw notFound();
    const offers = catalog.list(user).filter((x) => x.project?.key === p.key);
    // Latest changed public articles first
    const faq = kb.search(user, '', { project: p.key, limit: 100000 }).filter((a) => a.visibility === 'public')
      .slice(0, 8).map((a) => ({ id: a.id, title: a.title }));
    return { department: { ...dept(p), id: p.id }, offers, faq };
  }

  return { overview, department };
}
