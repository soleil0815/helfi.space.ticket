// "＋": report a problem (title, description, photos/files; agents also project, type, priority),
// service catalog (tiles → form with the item's fields) and knowledge suggestions while typing.
// Same API calls and choices as the desktop "Create" dialog and catalog; the server decides.
import { api } from '/js/api.js';
import { h, icon, toast, typeIcon, priorityIcon, fmtSize, avatar } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { typesFor } from '/js/types.js';
import { renderDoc } from '/js/kbdoc.js';
import { go, dataChanged } from '../router.js';
import { openSheet } from '../sheet.js';
import { emptyState } from '../ui.js';
import { PRIOS, openReporterSheet } from '../actions.js';
import { downscale, uploadDraft, isPicture, pickFiles, MAX_FILES } from '../files.js';

// Unsent report: per account (never shown to another account, see /js/userdata.js)
const draftKey = (uid) => `helfi.m.newTicket.${uid}`;
const readDraft = () => {
  const uid = state.user?.id;
  if (!uid) return null;
  try { const d = JSON.parse(sessionStorage.getItem(draftKey(uid)) || 'null'); return d && d.uid === uid ? d : null; } catch { return null; }
};
const writeDraft = (d) => {
  const uid = state.user?.id;
  if (!uid) return;
  try {
    if (d && (d.title || d.description)) sessionStorage.setItem(draftKey(uid), JSON.stringify({ ...d, uid }));
    else sessionStorage.removeItem(draftKey(uid));
  } catch { /* storage blocked: the text just is not kept */ }
};

const canCreate = () => state.isAgent || state.boot?.allowSelfService;
const notAllowed = (page) => {
  page.title(t('m.newTicket'));
  page.body.replaceChildren(emptyState('lock', t('m.new.offTitle'), t('m.new.offText')));
};

let fieldSeq = 0;
/** Label + input; required fields get a marker */
function fieldEl(label, input, { hint = null, required = false } = {}) {
  const id = input.id || `nf-${++fieldSeq}`;
  input.id = id;
  return h('div.m-field', h('label', { for: id }, label, required ? h('span.m-req', { 'aria-hidden': 'true' }, ' *') : null), input, hint ? h('div.m-field-hint', hint) : null);
}

// ---------- "＋": chooser ----------
export async function renderNew(page) {
  page.title(t('m.new.title'));
  if (!canCreate()) return notAllowed(page);
  if (!state.boot?.hasCatalog) return renderReport(page, { params: new URLSearchParams() }, { replaceTitle: true });
  page.body.replaceChildren(h('div.m-tiles', { 'aria-busy': 'true' }, [1, 2, 3].map(() => h('div.m-tile.m-skeleton', h('div.sk.sk-line.short'), h('div.sk.sk-line')))));
  let items = [];
  try { ({ items } = await api.catalog()); } catch { /* the problem form still works */ }
  if (!items.length) return renderReport(page, { params: new URLSearchParams() }, { replaceTitle: true });
  const tile = (href, emoji, title, desc, extra = null, cls = '') => h('a.m-tile', { href, 'data-link': '', class: cls },
    h('span.m-tile-emoji', { 'aria-hidden': 'true' }, emoji),
    h('span.m-tile-text', h('span.m-tile-title', title), desc ? h('span.m-tile-desc', desc) : null, extra),
    icon('chevron-right', 'm-row-chevron'));
  page.body.replaceChildren(
    h('p.m-intro', t('m.new.intro')),
    h('div.m-tiles',
      tile('/m/new/report', '🛠️', t('m.new.report'), t('m.new.reportText'), null, 'm-tile-report'),
      h('h2.m-section-title.m-tiles-head', t('m.new.catalog')),
      items.map((x) => tile(`/m/new/c/${x.id}`, x.emoji || '📦', x.title, x.description,
        x.needsApproval ? h('span.m-tile-approval', icon('shield'), t('catalog.needsApproval')) : null))));
}

