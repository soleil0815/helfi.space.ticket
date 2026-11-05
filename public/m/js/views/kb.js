// Knowledge base (read-only on the phone): search, categories, recently viewed, most read,
// page tree as drill-down (each page lists its subpages), article view with table of contents
// sheet and comments. Users only get public articles – the API decides.
import { api } from '/js/api.js';
import { h, icon, toast, avatar, fmtDate, relTime, richText } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { renderDoc, headings } from '/js/kbdoc.js';
import { mobileUrlFor } from '/js/uimode.js';
import { go, replaceUrl } from '../router.js';
import { openSheet } from '../sheet.js';
import { pullToRefresh } from '../ptr.js';
import { emptyState, skeletonList, section, chip, chipRow } from '../ui.js';

const RECENT_KEY = 'helfi.m.kbRecent';
const RECENT_MAX = 5;
// Stored with the account id: another account never sees this list (cleared on sign-out, see /js/userdata.js)
export function recentArticles() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || 'null');
    if (!v || v.uid !== state.user?.id || !Array.isArray(v.items)) return [];
    return v.items.filter((x) => x && Number.isInteger(x.id));
  } catch { return []; }
}
const store = (items) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify({ uid: state.user?.id, items })); } catch { /* ignore */ } };
const remember = (a) => store([{ id: a.id, title: a.title }, ...recentArticles().filter((x) => x.id !== a.id)].slice(0, RECENT_MAX));
const forget = (id) => store(recentArticles().filter((x) => x.id !== id));

const kbTitle = () => (state.isAgent ? t('kb.title') : t('kb.titleUser'));

function articleRow(a, { meta = null } = {}) {
  return h('a.m-row.m-kb-row', { href: `/m/kb/${a.id}`, 'data-link': '', 'data-id': String(a.id) },
    h('span.m-row-icon', icon(a.childCount ? 'list' : 'file')),
    h('span.m-row-text',
      h('span.m-row-label', a.title,
        state.isAgent && a.visibility === 'internal' ? h('span.m-kb-lock', { title: t('kb.vis.internal'), 'aria-label': t('kb.vis.internal') }, icon('lock')) : null),
      a.excerpt ? h('span.m-row-hint.m-kb-excerpt', a.excerpt) : null,
      meta ? h('span.m-row-hint', meta) : null),
    icon('chevron-right', 'm-row-chevron'));
}
const group = (title, rows) => h('section.m-group', title ? h('h2.m-group-title', title) : null, h('div.m-group-rows', rows));

// ---------- Start page / search ----------
export async function renderKb(page, ctx) {
  page.title(kbTitle());
  let q = ctx.params.get('q') || '';
  let cat = ctx.params.get('category') || '';
  const input = h('input.m-search-input', { type: 'search', value: q, placeholder: t('kb.searchHint'), 'aria-label': t('kb.search'), enterkeyhint: 'search', autocomplete: 'off' });
  const results = h('div.m-kb-results', skeletonList(3));
  const setUrl = () => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (cat) p.set('category', cat);
    replaceUrl(`/m/kb${p.toString() ? `?${p}` : ''}`);
  };
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { q = input.value.trim(); setUrl(); load().catch(showError); }, 300);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  page.body.replaceChildren(h('div.m-sticky-tools', h('div.m-search', icon('search'), input)), results);
  const showError = (e) => results.replaceChildren(emptyState('warning', t('app.error'), e.message));

  let seq = 0;
  async function load() {
    const mine = ++seq;
    const searching = !!(q || cat);
    const [{ articles, categories }, tree] = await Promise.all([
      api.kb({ q, category: cat }),
      searching ? Promise.resolve(null) : api.kbTree().then((r) => r.tree),
    ]);
    if (mine !== seq) return;
    const cats = categories.length ? chipRow([
      chip(t('kb.allCategories'), { active: !cat, onClick: () => { cat = ''; setUrl(); load().catch(showError); } }),
      ...categories.map((c) => chip(c.name, { active: c.name === cat, count: c.count, onClick: () => { cat = c.name === cat ? '' : c.name; setUrl(); load().catch(showError); } })),
    ], t('kb.allCategories')) : null;
    if (searching) {
      results.replaceChildren(cats || '',
        articles.length
          ? group(q ? t('m.kb.results', { n: articles.length }) : cat, articles.map((a) => articleRow(a, { meta: [a.category, fmtDate(a.updatedAt, false)].filter(Boolean).join(' · ') })))
          : emptyState('search', t('kb.noResults'), t('m.kb.noResultsText')));
      return;
    }
    if (!articles.length && !tree.length) {
      results.replaceChildren(emptyState('book', t('kb.empty'), null));
      return;
    }
    const known = new Set(articles.map((a) => a.id));
    // Recently viewed (this device) – only articles this account can still see
    const recent = recentArticles().filter((x) => known.has(x.id) || inTree(tree, x.id));
    const popular = [...articles].filter((a) => a.views > 0).sort((a, b) => b.views - a.views).slice(0, 5);
    const count = (n) => n.children.length;
    results.replaceChildren(
      cats || '',
      recent.length ? group(t('m.kb.recentViewed'), recent.map((a) => articleRow(a))) : '',
      popular.length ? group(t('m.kb.popular'), popular.map((a) => articleRow(a))) : '',
      tree.length ? group(t('kb.tree.title'), tree.map((n) => articleRow({ ...n, childCount: count(n) }, { meta: count(n) ? t('m.kb.subpages', { n: count(n) }) : null }))) : '',
      group(t('kb.recent'), articles.slice(0, 5).map((a) => articleRow(a, { meta: fmtDate(a.updatedAt, false) }))));
  }
  await load().catch(showError);
  page.refresh = () => load();
  pullToRefresh(page, load);
}

