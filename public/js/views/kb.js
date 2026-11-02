// Wissensdatenbank: Suche, Artikel, Editor, bekannte Fehler, Vorschläge beim Melden
import { api } from '../api.js';
import { h, mount, icon, toast, fmtDate, relTime, modal, field, select, dropdown, avatar, richText } from '../dom.js';
import { withEmoji } from '../emoji.js';
import { t } from '../i18n.js';
import { state, navigate, setLeaveGuard } from '../app.js';
import { renderDoc, headings } from '../kbdoc.js';
import { createKbEditor } from '../kbeditor.js';
import { builtinTemplates } from '../kbtemplates.js';
import { diffLines } from '../diff.js';

const visBadge = (v) => h(`span.badge.kb-${v}`, t(`kb.vis.${v}`));

export async function renderKb(content, params, path) {
  const m = /^\/kb\/(\d+)(\/edit)?$/.exec(path);
  if (path === '/kb/new') {
    const parent = Number(params.get('parent')) || null;
    if (params.get('from')) return editor(content, { fromKey: params.get('from') });
    if (!params.has('template')) return templatePicker(content, parent);
    return editor(content, { template: params.get('template'), parent });
  }
  const tm = /^\/kb\/templates\/(new|\d+)$/.exec(path);
  if (tm && state.isAgent) return editor(content, { templateEdit: tm[1] === 'new' ? 'new' : Number(tm[1]) });
  const hist = /^\/kb\/(\d+)\/history(?:\/(\d+))?$/.exec(path);
  if (hist && state.isAgent) return hist[2] ? versionView(content, Number(hist[1]), Number(hist[2])) : history(content, Number(hist[1]));
  const pr = /^\/kb\/(\d+)\/print$/.exec(path);
  if (pr) return printBundle(content, Number(pr[1]));
  const cmp = /^\/kb\/(\d+)\/compare$/.exec(path);
  if (cmp && state.isAgent) return compare(content, Number(cmp[1]), Number(params.get('a')), Number(params.get('b')));
  if (m && m[2]) return editor(content, { id: Number(m[1]) });
  if (m) return article(content, Number(m[1]));
  return list(content, params);
}

async function list(content, params) {
  const agent = state.isAgent;
  const tab = agent && ['known', 'templates'].includes(params.get('tab')) ? params.get('tab') : 'articles';
  const q = params.get('q') || '';
  const cat = params.get('category') || '';
  const search = h('input.kb-search', { type: 'search', value: q, placeholder: t('kb.searchHint'), 'aria-label': t('kb.search') });
  const results = h('div.kb-results', h('div.loading', t('app.loading')));
  const go = (patch) => {
    const p = new URLSearchParams({ ...(q ? { q } : {}), ...(cat ? { category: cat } : {}), ...(tab === 'known' ? { tab } : {}), ...patch });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    navigate(`/kb${p.toString() ? `?${p}` : ''}`, { replace: true });
  };
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => go({ q: search.value.trim() }), 300); });
  mount(content,
    h('div.page-head', h('h1', t('kb.title')),
      agent ? h('a.btn.btn-primary', { href: '/kb/new', 'data-link': '' }, icon('plus'), t('kb.new')) : null),
    agent ? h('div.tabs.kb-tabs',
      h('a.tab', { href: '/kb', 'data-link': '', class: tab === 'articles' ? 'active' : '' }, t('kb.articles')),
      h('a.tab', { href: '/kb?tab=known', 'data-link': '', class: tab === 'known' ? 'active' : '' }, t('kb.knownErrors')),
      h('a.tab', { href: '/kb?tab=templates', 'data-link': '', class: tab === 'templates' ? 'active' : '' }, t('kb.tpl.title'))) : null,
    tab === 'articles' ? h('div.kb-search-row', icon('search'), search) : null,
    results);
  if (!params.get('q') || document.activeElement === document.body) search.focus();
  search.setSelectionRange(search.value.length, search.value.length);

  if (tab === 'templates') {
    const { templates } = await api.kbTemplates();
    mount(results,
      h('p.muted', t('kb.tpl.intro')),
      h('div.form-actions', h('a.btn.btn-subtle', { href: '/kb/templates/new', 'data-link': '' }, icon('plus'), t('kb.tpl.new'))),
      templates.length ? templates.map((x) => h('div.kb-card.kb-tpl-card',
        h('div.kb-card-title', '📄 ', x.title),
        x.description ? h('div.kb-card-text', x.description) : null,
        h('div.kb-card-meta', [x.author, fmtDate(x.updatedAt, false)].filter(Boolean).join(' · ')),
        h('div.kb-tpl-actions',
          h('a.btn.btn-subtle.small', { href: `/kb/new?template=tpl:${x.id}`, 'data-link': '' }, t('kb.tpl.use')),
          h('a.btn.btn-subtle.small', { href: `/kb/templates/${x.id}`, 'data-link': '' }, t('app.edit')),
          h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => { if (!confirm(t('app.confirmDelete'))) return; await api.kbTemplateDelete(x.id); navigate('/kb?tab=templates', { replace: true }); } }, icon('trash'))))) : h('p.muted', t('kb.tpl.none')));
    return;
  }
  if (tab === 'known') {
    const { knownErrors } = await api.knownErrors();
    mount(results, knownErrors.length ? knownErrors.map((k) => h('a.kb-card', { href: `/browse/${k.key}`, 'data-link': '' },
      h('div.kb-card-title', icon('type-problem'), ' ', k.key, ' ', k.title),
      k.workaround ? h('div.kb-card-text', h('strong', t('problem.workaround'), ': '), k.workaround.slice(0, 220)) : null,
      h('div.kb-card-meta', t(`status.${k.status}`)))) : h('p.muted', t('kb.noKnown')));
    return;
  }
  const [{ articles, categories }, { tree }] = await Promise.all([api.kb({ q, category: cat }), q || cat ? { tree: [] } : api.kbTree()]);
  // Startseite: Seitenbaum + zuletzt geändert; bei Suche oder Kategorie die Trefferliste
  const overview = !q && !cat && tree.length;
  mount(results,
    categories.length ? h('div.kb-cats',
      h('a.chip', { href: '/kb', 'data-link': '', class: !cat ? 'active' : '' }, t('kb.allCategories')),
      categories.map((c) => h('a.chip', { href: `/kb?category=${encodeURIComponent(c.name)}`, 'data-link': '', class: c.name === cat ? 'active' : '' }, c.name, h('span.count', c.count)))) : null,
    overview ? h('div.kb-overview',
      h('section.kb-overview-tree', treeHead(tree, null), treeNav(tree)),
      h('section.kb-overview-recent', h('h3', t('kb.recent')), articles.slice(0, 8).map((a) => h('a.kb-card', { href: `/kb/${a.id}`, 'data-link': '' },
        h('div.kb-card-title', a.title, agent ? visBadge(a.visibility) : null, a.openComments ? h('span.kb-cm-count', { title: t('kb.cm.open', { n: a.openComments }) }, '💬 ', String(a.openComments)) : null),
        a.excerpt ? h('div.kb-card-text', a.excerpt) : null,
        h('div.kb-card-meta', [a.category, fmtDate(a.updatedAt, false)].filter(Boolean).join(' · ')))))) : null,
    overview ? null : articles.length ? articles.map((a) => h('a.kb-card', { href: `/kb/${a.id}`, 'data-link': '' },
      h('div.kb-card-title', a.title, agent ? visBadge(a.visibility) : null, a.openComments ? h('span.kb-cm-count', { title: t('kb.cm.open', { n: a.openComments }) }, '💬 ', String(a.openComments)) : null),
      a.excerpt ? h('div.kb-card-text', a.excerpt) : null,
      h('div.kb-card-meta', [a.category, fmtDate(a.updatedAt, false)].filter(Boolean).join(' · ')))) : h('p.muted', q ? t('kb.noResults') : t('kb.empty')));
}

