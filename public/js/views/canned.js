// Canned responses: picker at the comment field, “Save as template” and management
import { api } from '../api.js';
import { h, mount, icon, modal, toast, field } from '../dom.js';
import { t } from '../i18n.js';
import { state } from '../app.js';
import { fillPlaceholders as fill } from '../placeholders.js';
import { withEmoji } from '../emoji.js';
import { examplesButton } from './examples.js';

/** Replace placeholders on insert; agent = logged-in person. */
export function fillPlaceholders(text, tk, user = state.user) {
  return fill(text, tk, user);
}

let cache = null;
async function load(force = false) {
  if (!cache || force) cache = (await api.canned.list()).responses;
  return cache;
}

/** Shared templates of another project do not fit this ticket */
export const forProject = (items, projectId) => (projectId ? items.filter((x) => !x.project || x.project.id === projectId) : items);

/** Forget the loaded templates (personal ones belong to one account) – on sign-in/sign-out */
export function resetCannedCache() { cache = null; }

/** Dropdown list with search; onPick(template) on selection. */
/** footer: further entries below the list, e.g. [{ label, onClick }] for “Save as canned response” */
/** projectId: ticket's project – shared templates of other projects are left out */
export async function openTemplatePicker(anchor, onPick, { footer = [], projectId = null } = {}) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const search = h('input.menu-search', { type: 'search', placeholder: t('canned.search'), autocomplete: 'off' });
  const listEl = h('div.menu-list');
  const foot = footer.length ? h('div.menu-foot', footer.map((f) => h('button.menu-item', { type: 'button', role: 'menuitem', onclick: () => { close(); f.onClick(); } }, f.icon || null, f.label))) : null;
  const menu = h('div.menu.menu-templates', { role: 'menu' }, search, listEl, foot);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  document.body.append(menu);
  // right-aligned buttons (toolbar end): open towards the left, stay in the window
  const left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  const close = () => { menu.remove(); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  const off = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
  setTimeout(() => { document.addEventListener('mousedown', off); document.addEventListener('keydown', esc); }, 0);

  let items = [];
  try { items = forProject(await load(), projectId); } catch (e) { toast(e.message, 'error'); close(); return; }
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    // Matches in the name before matches in the text, name prefix first
    const score = (x) => {
      const ti = x.title.toLowerCase();
      if (!q) return 0;
      if (ti.startsWith(q)) return 3;
      if (ti.includes(q)) return 2;
      return x.body.toLowerCase().includes(q) ? 1 : -1;
    };
    const hits = items.map((x) => [score(x), x]).filter(([n]) => n >= 0).sort((a, b) => b[0] - a[0]).map(([, x]) => x);
    const group = (label, arr) => (arr.length ? [h('div.menu-group', label), ...arr.map((x) => h('button.menu-item.menu-template', {
      type: 'button', role: 'menuitem', title: x.body,
      onclick: () => { close(); onPick(x); },
    }, h('span.template-title', x.title), h('span.template-preview', x.body.replace(/\s+/g, ' ').slice(0, 80))))] : []);
    // When searching, one list by match quality, otherwise grouped by “For everyone”/“Mine”
    const nodes = q
      ? group(t('canned.results'), hits)
      : [...group(t('canned.shared'), hits.filter((x) => x.shared)), ...group(t('canned.personal'), hits.filter((x) => !x.shared))];
    mount(listEl, nodes.length ? nodes : h('div.menu-empty', items.length ? t('canned.noMatch') : t('canned.empty')));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); listEl.querySelector('.menu-template')?.click(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); listEl.querySelector('.menu-template')?.focus(); }
  });
  draw();
  search.focus();
}