function inTree(nodes, id) {
  for (const n of nodes) if (n.id === id || inTree(n.children, id)) return true;
  return false;
}

// ---------- Article ----------
export async function renderKbArticle(page, ctx) {
  const id = Number(ctx.match[1]);
  page.title(kbTitle());
  page.body.replaceChildren(h('div.m-skeleton-block.m-pad-top', { 'aria-busy': 'true' }, h('div.sk.sk-line.short'), h('div.sk.sk-title'), h('div.sk.sk-line'), h('div.sk.sk-line.mid'), h('div.sk.sk-box')));
  let a;
  try { ({ article: a } = await api.kbArticle(id, true)); } catch (e) { if (e.status === 404) forget(id); throw e; }
  remember(a);
  const agent = state.isAgent;
  page.title(a.title);

  const doc = renderDoc(a.body);
  doc.classList.add('kb-body', 'm-kb-body');
  // Links to tickets and articles stay in the mobile UI
  doc.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link || link.target === '_blank') return;
    const u = new URL(link.href, location.origin);
    if (u.origin !== location.origin) return;
    const m = mobileUrlFor(u.pathname, u.search);
    if (m) { e.preventDefault(); go(m); }
  });
  const hs = headings(doc);
  const tocBtn = hs.length >= 3 ? h('button.m-iconbtn.m-toc-btn', { type: 'button', 'aria-label': t('kb.toc'), onclick: () => openToc(page, doc) }, icon('ed-toc')) : null;
  page.action(tocBtn);

  const crumbs = h('nav.m-kb-crumbs', { 'aria-label': t('m.kb.path') },
    h('a', { href: '/m/kb', 'data-link': '' }, kbTitle()),
    a.path.map((x) => [h('span.m-dot', { 'aria-hidden': 'true' }, '›'), h('a', { href: `/m/kb/${x.id}`, 'data-link': '' }, x.title)]));
  const children = a.children.length ? section(t('kb.tree.children'),
    h('div.m-group-rows', a.children.map((c) => articleRow(c)))) : null;
  const help = !agent ? h('div.m-card.m-kb-help',
    h('p', t('kb.stillNeedHelp')),
    state.boot?.allowSelfService ? h('a.m-btn.m-btn-primary.m-btn-block', { href: `/m/new/report?title=${encodeURIComponent(a.title)}`, 'data-link': '' }, icon('plus'), t('kb.reportProblem')) : null) : null;

  page.body.replaceChildren(h('article.m-kb-article',
    crumbs,
    h('h2.m-kb-title', a.title),
    h('div.m-kb-meta',
      agent ? h(`span.m-kb-vis.${a.visibility}`, a.visibility === 'internal' ? icon('lock') : icon('globe'), t(`kb.vis.${a.visibility}`)) : null,
      a.category ? h('a.m-label', { href: `/m/kb?category=${encodeURIComponent(a.category)}`, 'data-link': '' }, a.category) : null,
      h('span', t('kb.updated', { when: fmtDate(a.updatedAt, false), who: a.author || '—' }))),
    tocBtn ? h('button.m-btn.m-btn-block.m-toc-inline', { type: 'button', onclick: () => openToc(page, doc) }, icon('ed-toc'), t('kb.toc'), h('span.m-muted', String(hs.length)), icon('chevron-right', 'm-push-right')) : null,
    a.body.trim() ? h('div.m-card.m-kb-doc', doc) : null,
    children,
    agent ? h('a.m-btn.m-btn-block.m-kb-edit', { href: `/kb/${a.id}/edit?ui=desktop` }, icon('monitor'), t('m.kb.editDesktop')) : null,
    help,
    commentsSection(a)));
}