const reloadPage = () => navigate(location.pathname + location.search, { replace: true });

/** Kopf des Seitenbaums; Bearbeiter können hier einen Ordner anlegen */
function treeHead(tree, currentId) {
  return h('div.kb-tree-title', icon('ed-toc'), h('span', t('kb.tree.title')), h('span.spacer'),
    state.isAgent ? h('button.btn.btn-subtle.small.kb-folder-btn', { type: 'button', onclick: () => folderDialog(tree, currentId) }, icon('plus'), t('kb.tree.newFolder')) : null);
}

/** Auswahl „Liegt unter“: eingerückt, optional ohne einen Artikel und seine Unterseiten */
function parentOptions(tree, excludeId = null) {
  const opts = [['', t('kb.tree.noParent')]];
  const walk = (nodes, depth) => { for (const n of nodes) { if (n.id === excludeId) continue; opts.push([n.id, `${'\u2003'.repeat(depth)}${n.title}`]); walk(n.children, depth + 1); } };
  walk(tree, 0);
  return opts;
}

/** Ordner = kurze Sammelseite ohne eigenen Text; ihre Unterseiten werden aufgelistet */
function folderDialog(tree, parentId) {
  const name = h('input', { maxLength: 200, placeholder: t('kb.tree.folderHint') });
  const under = select(parentOptions(tree), parentId || '');
  const vis = select([['public', t('kb.vis.public')], ['internal', t('kb.vis.internal')]], 'public');
  const dlg = modal(t('kb.tree.newFolder'), h('div', h('p.muted.small', t('kb.tree.folderIntro')), field(t('kb.tree.folderName'), name), field(t('kb.tree.parent'), under), field(t('kb.f.visibility'), vis)), {
    footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
      h('button.btn.btn-primary', {
        type: 'button',
        onclick: async () => {
          if (!name.value.trim()) { name.focus(); return; }
          try {
            await api.kbCreate({ title: name.value, body: '', visibility: vis.value, parentId: Number(under.value) || null, note: t('kb.tree.folderNote') });
            dlg.close(); toast(t('kb.tree.folderCreated'), 'success'); reloadPage();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, t('kb.tree.create'))],
  });
}

/** Seitenbaum zum Auf- und Zuklappen; der aktuelle Artikel und seine Vorfahren sind offen.
 *  Bearbeiter ziehen Artikel auf einen anderen (wird Unterseite) oder auf „Oberste Ebene“. */
function treeNav(nodes, currentId = null, openIds = new Set()) {
  const canDrag = state.isAgent && !window.matchMedia('(max-width: 800px)').matches;
  let dragId = null;
  const drop = async (targetId) => {
    if (!dragId || dragId === targetId) return;
    try { await api.kbMove(dragId, targetId); toast(t('kb.tree.moved'), 'success'); reloadPage(); } catch (e) { toast(e.message, 'error'); }
  };
  const dropZone = (el, targetId) => {
    el.addEventListener('dragover', (e) => { if (!dragId || dragId === targetId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop'); });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); drop(targetId); });
  };
  const KEY = 'helfi.kbtree.open';
  let stored = new Set();
  try { stored = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { /* egal */ }
  const remember = () => { try { localStorage.setItem(KEY, JSON.stringify([...stored].slice(-200))); } catch { /* egal */ } };
  const item = (n, depth) => {
    const open = openIds.has(n.id) || stored.has(n.id);
    const sub = n.children.length ? h('ul.kb-tree-list', { hidden: !open }, n.children.map((c) => item(c, depth + 1))) : null;
    const toggle = n.children.length ? h('button.kb-tree-toggle', {
      type: 'button', 'aria-expanded': String(open), 'aria-label': n.title,
      onclick: (e) => {
        const on = sub.hidden;
        sub.hidden = !on; e.currentTarget.setAttribute('aria-expanded', String(on));
        if (on) stored.add(n.id); else stored.delete(n.id);
        remember();
      },
    }, icon('chevron-down')) : h('span.kb-tree-dot');
    const row = h(`div.kb-tree-row${n.id === currentId ? '.current' : ''}`, toggle,
      h('a', { href: `/kb/${n.id}`, 'data-link': '', 'aria-current': n.id === currentId ? 'page' : null, draggable: canDrag ? 'true' : 'false' }, n.title),
      state.isAgent && n.visibility === 'internal' ? h('span.kb-tree-lock', { title: t('kb.vis.internal') }, icon('lock')) : null);
    if (canDrag) {
      row.addEventListener('dragstart', (e) => { dragId = n.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(n.id)); root.classList.add('dragging'); });
      row.addEventListener('dragend', () => { dragId = null; root.classList.remove('dragging'); });
      dropZone(row, n.id);
    }
    return h('li', row, sub);
  };
  const top = canDrag ? h('div.kb-tree-top', icon('arrow-down'), t('kb.tree.dropTop')) : null;
  if (top) dropZone(top, null);
  const root = h('div.kb-tree', h('ul.kb-tree-list.kb-tree-root', nodes.map((n) => item(n, 0))), top,
    canDrag && nodes.length ? h('div.kb-tree-hint.muted.small', t('kb.tree.dragHint')) : null);
  return root;
}

async function article(content, id) {
  const [{ article: a }, { tree }] = await Promise.all([api.kbArticle(id, true), api.kbTree()]);
  const agent = state.isAgent;
  const side = h('aside.kb-tree-side', treeHead(tree, a.id), treeNav(tree, a.id, new Set([...a.path.map((x) => x.id), a.id])));
  const treeBtn = h('button.btn.btn-subtle.kb-tree-btn', { type: 'button', onclick: () => side.classList.toggle('open') }, icon('ed-toc'), t('kb.tree.pages'));
  const printMenu = (e) => {
    if (!a.children.length) { window.print(); return; }
    dropdown(e.currentTarget, [
      { label: t('kb.print.page'), onClick: () => window.print() },
      { label: t('kb.print.withChildren'), onClick: () => navigate(`/kb/${a.id}/print?sub=1`) },
    ], { align: 'right' });
  };
  mount(content,
    h('div.kb-page',
      side,
      h('div.kb-page-main',
        h('div.breadcrumbs', h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), a.path.map((x) => [' / ', h('a', { href: `/kb/${x.id}`, 'data-link': '' }, x.title)])),
        h('div.page-head', h('h1', a.title),
          h('div.actions',
            treeBtn,
            h('button.btn.btn-subtle', { type: 'button', title: t('kb.print.title'), onclick: printMenu }, icon('download'), h('span.btn-label', t('kb.print.title'))),
            agent ? h('a.btn.btn-subtle', { href: `/kb/new?parent=${a.id}`, 'data-link': '', title: t('kb.tree.addChild') }, icon('plus'), h('span.btn-label', t('kb.tree.child'))) : null,
            agent ? h('a.btn', { href: `/kb/${a.id}/edit`, 'data-link': '' }, t('app.edit')) : null,
            agent ? h('button.btn.btn-subtle', {
              type: 'button', 'aria-label': t('app.delete'),
              onclick: async () => {
                if (!confirm(a.children.length ? t('kb.tree.deleteConfirm', { n: a.children.length }) : t('kb.deleteConfirm'))) return;
                await api.kbDelete(a.id); navigate(a.parentId ? `/kb/${a.parentId}` : '/kb');
              },
            }, icon('trash')) : null)),
        h('div.kb-meta', agent ? visBadge(a.visibility) : null,
          a.category ? h('a.chip', { href: `/kb?category=${encodeURIComponent(a.category)}`, 'data-link': '' }, a.category) : null,
          h('span.muted', t('kb.updated', { when: fmtDate(a.updatedAt), who: a.author || '—' })),
          agent && a.sourceTicket ? h('span.muted.no-print', ' · ', t('kb.source'), ' ', h('a', { href: `/browse/${a.sourceTicket}`, 'data-link': '' }, a.sourceTicket)) : null,
          agent ? h('span.muted.no-print', ` · ${t('kb.views', { n: a.views })}`) : null,
          agent && a.version ? h('span.muted.no-print', ' · ', h('a', { href: `/kb/${a.id}/history`, 'data-link': '' }, t('kb.ver.link', { v: a.version }))) : null),
        articleBody(a.body),
        a.children.length ? h('section.kb-children', h('h3', t('kb.tree.children')),
          h('ul', a.children.map((c) => h('li', h('a', { href: `/kb/${c.id}`, 'data-link': '' }, c.title), agent && c.visibility === 'internal' ? h('span.badge.kb-internal', t('kb.vis.internal')) : null)))) : null,
        commentsSection(a),
        !agent ? h('div.kb-help', t('kb.stillNeedHelp'), ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); import('./ticket.js').then((m) => m.openCreateDialog({ title: a.title })); } }, t('kb.reportProblem'))) : null)));
}

