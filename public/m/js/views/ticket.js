// Ticket view: header with quick actions, approval and rating cards, description, attachments,
// chat-like timeline, details sheet and the reply bar at the bottom.
// What a user may see and do is decided by the API (no internal notes, no history, no agent
// fields for users); the UI only offers what the API allows for this account.
import { api } from '/js/api.js';
import { rememberTicket } from '/js/userdata.js';
import { h, icon, avatar, lozenge, typeIcon, priorityIcon, fmtDate, relTime, fmtSize, richText, toast } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { typesFor } from '/js/types.js';
import { slaChip } from '/js/views/sla.js';
import { linkLabel } from '/js/views/links.js';
import { activityFieldLabel, activityValue } from '/js/activity.js';
import { replaceUrl, go, dataChanged } from '../router.js';
import { pullToRefresh } from '../ptr.js';
import { openSheet } from '../sheet.js';
import { section } from '../ui.js';
import { replyBar } from '../reply.js';
import {
  openActionSheet, openStatusSheet, openAssigneeSheet, openPrioritySheet, openTypeSheet, openParticipantsSheet, openLinkSheet,
} from '../actions.js';

const isImage = (a) => /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
const desktopUrl = (tk) => `/browse/${encodeURIComponent(tk.key)}?ui=desktop`;

