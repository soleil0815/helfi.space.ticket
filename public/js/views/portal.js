// Portal for users: "my requests" at a glance, search across offerings and public articles,
// departments (projects shown in the portal) as tiles; per department its catalog, its public
// articles and "report something else" (lands in that project).
import { api } from '../api.js';
import { h, mount, icon, lozenge, relTime } from '../dom.js';
import { t } from '../i18n.js';
import { state } from '../app.js';
import { openCreateDialog } from './ticket.js';

export async function renderPortal(content, path) {
  const key = /^\/portal\/([A-Za-z0-9]+)$/.exec(path)?.[1];
  return key ? department(content, key.toUpperCase()) : start(content);
}

/** Tile symbol in the project's colour */
export const deptIcon = (d, size = '') => h(`span.portal-icon.portal-c-${d.color}${size ? `.portal-icon-${size}` : ''}`, icon(d.icon));
const canReport = () => state.isAgent || state.boot.allowSelfService;

async function start(content) {
  const data = await api.portal();
  const first = (state.user.displayName || '').split(' ')[0];
  const results = h('div.portal-results', { hidden: true, role: 'region', 'aria-live': 'polite', 'aria-label': t('portal.results') });
  const q = h('input#portal-q', { type: 'search', autocomplete: 'off', placeholder: t('portal.searchPlaceholder') });
  q.addEventListener('input', () => search(q.value, results));
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; results.hidden = true; } });
  const c = data.counts;
  const counter = (n, label, status, cls = '') => h(`a.portal-count${cls}`, { href: `/requests?status=${status}`, 'data-link': '' }, h('span.portal-count-n', String(n)), h('span', label));
  mount(content,
    h('section.portal-hero',
      h('h1', t('portal.hello', { name: first })),
      h('label.portal-search-label', { for: 'portal-q' }, t('portal.searchLabel')),
      h('div.portal-search', icon('search'), q),
      results),
    h('section.portal-section', { 'aria-labelledby': 'portal-mine' },
      h('div.portal-section-head', h('h2#portal-mine', t('portal.mine')), h('span.spacer'), h('a', { href: '/requests', 'data-link': '' }, t('portal.showAll'))),
      h('div.portal-counts',
        counter(c.active, t('portal.count.active'), 'open,in_progress'),
        counter(c.waiting, t('portal.count.waiting'), 'waiting', c.waiting ? '.portal-count-warn' : ''),
        counter(c.done, t('portal.count.done'), 'done')),
      data.recent.length
        ? h('div.portal-recent', data.recent.map((r) => h('a.portal-recent-row', { href: `/browse/${r.key}`, 'data-link': '' },
          h('span.portal-recent-key', r.key), h('span.portal-recent-title', r.title), h('span.portal-recent-dept', r.project),
          h('span.portal-recent-status', lozenge(r.status)), h('span.portal-recent-when', relTime(r.updatedAt)))))
        : h('p.muted', t('portal.noRequests'))),
    h('section.portal-section', { 'aria-labelledby': 'portal-depts' },
      h('h2#portal-depts', t('portal.departments')),
      data.departments.length
        ? h('div.portal-depts', data.departments.map((d) => h('a.portal-dept', { href: `/portal/${d.key.toLowerCase()}`, 'data-link': '', 'data-dept': d.key },
          deptIcon(d), h('span.portal-dept-name', d.name),
          d.description ? h('span.portal-dept-desc', d.description) : null,
          h('span.portal-dept-meta', [d.offers ? t(d.offers === 1 ? 'portal.offer1' : 'portal.offers', { n: d.offers }) : '', d.articles ? t(d.articles === 1 ? 'portal.article1' : 'portal.articles', { n: d.articles }) : ''].filter(Boolean).join(' · ')))))
        : null,
      // Without departments: still a way to report something (lands in the default project)
      !data.departments.length && canReport() ? reportCard(null) : null));
}