/** Table of contents as a sheet: tapping a heading scrolls the page to it */
function openToc(page, doc) {
  const hs = [...doc.querySelectorAll('h1, h2, h3')];
  let target = null;
  const sheet = openSheet({
    title: t('kb.toc'),
    className: 'm-sheet-choices m-sheet-toc',
    content: h('nav.m-toc', { 'aria-label': t('kb.toc') }, hs.map((el) => h(`button.m-toc-item.l${el.tagName[1]}`, {
      type: 'button', onclick: () => { target = el; sheet.close(); },
    }, el.textContent))),
    onClose: () => {
      if (!target) return;
      const sc = page.scroll;
      const top = target.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12;
      sc.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    },
  });
}

/** Comments: read, write (everybody who can read the article, as in the desktop UI), delete own */
function commentsSection(a) {
  const list = h('div.m-kb-comments', skeletonList(1));
  const ta = h('textarea.m-textarea', { rows: 2, maxLength: 5000, placeholder: t('kb.cm.placeholder'), 'aria-label': t('kb.cm.placeholder') });
  const send = h('button.m-btn.m-btn-primary', { type: 'button' }, icon('send'), t('kb.cm.send'));
  let showDone = false;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`; };
  ta.addEventListener('input', grow);
  send.addEventListener('click', async () => {
    if (!ta.value.trim()) { ta.focus(); return; }
    send.disabled = true;
    try {
      await api.kbCommentAdd(a.id, ta.value);
      ta.value = ''; grow();
      toast(t('m.kb.commentSent'), 'success');
      await load();
    } catch (e) { toast(e.message, 'error'); }
    send.disabled = false;
  });
  const item = (c) => h('div.m-kb-cm', { class: c.resolved ? 'resolved' : '' },
    avatar(c.author, 'sm'),
    h('div.m-kb-cm-main',
      h('div.m-kb-cm-head', h('strong', c.author?.displayName || '—'), h('time', { datetime: c.createdAt, title: fmtDate(c.createdAt) }, relTime(c.createdAt)),
        c.resolved ? h('span.m-approval-state.approved', t('kb.cm.doneBy', { who: c.resolvedBy || '—' })) : null,
        h('span.spacer'),
        c.canDelete ? h('button.m-iconbtn.m-kb-cm-del', {
          type: 'button', 'aria-label': t('app.delete'),
          onclick: async () => {
            if (!confirm(t('kb.cm.deleteConfirm'))) return;
            try { await api.kbCommentDelete(c.id); await load(); } catch (e) { toast(e.message, 'error'); }
          },
        }, icon('trash')) : null),
      richText(c.body)));
  async function load() {
    const { comments } = await api.kbComments(a.id);
    const open = comments.filter((c) => !c.resolved);
    const done = comments.filter((c) => c.resolved);
    list.replaceChildren(
      ...(open.length ? open.map(item) : [h('p.m-muted.m-kb-cm-none', done.length ? t('kb.cm.allDone') : t('kb.cm.none'))]),
      done.length ? h('button.m-link', { type: 'button', onclick: () => { showDone = !showDone; load().catch(() => {}); } }, showDone ? t('kb.cm.hideDone') : t('kb.cm.showDone', { n: done.length })) : '',
      ...(showDone ? done.map(item) : []));
  }
  load().catch((e) => list.replaceChildren(h('p.m-muted', e.message)));
  return section(t('kb.cm.title'), h('div.m-card.m-kb-cm-card', list,
    h('div.m-kb-cm-compose', ta, h('div.m-kb-cm-actions', h('span.m-muted', t(state.isAgent ? 'm.kb.cmHint' : 'm.kb.cmHintUser')), send))));
}
