// Kanban-Board mit Drag & Drop
import { api } from '../api.js';
import { h, mount, icon, avatar, typeIcon, priorityIcon, toast, select, dropdown } from '../dom.js';
import { t } from '../i18n.js';
import { state } from '../app.js';

const COLUMNS = ['open', 'in_progress', 'waiting', 'done'];

export async function renderBoard(content, params) {
  const project = params.get('project') ? state.projects.find((p) => p.key === params.get('project').toUpperCase()) : state.project;
  if (project) state.project = project;
  if (!project) {
    mount(content, h('div.empty-state', h('h2', t('nav.projects')), state.isAdmin ? h('a.btn.btn-primary', { href: '/admin/projects', 'data-link': '' }, t('projects.new')) : null));
    return;
  }

  const filter = { q: '', mine: false, assignee: null, type: '' };
  let tickets = [];

  const columnsEl = h('div.board');
  const headerEl = h('div.page-head',
    h('div.breadcrumbs', h('span', t('nav.projects')), ' / ', h('span', project.name)),
    h('h1', `${project.key} ${t('board.title')}`),
  );

  const qInput = h('input.input-search', { type: 'search', placeholder: t('filter.search'), oninput: (e) => { filter.q = e.target.value.toLowerCase(); draw(); } });
  const assigneeAvatars = h('div.avatar-filter');
  const typeSel = select([['', t('filter.allTypes')], ...['incident', 'request', 'task', 'question'].map((x) => [x, t(`type.${x}`)])], '', {
    class: 'select-sm', onchange: (e) => { filter.type = e.target.value; draw(); },
  });
  const mineBtn = h('button.btn.btn-subtle', { type: 'button', onclick: () => { filter.mine = !filter.mine; mineBtn.classList.toggle('active', filter.mine); draw(); } }, t('board.onlyMine'));
  const toolbar = h('div.toolbar', h('div.toolbar-search', icon('search'), qInput), assigneeAvatars, typeSel, mineBtn);

  mount(content, headerEl, toolbar, columnsEl);

  async function load() {
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const r = await api.tickets({ project: project.key, sort: 'rank', limit: 1000 });
    tickets = r.tickets.filter((x) => x.status !== 'done' || (x.resolvedAt || x.updatedAt) >= since);
    // Bearbeiter-Avatare als Filter
    const people = new Map();
    for (const tk of tickets) if (tk.assignee) people.set(tk.assignee.id, tk.assignee);
    mount(assigneeAvatars, [...people.values()].map((p) => h('button.avatar-btn', {
      type: 'button', title: p.displayName, class: filter.assignee === p.id ? 'active' : '', dataset: { id: p.id },
      onclick: () => {
        filter.assignee = filter.assignee === p.id ? null : p.id;
        for (const b of assigneeAvatars.children) b.classList.toggle('active', Number(b.dataset.id) === filter.assignee);
        draw();
      },
    }, avatar(p, 'sm'))));
    draw();
  }

  function visible(tk) {
    if (filter.mine && tk.assignee?.id !== state.user.id) return false;
    if (filter.assignee && tk.assignee?.id !== filter.assignee) return false;
    if (filter.type && tk.type !== filter.type) return false;
    if (filter.q && !(`${tk.key} ${tk.title} ${tk.labels.join(' ')}`.toLowerCase().includes(filter.q))) return false;
    return true;
  }

  function draw() {
    mount(columnsEl, COLUMNS.map((status) => {
      const items = tickets.filter((x) => x.status === status && visible(x)).sort((a, b) => a.rank - b.rank || a.id - b.id);
      const list = h('div.column-cards', { dataset: { status } }, items.length ? items.map(card) : h('div.column-empty', t('board.empty')));
      const col = h('section.column', {
        dataset: { status },
        ondragover: (e) => { e.preventDefault(); col.classList.add('drop'); placeholder(list, e.clientY); },
        ondragleave: (e) => { if (!col.contains(e.relatedTarget)) { col.classList.remove('drop'); list.querySelector('.drop-marker')?.remove(); } },
        ondrop: (e) => { e.preventDefault(); col.classList.remove('drop'); onDrop(e, status, list); },
      },
      h('header.column-head', h('span', t(`status.${status}`).toUpperCase()), h('span.count', items.length), status === 'done' ? h('span.column-hint', { title: t('board.doneHint') }, icon('info')) : null),
      list);
      return col;
    }));
  }

  function card(tk) {
    return h('a.card', {
      href: `/browse/${tk.key}`, 'data-link': '', draggable: 'true', dataset: { key: tk.key },
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', tk.key); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
      ondragend: (e) => { e.currentTarget.classList.remove('dragging'); document.querySelectorAll('.drop-marker').forEach((m) => m.remove()); },
    },
    h('div.card-title', tk.title),
    tk.labels.length ? h('div.card-labels', tk.labels.slice(0, 3).map((l) => h('span.label', l))) : null,
    h('div.card-foot',
      typeIcon(tk.type),
      h(`span.card-key${tk.status === 'done' ? '.done' : ''}`, tk.key),
      tk.source === 'email' ? h('span.card-src', { title: t('source.email') }, icon('mail')) : null,
      tk.commentCount ? h('span.card-src', { title: t('ticket.comments') }, icon('comment'), String(tk.commentCount)) : null,
      h('span.spacer'),
      priorityIcon(tk.priority),
      avatar(tk.assignee, 'sm'),
      // Smartphone: Ziehen klappt mit dem Finger nicht zuverlässig → Status über ein Menü
      h('button.btn-icon.card-move', {
        type: 'button', 'aria-label': t('board.moveTo'), title: t('board.moveTo'),
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          dropdown(e.currentTarget, COLUMNS.map((st) => ({
            label: t(`status.${st}`), active: st === tk.status,
            onClick: async () => {
              if (st === tk.status) return;
              try { const r = await api.updateTicket(tk.key, { status: st }); Object.assign(tk, r.ticket || { status: st }); draw(); } catch (ex) { toast(ex.message, 'error'); }
            },
          })), { align: 'right' });
        },
      }, icon('ed-more')),
    ));
  }

  function placeholder(list, y) {
    let marker = list.querySelector('.drop-marker');
    if (!marker) marker = h('div.drop-marker');
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    const after = cards.find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (after) list.insertBefore(marker, after); else list.append(marker);
  }

  async function onDrop(e, status, list) {
    const key = e.dataTransfer.getData('text/plain');
    const tk = tickets.find((x) => x.key === key);
    const marker = list.querySelector('.drop-marker');
    if (!tk) return;
    // Rang zwischen den Nachbarn bestimmen
    const order = [...list.children].filter((c) => c.classList.contains('drop-marker') || (c.classList.contains('card') && c.dataset.key !== key));
    const idx = order.indexOf(marker);
    marker?.remove();
    const neighbors = order.filter((c) => c !== marker).map((c) => tickets.find((x) => x.key === c.dataset.key));
    const before = neighbors[idx - 1];
    const after = neighbors[idx];
    let rank;
    if (before && after) rank = (before.rank + after.rank) / 2;
    else if (before) rank = before.rank + 1;
    else if (after) rank = after.rank - 1;
    else rank = 0;
    const prev = { status: tk.status, rank: tk.rank };
    Object.assign(tk, { status, rank });
    draw();
    try {
      const r = await api.updateTicket(key, { status, rank });
      Object.assign(tk, r.ticket);
    } catch (ex) {
      Object.assign(tk, prev);
      draw();
      toast(ex.message, 'error');
    }
  }

  await load();
}

