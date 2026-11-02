// Wissensdatenbank: Suche, Artikel, Editor, bekannte Fehler, Vorschläge beim Melden
import { api } from '../api.js';
import { h, mount, icon, toast, fmtDate, modal, field } from '../dom.js';
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
    if (params.get('from')) return editor(content, { fromKey: params.get('from') });
    if (!params.has('template')) return templatePicker(content);
    return editor(content, { template: params.get('template') });
  }
  const tm = /^\/kb\/templates\/(new|\d+)$/.exec(path);
  if (tm && state.isAgent) return editor(content, { templateEdit: tm[1] === 'new' ? 'new' : Number(tm[1]) });
  const hist = /^\/kb\/(\d+)\/history(?:\/(\d+))?$/.exec(path);
  if (hist && state.isAgent) return hist[2] ? versionView(content, Number(hist[1]), Number(hist[2])) : history(content, Number(hist[1]));
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
      agent ? h('span.muted', ` · ${t('kb.views', { n: a.views })}`) : null,
      agent && a.version ? h('span.muted', ' · ', h('a', { href: `/kb/${a.id}/history`, 'data-link': '' }, t('kb.ver.link', { v: a.version }))) : null),
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

/** Vorlage für einen neuen Artikel wählen */
async function templatePicker(content) {
  let own = [];
  try { own = (await api.kbTemplates()).templates; } catch { /* egal */ }
  const card = (href, emoji, title, desc) => h('a.kb-tpl-pick', { href, 'data-link': '' }, h('div.kb-tpl-emoji', emoji), h('div', h('div.kb-tpl-title', title), desc ? h('div.kb-tpl-desc', desc) : null));
  mount(content,
    h('div.breadcrumbs', h('a', { href: '/kb', 'data-link': '' }, t('kb.title')), ' / ', t('kb.new')),
    h('div.page-head', h('h1', t('kb.tpl.pick'))),
    h('div.kb-tpl-grid',
      card('/kb/new?template=blank', '📝', t('kb.tpl.blank'), t('kb.tpl.blankHint')),
      builtinTemplates().map((x) => card(`/kb/new?template=builtin:${x.id}`, x.emoji, x.title, x.description))),
    own.length ? [h('h3.kb-tpl-own', t('kb.tpl.own')), h('div.kb-tpl-grid', own.map((x) => card(`/kb/new?template=tpl:${x.id}`, '📄', x.title, x.description)))] : null);
}

/**
 * Editor für Artikel und eigene Vorlagen.
 * opts: { id } Artikel bearbeiten · { fromKey } aus Ticket · { template } neuer Artikel aus Vorlage · { templateEdit: 'new'|id } Vorlage bearbeiten
 */
async function editor(content, opts = {}) {
  const { id = null, fromKey = null } = opts;
  const tplMode = opts.templateEdit !== undefined;
  const tplId = tplMode && opts.templateEdit !== 'new' ? opts.templateEdit : null;
  let a = { title: '', body: '', visibility: 'internal', category: '', description: '' };
  if (id) a = (await api.kbArticle(id)).article;
  else if (fromKey) { const { draft } = await api.kbDraft(fromKey); a = { ...a, ...draft }; }
  else if (tplId) { const { template } = await api.kbTemplate(tplId); a = { ...a, ...template }; }
  else if (opts.template) {
    const [kind, ref] = String(opts.template).split(':');
    if (kind === 'builtin') a.body = builtinTemplates().find((x) => x.id === ref)?.body || '';
    if (kind === 'tpl') { try { a.body = (await api.kbTemplate(ref)).template.body; } catch { /* Vorlage weg → leer */ } }
  }
  const { categories } = tplMode ? { categories: [] } : await api.kb({});
  const key = tplMode ? `helfi.kbtpl.${tplId || 'new'}` : draftKey(id, fromKey);
  const original = { title: a.title, body: a.body, category: a.category, visibility: a.visibility, description: a.description || '' };

  const title = h('input.kb-title-input', { value: a.title, maxLength: tplMode ? 120 : 200, required: true, placeholder: tplMode ? t('kb.tpl.name') : t('kb.f.titleHint'), 'aria-label': t('kb.f.title') });
  const cat = h('input', { value: a.category, maxLength: 60, list: 'kb-cats', placeholder: t('kb.f.category') });
  const desc = h('input', { value: a.description || '', maxLength: 300, placeholder: t('kb.tpl.descHint') });
  const dl = h('datalist', { id: 'kb-cats' }, categories.map((c) => h('option', { value: c.name })));
  let visibility = a.visibility;
  const visBtn = (v) => h(`button.seg${visibility === v ? '.active' : ''}`, { type: 'button', title: t(`kb.visHint.${v}`), onclick: () => { visibility = v; visRow.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.v === v)); onEdit(); }, 'data-v': v }, t(`kb.vis.${v}`));
  const visRow = h('div.segmented', { role: 'group', 'aria-label': t('kb.f.visibility') }, visBtn('internal'), visBtn('public'));
  const status = h('span.kb-save-state.muted.small');
  const note = id ? h('input.kb-note', { maxLength: 200, placeholder: t('kb.notePlaceholder'), 'aria-label': t('kb.note') }) : null;

  const current = () => ({ title: title.value, body: ed.getValue(), category: cat.value, visibility, description: desc.value });
  const dirty = () => {
    const c = current();
    return c.title !== original.title || c.body.trim() !== String(original.body || '').trim()
      || (tplMode ? c.description !== original.description : (c.category !== original.category || c.visibility !== original.visibility));
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
  const cancel = () => navigate(tplMode ? '/kb?tab=templates' : (id ? `/kb/${id}` : '/kb'));
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
    h('button.btn.btn-primary.small', { type: 'button', onclick: () => { title.value = draft.title; cat.value = draft.category || ''; desc.value = draft.description || ''; visibility = draft.visibility || visibility; visRow.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.v === visibility)); ed.setValue(draft.body || ''); banner.remove(); onEdit(); } }, t('kb.draftRestore')),
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
      tplMode ? h('div.kb-edit-meta', desc) : h('div.kb-edit-meta', cat, dl, visRow, h('span.muted.small.kb-vis-hint', t(`kb.visHint.${visibility}`))),
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