/** Kommentare unter einem Artikel */
function commentsSection(a) {
  const box = h('section.kb-comments.no-print', { id: 'comments' }, h('h3', icon('comment'), t('kb.cm.title')), h('div.loading', t('app.loading')));
  let showDone = false;
  const ta = h('textarea', { rows: 3, maxLength: 5000, placeholder: t('kb.cm.placeholder') });
  const send = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      if (!ta.value.trim()) return;
      send.disabled = true;
      try { await api.kbCommentAdd(a.id, ta.value); ta.value = ''; await load(); } catch (e) { toast(e.message, 'error'); }
      send.disabled = false;
    },
  }, t('kb.cm.send'));
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send.click(); } });
  const composer = h('div.kb-cm-composer', avatar(state.user, 'sm'), h('div.kb-cm-input', withEmoji(ta), h('div.form-actions', send, h('span.muted.small', t(state.isAgent ? 'kb.cm.hint' : 'kb.cm.hintUser')))));
  const item = (c) => h(`div.kb-cm${c.resolved ? '.resolved' : ''}`,
    avatar(c.author, 'sm'),
    h('div.kb-cm-main',
      h('div.kb-cm-head', h('strong', c.author?.displayName || '—'), h('span.muted', { title: fmtDate(c.createdAt) }, relTime(c.createdAt)),
        c.resolved ? h('span.badge.kb-public', t('kb.cm.doneBy', { who: c.resolvedBy || '—' })) : null,
        h('span.spacer'),
        state.isAgent ? h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => { try { await api.kbCommentResolve(c.id, !c.resolved); await load(); } catch (e) { toast(e.message, 'error'); } } }, c.resolved ? t('kb.cm.reopen') : [icon('check'), t('kb.cm.done')]) : null,
        c.canDelete ? h('button.btn-icon.small', { type: 'button', title: t('app.delete'), 'aria-label': t('app.delete'), onclick: async () => { if (!confirm(t('kb.cm.deleteConfirm'))) return; try { await api.kbCommentDelete(c.id); await load(); } catch (e) { toast(e.message, 'error'); } } }, icon('trash')) : null),
      richText(c.body)));
  async function load() {
    const { comments } = await api.kbComments(a.id);
    const open = comments.filter((c) => !c.resolved);
    const done = comments.filter((c) => c.resolved);
    mount(box,
      h('h3', icon('comment'), t('kb.cm.title'), comments.length ? h('span.count', String(open.length)) : null),
      open.length ? open.map(item) : h('p.muted', done.length ? t('kb.cm.allDone') : t('kb.cm.none')),
      done.length ? h('button.btn.btn-subtle.small.kb-cm-toggle', { type: 'button', onclick: () => { showDone = !showDone; load(); } }, showDone ? t('kb.cm.hideDone') : t('kb.cm.showDone', { n: done.length })) : null,
      showDone ? done.map(item) : null,
      composer);
    if (location.hash === '#comments') { box.scrollIntoView({ block: 'start' }); history.replaceState({}, '', location.pathname); }
  }
  load().catch((e) => mount(box, h('p.error-text', e.message)));
  return box;
}

