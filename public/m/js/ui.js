// Mobile building blocks: ticket cards, chips, sections, empty states, skeletons.
import { h, icon, avatar, lozenge, typeIcon, priorityIcon, relTime, fmtDate, highlight } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { slaBadge } from '/js/views/sla.js';

/** Large tappable ticket card for lists */
export function ticketCard(tk, { terms = [], showAssignee = true } = {}) {
  const sla = tk.sla && tk.sla.state !== 'met' ? slaBadge(tk.sla) : null;
  return h('a.m-card.m-ticket', { href: `/m/t/${encodeURIComponent(tk.key)}`, 'data-link': '', 'data-key': tk.key },
    h('div.m-ticket-top',
      typeIcon(tk.type),
      h('span.m-ticket-key', tk.key),
      tk.source === 'email' ? h('span.m-ticket-src', { title: t('source.email') }, icon('mail')) : null,
      tk.mentionUnseen ? h('span.mention-dot', { title: t('mention.unseen'), 'aria-label': t('mention.unseen') }, '@') : null,
      h('span.spacer'),
      sla,
      h('span.m-ticket-time', { title: fmtDate(tk.updatedAt) }, relTime(tk.updatedAt))),
    h('div.m-ticket-title', highlight(tk.title, terms)),
    tk.match ? h('div.m-ticket-match', { class: tk.match.source === 'internal' ? 'internal' : '' }, highlight(tk.match.text, terms)) : null,
    h('div.m-ticket-meta',
      lozenge(tk.status),
      h('span.m-ticket-prio', priorityIcon(tk.priority), h('span', t(`priority.${tk.priority}`))),
      tk.commentCount ? h('span.m-ticket-comments', { 'aria-label': t('m.comments', { n: tk.commentCount }) }, icon('comment'), String(tk.commentCount)) : null,
      h('span.spacer'),
      showAssignee ? avatar(tk.assignee, 'sm') : null));
}

export function ticketList(tickets, opts = {}) {
  return h('div.m-list', tickets.map((tk) => ticketCard(tk, opts)));
}

/** Filter chip (toggle). count: optional number shown in the chip */
export function chip(label, { active = false, count = null, onClick, href } = {}) {
  const attrs = { class: active ? 'active' : '', 'aria-pressed': href ? undefined : String(active) };
  const kids = [h('span', label), count !== null && count !== undefined ? h('span.m-chip-count', String(count)) : null];
  if (href) return h('a.m-chip', { ...attrs, href, 'data-link': '' }, kids);
  return h('button.m-chip', { ...attrs, type: 'button', onclick: onClick }, kids);
}

export function chipRow(chips, label) {
  return h('div.m-chips', { role: 'group', 'aria-label': label }, chips);
}

export function section(title, ...children) {
  return h('section.m-section', title ? h('h2.m-section-title', title) : null, ...children);
}

export function emptyState(ic, title, text, action = null) {
  return h('div.m-empty', h('div.m-empty-icon', icon(ic)), h('p.m-empty-title', title), text ? h('p.m-empty-text', text) : null, action);
}

export function skeletonList(n = 4) {
  return h('div.m-list', { 'aria-busy': 'true', 'aria-label': t('app.loading') },
    Array.from({ length: n }, () => h('div.m-card.m-skeleton', h('div.sk.sk-line.short'), h('div.sk.sk-line'), h('div.sk.sk-line.mid'))));
}

/** Row in a grouped list (settings style) */
export function listRow({ icon: ic, label, hint, href, onClick, danger = false, trailing = null, external = false }) {
  const kids = [
    ic ? h('span.m-row-icon', icon(ic)) : null,
    h('span.m-row-text', h('span.m-row-label', label), hint ? h('span.m-row-hint', hint) : null),
    trailing,
    href || external ? icon('chevron-right', 'm-row-chevron') : null,
  ];
  const cls = danger ? 'danger' : '';
  if (href) return h('a.m-row', { href, class: cls, ...(external ? {} : { 'data-link': '' }) }, kids);
  return h('button.m-row', { type: 'button', class: cls, onclick: onClick }, kids);
}
