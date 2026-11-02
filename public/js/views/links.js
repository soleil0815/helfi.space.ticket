// Verknüpfungen und Unteraufgaben in der Ticketansicht (nur Bearbeiter)
import { api } from '../api.js';
import { h, mount, icon, lozenge, typeIcon, toast, avatar } from '../dom.js';
import { t } from '../i18n.js';

// Auswahl aus Sicht des aktuellen Tickets → [kind, umgekehrt?]
const CHOICES = [
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
    lozenge(l.ticket.status),
    h('button.btn-icon.small', {
      type: 'button', title: t('link.remove'),
      onclick: async () => { try { await api.unlink(tk.key, l.id); refresh(); } catch (e) { toast(e.message, 'error'); } },
    }, icon('close')));
}

/** Eingabe einer Ticketnummer mit Vorschlägen aus der Suche */
function ticketPicker(currentKey) {
  const listId = `tp-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input.link-target', { placeholder: t('link.targetHint'), list: listId, autocomplete: 'off', required: true });
  const dl = h('datalist', { id: listId });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      try {
        const r = await api.tickets({ q, limit: 10 });
        mount(dl, (r.tickets || []).filter((x) => x.key !== currentKey).map((x) => h('option', { value: x.key }, `${x.key} – ${x.title}`)));
      } catch { /* egal */ }
    }, 200);
  });
  return { input, el: h('span.link-picker', input, dl) };
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

  // nach Bedeutung gruppiert
  const groups = new Map();
  for (const l of others) {
    const label = linkLabel(l.kind, l.direction);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(l);
  }
  const done = children.filter((c) => c.ticket.status === 'done').length;

  return h('section.ticket-section.links-section',
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
}