/** Druckansicht eines Artikels mit allen Unterseiten (danach „Als PDF speichern“) */
async function printBundle(content, id) {
  const { articles } = await api.kbBundle(id);
  const root = articles[0];
  const stand = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' });
  mount(content,
    h('div.kb-print-bar', icon('info'), h('span', t('kb.print.hint')), h('span.spacer'),
      h('a.btn.btn-subtle', { href: `/kb/${id}`, 'data-link': '' }, t('kb.print.back')),
      h('button.btn.btn-primary', { type: 'button', onclick: () => window.print() }, icon('download'), t('kb.print.now'))),
    h('div.kb-print',
      h('header.kb-print-cover', h('div.kb-print-path', [t('kb.title'), ...root.path.map((x) => x.title)].join(' / ')), h('h1', root.title), h('div.kb-print-meta', t('kb.print.stand', { date: stand, n: articles.length }))),
      articles.length > 1 ? h('nav.kb-print-toc', h('h2', t('kb.toc')), h('ol', articles.slice(1).map((x) => h('li', { style: { marginLeft: `${(x.depth - 1) * 18}px` } }, x.title)))) : null,
      articles.map((x, i) => h(`section.kb-print-article${i ? '.page' : ''}`,
        i ? h(`h1.kb-print-h.d${Math.min(x.depth, 3)}`, x.title) : null,
        h('div.kb-print-meta', t('kb.updated', { when: fmtDate(x.updatedAt), who: x.author || '—' })),
        (() => { const d = renderDoc(x.body); d.classList.add('kb-body'); return d; })()))));
  // nach dem Laden der Bilder gleich den Druckdialog öffnen
  const imgs = [...content.querySelectorAll('img')];
  await Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = r; im.onerror = r; }))));
  setTimeout(() => window.print(), 300);
}

