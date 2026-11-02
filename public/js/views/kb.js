// Wissensdatenbank: Suche, Artikel, Editor, bekannte Fehler, Vorschläge beim Melden
import { api } from '../api.js';
import { h, mount, icon, toast, fmtDate, modal } from '../dom.js';
import { t } from '../i18n.js';
import { state, navigate, setLeaveGuard } from '../app.js';
import { renderDoc, headings } from '../kbdoc.js';
import { createKbEditor } from '../kbeditor.js';

const visBadge = (v) => h(`span.badge.kb-${v}`, t(`kb.vis.${v}`));

export async function renderKb(content, params, path) {
  const m = /^\/kb\/(\d+)(\/edit)?$/.exec(path);
  if (path === '/kb/new') return editor(content, null, params.get('from'));
  if (m && m[2]) return editor(content, Number(m[1]));
  if (m) return article(content, Number(m[1]));
  return list(content, params);
}

async function list(content, params) {
  const agent = state.isAgent;
  const tab = params.get('tab') === 'known' && agent ? 'known' : 'articles';
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
      h('a.tab', { href: '/kb?tab=known', 'data-link': '', class: tab === 'known' ? 'active' : '' }, t('kb.knownErrors'))) : null,
    tab === 'articles' ? h('div.kb-search-row', icon('search'), search) : null,
    results);
  if (!params.get('q') || document.activeElement === document.body) search.focus();
  search.setSelectionRange(search.value.length, search.value.length);

  if (tab === 'known') {
    const { knownErrors } = await api.knownErrors();
    mount(results, knownErrors.length ? knownErrors.map((k) => h('a.kb-card', { href: `/browse/${k.key}`, 'data-link': '' },
      h('div.kb-card-title', icon('type-problem'), ' ', k.key, ' ', k.title),
      k.workaround ? h('div.kb-card-text', h('strong', t('problem.workaround'), ': '), k.workaround.slice(0, 220)) : null,
      h('div.kb-card-meta', t(`status.${k.status}`)))) : h('p.muted', t('kb.noKnown')));
    return;
  }
  const { articles, categories } = await api.kb({ q, category: cat });
  mount(results,
    categories.length ? h('div.kb-cats',
      h('a.chip', { href: '/kb', 'data-link': '', class: !cat ? 'active' : '' }, t('kb.allCategories')),
      categories.map((c) => h('a.chip', { href: `/kb?category=${encodeURIComponent(c.name)}`, 'data-link': '', class: c.name === cat ? 'active' : '' }, c.name, h('span.count', c.count)))) : null,
    articles.length ? articles.map((a) => h('a.kb-card', { href: `/kb/${a.id}`, 'data-link': '' },
      h('div.kb-card-title', a.title, agent ? visBadge(a.visibility) : null),
      a.excerpt ? h('div.kb-card-text', a.excerpt) : null,
      h('div.kb-card-meta', [a.category, fmtDate(a.updatedAt, false)].filter(Boolean).join(' · ')))) : h('p.muted', q ? t('kb.noResults') : t('kb.empty')));
}

async function article(content, id) {
  const { article: a } = await api.kbArticle(id, true);
  const agent = state.isAgent;
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), a.category ? [' / ', h('a', { href: `/kb?category=${encodeURIComponent(a.category)}`, 'data-link': '' }, a.category)] : null),
    h('div.page-head', h('h1', a.title),
      agent ? h('div.actions',
        h('a.btn', { href: `/kb/${a.id}/edit`, 'data-link': '' }, t('app.edit')),
        h('button.btn.btn-subtle', { type: 'button', onclick: async () => { if (confirm(t('kb.deleteConfirm'))) { await api.kbDelete(a.id); navigate('/kb'); } } }, icon('trash'))) : null),
    h('div.kb-meta', agent ? visBadge(a.visibility) : null,
      h('span.muted', t('kb.updated', { when: fmtDate(a.updatedAt), who: a.author || '—' })),
      agent && a.sourceTicket ? h('span.muted', ' · ', t('kb.source'), ' ', h('a', { href: `/browse/${a.sourceTicket}`, 'data-link': '' }, a.sourceTicket)) : null,
      agent ? h('span.muted', ` · ${t('kb.views', { n: a.views })}`) : null),
    articleBody(a.body),
    !agent ? h('div.kb-help', t('kb.stillNeedHelp'), ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); import('./ticket.js').then((m) => m.openCreateDialog({ title: a.title })); } }, t('kb.reportProblem'))) : null);
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

