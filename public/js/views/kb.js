// Wissensdatenbank: Suche, Artikel, Editor, bekannte Fehler, Vorschläge beim Melden
import { api } from '../api.js';
import { h, mount, icon, toast, field, richText, fmtDate, modal } from '../dom.js';
import { t } from '../i18n.js';
import { state, navigate } from '../app.js';
import { withEmoji } from '../emoji.js';

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
    h('article.kb-body', richText(a.body)),
    !agent ? h('div.kb-help', t('kb.stillNeedHelp'), ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); import('./ticket.js').then((m) => m.openCreateDialog({ title: a.title })); } }, t('kb.reportProblem'))) : null);
}

async function editor(content, id, fromKey = null) {
  let a = { title: '', body: '', visibility: 'internal', category: '' };
  if (id) a = (await api.kbArticle(id)).article;
  else if (fromKey) { const { draft } = await api.kbDraft(fromKey); a = { ...a, ...draft }; }
  const { categories } = await api.kb({});
  const title = h('input', { value: a.title, maxLength: 200, required: true });
  const cat = h('input', { value: a.category, maxLength: 60, list: 'kb-cats' });
  const dl = h('datalist', { id: 'kb-cats' }, categories.map((c) => h('option', { value: c.name })));
  const body = h('textarea', { rows: 18, maxLength: 100000 });
  body.value = a.body;
  const vis = (v) => h('label.radio', h('input', { type: 'radio', name: 'kb-vis', value: v, checked: a.visibility === v }), ' ', t(`kb.vis.${v}`), h('span.muted.small', ` – ${t(`kb.visHint.${v}`)}`));
  const preview = h('div.kb-body.kb-preview', { hidden: true });
  const togglePreview = () => { preview.hidden = !preview.hidden; if (!preview.hidden) mount(preview, richText(body.value)); };
  mount(content,
    h('div.page-head', h('h1', id ? t('kb.edit') : t('kb.new'))),
    h('form.panel.kb-editor', {
      onsubmit: async (e) => {
        e.preventDefault();
        const data = { title: title.value, body: body.value, category: cat.value, visibility: content.querySelector('input[name=kb-vis]:checked')?.value || 'internal', sourceTicket: a.sourceTicket || null };
        try {
          const r = id ? await api.kbUpdate(id, data) : await api.kbCreate(data);
          toast(t('app.saved'), 'success');
          navigate(`/kb/${r.article.id}`);
        } catch (ex) { toast(ex.message, 'error'); }
      },
    },
    a.sourceTicket && !id ? h('p.muted.small', t('kb.fromTicket', { key: a.sourceTicket })) : null,
    field(t('kb.f.title'), title),
    h('div.grid-2', field(t('kb.f.category'), cat), h('div.field', h('label', t('kb.f.visibility')), h('div.radio-col', vis('internal'), vis('public')))), dl,
    field(t('kb.f.body'), withEmoji(body), t('kb.bodyHint')),
    preview,
    h('div.form-actions',
      h('button.btn.btn-primary', { type: 'submit' }, t('app.save')),
      h('button.btn.btn-subtle', { type: 'button', onclick: togglePreview }, t('kb.preview')),
      h('a.btn.btn-subtle', { href: id ? `/kb/${id}` : '/kb', 'data-link': '' }, t('app.cancel')))));
  title.focus();
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
              const dlg = modal(article.title, h('div.kb-body', richText(article.body)), { footer: [h('span.spacer'), h('button.btn.btn-primary', { type: 'button', onclick: () => dlg.close() }, t('kb.back'))] });
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