/** Artikeltext mit Inhaltsverzeichnis (ab drei Überschriften) */
function articleBody(md) {
  const doc = renderDoc(md);
  doc.classList.add('kb-body');
  const hs = headings(doc);
  if (hs.length < 3) return h('div.kb-article', h('article', doc));
  const toc = h('nav.kb-toc', { 'aria-label': t('kb.toc') }, h('div.kb-toc-title', icon('ed-toc'), t('kb.toc')),
    hs.map((x) => h(`a.kb-toc-l${x.level}`, { href: `#${x.id}`, onclick: (e) => { e.preventDefault(); document.getElementById(x.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, x.text)));
  return h('div.kb-article.with-toc', h('article', doc), toc);
}

const draftKey = (id, fromKey) => `helfi.kbdraft.${id || 'new'}${fromKey && !id ? `.${fromKey}` : ''}`;
const readDraft = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const writeDraft = (k, v) => { try { if (v) localStorage.setItem(k, JSON.stringify(v)); else localStorage.removeItem(k); } catch { /* egal */ } };

/** Vorlage für einen neuen Artikel wählen */
async function templatePicker(content, parent = null) {
  const pq = parent ? `&parent=${parent}` : '';
  let own = [];
  try { own = (await api.kbTemplates()).templates; } catch { /* egal */ }
  const card = (href, emoji, title, desc) => h('a.kb-tpl-pick', { href, 'data-link': '' }, h('div.kb-tpl-emoji', emoji), h('div', h('div.kb-tpl-title', title), desc ? h('div.kb-tpl-desc', desc) : null));
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), ' / ', t('kb.new')),
    h('div.page-head', h('h1', t('kb.tpl.pick'))),
    h('div.kb-tpl-grid',
      card(`/kb/new?template=blank${pq}`, '📝', t('kb.tpl.blank'), t('kb.tpl.blankHint')),
      builtinTemplates().map((x) => card(`/kb/new?template=builtin:${x.id}${pq}`, x.emoji, x.title, x.description))),
    own.length ? [h('h3.kb-tpl-own', t('kb.tpl.own')), h('div.kb-tpl-grid', own.map((x) => card(`/kb/new?template=tpl:${x.id}${pq}`, '📄', x.title, x.description)))] : null);
}

/**
 * Editor für Artikel und eigene Vorlagen.
 * opts: { id } Artikel bearbeiten · { fromKey } aus Ticket · { template } neuer Artikel aus Vorlage · { templateEdit: 'new'|id } Vorlage bearbeiten
 */