// ---------- Report a problem ----------
export async function renderReport(page, ctx, { replaceTitle = false } = {}) {
  page.title(t('m.new.report'));
  if (!canCreate()) return notAllowed(page);
  const agent = state.isAgent;
  const draft = readDraft() || {};
  const prefill = ctx.params?.get('title') || '';
  const projects = state.projects || [];
  const types = typesFor(agent);
  const v = {
    projectId: projects.some((p) => p.id === draft.projectId) ? draft.projectId : (state.project?.id || projects[0]?.id || null),
    type: types.includes(draft.type) ? draft.type : (agent ? 'task' : 'request'),
    priority: PRIOS.includes(draft.priority) ? draft.priority : 'medium',
  };
  let files = []; // { id, file, url, resized, state, progress, error, el }
  let busy = false;

  const title = h('input', { name: 'title', required: true, maxLength: 255, autocomplete: 'off', enterkeyhint: 'next', placeholder: t('m.new.titleHint') });
  title.value = draft.title || prefill;
  const desc = h('textarea.m-textarea.m-new-desc', { name: 'description', rows: 5, placeholder: t('create.descriptionHint') });
  desc.value = draft.description || '';
  const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
  const suggest = h('div.m-suggest', { hidden: true, 'aria-live': 'polite' });
  const filesEl = h('div.m-new-files', { role: 'list', 'aria-label': t('m.reply.attachments'), hidden: true });

  const save = () => writeDraft({ title: title.value, description: desc.value, ...v });
  let saveTimer;
  const changed = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); };
  title.addEventListener('input', () => { changed(); suggestions(); });
  desc.addEventListener('input', () => { changed(); grow(); });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); desc.focus(); } });
  const grow = () => { desc.style.height = 'auto'; desc.style.height = `${Math.min(desc.scrollHeight + 2, 360)}px`; };

  // Choices as chips (type, priority): large tap targets, no native select needed
  const chips = (label, options, key) => {
    const group = h('div.m-choice-group', { role: 'radiogroup', 'aria-label': label });
    const draw = () => group.replaceChildren(...options.map((o) => h('button.m-choice', {
      type: 'button', role: 'radio', 'aria-checked': String(v[key] === o.value), class: v[key] === o.value ? 'active' : '', 'data-value': o.value,
      onclick: () => { v[key] = o.value; draw(); save(); },
    }, o.iconEl, h('span', o.label))));
    draw();
    return h('div.m-field', h('span.m-field-label', label), group);
  };
  const projectSel = projects.length > 1 ? h('select.m-select', { name: 'project', onchange: (e) => { v.projectId = Number(e.target.value); save(); } },
    projects.map((p) => h('option', { value: p.id, selected: p.id === v.projectId }, `${p.name} (${p.key})`))) : null;

  // ---------- Knowledge suggestions (as in the desktop dialog: public articles, from 4 characters) ----------
  let sugTimer; let lastQ = '';
  function suggestions() {
    clearTimeout(sugTimer);
    sugTimer = setTimeout(async () => {
      const q = title.value.trim();
      if (q.length < 4) { suggest.hidden = true; lastQ = ''; return; }
      if (q === lastQ) return;
      lastQ = q;
      try {
        const { articles } = await api.kbSuggest(q);
        if (q !== title.value.trim()) return;
        suggest.hidden = !articles.length;
        suggest.replaceChildren(h('div.m-suggest-head', icon('book'), h('span', t('kb.suggest'))),
          ...articles.map((a) => h('button.m-suggest-item', { type: 'button', onclick: () => previewArticle(a.id) },
            h('span.m-suggest-title', a.title), a.excerpt ? h('span.m-suggest-text', a.excerpt) : null)));
      } catch { suggest.hidden = true; }
    }, 400);
  }

  // ---------- Attachments ----------
  let seq = 0;
  function addFiles(list) {
    const room = MAX_FILES - files.length;
    if (list.length > room) toast(t('m.reply.tooMany', { n: MAX_FILES }), 'error');
    for (const file of list.slice(0, Math.max(0, room))) addFile(file);
  }
  async function addFile(original) {
    const f = { id: ++seq, file: original, url: null, resized: false, state: 'processing', progress: 0, error: null };
    files.push(f);
    drawFiles(); update();
    try {
      if (isPicture(original.type)) {
        const r = await downscale(original);
        f.file = r.file; f.resized = r.resized;
        f.url = URL.createObjectURL(f.file);
      }
    } catch { /* keep the original */ }
    if (!files.includes(f)) { if (f.url) URL.revokeObjectURL(f.url); return; }
    const max = state.boot?.maxUploadMb;
    if (max && f.file.size > max * 1024 * 1024) {
      f.state = 'error'; f.error = t('m.reply.tooLarge', { name: f.file.name, max });
      toast(f.error, 'error');
    } else f.state = 'ready';
    drawFiles(); update();
  }
  function drawFiles() {
    filesEl.hidden = !files.length;
    filesEl.replaceChildren(...files.map((f) => {
      const pic = isPicture(f.file.type);
      const meta = f.state === 'processing' ? t('m.reply.processing')
        : f.state === 'uploading' ? t('m.reply.uploading', { pct: Math.round(f.progress * 100) })
          : f.state === 'error' ? f.error
            : [fmtSize(f.file.size), f.resized ? t('m.reply.resized') : null].filter(Boolean).join(' · ');
      f.el = h('div.m-file', { role: 'listitem', class: [f.state, pic ? 'pic' : ''].filter(Boolean).join(' '), 'data-name': f.file.name },
        h('span.m-file-thumb', f.url ? h('img', { src: f.url, alt: '' }) : icon(pic ? 'image' : 'file')),
        h('span.m-file-text', h('span.m-file-name', f.file.name), h('span.m-file-meta', meta)),
        f.state === 'uploading' ? h('span.m-file-progress', { 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round(f.progress * 100)}%` } })) : null,
        h('button.m-file-x', {
          type: 'button', 'aria-label': t('m.reply.remove', { name: f.file.name }), disabled: busy,
          onclick: () => { files = files.filter((x) => x !== f); if (f.url) URL.revokeObjectURL(f.url); drawFiles(); update(); },
        }, icon('close')));
      return f.el;
    }));
  }

  // ---------- Reporter (agents): enter the ticket for someone else ----------
  let reporter = null; // null = me, otherwise { choice, person }
  const notify = h('input', { type: 'checkbox', checked: true });
  const notifyRow = h('label.m-check', { hidden: true }, notify, h('span.m-check-box', { 'aria-hidden': 'true' }, icon('check')), h('span.m-check-label', t('create.reporterNotify')));
  const reporterBtn = h('button.m-reporter', { type: 'button', 'aria-label': t('ticket.reporter'), onclick: () => openReporterSheet({
    intro: t('m.new.reporterIntro'),
    onPick: (choice, person) => { reporter = choice.userId === state.user.id ? null : { choice, person }; drawReporter(); },
  }) });
  const resetBtn = h('button.m-link.m-link-small', { type: 'button', hidden: true, onclick: () => { reporter = null; drawReporter(); } }, t('create.reporterReset'));
  function drawReporter() {
    const p = reporter ? (reporter.person || { displayName: reporter.choice.email }) : state.user;
    const sub = reporter ? (reporter.person?.email || reporter.person?.username || '') : '';
    reporterBtn.replaceChildren(...[avatar(p, 'sm'),
      h('span.m-reporter-text', h('span.m-reporter-name', reporter ? p.displayName : t('create.reporterMe', { name: state.user.displayName })), sub && sub !== p.displayName ? h('span.m-reporter-sub', sub) : null),
      reporter?.person?.source === 'ad' ? h('span.m-badge-ad', 'AD') : null,
      icon('chevron-right', 'm-row-chevron')].filter(Boolean));
    notifyRow.hidden = !reporter;
    resetBtn.hidden = !reporter;
  }
  drawReporter();
  const reporterField = agent ? h('div.m-field', h('span.m-field-label', t('ticket.reporter')), reporterBtn, resetBtn, notifyRow) : null;

  // ---------- Send ----------
  const submit = h('button.m-btn.m-btn-primary.m-btn-block', { type: 'submit', form: 'm-new-form' }, icon('send'), t('m.new.submit'));
  function update() {
    submit.disabled = busy || files.some((f) => f.state === 'processing');
    page.el.classList.toggle('busy', busy);
  }
  const form = h('form#m-new-form.m-form.m-new-form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (busy) return;
      err.hidden = true;
      if (!title.value.trim()) {
        err.textContent = t('m.new.titleMissing'); err.hidden = false;
        title.focus();
        return;
      }
      busy = true; update(); drawFiles();
      let key = null;
      try {
        const body = { projectId: v.projectId || undefined, type: v.type, priority: v.priority, title: title.value.trim(), description: desc.value };
        if (agent && reporter) Object.assign(body, { reporter: reporter.choice, notifyReporter: notify.checked });
        key = (await api.createTicket(body)).ticket.key;
      } catch (ex) {
        busy = false; update(); drawFiles();
        err.textContent = ex.message; err.hidden = false;
        page.scroll.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      // The ticket exists: from here on never create it a second time
      writeDraft(null);
      let failed = 0;
      for (const f of files.filter((x) => x.state === 'ready')) {
        f.state = 'uploading'; f.progress = 0; drawFiles();
        try {
          await uploadDraft(key, f.file, null, (p) => {
            f.progress = p;
            const meta = f.el?.querySelector('.m-file-meta');
            if (meta) meta.textContent = t('m.reply.uploading', { pct: Math.round(p * 100) });
            const bar = f.el?.querySelector('.m-file-progress > span');
            if (bar) bar.style.width = `${Math.round(p * 100)}%`;
          });
          f.state = 'done';
        } catch { failed += 1; f.state = 'error'; }
      }
      for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
      dataChanged();
      if (failed) toast(t('m.new.uploadFailed', { key, n: failed }), 'error');
      else toast(t('create.done', { key }), 'success');
      go(`/m/t/${encodeURIComponent(key)}`, { replace: true });
    },
  },
  err,
  reporterField,
  fieldEl(t('create.summary'), title, { required: true }),
  suggest,
  fieldEl(t('create.description'), desc),
  h('div.m-field', h('span.m-field-label', t('create.attachments')),
    filesEl,
    h('div.m-attach-btns',
      h('button.m-btn.m-attach-btn', { type: 'button', onclick: () => pickFiles('camera', addFiles) }, icon('camera'), t('m.reply.photo')),
      h('button.m-btn.m-attach-btn', { type: 'button', onclick: () => pickFiles('file', addFiles) }, icon('paperclip'), t('m.reply.file'))),
    h('div.m-field-hint', t('m.reply.photoHint'))),
  projectSel ? fieldEl(t('create.project'), projectSel) : null,
  chips(t('create.type'), types.map((x) => ({ value: x, label: t(`type.${x}`), iconEl: typeIcon(x) })), 'type'),
  chips(t('create.priority'), PRIOS.map((x) => ({ value: x, label: t(`priority.${x}`), iconEl: priorityIcon(x) })), 'priority'));

  page.body.replaceChildren(form);
  page.el.classList.add('has-foot');
  page.el.append(h('div.m-foot', submit));
  if (replaceTitle) page.title(t('m.new.report'));
  requestAnimationFrame(grow);
  if (title.value) suggestions();
  update();
}

/** Article from a suggestion in a sheet (the form and its draft stay as they are) */
async function previewArticle(id) {
  let article;
  try { ({ article } = await api.kbArticle(id, true)); } catch (e) { toast(e.message, 'error'); return; }
  const doc = renderDoc(article.body);
  doc.classList.add('kb-body', 'm-kb-body');
  let after = null;
  const sheet = openSheet({
    title: article.title,
    className: 'm-sheet-tall m-sheet-article',
    content: doc,
    footer: [
      h('button.m-btn', { type: 'button', onclick: () => sheet.close() }, t('m.new.backToForm')),
      h('button.m-btn.m-btn-primary', { type: 'button', onclick: () => { after = () => go(`/m/kb/${article.id}`); sheet.close(); } }, t('m.new.openArticle')),
    ],
    onClose: () => after?.(),
  });
}

// ---------- Catalog item ----------
export async function renderCatalogItem(page, ctx) {
  page.title(t('m.new.catalog'));
  if (!canCreate()) return notAllowed(page);
  const id = Number(ctx.match[1]);
  const { item } = await api.catalogItem(id);
  page.title(item.title);
  const inputs = {};
  const fieldFor = (f) => {
    let el;
    const label = f.label;
    if (f.type === 'checkbox') {
      el = h('input', { type: 'checkbox', name: `f${f.id}` });
      inputs[f.id] = () => el.checked;
      return h('label.m-check', el, h('span.m-check-box', { 'aria-hidden': 'true' }, icon('check')), h('span.m-check-label', label));
    }
    if (f.type === 'textarea') el = h('textarea.m-textarea', { rows: 4, maxLength: 10000 });
    else if (f.type === 'select') el = h('select.m-select', h('option', { value: '' }, '—'), (f.options || []).map((o) => h('option', { value: o }, o)));
    else if (f.type === 'date') el = h('input', { type: 'date' });
    else el = h('input', { maxLength: 500, autocomplete: 'off' });
    el.name = `f${f.id}`;
    el.required = !!f.required;
    inputs[f.id] = () => el.value;
    return fieldEl(label, el, { required: !!f.required });
  };
  const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
  const submit = h('button.m-btn.m-btn-primary.m-btn-block', { type: 'submit', form: 'm-cat-form' }, icon('send'), t('catalog.submit'));
  const form = h('form#m-cat-form.m-form.m-new-form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      // Required fields: the first empty one gets the focus
      const missing = [...form.querySelectorAll('[required]')].find((x) => !String(x.value || '').trim());
      if (missing) {
        err.textContent = t('m.new.requiredMissing'); err.hidden = false;
        missing.focus();
        missing.closest('.m-field')?.classList.add('invalid');
        return;
      }
      submit.disabled = true;
      try {
        const answers = Object.fromEntries(Object.entries(inputs).map(([k, fn]) => [k, fn()]));
        const r = await api.catalogOrder(id, answers);
        dataChanged();
        toast(t('catalog.sent', { key: r.ticket.key }), 'success');
        go(`/m/t/${encodeURIComponent(r.ticket.key)}`, { replace: true });
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        submit.disabled = false;
      }
    },
    oninput: (e) => e.target.closest('.m-field')?.classList.remove('invalid'),
  },
  h('div.m-cat-head', h('span.m-tile-emoji', { 'aria-hidden': 'true' }, item.emoji || '📦'),
    h('div', h('h2.m-cat-title', item.title), item.description ? h('p.m-cat-desc', item.description) : null)),
  item.needsApproval ? h('div.m-alert.m-alert-info.m-approval-note', icon('shield'), h('span', t('catalog.approvalHint'))) : null,
  err,
  item.fields.map(fieldFor),
  item.fields.length ? null : h('p.m-muted', t('m.new.noFields')));
  page.body.replaceChildren(form);
  page.el.classList.add('has-foot');
  page.el.append(h('div.m-foot', submit));
}
