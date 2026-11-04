// Ticket view (read-only in this version): header, description, attachments, timeline, details sheet.
// What a user may see is decided by the API (no internal notes, no history for users).
import { api } from '/js/api.js';
import { h, icon, avatar, lozenge, typeIcon, priorityIcon, fmtDate, relTime, fmtSize, richText } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { slaChip } from '/js/views/sla.js';
import { linkLabel } from '/js/views/links.js';
import { activityFieldLabel, activityValue } from '/js/activity.js';
import { replaceUrl } from '../router.js';
import { pullToRefresh } from '../ptr.js';
import { openSheet } from '../sheet.js';
import { section } from '../ui.js';

const isImage = (a) => /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
const desktopUrl = (tk) => `/browse/${encodeURIComponent(tk.key)}?ui=desktop`;

export async function renderTicket(page, ctx) {
  const key = decodeURIComponent(ctx.match[1]);
  page.title(key);
  page.body.replaceChildren(skeleton());
  let tk;
  const load = async () => {
    tk = (await api.ticket(key)).ticket;
    if (!page.isActive() && !page.el.isConnected) return;
    if (tk.key !== key && page.isActive()) replaceUrl(`/m/t/${encodeURIComponent(tk.key)}`);
    page.title(tk.key);
    draw();
  };
  const agent = state.isAgent;

  function draw() {
    page.action(h('button.m-iconbtn', { type: 'button', 'aria-label': t('m.ticket.details'), onclick: openDetails }, icon('info')));
    page.body.replaceChildren(
      header(),
      descriptionEl(),
      // Files of the ticket itself; files of a reply appear in its message
      tk.attachments.some((a) => !a.commentId) ? section(t('ticket.attachments'), attachmentsEl(tk.attachments.filter((a) => !a.commentId))) : null,
      section(t('ticket.activity'), timeline()),
      // Room for the reply bar
      h('div.m-reply-space'));
  }

  // ---------- Header ----------
  function person(label, user, extra) {
    return h('div.m-person',
      avatar(user, 'md'),
      h('div.m-person-text', h('span.m-person-label', label), h('span.m-person-name', user?.displayName || (user ? '—' : t('app.unassigned'))), extra ? h('span.m-person-extra', extra) : null));
  }
  function header() {
    return h('header.m-ticket-head',
      agent && tk.major ? h('div.m-banner.m-banner-major', icon('warning'), h('strong', t('major.title'))) : null,
      h('div.m-ticket-crumb', typeIcon(tk.type), h('span', t(`type.${tk.type}`)), h('span.m-dot', '·'), h('span', tk.projectName)),
      h('h2.m-ticket-h1', tk.title),
      h('div.m-ticket-badges',
        lozenge(tk.status),
        h('span.m-pill', priorityIcon(tk.priority), t(`priority.${tk.priority}`)),
        tk.sla ? slaPill(tk.sla) : null,
        tk.dueDate ? h('span.m-pill', `${t('ticket.dueDate')} ${fmtDate(tk.dueDate, false)}`) : null),
      h('div.m-people',
        person(agent ? t('ticket.assignee') : t('ticket.yourContact'), tk.assignee),
        person(t('ticket.reporter'), tk.reporter || { displayName: '—' })),
      h('button.m-btn.m-btn-block.m-details-btn', { type: 'button', onclick: openDetails }, icon('list'), t('m.ticket.allDetails'), icon('chevron-right', 'm-push-right')),
      h('div.m-ticket-dates', `${t('ticket.created')} ${fmtDate(tk.createdAt)} · ${t('ticket.updated')} ${relTime(tk.updatedAt)}`));
  }

  // ---------- Description ----------
  function mailNote(href) {
    return h('div.m-mail-note', icon('mail'), h('span', t('m.ticket.mailText')), h('a', { href }, t('m.ticket.mailOriginal')));
  }
  function descriptionEl() {
    return section(t('ticket.description'), h('div.m-card.m-desc',
      tk.description ? richText(tk.description) : h('p.m-muted', t('m.ticket.noDescription')),
      tk.descriptionHtml ? mailNote(desktopUrl(tk)) : null));
  }

  // ---------- Attachments ----------
  function attachmentsEl(list) {
    return h('div.m-attachments', list.map((a) => isImage(a)
      ? h('a.m-att.m-att-img', { href: `/api/attachments/${a.id}`, target: '_blank', rel: 'noopener', 'aria-label': `${a.filename} (${fmtSize(a.size)})` },
        h('img', { src: `/api/attachments/${a.id}`, alt: '', loading: 'lazy' }))
      : h('a.m-att.m-att-file', { href: `/api/attachments/${a.id}?download=1`, title: a.filename },
        icon('file'), h('span.m-att-name', a.filename), h('span.m-att-size', fmtSize(a.size)))));
  }

  // ---------- Timeline (oldest first, like a chat) ----------
  function timeline() {
    const items = tk.comments.map((c) => ({ at: c.createdAt, el: bubble(c) }));
    // History for agents: small grey lines (creation and changes); comments are already bubbles
    if (agent) for (const a of tk.activity) items.push({ at: a.createdAt, el: historyLine(a) });
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    if (!items.length) return h('p.m-muted.m-pad', t('ticket.noComments'));
    return h('div.m-timeline', items.map((i) => i.el));
  }

  function bubble(c) {
    const mine = c.author?.id && c.author.id === state.user.id;
    const files = tk.attachments.filter((a) => a.commentId === c.id);
    return h('article.m-msg', { class: [mine ? 'mine' : '', c.internal ? 'internal' : ''].filter(Boolean).join(' ') },
      mine ? null : avatar(c.author, 'sm'),
      h('div.m-msg-bubble',
        h('div.m-msg-head',
          h('strong', mine ? t('m.ticket.you') : c.author.displayName),
          c.internal ? h('span.m-msg-internal', icon('lock'), t('ticket.internal')) : null,
          c.source === 'email' ? h('span.m-msg-src', { title: t('source.email') }, icon('mail')) : null),
        richText(c.body),
        c.hasHtml ? mailNote(desktopUrl(tk)) : null,
        files.length ? attachmentsEl(files) : null,
        h('time.m-msg-time', { datetime: c.createdAt, title: fmtDate(c.createdAt) }, relTime(c.createdAt))));
  }

  function historyLine(a) {
    const who = a.user?.displayName || (a.action === 'sla' ? 'Helfi.Space' : t('m.ticket.system'));
    let detail = null;
    if (a.action === 'changed' && a.field !== 'description') detail = `${activityValue(a, a.oldValue)} → ${activityValue(a, a.newValue)}`;
    else if (a.action === 'sla') detail = `${t(`sla.kind.${a.field}`)} ${t(`sla.state.${a.newValue}`)}`;
    else if (a.action === 'approval') detail = t(`change.decision.${a.field}`);
    else if ((a.action === 'linked' || a.action === 'unlinked') && a.field) detail = `${linkLabel(...a.field.split(':'))} ${a.newValue || a.oldValue || ''}`;
    else if (a.action === 'rated') detail = '★'.repeat(Number(a.newValue) || 0);
    else if (['attached', 'detached', 'participantAdded', 'participantRemoved', 'ciLinked', 'ciUnlinked', 'approvalRequested', 'kbCreated'].includes(a.action)) detail = a.newValue || a.oldValue;
    const what = t(`act.${a.action}`, { field: activityFieldLabel(a) });
    return h('div.m-event',
      h('span.m-event-text', h('strong', who), ' ', what, detail ? [what.endsWith(':') ? ' ' : ': ', h('span.m-event-detail', detail)] : null),
      h('time', { datetime: a.createdAt, title: fmtDate(a.createdAt) }, ` · ${relTime(a.createdAt)}`));
  }

  // ---------- Details sheet ----------
  function openDetails() {
    const row = (label, value) => (value === null || value === undefined ? null : h('div.m-drow', h('dt', label), h('dd', value)));
    const none = () => h('span.m-muted', t('app.none'));
    const withIcon = (ic, text) => h('span.m-inline', ic, h('span', text));
    const level = (v) => (v ? t(`level.${v}`) : none());
    const people = (list) => (list.length ? h('div.m-chips-wrap', list.map((p) => h('span.m-person-chip', avatar(p, 'xs'), h('span', p.displayName)))) : none());
    const links = tk.links || [];
    const cis = tk.cis || [];
    const content = h('dl.m-details',
      row(t('m.filter.status'), lozenge(tk.status)),
      row(t('ticket.priority'), withIcon(priorityIcon(tk.priority), t(`priority.${tk.priority}`))),
      row(t('ticket.type'), withIcon(typeIcon(tk.type), t(`type.${tk.type}`))),
      row(agent ? t('ticket.assignee') : t('ticket.yourContact'), withIcon(avatar(tk.assignee, 'xs'), tk.assignee?.displayName || t('app.unassigned'))),
      row(t('ticket.reporter'), h('span.m-stack', withIcon(avatar(tk.reporter, 'xs'), tk.reporter?.displayName || '—'),
        tk.reporter?.email && tk.reporter.email !== tk.reporter.displayName ? h('span.m-muted', tk.reporter.email) : null)),
      row(t('ticket.participants'), people(tk.participants || [])),
      tk.sla ? row(t('sla.kind.response'), slaChip(tk.sla.response)) : null,
      tk.sla ? row(t('sla.kind.resolve'), slaChip(tk.sla.resolve)) : null,
      agent ? row(t('itil.impact'), level(tk.impact)) : null,
      agent ? row(t('itil.urgency'), level(tk.urgency)) : null,
      row(t('ticket.labels'), tk.labels.length ? h('div.m-chips-wrap', tk.labels.map((l) => (agent
        ? h('a.m-label', { href: `/m/tickets?label=${encodeURIComponent(l)}`, 'data-link': '' }, l)
        : h('span.m-label', l)))) : none()),
      row(t('ticket.dueDate'), tk.dueDate ? fmtDate(tk.dueDate, false) : none()),
      row(t('ticket.project'), `${tk.projectName} (${tk.projectKey})`),
      row(t('ticket.source'), withIcon(icon(tk.source === 'email' ? 'mail' : (tk.source === 'jira' ? 'download' : 'globe')), t(`source.${tk.source}`))),
      agent ? row(t('m.ticket.links'), links.length ? h('div.m-linked', links.map((l) => h('a.m-linked-item', { href: `/m/t/${encodeURIComponent(l.ticket.key)}`, 'data-link': '' },
        h('span.m-muted.m-linked-kind', linkLabel(l.kind, l.direction)),
        h('span.m-linked-main', typeIcon(l.ticket.type), h('strong', l.ticket.key), h('span.m-linked-title', l.ticket.title)),
        lozenge(l.ticket.status)))) : none()) : null,
      agent && cis.length ? row(t('m.ticket.cis'), String(cis.length)) : null,
      row(t('ticket.created'), fmtDate(tk.createdAt)),
      row(t('ticket.updated'), fmtDate(tk.updatedAt)),
      tk.resolvedAt ? row(t('ticket.resolved'), fmtDate(tk.resolvedAt)) : null);
    openSheet({ title: `${tk.key} · ${t('ticket.details')}`, content, className: 'm-sheet-details' });
  }

  await load();
  pullToRefresh(page, load);
}

/** SLA in the header: the clock that is still running (first response, then resolution) */
function slaPill(sla) {
  const running = (c) => ['ok', 'warning', 'breached'].includes(c.state);
  const kind = running(sla.response) ? 'response' : 'resolve';
  return h('span.m-sla', h('span.m-sla-kind', t(`sla.kind.${kind}`)), slaChip(sla[kind]));
}

function skeleton() {
  return h('div.m-ticket-head.m-skeleton-block', { 'aria-busy': 'true', 'aria-label': t('app.loading') },
    h('div.sk.sk-line.short'), h('div.sk.sk-title'), h('div.sk.sk-line.mid'), h('div.sk.sk-line'), h('div.sk.sk-box'));
}