async function editor(content, opts = {}) {
  const { id = null, fromKey = null } = opts;
  const tplMode = opts.templateEdit !== undefined;
  const tplId = tplMode && opts.templateEdit !== 'new' ? opts.templateEdit : null;
  let a = { title: '', body: '', visibility: 'internal', category: '', description: '', parentId: opts.parent || null };
  if (id) a = (await api.kbArticle(id)).article;
  else if (fromKey) { const { draft } = await api.kbDraft(fromKey); a = { ...a, ...draft }; }
  else if (tplId) { const { template } = await api.kbTemplate(tplId); a = { ...a, ...template }; }
  else if (opts.template) {
    const [kind, ref] = String(opts.template).split(':');
    if (kind === 'builtin') a.body = builtinTemplates().find((x) => x.id === ref)?.body || '';
    if (kind === 'tpl') { try { a.body = (await api.kbTemplate(ref)).template.body; } catch { /* Vorlage weg → leer */ } }
  }
  const [{ categories }, { tree }] = tplMode ? [{ categories: [] }, { tree: [] }] : await Promise.all([api.kb({}), api.kbTree()]);
  // Auswahl des übergeordneten Artikels: eingerückt, ohne den Artikel selbst und seine Unterseiten
  const parentSel = select(parentOptions(tree, id), a.parentId || '', { class: 'kb-parent', id: 'kb-parent' });
  const key = tplMode ? `helfi.kbtpl.${tplId || 'new'}` : draftKey(id, fromKey);
  const original = { title: a.title, body: a.body, category: a.category, visibility: a.visibility, description: a.description || '', parentId: a.parentId || null };

  const title = h('input.kb-title-input', { value: a.title, maxLength: tplMode ? 120 : 200, required: true, placeholder: tplMode ? t('kb.tpl.name') : t('kb.f.titleHint'), 'aria-label': t('kb.f.title') });
  const cat = h('input', { id: 'kb-cat', value: a.category, maxLength: 60, list: 'kb-cats', placeholder: t('kb.f.categoryHint') });
  const desc = h('input', { value: a.description || '', maxLength: 300, placeholder: t('kb.tpl.descHint') });
  const dl = h('datalist', { id: 'kb-cats' }, categories.map((c) => h('option', { value: c.name })));
  let visibility = a.visibility;
  const visBtn = (v) => h(`button.seg${visibility === v ? '.active' : ''}`, { type: 'button', title: t(`kb.visHint.${v}`), onclick: () => { visibility = v; visRow.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.v === v)); onEdit(); }, 'data-v': v }, t(`kb.vis.${v}`));
  const visRow = h('div.segmented', { role: 'group', 'aria-label': t('kb.f.visibility') }, visBtn('internal'), visBtn('public'));
  const status = h('span.kb-save-state.muted.small');
  const note = id ? h('input.kb-note', { maxLength: 200, placeholder: t('kb.notePlaceholder'), 'aria-label': t('kb.note') }) : null;

  const current = () => ({ title: title.value, body: ed.getValue(), category: cat.value, visibility, description: desc.value, parentId: Number(parentSel.value) || null });
  const dirty = () => {
    const c = current();
    return c.title !== original.title || c.body.trim() !== String(original.body || '').trim()
      || (tplMode ? c.description !== original.description : (c.category !== original.category || c.visibility !== original.visibility || c.parentId !== original.parentId));
  };
  let draftTimer;
  const onEdit = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (dirty()) { writeDraft(key, { ...current(), at: new Date().toISOString() }); status.textContent = t('kb.draftSaved'); } else { writeDraft(key, null); status.textContent = ''; }
    }, 600);
  };
  const ed = createKbEditor({ value: a.body, placeholder: t('kb.ed.placeholder'), onChange: onEdit });
  for (const el of [title, cat, desc]) el.addEventListener('input', onEdit);
  parentSel.addEventListener('change', onEdit);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ed.focus(); } });

  let saving = false;
  const save = async () => {
    if (saving) return;
    if (!title.value.trim()) { title.focus(); toast(t('kb.titleMissing'), 'error'); return; }
    saving = true;
    try {
      if (tplMode) {
        const c = current();
        const data = { title: c.title, description: c.description, body: c.body };
        if (tplId) await api.kbTemplateUpdate(tplId, data); else await api.kbTemplateCreate(data);
        writeDraft(key, null); ed.destroy(); toast(t('app.saved'), 'success');
        navigate('/kb?tab=templates', { force: true });
        return;
      }
      const data = { ...current(), sourceTicket: a.sourceTicket || null, note: note?.value || '' };
      const r = id ? await api.kbUpdate(id, data) : await api.kbCreate(data);
      writeDraft(key, null);
      ed.destroy();
      toast(t('app.saved'), 'success');
      navigate(`/kb/${r.article.id}`, { force: true });
    } catch (ex) { toast(ex.message, 'error'); saving = false; }
  };
  const cancel = () => navigate(tplMode ? '/kb?tab=templates' : (id ? `/kb/${id}` : (opts.parent ? `/kb/${opts.parent}` : '/kb')));
  // aktuellen Inhalt als eigene Vorlage sichern
  const saveAsTemplate = () => {
    const name = h('input', { value: title.value, maxLength: 120 });
    const d = h('input', { maxLength: 300, placeholder: t('kb.tpl.descHint') });
    const dlg = modal(t('kb.tpl.saveAs'), h('div', h('p.muted.small', t('kb.tpl.saveAsHint')), field(t('kb.tpl.name'), name), field(t('kb.tpl.desc'), d)), {
      footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
        h('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => {
            if (!name.value.trim()) { name.focus(); return; }
            try { await api.kbTemplateCreate({ title: name.value, description: d.value, body: ed.getValue() }); dlg.close(); toast(t('kb.tpl.saved'), 'success'); } catch (e) { toast(e.message, 'error'); }
          },
        }, t('app.save'))],
    });
  };

  // ungespeicherter Entwurf aus einer früheren Sitzung?
  const draft = readDraft(key);
  const banner = draft && (draft.body !== a.body || draft.title !== a.title) ? h('div.hint-box.kb-draft-banner', icon('info'),
    h('div', t('kb.draftFound', { when: fmtDate(draft.at) })),
    h('span.spacer'),
    h('button.btn.btn-primary.small', { type: 'button', onclick: () => { title.value = draft.title; cat.value = draft.category || ''; if ('parentId' in draft) parentSel.value = draft.parentId || ''; desc.value = draft.description || ''; visibility = draft.visibility || visibility; visRow.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.v === visibility)); ed.setValue(draft.body || ''); banner.remove(); onEdit(); } }, t('kb.draftRestore')),
    h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { writeDraft(key, null); banner.remove(); } }, t('kb.draftDiscard'))) : null;

  const crumb = tplMode ? [h('a', { href: '/kb?tab=templates', 'data-link': '' }, t('kb.tpl.title')), ' / ', tplId ? t('kb.tpl.edit') : t('kb.tpl.new')]
    : [h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), ' / ', id ? t('kb.edit') : t('kb.new')];
  mount(content,
    h('div.kb-edit-head',
      h('div.breadcrumbs', crumb),
      h('span.spacer'), status, note,
      !tplMode ? h('button.btn-icon', { type: 'button', title: t('kb.tpl.saveAs'), 'aria-label': t('kb.tpl.saveAs'), onclick: saveAsTemplate }, icon('copy')) : null,
      h('button.btn.btn-subtle', { type: 'button', onclick: cancel }, t('app.cancel')),
      h('button.btn.btn-primary', { type: 'button', onclick: save, title: `${t('app.save')} (Strg+S)` }, tplMode ? t('app.save') : (id ? t('kb.update') : t('kb.publish')))),
    banner,
    h('div.kb-edit',
      a.sourceTicket && !id ? h('p.muted.small', t('kb.fromTicket', { key: a.sourceTicket })) : null,
      title,
      tplMode ? h('div.kb-edit-meta', desc) : h('div.kb-edit-meta',
        h('div.kb-meta-field', h('label', { for: 'kb-parent' }, icon('ed-toc'), t('kb.tree.parent')), parentSel),
        h('div.kb-meta-field', h('label', { for: 'kb-cat' }, t('kb.f.category')), cat, dl),
        h('div.kb-meta-field', h('label', t('kb.f.visibility')), h('div.kb-vis-row', visRow, h('span.muted.small.kb-vis-hint', t(`kb.visHint.${visibility}`))))),
      ed.el));
  visRow.addEventListener('click', () => { const x = content.querySelector('.kb-vis-hint'); if (x) x.textContent = t(`kb.visHint.${visibility}`); });
  content.querySelector('.kb-edit').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
  note?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  setLeaveGuard(dirty);
  if (!a.title) title.focus(); else ed.focus();
}