async function editor(content, id, fromKey = null) {
  let a = { title: '', body: '', visibility: 'internal', category: '' };
  if (id) a = (await api.kbArticle(id)).article;
  else if (fromKey) { const { draft } = await api.kbDraft(fromKey); a = { ...a, ...draft }; }
  const { categories } = await api.kb({});
  const key = draftKey(id, fromKey);
  const original = { title: a.title, body: a.body, category: a.category, visibility: a.visibility };

  const title = h('input.kb-title-input', { value: a.title, maxLength: 200, required: true, placeholder: t('kb.f.titleHint'), 'aria-label': t('kb.f.title') });
  const cat = h('input', { value: a.category, maxLength: 60, list: 'kb-cats', placeholder: t('kb.f.category') });
  const dl = h('datalist', { id: 'kb-cats' }, categories.map((c) => h('option', { value: c.name })));
  let visibility = a.visibility;
  const visBtn = (v) => h(`button.seg${visibility === v ? '.active' : ''}`, { type: 'button', title: t(`kb.visHint.${v}`), onclick: () => { visibility = v; visRow.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.v === v)); onEdit(); }, 'data-v': v }, t(`kb.vis.${v}`));
  const visRow = h('div.segmented', { role: 'group', 'aria-label': t('kb.f.visibility') }, visBtn('internal'), visBtn('public'));
  const status = h('span.kb-save-state.muted.small');

  const current = () => ({ title: title.value, body: ed.getValue(), category: cat.value, visibility });
  const dirty = () => { const c = current(); return c.title !== original.title || c.body.trim() !== String(original.body || '').trim() || c.category !== original.category || c.visibility !== original.visibility; };
  let draftTimer;
  const onEdit = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (dirty()) { writeDraft(key, { ...current(), at: new Date().toISOString() }); status.textContent = t('kb.draftSaved'); } else { writeDraft(key, null); status.textContent = ''; }
    }, 600);
  };
  const ed = createKbEditor({ value: a.body, placeholder: t('kb.ed.placeholder'), onChange: onEdit });
  title.addEventListener('input', onEdit);
  cat.addEventListener('input', onEdit);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ed.focus(); } });

  let saving = false;
  const save = async () => {
    if (saving) return;
    if (!title.value.trim()) { title.focus(); toast(t('kb.titleMissing'), 'error'); return; }
    saving = true;
    const data = { ...current(), sourceTicket: a.sourceTicket || null };
    try {
      const r = id ? await api.kbUpdate(id, data) : await api.kbCreate(data);
      writeDraft(key, null);
      ed.destroy();
      toast(t('app.saved'), 'success');
      navigate(`/kb/${r.article.id}`, { force: true });
    } catch (ex) { toast(ex.message, 'error'); saving = false; }
  };
  const cancel = () => navigate(id ? `/kb/${id}` : '/kb');

  // ungespeicherter Entwurf aus einer früheren Sitzung?
  const draft = readDraft(key);
  const banner = draft && (draft.body !== a.body || draft.title !== a.title) ? h('div.hint-box.kb-draft-banner', icon('info'),
    h('div', t('kb.draftFound', { when: fmtDate(draft.at) })),
    h('span.spacer'),
    h('button.btn.btn-primary.small', { type: 'button', onclick: () => { title.value = draft.title; cat.value = draft.category || ''; visibility = draft.visibility || visibility; visRow.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.v === visibility)); ed.setValue(draft.body || ''); banner.remove(); onEdit(); } }, t('kb.draftRestore')),
    h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { writeDraft(key, null); banner.remove(); } }, t('kb.draftDiscard'))) : null;

  mount(content,
    h('div.kb-edit-head',
      h('div.breadcrumbs', h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), ' / ', id ? t('kb.edit') : t('kb.new')),
      h('span.spacer'), status,
      h('button.btn.btn-subtle', { type: 'button', onclick: cancel }, t('app.cancel')),
      h('button.btn.btn-primary', { type: 'button', onclick: save, title: `${t('app.save')} (Strg+S)` }, id ? t('kb.update') : t('kb.publish'))),
    banner,
    h('div.kb-edit',
      a.sourceTicket && !id ? h('p.muted.small', t('kb.fromTicket', { key: a.sourceTicket })) : null,
      title,
      h('div.kb-edit-meta', cat, dl, visRow, h('span.muted.small', t(`kb.visHint.${visibility}`))),
      ed.el));
  visRow.addEventListener('click', () => { content.querySelector('.kb-edit-meta > .muted').textContent = t(`kb.visHint.${visibility}`); });
  content.querySelector('.kb-edit').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
  setLeaveGuard(dirty);
  if (!a.title) title.focus(); else ed.focus();
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
