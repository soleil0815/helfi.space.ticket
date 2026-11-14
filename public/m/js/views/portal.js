// Portal in the phone app (users): search, "my requests" counters and the departments; per department
// its offerings, "report something else" (fixed to that project) and its public articles.
import { api } from '/js/api.js';
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { pullToRefresh } from '../ptr.js';
import { section, emptyState, skeletonList, listRow } from '../ui.js';

const deptIcon = (d) => h(`span.m-portal-icon.portal-c-${d.color}`, icon(d.icon));
const canReport = () => state.isAgent || state.boot?.allowSelfService;

export async function renderPortal(page) {
  const first = (state.user.displayName || '').split(' ')[0];
  page.title(t('portal.hello', { name: first }));
  page.body.replaceChildren(skeletonList(3));
  const results = h('div.m-portal-results', { hidden: true, 'aria-live': 'polite' });
  const q = h('input.m-portal-q', { type: 'search', autocomplete: 'off', enterkeyhint: 'search', placeholder: t('portal.searchPlaceholder'), 'aria-label': t('portal.searchLabel') });
  let catalog = null;
  let seq = 0;
  q.addEventListener('input', async () => {
    const my = ++seq;
    const v = q.value.trim();
    if (v.length < 2) { results.hidden = true; return; }
    if (!catalog) catalog = (await api.catalog().catch(() => ({ items: [] }))).items;
    const { articles } = await api.kb({ q: v });
    if (my !== seq) return;
    const words = v.toLowerCase().split(/\s+/);
    const offers = catalog.filter((x) => words.every((w) => `${x.title} ${x.description}`.toLowerCase().includes(w))).slice(0, 5);
    const pub = articles.filter((a) => a.visibility === 'public').slice(0, 6);
    results.hidden = false;
    results.replaceChildren(
      ...(offers.length ? [section(t('portal.resultOffers'), h('div.m-group-rows', offers.map((x) => listRow({ label: x.title, hint: x.project?.name, href: `/m/new/c/${x.id}` }))))] : []),
      ...(pub.length ? [section(t('portal.resultArticles'), h('div.m-group-rows', pub.map((a) => listRow({ icon: 'book', label: a.title, hint: a.project?.name, href: `/m/kb/${a.id}` }))))] : []),
      ...(!offers.length && !pub.length ? [h('p.m-muted', t('portal.noResults'))] : []));
  });
  const load = async () => {
    const data = await api.portal();
    const c = data.counts;
    // The counters count the user's own reports by status: the list behind them shows exactly those
    const stat = (n, label, filter, cls = '') => h(`a.m-stat${cls}`, { href: `/m/requests?filter=${filter}&mine=1`, 'data-link': '' }, h('span.m-stat-n', String(n)), h('span.m-stat-l', label));
    page.body.replaceChildren(
      h('div.m-portal-search', icon('search'), q),
      results,
      section(t('portal.mine'),
        h('div.m-stats.m-portal-stats', stat(c.active, t('portal.count.active'), 'active'), stat(c.waiting, t('portal.count.waiting'), 'waiting', c.waiting ? '.warn' : ''), stat(c.done, t('portal.count.done'), 'done')),
        data.recent[0] ? h('div.m-group-rows', data.recent.slice(0, 2).map((r) => listRow({ label: r.title, hint: `${r.key} · ${r.project} · ${t(`status.${r.status}`)}`, href: `/m/t/${encodeURIComponent(r.key)}` }))) : null),
      data.departments.length
        ? section(t('portal.departments'), h('div.m-group-rows.m-portal-depts', data.departments.map((d) => h('a.m-row', { href: `/m/portal/${d.key.toLowerCase()}`, 'data-link': '', 'data-dept': d.key },
          deptIcon(d), h('span.m-row-text', h('span.m-row-label', d.name), d.description ? h('span.m-row-hint', d.description) : null), icon('chevron-right', 'm-row-chevron')))))
        : (canReport() ? section('', h('a.m-btn.m-btn-primary', { href: '/m/new/report', 'data-link': '' }, icon('plus'), t('portal.report'))) : null));
  };
  await load();
  pullToRefresh(page, load);
}

export async function renderPortalDepartment(page, ctx) {
  const key = String(ctx.match?.[1] || '').toUpperCase();
  page.body.replaceChildren(skeletonList(3));
  const { department: d, offers, faq } = await api.portalDepartment(key);
  page.title(d.name);
  page.body.replaceChildren(
    h('div.m-portal-dept-head', deptIcon(d), d.intro || d.description ? h('p', d.intro || d.description) : null),
    section(t('portal.whatToRequest'),
      offers.length
        ? h('div.m-group-rows', offers.map((x) => listRow({ label: `${x.emoji || '📦'}  ${x.title}`, hint: x.description, href: `/m/new/c/${x.id}` })))
        : emptyState('inbox', t(canReport() ? 'portal.noOffers' : 'portal.noOffersNoReport'), null),
      canReport() ? h('a.m-btn.m-btn-block.m-portal-report', { href: `/m/new/report?project=${encodeURIComponent(d.key)}`, 'data-link': '', 'data-report': '' }, icon('plus'), t('portal.report')) : null),
    faq.length ? section(t('portal.faq'), h('div.m-group-rows', faq.map((a) => listRow({ icon: 'book', label: a.title, href: `/m/kb/${a.id}` })))) : null);
}
