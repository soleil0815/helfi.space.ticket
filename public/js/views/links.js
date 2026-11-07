// Links and subtasks in the ticket view (agents only)
import { api } from '../api.js';
import { h, mount, icon, lozenge, typeIcon, toast, avatar } from '../dom.js';
import { t } from '../i18n.js';

// Choice from the current ticket's point of view → [kind, reversed?]
export const CHOICES = [
  ['relates', 'relates', false], ['duplicates', 'duplicates', false], ['duplicatedBy', 'duplicates', true],
  ['blocks', 'blocks', false], ['blockedBy', 'blocks', true], ['causes', 'causes', false], ['causedBy', 'causes', true],
  ['childOf', 'parent', false], ['parentOf', 'parent', true],
];

export const linkLabel = (kind, direction) => t(`link.${kind}.${direction}`);

function row(tk, l, refresh) {
  return h('div.link-row',
    typeIcon(l.ticket.type),
    h('a.link-key', { href: `/browse/${l.ticket.key}`, 'data-link': '' }, l.ticket.key),
    h('a.link-title', { href: `/browse/${l.ticket.key}`, 'data-link': '' }, l.ticket.title),
    l.ticket.assignee ? avatar(l.ticket.assignee, 'sm') : h('span'),
    lozenge(l.ticket.status, l.ticket.resolution),
    h('button.btn-icon.small', {
      type: 'button', title: t('link.remove'),
      onclick: async () => { try { await api.unlink(tk.key, l.id); refresh(); } catch (e) { toast(e.message, 'error'); } },
    }, icon('close')));
}

/** Ticket number input with suggestions from the search */
/**
 * Field for the ticket to link with: search by number or words (title, description, comments) and
 * – while empty – suggestions: possible cause (open problems, major incidents) and similar tickets.
 * forKeys = the ticket(s) to be linked (left out of the results, basis for "similar").
 */