let seq = 0;
let catalogCache = null;
/** Offerings (all departments) and public articles matching the search */
async function search(value, box) {
  const q = value.trim();
  const my = ++seq;
  if (q.length < 2) { box.hidden = true; return; }
  if (!catalogCache) catalogCache = (await api.catalog().catch(() => ({ items: [] }))).items;
  const { articles } = await api.kb({ q });
  if (my !== seq) return;
  const words = q.toLowerCase().split(/\s+/);
  const offers = catalogCache.filter((x) => words.every((w) => `${x.title} ${x.description}`.toLowerCase().includes(w))).slice(0, 5);
  const pub = articles.filter((a) => a.visibility === 'public').slice(0, 6);
  const row = (href, title, dept) => h('a.portal-result', { href, 'data-link': '' }, h('span.portal-result-title', title), dept ? h('span.muted', ` · ${dept}`) : null);
  box.hidden = false;
  mount(box,
    offers.length ? [h('div.portal-results-head', t('portal.resultOffers')), offers.map((x) => row(`/catalog/${x.id}`, x.title, x.project?.name))] : null,
    pub.length ? [h('div.portal-results-head', t('portal.resultArticles')), pub.map((a) => row(`/kb/${a.id}`, a.title, a.project?.name))] : null,
    !offers.length && !pub.length ? h('p.muted.portal-results-empty', t('portal.noResults')) : null);
}

function reportCard(dept) {
  return h('button.portal-report', { type: 'button', 'data-report': '', onclick: () => openCreateDialog(dept ? { projectId: dept.id, lockProject: true } : {}) },
    h('span.portal-icon.portal-c-blue', icon('plus')),
    h('span.portal-report-text', h('strong', t('portal.report')), h('span', dept ? t('portal.reportHint', { name: dept.name }) : t('portal.reportHintGeneral'))));
}

async function department(content, key) {
  const { department: d, offers, faq } = await api.portalDepartment(key);
  const local = h('input#dept-q', { type: 'search', autocomplete: 'off', placeholder: t('portal.searchIn', { name: d.name }) });
  const grid = h('div.portal-offers');
  const draw = () => {
    const words = local.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = offers.filter((x) => words.every((w) => `${x.title} ${x.description}`.toLowerCase().includes(w)));
    mount(grid, list.length ? list.map((x) => h('a.portal-offer', { href: `/catalog/${x.id}`, 'data-link': '' },
      h('span.portal-offer-emoji', x.emoji || '📦'),
      h('span.portal-offer-text', h('strong', x.title), x.description ? h('span', x.description) : null,
        x.needsApproval ? h('span.portal-offer-approval', icon('check'), t('catalog.needsApproval')) : null)))
      : h('p.muted', words.length ? t('portal.noResults') : t('portal.noOffers')));
  };
  local.addEventListener('input', draw);
  mount(content,
    h('nav.breadcrumbs', { 'aria-label': t('portal.path') }, h('a', { href: '/portal', 'data-link': '' }, t('portal.title')), h('span', ` › ${d.name}`)),
    h('section.portal-dept-head',
      deptIcon(d, 'lg'),
      h('div', h('h1', d.name), d.intro || d.description ? h('p.portal-dept-intro', d.intro || d.description) : null)),
    offers.length > 4 ? h('div.portal-search.portal-search-small', icon('search'), h('label.sr-only', { for: 'dept-q' }, t('portal.searchIn', { name: d.name })), local) : null,
    h('div.portal-dept-body',
      h('section.portal-dept-main', { 'aria-labelledby': 'portal-offers' },
        h('h2#portal-offers', t('portal.whatToRequest')),
        grid,
        canReport() ? reportCard(d) : null),
      faq.length ? h('aside.portal-faq', { 'aria-labelledby': 'portal-faq' },
        h('h2#portal-faq', t('portal.faq')),
        h('div.portal-faq-list', faq.map((a) => h('a', { href: `/kb/${a.id}`, 'data-link': '' }, a.title))),
        h('a.small', { href: `/kb?project=${encodeURIComponent(d.key)}`, 'data-link': '' }, t('portal.allArticles', { name: d.name }))) : null));
  draw();
}

/** Where users land when they open the start page directly (links from mails go straight to their target) */
export const userStartPath = () => (state.boot.userStart === 'requests' ? '/requests' : '/portal');
