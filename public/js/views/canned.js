// Antwortvorlagen: Auswahl am Kommentarfeld, „Als Vorlage speichern“ und Verwaltung
import { api } from '../api.js';
import { h, mount, icon, modal, toast, field } from '../dom.js';
import { t } from '../i18n.js';
import { state } from '../app.js';
import { fillPlaceholders as fill } from '../placeholders.js';
import { withEmoji } from '../emoji.js';

/** Platzhalter beim Einfügen ersetzen; Bearbeiter = angemeldete Person. */
export function fillPlaceholders(text, tk, user = state.user) {
  return fill(text, tk, user);
}

let cache = null;
async function load(force = false) {
  if (!cache || force) cache = (await api.canned.list()).responses;
  return cache;
}

/** Aufklappliste mit Suche; onPick(vorlage) beim Auswählen. */
export async function openTemplatePicker(anchor, onPick) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const search = h('input.menu-search', { type: 'search', placeholder: t('canned.search'), autocomplete: 'off' });
  const listEl = h('div.menu-list');
  const menu = h('div.menu.menu-templates', { role: 'menu' }, search, listEl);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.left = `${r.left + window.scrollX}px`;
  document.body.append(menu);
  const close = () => { menu.remove(); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  const off = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
  setTimeout(() => { document.addEventListener('mousedown', off); document.addEventListener('keydown', esc); }, 0);

  let items = [];
  try { items = await load(); } catch (e) { toast(e.message, 'error'); close(); return; }
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    // Treffer im Namen vor Treffern im Text, Namensanfang zuerst
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
    // Beim Suchen eine Liste nach Treffergüte, sonst nach „Für alle“/„Meine“ gruppiert
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

/** Dialog zum Anlegen/Bearbeiten. shared: für alle (nur Admins). */
export function templateDialog({ existing = null, body = '', shared = false, onSaved } = {}) {
  const title = h('input', { required: true, maxLength: 100, value: existing?.title || '' });
  const text = h('textarea', { rows: 8, required: true, maxLength: 10000 });
  text.value = existing?.body ?? body;
  const forAll = h('input', { type: 'checkbox', checked: existing ? existing.shared : shared });
  const canShare = state.isAdmin && !existing;
  const form = h('form#template-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const data = { title: title.value, body: text.value };
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
  canShare ? h('label.check-inline', forAll, t('canned.forAll')) : null);
  const dlg = modal(existing ? t('canned.edit') : t('canned.new'), form, {
    wide: true,
    footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
      h('button.btn.btn-primary', { type: 'submit', form: 'template-form' }, t('app.save'))],
  });
  setTimeout(() => title.focus(), 40);
}

/** Verwaltung: shared = Vorlagen für alle (Administration), sonst die eigenen (Profil). */
export function templatesPanel({ shared }) {
  const panel = h('section.panel', h('div.loading', t('app.loading')));
  const draw = async () => {
    let items;
    try { items = (await load(true)).filter((x) => (shared ? x.shared : x.mine)); }
    catch (e) { return mount(panel, h('p.error-text', e.message)); }
    mount(panel,
      h('div.section-head', h('h2', shared ? t('canned.sharedTitle') : t('canned.personalTitle')),
        h('button.btn.btn-primary', { type: 'button', onclick: () => templateDialog({ shared, onSaved: draw }) }, icon('plus'), t('canned.new'))),
      h('p.muted', shared ? t('canned.sharedIntro') : t('canned.personalIntro')),
      items.length
        ? h('div.template-list', items.map((x) => h('div.template-row',
          h('div.template-main', h('strong', x.title), h('div.template-preview.muted', x.body.replace(/\s+/g, ' ').slice(0, 160))),
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