// ---------- Versionen ----------
async function history(content, id) {
  const [{ article: a }, { versions }] = await Promise.all([api.kbArticle(id), api.kbVersions(id)]);
  let pickA = versions[1]?.version ?? null; let pickB = versions[0]?.version ?? null;
  const radio = (side, v) => h('input', {
    type: 'radio', name: `kb-cmp-${side}`, checked: (side === 'a' ? pickA : pickB) === v.version, 'aria-label': `${side === 'a' ? t('kb.ver.from') : t('kb.ver.to')} ${v.version}`,
    onchange: () => { if (side === 'a') pickA = v.version; else pickB = v.version; },
  });
  const latest = versions[0]?.version;
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), ' / ', h('a', { href: `/kb/${id}`, 'data-link': '' }, a.title)),
    h('div.page-head', h('h1', t('kb.ver.title')),
      versions.length > 1 ? h('button.btn.btn-primary', { type: 'button', onclick: () => { if (pickA && pickB && pickA !== pickB) navigate(`/kb/${id}/compare?a=${Math.min(pickA, pickB)}&b=${Math.max(pickA, pickB)}`); } }, t('kb.ver.compare')) : null),
    h('p.muted', t('kb.ver.intro')),
    h('table.data.kb-versions',
      h('thead', h('tr', h('th', t('kb.ver.from')), h('th', t('kb.ver.to')), h('th', t('kb.ver.version')), h('th', t('kb.ver.when')), h('th', t('kb.ver.who')), h('th', t('kb.note')), h('th', ''))),
      h('tbody', versions.map((v) => h('tr',
        h('td', radio('a', v)), h('td', radio('b', v)),
        h('td', h('a', { href: `/kb/${id}/history/${v.version}`, 'data-link': '' }, `${v.version}`), v.version === latest ? h('span.badge.kb-public', t('kb.ver.current')) : null),
        h('td', fmtDate(v.createdAt)), h('td', v.author || '—'),
        h('td.muted', v.note.startsWith('↩ ') ? t('kb.ver.restoredFrom', { v: v.note.slice(2) }) : v.note),
        h('td', v.version !== latest ? h('button.btn.btn-subtle.small', { type: 'button', onclick: () => restore(id, v.version) }, t('kb.ver.restore')) : null))))));
}

async function restore(id, v) {
  if (!confirm(t('kb.ver.restoreConfirm', { v }))) return;
  try { await api.kbRestore(id, v); toast(t('kb.ver.restored', { v }), 'success'); navigate(`/kb/${id}`); } catch (e) { toast(e.message, 'error'); }
}