export async function renderTicket(page, ctx) {
  const key = decodeURIComponent(ctx.match[1]);
  page.title(key);
  page.body.replaceChildren(skeleton());
  let tk;
  let bar = null;
  const agent = state.isAgent;

  const load = async () => {
    const fresh = (await api.ticket(tk?.key || key)).ticket;
    if (!page.el.isConnected && !page.isActive()) { tk = fresh; return; }
    if (tk && fresh.key !== tk.key) bar?.rekey(tk.key, fresh.key);
    tk = fresh;
    rememberTicket(tk); // suggestions of the search field
    if (page.isActive() && location.pathname !== `/m/t/${encodeURIComponent(tk.key)}`) replaceUrl(`/m/t/${encodeURIComponent(tk.key)}`);
    page.title(tk.key);
    draw();
  };

  /** Keep the scroll position when the content is rebuilt */
  function draw() {
    const top = page.scroll.scrollTop;
    page.action(
      h('button.m-iconbtn', { type: 'button', 'aria-label': t('m.ticket.details'), onclick: openDetails }, icon('info')),
      h('button.m-iconbtn.m-more-btn', { type: 'button', 'aria-label': t('m.act.more'), onclick: openActions }, icon('more')));
    page.body.replaceChildren(...[
      header(),
      approvalCard(),
      ratingCard(),
      descriptionEl(),
      // Files of the ticket itself; files of a reply appear in its message
      tk.attachments.some((a) => !a.commentId) ? section(t('ticket.attachments'), attachmentsEl(tk.attachments.filter((a) => !a.commentId))) : null,
      activitySection(),
    ].filter(Boolean));
    page.scroll.scrollTop = top;
  }

  // ---------- Changes ----------
  /** Change fields: show at once (optimistic), then take what the server says; on error back + message */
  async function save(patch, optimistic = {}) {
    const before = tk;
    tk = { ...tk, ...optimistic };
    draw();
    try {
      tk = { ...tk, ...(await api.updateTicket(before.key, patch)).ticket };
      dataChanged();
      await load();
    } catch (e) {
      tk = before;
      draw();
      toast(e.message, 'error');
    }
  }
  const reloadAfterChange = async () => { dataChanged(); try { await load(); } catch (e) { toast(e.message, 'error'); } };

  // Title and description: agents and the reporter (as in the desktop UI; the API checks it)
  const canEditText = () => agent || tk.reporter?.id === state.user.id;
  function openEdit() {
    const title = h('input', { id: 'm-edit-title', value: tk.title, maxLength: 255, required: true, autocomplete: 'off', enterkeyhint: 'next' });
    const desc = h('textarea.m-textarea.m-edit-desc', { id: 'm-edit-desc', rows: 8 });
    desc.value = tk.description || '';
    const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
    const ok = h('button.m-btn.m-btn-primary', { type: 'submit', form: 'm-edit-form' }, t('app.save'));
    const form = h('form#m-edit-form.m-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const nt = title.value.trim();
        if (!nt) { err.textContent = t('m.new.titleMissing'); err.hidden = false; title.focus(); return; }
        const patch = {};
        if (nt !== tk.title) patch.title = nt;
        if (desc.value !== (tk.description || '')) patch.description = desc.value;
        if (!Object.keys(patch).length) { sheet.close(); return; }
        ok.disabled = true;
        try {
          await api.updateTicket(tk.key, patch);
          sheet.close();
          toast(t('app.saved'), 'success');
          await reloadAfterChange();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; ok.disabled = false; }
      },
    }, err,
    h('div.m-field', h('label', { for: 'm-edit-title' }, t('create.summary')), title),
    h('div.m-field', h('label', { for: 'm-edit-desc' }, t('create.description')), desc),
    tk.descriptionHtml ? h('p.m-muted.m-small', t('m.edit.mailHint')) : null);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); desc.focus(); } });
    const sheet = openSheet({
      title: t('m.edit.title'), content: form, className: 'm-sheet-tall m-sheet-edit',
      footer: [h('button.m-btn', { type: 'button', onclick: () => sheet.close() }, t('app.cancel')), ok],
    });
  }

  function openActions() {
    const canParticipants = tk.canManageParticipants || (tk.participants || []).length;
    openActionSheet(`${tk.key} · ${t('m.act.title')}`, [
      agent ? { id: 'status', icon: 'check', label: t('m.act.status'), hint: t(`status.${tk.status}`), onClick: statusSheet } : null,
      agent && tk.assignee?.id !== state.user.id ? { id: 'assign-me', iconEl: avatar(state.user, 'sm'), label: t('ticket.assignToMe'), onClick: assignToMe } : null,
      agent ? { id: 'assignee', icon: 'user', label: t('m.act.assignee'), hint: tk.assignee?.displayName || t('app.unassigned'), onClick: () => openAssigneeSheet(tk, save) } : null,
      agent ? { id: 'priority', iconEl: priorityIcon(tk.priority), label: t('m.act.priority'), hint: t(`priority.${tk.priority}`), onClick: () => openPrioritySheet(tk, save) } : null,
      agent ? { id: 'type', iconEl: typeIcon(tk.type), label: t('m.act.type'), hint: t(`type.${tk.type}`), onClick: () => openTypeSheet(tk, save, typesFor(true)) } : null,
      canEditText() ? { id: 'edit', icon: 'pencil', label: t('m.edit.title'), hint: t('m.edit.hint'), onClick: openEdit } : null,
      canParticipants ? { id: 'participants', icon: 'users', label: t('m.act.participants'), hint: (tk.participants || []).map((p) => p.displayName).join(', ') || t('m.part.none'), onClick: participants } : null,
      {
        id: 'copy', icon: 'link', label: t('ticket.copyLink'),
        onClick: async () => {
          try { await navigator.clipboard.writeText(`${location.origin}/browse/${encodeURIComponent(tk.key)}`); toast(t('ticket.linkCopied')); } catch { /* not allowed here */ }
        },
      },
      { id: 'desktop', icon: 'monitor', label: t('m.openDesktop'), onClick: () => location.assign(desktopUrl(tk)) },
    ]);
  }
  const statusSheet = () => openStatusSheet(tk, { save, onResolved: reloadAfterChange });
  const assignToMe = async () => {
    await save({ assigneeId: state.user.id }, { assignee: { id: state.user.id, displayName: state.user.displayName, username: state.user.username } });
    if (tk.assignee?.id === state.user.id) toast(t('m.act.assigned'), 'success');
  };
  const participants = () => openParticipantsSheet(() => tk, {
    changed: reloadAfterChange,
    left: () => { dataChanged(); go('/m', { replace: true, anim: 'none' }); },
  });

  // ---------- Header ----------
  function person(label, user, { onClick, extra } = {}) {
    const kids = [avatar(user, 'md'),
      h('span.m-person-text',
        h('span.m-person-label', label, onClick ? icon('chevron-down', 'm-person-chevron') : null),
        h('span.m-person-name', user?.displayName || (user ? '—' : t('app.unassigned'))), extra ? h('span.m-person-extra', extra) : null)];
    return onClick ? h('button.m-person.m-person-btn', { type: 'button', onclick: onClick, 'aria-label': `${label}: ${user?.displayName || t('app.unassigned')} – ${t('m.act.assignee')}` }, kids) : h('div.m-person', kids);
  }
  function header() {
    const statusEl = agent
      ? h('button.m-status-btn', { type: 'button', onclick: statusSheet, 'aria-label': t('m.act.changeStatus', { status: t(`status.${tk.status}`) }) }, lozenge(tk.status), icon('chevron-down'))
      : lozenge(tk.status);
    const prioEl = agent
      ? h('button.m-pill.m-pill-btn', { type: 'button', onclick: () => openPrioritySheet(tk, save), 'aria-label': `${t('ticket.priority')}: ${t(`priority.${tk.priority}`)} – ${t('m.act.priority')}` },
        priorityIcon(tk.priority), t(`priority.${tk.priority}`), icon('chevron-down'))
      : h('span.m-pill', priorityIcon(tk.priority), t(`priority.${tk.priority}`));
    const mine = tk.assignee?.id === state.user.id;
    return h('header.m-ticket-head',
      agent && tk.major ? h('div.m-banner.m-banner-major', icon('warning'), h('strong', t('major.title'))) : null,
      h('div.m-ticket-crumb', typeIcon(tk.type), h('span', t(`type.${tk.type}`)), h('span.m-dot', '·'), h('span', tk.projectName)),
      h('h2.m-ticket-h1', tk.title),
      h('div.m-ticket-badges',
        statusEl,
        prioEl,
        tk.sla ? slaPill(tk.sla) : null,
        tk.dueDate ? h('span.m-pill', `${t('ticket.dueDate')} ${fmtDate(tk.dueDate, false)}`) : null),
      h('div.m-people',
        person(agent ? t('ticket.assignee') : t('ticket.yourContact'), tk.assignee, agent ? { onClick: () => openAssigneeSheet(tk, save) } : {}),
        person(t('ticket.reporter'), tk.reporter || { displayName: '—' })),
      agent && !mine && tk.status !== 'done' ? h('button.m-btn.m-btn-block.m-assign-me', { type: 'button', onclick: assignToMe }, avatar(state.user, 'xs'), t('ticket.assignToMe')) : null,
      h('button.m-btn.m-btn-block.m-details-btn', { type: 'button', onclick: openDetails }, icon('list'), t('m.ticket.allDetails'), icon('chevron-right', 'm-push-right')),
      h('div.m-ticket-dates', `${t('ticket.created')} ${fmtDate(tk.createdAt)} · ${t('ticket.updated')} ${relTime(tk.updatedAt)}`));
  }

  // ---------- Approval (catalog request or change waiting for this person) ----------
  function approvalCard() {
    const catalog = tk.approval || null;
    const change = agent && tk.type === 'change' ? tk.change : null;
    const canDecide = (catalog?.canDecide) || (change?.canDecide && (change.approvals?.items || []).some((x) => !x.decision));
    if (!canDecide) {
      // Others only see the state of a catalog approval (as in the desktop box)
      if (!catalog) return null;
      return h('div.m-card.m-approval.m-approval-info', { class: `state-${catalog.state}` },
        h('div.m-approval-head', icon('shield'), h('strong', t('catalog.approval')), h(`span.m-approval-state.${catalog.state}`, t(`catalog.state.${catalog.state}`))),
        approverList(catalog.items));
    }
    const items = catalog?.canDecide ? catalog.items : change.approvals.items;
    const comment = h('textarea.m-textarea', { rows: 2, maxLength: 2000, placeholder: t('change.commentHint'), 'aria-label': t('change.commentHint') });
    let busy = false;
    const decide = async (decision, btn) => {
      if (busy) return;
      busy = true;
      for (const b of card.querySelectorAll('button')) b.disabled = true;
      btn.classList.add('busy');
      try {
        await api.decideApproval(tk.key, { decision, comment: comment.value.trim() });
        toast(t('m.approval.done'), 'success');
        await reloadAfterChange();
      } catch (e) {
        busy = false;
        for (const b of card.querySelectorAll('button')) b.disabled = false;
        btn.classList.remove('busy');
        toast(e.message, 'error');
      }
    };
    const card = h('section.m-card.m-approval', { 'aria-labelledby': 'm-approval-title' },
      h('div.m-approval-head', h('span.m-approval-icon', icon('shield')), h('div',
        h('h2#m-approval-title', t('m.approval.title')),
        h('p', catalog?.canDecide ? t('m.approval.textCatalog') : t('m.approval.textChange')))),
      approverList(items),
      comment,
      h('div.m-approval-actions',
        h('button.m-btn.m-btn-danger', { type: 'button', onclick: (e) => decide('reject', e.currentTarget) }, icon('close'), t('change.reject')),
        h('button.m-btn.m-btn-success', { type: 'button', onclick: (e) => decide('approve', e.currentTarget) }, icon('check'), t('change.approve'))));
    return card;
  }
  function approverList(items = []) {
    if (!items.length) return null;
    return h('ul.m-approvers', items.map((x) => h('li',
      avatar({ displayName: x.name }, 'xs'), h('span.m-approver-name', x.name),
      h(`span.m-approval-state.${x.decision || 'pending'}`, t(`change.decision.${x.decision || 'pending'}`)),
      x.comment ? h('span.m-approver-comment', `„${x.comment}“`) : null)));
  }

  // ---------- Rating (reporter of a resolved ticket, as in the desktop UI) ----------
  function ratingCard() {
    const r = tk.rating;
    if (agent || !r?.open) return null;
    const rate = async (n, withComment = false) => {
      try {
        await api.rateTicket(tk.key, { rating: n, ...(withComment ? { comment: comment.value } : {}) });
        if (withComment || !r.value) toast(t('m.rate.thanks'), 'success');
        await reloadAfterChange();
      } catch (e) { toast(e.message, 'error'); }
    };
    const comment = h('textarea.m-textarea', { rows: 2, maxLength: 2000, placeholder: t('survey.commentHint'), 'aria-label': t('survey.comment') });
    comment.value = r.comment || '';
    return h('section.m-card.m-rating',
      h('h2', r.value ? t('survey.yourRating') : t('survey.question')),
      h('div.m-stars', { role: 'radiogroup', 'aria-label': t('survey.question') }, [1, 2, 3, 4, 5].map((n) => h('button.m-star', {
        type: 'button', role: 'radio', 'aria-checked': String(r.value === n), 'aria-label': `${t('m.rate.star', { n })} – ${t(`survey.label.${n}`)}`,
        class: r.value && n <= r.value ? 'on' : '', onclick: () => rate(n),
      }, icon('star')))),
      r.value ? h('p.m-rating-label', t(`survey.label.${r.value}`)) : null,
      r.value ? h('div.m-rating-form', comment, h('button.m-btn', { type: 'button', onclick: () => rate(r.value, true) }, t('survey.sendComment'))) : null);
  }

  // ---------- Description ----------
  function mailNote(href) {
    return h('div.m-mail-note', icon('mail'), h('span', t('m.ticket.mailText')), h('a', { href }, t('m.ticket.mailOriginal')));
  }
  function descriptionEl() {
    const edit = canEditText() ? h('button.m-link.m-section-action', { type: 'button', onclick: openEdit, 'aria-label': t('m.edit.title') }, icon('pencil'), t('app.edit')) : null;
    return section(h('span.m-section-row', h('span', t('ticket.description')), edit), h('div.m-card.m-desc',
      tk.description ? richText(tk.description) : h('p.m-muted', t('m.ticket.noDescription')),
      tk.descriptionHtml ? mailNote(desktopUrl(tk)) : null));
  }

  // ---------- Attachments ----------
  function attachmentsEl(list) {
    return h('div.m-attachments', list.map((a) => (isImage(a)
      ? h('a.m-att.m-att-img', { href: `/api/attachments/${a.id}`, target: '_blank', rel: 'noopener', 'aria-label': `${a.filename} (${fmtSize(a.size)})` },
        h('img', { src: `/api/attachments/${a.id}`, alt: '', loading: 'lazy' }))
      : h('a.m-att.m-att-file', { href: `/api/attachments/${a.id}?download=1`, title: a.filename },
        icon('file'), h('span.m-att-name', a.filename), h('span.m-att-size', fmtSize(a.size))))));
  }

  // ---------- Timeline (oldest first, like a chat) ----------
  /** Comments only by default; agents can show the history lines too (remembered on this device) */
  function activitySection() {
    if (!agent || !tk.activity.length) return section(t('ticket.activity'), timeline(false));
    const showAll = readShowAll();
    const btn = (all, label) => h('button', {
      type: 'button', class: showAll === all ? 'active' : '', 'aria-pressed': String(showAll === all),
      onclick: () => { if (showAll !== all) { writeShowAll(all); draw(); } },
    }, label);
    return h('section.m-section',
      h('div.m-section-row.m-activity-head',
        h('h2.m-section-title', t('ticket.activity')),
        h('div.m-segmented.m-segmented-small', { role: 'group', 'aria-label': t('ticket.activity') },
          btn(false, t('ticket.comments')), btn(true, t('ticket.all')))),
      timeline(showAll));
  }

  function timeline(withHistory) {
    const items = tk.comments.map((c) => ({ at: c.createdAt, el: bubble(c) }));
    // History for agents (on request): small grey lines (creation and changes); comments are already bubbles
    if (agent && withHistory) for (const a of tk.activity) items.push({ at: a.createdAt, el: historyLine(a) });
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    if (!items.length) return h('p.m-muted.m-pad', t('ticket.noComments'));
    return h('div.m-timeline', items.map((i) => i.el));
  }

  function bubble(c) {
    const mine = c.author?.id && c.author.id === state.user.id;
    // Pictures shown in the text are not repeated below it
    const inline = new Set([...String(c.body).matchAll(/\]\(\/api\/attachments\/(\d+)\)/g)].map((m) => Number(m[1])));
    const files = tk.attachments.filter((a) => a.commentId === c.id && !inline.has(a.id));
    return h('article.m-msg', { class: [mine ? 'mine' : '', c.internal ? 'internal' : '', c.mentionsMe ? 'mentions-me' : ''].filter(Boolean).join(' '), 'data-id': String(c.id) },
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
    let after = null; // a change opens its own sheet only after this one is gone
    const row = (label, value) => (value === null || value === undefined ? null : h('div.m-drow', h('dt', label), h('dd', value)));
    const none = () => h('span.m-muted', t('app.none'));
    const withIcon = (ic, text) => h('span.m-inline', ic, h('span', text));
    const level = (v) => (v ? t(`level.${v}`) : none());
    const canRemove = (p) => agent || tk.reporter?.id === state.user.id || p.id === state.user.id;
    const list = tk.participants || [];
    const people = h('div.m-stack',
      list.length ? h('div.m-chips-wrap', list.map((p) => h('span.m-person-chip', avatar(p, 'xs'), h('span', p.displayName),
        canRemove(p) ? h('button.m-chip-x', {
          type: 'button', 'aria-label': t('m.reply.remove', { name: p.displayName }), title: t('ticket.removeParticipant'),
          onclick: async () => {
            try {
              await api.removeParticipant(tk.key, p.id);
              toast(t('m.part.removed', { name: p.displayName }));
              if (p.id === state.user.id && !agent && tk.reporter?.id !== state.user.id) { sheet.close(); dataChanged(); setTimeout(() => go('/m', { replace: true, anim: 'none' }), 50); return; }
              sheet.close();
              await reloadAfterChange();
            } catch (e) { toast(e.message, 'error'); }
          },
        }, icon('close')) : null))) : none(),
      tk.canManageParticipants ? h('button.m-link.m-add-link', { type: 'button', onclick: () => { after = participants; sheet.close(); } }, icon('plus'), t('m.part.add')) : null);
    const links = tk.links || [];
    const cis = tk.cis || [];
    const edit = (value, onClick, label) => (agent ? h('button.m-drow-edit', { type: 'button', onclick: () => { after = onClick; sheet.close(); }, 'aria-label': `${label} – ${t('app.edit')}` }, value, icon('chevron-right')) : value);
    const content = h('dl.m-details',
      row(t('m.filter.status'), edit(lozenge(tk.status), statusSheet, t('m.filter.status'))),
      row(t('ticket.priority'), edit(withIcon(priorityIcon(tk.priority), t(`priority.${tk.priority}`)), () => openPrioritySheet(tk, save), t('ticket.priority'))),
      row(t('ticket.type'), edit(withIcon(typeIcon(tk.type), t(`type.${tk.type}`)), () => openTypeSheet(tk, save, typesFor(true)), t('ticket.type'))),
      row(agent ? t('ticket.assignee') : t('ticket.yourContact'), edit(withIcon(avatar(tk.assignee, 'xs'), tk.assignee?.displayName || t('app.unassigned')), () => openAssigneeSheet(tk, save), t('ticket.assignee'))),
      row(t('ticket.reporter'), h('span.m-stack', withIcon(avatar(tk.reporter, 'xs'), tk.reporter?.displayName || '—'),
        tk.reporter?.email && tk.reporter.email !== tk.reporter.displayName ? h('span.m-muted', tk.reporter.email) : null)),
      row(t('ticket.participants'), people),
      tk.approval ? row(t('catalog.approval'), h(`span.m-approval-state.${tk.approval.state}`, t(`catalog.state.${tk.approval.state}`))) : null,
      tk.sla ? row(t('sla.kind.response'), slaChip(tk.sla.response)) : null,
      tk.sla ? row(t('sla.kind.resolve'), slaChip(tk.sla.resolve)) : null,
      agent ? row(t('itil.impact'), level(tk.impact)) : null,
      agent ? row(t('itil.urgency'), level(tk.urgency)) : null,
      row(t('ticket.labels'), tk.labels.length ? h('div.m-chips-wrap', tk.labels.map((l) => (agent
        ? h('a.m-label', { href: `/m/tickets?label=${encodeURIComponent(l)}`, 'data-link': '' }, l)
        : h('span.m-label', l)))) : none()),
      row(t('ticket.dueDate'), tk.dueDate ? fmtDate(tk.dueDate, false) : none()),
      row(t('ticket.project'), `${tk.projectName} (${tk.projectKey})`),
      row(t('ticket.source'), withIcon(icon(tk.source === 'email' ? 'mail' : (tk.source === 'jira' || tk.source === 'import' ? 'download' : 'globe')), t(`source.${tk.source}`))),
      agent ? row(t('m.ticket.links'), h('div.m-stack', links.length ? h('div.m-linked', links.map((l) => h('a.m-linked-item', { href: `/m/t/${encodeURIComponent(l.ticket.key)}`, 'data-link': '' },
        h('span.m-muted.m-linked-kind', linkLabel(l.kind, l.direction)),
        h('span.m-linked-main', typeIcon(l.ticket.type), h('strong', l.ticket.key), h('span.m-linked-title', l.ticket.title)),
        lozenge(l.ticket.status)))) : none(),
      h('button.m-link.m-add-link', { type: 'button', onclick: () => { after = () => openLinkSheet(tk, { onDone: reloadAfterChange }); sheet.close(); } }, icon('plus'), t('link.addLink')))) : null,
      agent && cis.length ? row(t('m.ticket.cis'), String(cis.length)) : null,
      row(t('ticket.created'), fmtDate(tk.createdAt)),
      row(t('ticket.updated'), fmtDate(tk.updatedAt)),
      tk.resolvedAt ? row(t('ticket.resolved'), fmtDate(tk.resolvedAt)) : null);
    const sheet = openSheet({ title: `${tk.key} · ${t('ticket.details')}`, content, className: 'm-sheet-details', onClose: () => after?.() });
  }

  await load();
  // Reply bar: built once, stays when the content is rebuilt (text, files, mode)
  bar = replyBar({
    getTicket: () => tk,
    onSent: async (comment) => {
      dataChanged();
      try { await load(); } catch (e) { toast(e.message, 'error'); }
      // Jump to the new message; pictures in it change the height once loaded
      const msg = comment && page.body.querySelector(`.m-msg[data-id="${comment.id}"]`);
      const sc = page.scroll;
      const toEnd = () => { sc.scrollTop = sc.scrollHeight; };
      toEnd();
      for (const img of msg?.querySelectorAll('img') || []) if (!img.complete) img.addEventListener('load', toEnd, { once: true });
      msg?.classList.add('m-msg-new');
    },
  });
  page.el.classList.add('has-reply');
  page.el.append(bar.el);
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

// "Comments" or "All" in the ticket timeline – per device, comments by default
const SHOW_ALL_KEY = 'helfi.m.activityAll';
function readShowAll() {
  try { return localStorage.getItem(SHOW_ALL_KEY) === '1'; } catch { return false; }
}
function writeShowAll(on) {
  try { if (on) localStorage.setItem(SHOW_ALL_KEY, '1'); else localStorage.removeItem(SHOW_ALL_KEY); } catch { /* ignore */ }
}