/** Dialog for creating/editing. shared: for everyone (admins only). */
export function templateDialog({ existing = null, body = '', shared = false, onSaved } = {}) {
  const title = h('input', { required: true, maxLength: 100, value: existing?.title || '' });
  const text = h('textarea', { rows: 8, required: true, maxLength: 10000 });
  text.value = existing?.body ?? body;
  const forAll = h('input', { type: 'checkbox', checked: existing ? existing.shared : shared });
  const canShare = state.isAdmin && !existing;
  // Shared templates: optionally only for one project (its agents see it, and only in its tickets)
  const sharedNow = () => (existing ? existing.shared : canShare && forAll.checked);
  const proj = h('select', { 'aria-label': t('canned.project') }, h('option', { value: '' }, t('canned.allProjects')));
  const projField = field(t('canned.project'), proj, t('canned.projectHint'));
  if (state.isAdmin) {
    api.projects().then(({ projects }) => {
      for (const p of projects) proj.append(h('option', { value: p.id }, p.name));
      proj.value = existing?.project?.id || '';
    }).catch(() => {});
  }
  const syncProj = () => { projField.hidden = !state.isAdmin || !sharedNow(); };
  forAll.addEventListener('change', syncProj);
  const form = h('form#template-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const data = { title: title.value, body: text.value, ...(state.isAdmin && sharedNow() ? { projectId: Number(proj.value) || null } : {}) };
        const r = existing ? await api.canned.update(existing.id, data) : await api.canned.create({ ...data, shared: canShare && forAll.checked });
        cache = null;
        toast(t('app.saved'), 'success');
        dlg.close();
        onSaved?.(r.response);
      } catch (ex) { toast(ex.message, 'error'); }
    },
  },
  field(t('canned.name'), title, t('canned.nameHint')),
  field(t('canned.text'), withEmoji(text), t('canned.placeholders')),
  canShare ? h('label.check-inline', forAll, t('canned.forAll')) : null,
  projField);
  syncProj();
  const dlg = modal(existing ? t('canned.edit') : t('canned.new'), form, {
    wide: true,
    footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
      h('button.btn.btn-primary', { type: 'submit', form: 'template-form' }, t('app.save'))],
  });
  setTimeout(() => title.focus(), 40);
}

/** Management: shared = templates for everyone (administration), otherwise own ones (profile). */
export function templatesPanel({ shared }) {
  const panel = h('section.panel', h('div.loading', t('app.loading')));
  const draw = async () => {
    let items;
    try { items = (await load(true)).filter((x) => (shared ? x.shared : x.mine)); }
    catch (e) { return mount(panel, h('p.error-text', e.message)); }
    mount(panel,
      h('div.section-head', h('h2', shared ? t('canned.sharedTitle') : t('canned.personalTitle')),
        h('div.actions',
          shared && state.user?.role === 'admin' ? examplesButton('canned', () => { cache = null; draw(); }) : null,
          h('button.btn.btn-primary', { type: 'button', onclick: () => templateDialog({ shared, onSaved: draw }) }, icon('plus'), t('canned.new')))),
      h('p.muted', shared ? t('canned.sharedIntro') : t('canned.personalIntro')),
      items.length
        ? h('div.template-list', items.map((x) => h('div.template-row',
          h('div.template-main', h('strong', x.title), shared ? h('span.badge.template-project', x.project ? x.project.name : t('canned.allProjects')) : null, h('div.template-preview.muted', x.body.replace(/\s+/g, ' ').slice(0, 160))),
          h('div.template-actions',
            h('button.btn.btn-subtle.small', { type: 'button', onclick: () => templateDialog({ existing: x, onSaved: draw }) }, t('app.edit')),
            h('button.btn-icon.small', {
              type: 'button', title: t('app.delete'),
              onclick: async () => {
                if (!confirm(`${x.title}: ${t('app.confirmDelete')}`)) return;
                try { await api.canned.remove(x.id); cache = null; draw(); } catch (e) { toast(e.message, 'error'); }
              },
            }, icon('trash'))))))
        : h('p.muted', t('canned.none')));
  };
  draw();
  return panel;
}