export function ticketPicker(currentKey, { forKeys = currentKey ? [currentKey] : [] } = {}) {
  const listId = `tp-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input.link-target', {
    placeholder: t('link.searchHint'), autocomplete: 'off', required: true, spellcheck: false,
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list',
  });
  const pop = h('div.tp-pop', { id: listId, role: 'listbox', hidden: true });
  const skip = new Set(forKeys.map((k) => String(k).toUpperCase()));
  let items = []; // shown options (for the keyboard)
  let active = -1;
  let suggestions = null; // loaded once on first focus
  let timer;
  let seq = 0;

  // Fixed position under the field: also works inside dialogs that cut off their content
  const place = () => {
    if (pop.hidden) return;
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.minWidth = `${r.width}px`;
    if (below < 220 && r.top > below) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 4}px`; }
    else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 4}px`; }
  };
  const onMove = () => place();
  const open = (on) => {
    const was = !pop.hidden;
    pop.hidden = !on;
    input.setAttribute('aria-expanded', String(on));
    if (!on) active = -1;
    if (on) { place(); if (!was) { window.addEventListener('scroll', onMove, true); window.addEventListener('resize', onMove); } }
    else if (was) { window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove); }
  };
  const option = (x) => h('div.tp-item', {
    role: 'option', id: `${listId}-${x.key}`, 'aria-selected': 'false',
    onmousedown: (e) => { e.preventDefault(); choose(x); }, // before the blur of the field
  }, typeIcon(x.type), h('span.tp-key', x.key), h('span.tp-title', x.title), x.major ? h('span.tp-major', icon('warning')) : null, lozenge(x.status, x.resolution));
  function render(groups, emptyText) {
    items = [];
    active = -1;
    const parts = [];
    for (const [label, list] of groups) {
      const shown = list.filter((x) => !skip.has(x.key));
      if (!shown.length) continue;
      parts.push(h('div.tp-group', label));
      for (const x of shown) { items.push(x); parts.push(option(x)); }
    }
    if (!parts.length && emptyText) parts.push(h('div.tp-empty', emptyText));
    mount(pop, parts);
    open(parts.length > 0 && document.activeElement === input);
  }
  function highlight(i) {
    const els = pop.querySelectorAll('.tp-item');
    els.forEach((el, n) => { el.classList.toggle('active', n === i); el.setAttribute('aria-selected', String(n === i)); });
    active = i;
    if (els[i]) { els[i].scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', els[i].id); }
  }
  function choose(x) {
    input.value = x.key;
    open(false);
    input.dispatchEvent(new Event('change'));
  }
  async function showSuggestions() {
    if (!suggestions) {
      try { suggestions = await api.linkSuggestions(forKeys); } catch { suggestions = { causes: [], similar: [] }; }
    }
    if (input.value.trim()) return;
    render([[t('link.suggestCause'), suggestions.causes], [t('link.suggestSimilar'), suggestions.similar]], null);
  }
  async function searchNow(q) {
    const my = ++seq;
    try {
      const r = await api.tickets({ q, limit: 10 });
      if (my !== seq) return; // a newer search is on its way
      render([[t('link.searchResults'), r.tickets || []]], t('link.noResults'));
    } catch { /* ignore */ }
  }
  input.addEventListener('focus', () => { if (!input.value.trim()) showSuggestions(); else if (items.length) open(true); });
  // Closed a moment after leaving the field (a click into the list comes first) – unless focus came back
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) open(false); }, 120));
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { showSuggestions(); return; }
    if (q.length < 2) { open(false); return; }
    timer = setTimeout(() => searchNow(q), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (pop.hidden || !items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!input.value.trim()) showSuggestions(); else if (items.length) open(true); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(items.length - 1, active + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(0, active - 1)); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open(false); }
  });
  return { input, el: h('span.link-picker', input, pop) };
}

export function linksSection(tk, refresh) {
  const links = tk.links || [];
  const children = links.filter((l) => l.kind === 'parent' && l.direction === 'out');
  const others = links.filter((l) => !(l.kind === 'parent' && l.direction === 'out'));
  const form = h('div.link-form', { hidden: true });
  const subForm = h('form.subtask-form', { hidden: true });

  const openForm = () => {
    const kind = h('select', CHOICES.map(([id]) => h('option', { value: id }, t(`link.choice.${id}`))));
    const picker = ticketPicker(tk.key);
    const close = h('label.link-close', { hidden: true }, h('input', { type: 'checkbox' }), ' ', t('link.closeDuplicate'));
    kind.addEventListener('change', () => { close.hidden = kind.value !== 'duplicates'; });
    const submit = async (e) => {
      e.preventDefault();
      const [, k, reverse] = CHOICES.find(([id]) => id === kind.value);
      const target = picker.input.value.trim().toUpperCase();
      try {
        if (reverse) await api.link(target, { kind: k, target: tk.key });
        else await api.link(tk.key, { kind: k, target });
        if (kind.value === 'duplicates' && close.querySelector('input').checked && tk.status !== 'done') await api.updateTicket(tk.key, { status: 'done' });
        refresh();
      } catch (ex) { toast(ex.message, 'error'); }
    };
    mount(form, h('form', { onsubmit: submit },
      kind, picker.el, close,
      h('button.btn.btn-primary.small', { type: 'submit' }, t('link.add')),
      h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { form.hidden = true; } }, t('app.cancel'))));
    form.hidden = false;
    picker.input.focus();
  };

  const openSubtask = () => {
    const title = h('input', { placeholder: t('link.subtaskTitle'), maxLength: 255, required: true });
    mount(subForm, title,
      h('button.btn.btn-primary.small', { type: 'submit' }, t('app.create')),
      h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { subForm.hidden = true; } }, t('app.cancel')));
    subForm.onsubmit = async (e) => {
      e.preventDefault();
      try { await api.createSubtask(tk.key, { title: title.value }); refresh(); } catch (ex) { toast(ex.message, 'error'); }
    };
    subForm.hidden = false;
    title.focus();
  };

  // grouped by meaning
  const groups = new Map();
  for (const l of others) {
    const label = linkLabel(l.kind, l.direction);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(l);
  }
  const done = children.filter((c) => c.ticket.status === 'done').length;

  const section = h('section.ticket-section.links-section',
    h('div.section-head',
      h('h3', t('link.title'), links.length ? h('span.count', links.length) : null),
      h('span.spacer'),
      h('button.btn.btn-subtle.small', { type: 'button', onclick: openSubtask }, icon('plus'), t('link.addSubtask')),
      h('button.btn.btn-subtle.small', { type: 'button', onclick: openForm }, icon('link'), t('link.addLink'))),
    form,
    children.length ? h('div.link-group',
      h('div.link-group-label', t('link.subtasks'), ' ', h('span.muted', t('link.progress', { done, total: children.length }))),
      h('div.progress', h('div.progress-bar', { style: { width: `${Math.round((done / children.length) * 100)}%` } })),
      children.map((l) => row(tk, l, refresh))) : null,
    subForm,
    [...groups].map(([label, items]) => h('div.link-group', h('div.link-group-label', label), items.map((l) => row(tk, l, refresh)))));
  // For the "Link" button in the ticket header: open the form and bring it into view
  section.openLinkForm = () => {
    openForm();
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return section;
}