async function versionView(content, id, v) {
  const [{ article: a }, { version }] = await Promise.all([api.kbArticle(id), api.kbVersion(id, v)]);
  const isLatest = a.version === version.version;
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), ' / ', h('a', { href: `/kb/${id}`, 'data-link': '' }, a.title), ' / ', h('a', { href: `/kb/${id}/history`, 'data-link': '' }, t('kb.ver.title'))),
    h('div.hint-box.kb-version-banner', icon('info'),
      h('div', t('kb.ver.viewing', { v: version.version, when: fmtDate(version.createdAt), who: version.author || '—' })),
      h('span.spacer'),
      version.version > 1 ? h('a.btn.btn-subtle.small', { href: `/kb/${id}/compare?a=${version.version - 1}&b=${version.version}`, 'data-link': '' }, t('kb.ver.changes')) : null,
      !isLatest ? h('button.btn.btn-primary.small', { type: 'button', onclick: () => restore(id, version.version) }, t('kb.ver.restore')) : null,
      h('a.btn.btn-subtle.small', { href: `/kb/${id}`, 'data-link': '' }, t('kb.ver.toCurrent'))),
    h('div.page-head', h('h1', version.title)),
    h('div.kb-meta', visBadge(version.visibility), version.category ? h('span.muted', version.category) : null),
    articleBody(version.body));
}

async function compare(content, id, va, vb) {
  const [{ article: a }, A, B] = await Promise.all([api.kbArticle(id), api.kbVersion(id, va), api.kbVersion(id, vb)]);
  const x = A.version; const y = B.version;
  const meta = [];
  if (x.title !== y.title) meta.push([t('kb.f.title'), x.title, y.title]);
  if (x.category !== y.category) meta.push([t('kb.f.category'), x.category || '—', y.category || '—']);
  if (x.visibility !== y.visibility) meta.push([t('kb.f.visibility'), t(`kb.vis.${x.visibility}`), t(`kb.vis.${y.visibility}`)]);
  const lines = diffLines(x.body, y.body);
  const changes = lines.filter((l) => l.op !== '=').length;
  // unveränderte Abschnitte zusammenklappen (3 Zeilen Umgebung)
  const keep = new Set();
  lines.forEach((l, i) => { if (l.op !== '=') for (let k = i - 3; k <= i + 3; k++) keep.add(k); });
  const rows = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (l.op === '=' && !keep.has(i)) { skipped++; return; }
    if (skipped) { rows.push(h('div.diff-skip', t('kb.ver.unchanged', { n: skipped }))); skipped = 0; }
    if (l.op === '=') rows.push(h('div.diff-line', l.a || ' '));
    else if (l.op === '-') rows.push(h('div.diff-line.del', h('del', l.a || ' ')));
    else if (l.op === '+') rows.push(h('div.diff-line.ins', h('ins', l.b || ' ')));
    else rows.push(h('div.diff-line.chg', l.words.map((w) => (w.op === '=' ? w.text : h(w.op === '-' ? 'del' : 'ins', w.text)))));
  });
  if (skipped) rows.push(h('div.diff-skip', t('kb.ver.unchanged', { n: skipped })));
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), ' / ', h('a', { href: `/kb/${id}`, 'data-link': '' }, a.title), ' / ', h('a', { href: `/kb/${id}/history`, 'data-link': '' }, t('kb.ver.title'))),
    h('div.page-head', h('h1', t('kb.ver.compareTitle', { a: x.version, b: y.version }))),
    h('p.muted', t('kb.ver.compareMeta', { a: x.version, aw: fmtDate(x.createdAt), au: x.author || '—', b: y.version, bw: fmtDate(y.createdAt), bu: y.author || '—' })),
    h('div.diff-legend', h('del', t('kb.ver.removed')), ' ', h('ins', t('kb.ver.added'))),
    meta.length ? h('table.data.diff-meta', h('tbody', meta.map(([k, o, n]) => h('tr', h('th', k), h('td', h('del', o)), h('td', h('ins', n)))))) : null,
    changes || meta.length ? h('div.diff', rows) : h('p.muted', t('kb.ver.same')));
}

/** Vorschläge beim Melden eines Problems (Dialog „Ticket erstellen“) */
export function kbSuggestions(input) {
  const box = h('div.kb-suggest', { hidden: true });
  let timer; let last = '';
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 4 || q === last) { if (q.length < 4) box.hidden = true; return; }
      last = q;
      try {
        const { articles } = await api.kbSuggest(q);
        box.hidden = !articles.length;
        mount(box, h('div.kb-suggest-head', icon('info'), t('kb.suggest')),
          articles.map((a) => h('a.kb-suggest-item', {
            href: `/kb/${a.id}`,
            onclick: async (e) => {
              e.preventDefault();
              const { article } = await api.kbArticle(a.id, true);
              const dlg = modal(article.title, (() => { const d = renderDoc(article.body); d.classList.add('kb-body'); return d; })(), { footer: [h('span.spacer'), h('button.btn.btn-primary', { type: 'button', onclick: () => dlg.close() }, t('kb.back'))] });
            },
          }, a.title)));
      } catch { box.hidden = true; }
    }, 400);
  });
  return box;
}

/** Knopf im Ticket: Wissensartikel aus diesem Ticket */
export function kbFromTicketButton(tk) {
  return h('a.btn.btn-subtle.small', { href: `/kb/new?from=${encodeURIComponent(tk.key)}`, 'data-link': '', title: t('kb.fromTicketHint') }, icon('file'), t('kb.article'));
}
