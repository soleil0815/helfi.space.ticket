// Ticketansicht (Jira-ähnlich, zweispaltig) und Dialog "Ticket erstellen"
import { api } from '../api.js';
import {
  h, mount, icon, avatar, lozenge, typeIcon, priorityIcon, fmtDate, relTime, fmtSize,
  richText, toast, modal, dropdown, field, select,
} from '../dom.js';
import { t } from '../i18n.js';
import { state, navigate, route } from '../app.js';

const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
const TYPES = ['incident', 'request', 'task', 'question'];
const PRIOS = ['highest', 'high', 'medium', 'low'];

export async function renderTicket(content, key) {
  let tk = (await api.ticket(key)).ticket;
  if (tk.key !== key) history.replaceState({}, '', `/browse/${tk.key}`);
  document.title = `[${tk.key}] ${tk.title} – Helfi.Space`;
  const agent = state.isAgent;
  const canEditText = agent || tk.reporter?.id === state.user.id;
  let tab = 'comments';

  const save = async (patch) => {
    try {
      tk = { ...tk, ...(await api.updateTicket(tk.key, patch)).ticket };
      // Neuer Schlüssel nach Projektwechsel → Adresse anpassen
      if (location.pathname !== `/browse/${tk.key}`) history.replaceState({}, '', `/browse/${tk.key}`);
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  };
  const refresh = async () => { tk = (await api.ticket(tk.key)).ticket; draw(); };

  // ---------- Bausteine ----------
  function titleEl() {
    const el = h('h1.ticket-title', { tabindex: canEditText ? 0 : -1, class: canEditText ? 'editable' : '' }, tk.title);
    if (!canEditText) return el;
    const edit = () => {
      const input = h('input.title-input', { value: tk.title, maxLength: 255 });
      const done = async (commit) => {
        if (commit && input.value.trim() && input.value.trim() !== tk.title) await save({ title: input.value.trim() });
        else draw();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
      el.replaceWith(input);
      input.focus();
      input.select();
    };
    el.addEventListener('click', edit);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') edit(); });
    return el;
  }

  function descriptionEl() {
    const box = h('div.desc', { class: canEditText ? 'editable' : '', tabindex: canEditText ? 0 : -1 },
      tk.description ? richText(tk.description) : h('p.placeholder', canEditText ? t('ticket.noDescription') : t('app.emptyValue')));
    if (!canEditText) return box;
    const edit = () => {
      const ta = h('textarea.desc-input', { rows: Math.min(20, Math.max(6, tk.description.split('\n').length + 2)) }, tk.description);
      ta.value = tk.description;
      const wrap = h('div.desc-edit', ta, h('div.actions',
        h('button.btn.btn-primary', { type: 'button', onclick: () => save({ description: ta.value }) }, t('app.save')),
        h('button.btn.btn-subtle', { type: 'button', onclick: () => draw() }, t('app.cancel'))));
      box.replaceWith(wrap);
      ta.focus();
    };
    box.addEventListener('click', (e) => { if (!e.target.closest('a')) edit(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === box) edit(); });
    return box;
  }

  function attachmentsEl() {
    const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => uploadFiles(input.files) });
    const list = tk.attachments.map((a) => {
      const isImg = /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
      return h('div.attachment',
        h('a.attachment-thumb', { href: `/api/attachments/${a.id}`, target: '_blank', rel: 'noopener' },
          isImg ? h('img', { src: `/api/attachments/${a.id}`, alt: a.filename, loading: 'lazy' }) : icon('file')),
        h('div.attachment-meta',
          h('a', { href: `/api/attachments/${a.id}?download=1`, title: a.filename }, a.filename),
          h('span.muted', `${fmtSize(a.size)} · ${relTime(a.createdAt)}`)),
        agent ? h('button.btn-icon.small', {
          type: 'button', title: t('app.delete'),
          onclick: async () => { if (confirm(t('app.confirmDelete'))) { await api.deleteAttachment(a.id); refresh(); } },
        }, icon('trash')) : null);
    });
    return h('section.ticket-section',
      h('div.section-head', h('h3', t('ticket.attachments'), tk.attachments.length ? h('span.count', tk.attachments.length) : null),
        h('button.btn.btn-subtle.small', { type: 'button', onclick: () => input.click() }, icon('paperclip'), t('ticket.addAttachment'))),
      input,
      list.length ? h('div.attachments', list) : null);
  }

  async function uploadFiles(files) {
    if (!files?.length) return;
    try { await api.upload(tk.key, [...files]); await refresh(); }
    catch (e) { toast(e.message, 'error'); }
  }

  function activityEl() {
    const tabs = h('div.tabs', [['comments', t('ticket.comments')], ...(agent ? [['history', t('ticket.history')], ['all', t('ticket.all')]] : [])]
      .map(([id, label]) => h('button.tab', { type: 'button', class: tab === id ? 'active' : '', onclick: () => { tab = id; draw(); } }, label)));

    const items = [];
    if (tab !== 'history') for (const c of tk.comments) items.push({ at: c.createdAt, el: commentEl(c) });
    if (tab !== 'comments') for (const a of tk.activity) items.push({ at: a.createdAt, el: historyEl(a) });
    items.sort((a, b) => (a.at < b.at ? 1 : -1)); // neueste oben, wie in Jira

    return h('section.ticket-section',
      h('h3', t('ticket.activity')),
      tabs,
      tab !== 'history' ? composer() : null,
      items.length ? h('div.activity', items.map((i) => i.el)) : h('p.muted', t('ticket.noComments')));
  }

  function commentEl(c) {
    return h('div.comment', { class: c.internal ? 'internal' : '' },
      avatar(c.author, 'md'),
      h('div.comment-main',
        h('div.comment-head',
          h('strong', c.author.displayName),
          c.internal ? h('span.badge.badge-internal', icon('lock'), t('ticket.internal')) : null,
          c.source === 'email' ? h('span.badge', icon('mail'), t('source.email')) : null,
          h('span.muted', { title: fmtDate(c.createdAt) }, relTime(c.createdAt))),
        richText(c.body)));
  }

  function historyEl(a) {
    const fieldLabel = a.field ? t(`field.${a.field}`) : '';
    const show = (v) => {
      if (v === null || v === undefined || v === '') return t('app.none');
      if (a.field === 'status') return t(`status.${v}`);
      if (a.field === 'priority') return t(`priority.${v}`);
      if (a.field === 'type') return t(`type.${v}`);
      return v;
    };
    return h('div.history',
      avatar(a.user, 'sm'),
      h('div',
        h('strong', a.user?.displayName || 'E-Mail'), ' ',
        t(`act.${a.action}`, { field: fieldLabel }),
        a.action === 'changed' && a.field !== 'description' ? h('span.change', h('span.old', show(a.oldValue)), ' → ', h('span.new', show(a.newValue))) : null,
        a.action === 'attached' || a.action === 'detached' ? h('span.change', a.newValue || a.oldValue) : null,
        a.action === 'imported' ? h('span.change', a.oldValue, a.newValue ? ` · ${t('act.importedAssignee', { value: a.newValue })}` : '') : null,
        h('span.muted', { title: fmtDate(a.createdAt) }, ' · ', relTime(a.createdAt))));
  }

  function composer() {
    let internal = false;
    const ta = h('textarea', { rows: 3, placeholder: t('ticket.addComment') });
    const hint = h('div.hint');
    const modeBtns = agent ? h('div.composer-modes',
      h('button.mode.active', { type: 'button', onclick: (e) => setMode(false, e.currentTarget) }, t('ticket.reply')),
      h('button.mode', { type: 'button', onclick: (e) => setMode(true, e.currentTarget) }, icon('lock'), t('ticket.internalNote'))) : null;
    const box = h('div.composer', avatar(state.user, 'md'), h('div.composer-main', modeBtns, ta, hint,
      h('div.actions',
        h('button.btn.btn-primary', { type: 'button', onclick: submit }, t('app.save')),
        h('span.muted.small', 'Ctrl+Enter'))));
    function setMode(isInternal, btn) {
      internal = isInternal;
      modeBtns.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b === btn));
      box.classList.toggle('internal', internal);
      hint.textContent = internal ? t('ticket.internalHint') : (tk.reporter?.email && tk.reporter.id !== state.user.id ? t('ticket.replyHint') : '');
    }
    async function submit() {
      if (!ta.value.trim()) return;
      try { await api.comment(tk.key, ta.value, internal); await refresh(); }
      catch (e) { toast(e.message, 'error'); }
    }
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); });
    if (agent) setTimeout(() => setMode(false, modeBtns.querySelector('.mode')), 0);
    return box;
  }

  // ---------- Rechte Spalte ----------
  function statusButton() {
    if (!agent) return lozenge(tk.status);
    return h(`button.status-btn.status-${tk.status}`, {
      type: 'button',
      onclick: (e) => dropdown(e.currentTarget, STATUSES.map((s) => ({ label: t(`status.${s}`), active: s === tk.status, onClick: () => save({ status: s }) }))),
    }, t(`status.${tk.status}`), icon('chevron-down'));
  }

  function detailRow(label, valueEl) { return h('div.detail-row', h('div.detail-label', label), h('div.detail-value', valueEl)); }

  function pick(current, options, onPick, render) {
    if (!agent) return render(current);
    return h('button.detail-pick', {
      type: 'button',
      onclick: (e) => dropdown(e.currentTarget, options.map(([v, label, ic]) => ({ label, icon: ic, active: v === current, onClick: () => onPick(v) }))),
    }, render(current));
  }

  function sidePanel() {
    const assignee = h('div',
      pick(tk.assignee?.id ?? null, [[null, t('app.unassigned'), avatar(null, 'sm')], ...state.agents.map((a) => [a.id, a.displayName, avatar(a, 'sm')])],
        (v) => save({ assigneeId: v }),
        () => h('span.person', avatar(tk.assignee, 'sm'), h('span', tk.assignee?.displayName || t('app.unassigned')))),
      agent && tk.assignee?.id !== state.user.id ? h('button.link', { type: 'button', onclick: () => save({ assigneeId: state.user.id }) }, t('ticket.assignToMe')) : null);

    const labels = (() => {
      const view = h('div.labels', tk.labels.length ? tk.labels.map((l) => h('a.label', { href: `/issues?label=${encodeURIComponent(l)}`, 'data-link': '' }, l)) : h('span.muted', t('app.none')));
      if (!agent) return view;
      const wrap = h('div.editable-inline', { tabindex: 0 }, view);
      const edit = () => {
        const input = h('input', { value: tk.labels.join(', '), placeholder: t('create.labelsHint') });
        const done = (commit) => (commit ? save({ labels: input.value }) : draw());
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
        input.addEventListener('blur', () => done(true));
        wrap.replaceWith(input);
        input.focus();
      };
      wrap.addEventListener('click', (e) => { if (!e.target.closest('a')) edit(); });
      return wrap;
    })();

    const due = agent
      ? h('input.input-inline', { type: 'date', value: tk.dueDate || '', onchange: (e) => save({ dueDate: e.target.value || null }) })
      : h('span', tk.dueDate ? fmtDate(tk.dueDate, false) : t('app.none'));

    return h('aside.ticket-side',
      h('div.side-top', statusButton(),
        h('button.btn-icon', {
          type: 'button', title: t('ticket.copyLink'),
          onclick: async () => { try { await navigator.clipboard.writeText(location.href); toast(t('ticket.linkCopied')); } catch { /* egal */ } },
        }, icon('link')),
        state.isAdmin ? h('button.btn-icon', {
          type: 'button', title: t('ticket.delete'),
          onclick: async () => { if (confirm(`${tk.key}: ${t('app.confirmDelete')}`)) { await api.deleteTicket(tk.key); navigate('/issues'); } },
        }, icon('trash')) : null),
      h('div.details-box',
        h('div.details-head', t('ticket.details')),
        detailRow(t('ticket.assignee'), assignee),
        detailRow(t('ticket.reporter'), h('span.person', avatar(tk.reporter, 'sm'), h('span', tk.reporter?.displayName || '—', tk.reporter?.email && tk.reporter.email !== tk.reporter.displayName ? h('span.muted.block', tk.reporter.email) : null))),
        detailRow(t('ticket.priority'), pick(tk.priority, PRIOS.map((p) => [p, t(`priority.${p}`), priorityIcon(p)]), (v) => save({ priority: v }),
          (v) => h('span.person', priorityIcon(v), h('span', t(`priority.${v}`))))),
        detailRow(t('ticket.type'), pick(tk.type, TYPES.map((p) => [p, t(`type.${p}`), typeIcon(p)]), (v) => save({ type: v }),
          (v) => h('span.person', typeIcon(v), h('span', t(`type.${v}`))))),
        detailRow(t('ticket.labels'), labels),
        detailRow(t('ticket.dueDate'), due),
        detailRow(t('ticket.project'), agent && state.projects.length > 1
          ? pick(tk.projectId, state.projects.map((p) => [p.id, `${p.name} (${p.key})`]), (v) => save({ projectId: v }), () => h('span', tk.projectName))
          : h('span', tk.projectName)),
        detailRow(t('ticket.source'), h('span.person', icon(tk.source === 'email' ? 'mail' : (tk.source === 'jira' ? 'download' : 'globe')), h('span', t(`source.${tk.source}`)))),
      ),
      h('div.timestamps',
        h('div', `${t('ticket.created')} ${fmtDate(tk.createdAt)}`),
        h('div', `${t('ticket.updated')} ${fmtDate(tk.updatedAt)}`),
        tk.resolvedAt ? h('div', `${t('ticket.resolved')} ${fmtDate(tk.resolvedAt)}`) : null));
  }

  function draw() {
    const page = h('div.ticket-page',
      h('div.ticket-main',
        h('div.breadcrumbs',
          h('a', { href: agent ? `/issues?project=${tk.projectKey}` : '/requests', 'data-link': '' }, tk.projectName), ' / ',
          h('span.crumb-key', typeIcon(tk.type), h('a', { href: `/browse/${tk.key}`, 'data-link': '' }, tk.key))),
        titleEl(),
        h('section.ticket-section', h('h3', t('ticket.description')), descriptionEl()),
        attachmentsEl(),
        activityEl()),
      sidePanel());
    // Dateien per Drag & Drop auf die Seite
    page.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); page.classList.add('file-drop'); } });
    page.addEventListener('dragleave', (e) => { if (!page.contains(e.relatedTarget)) page.classList.remove('file-drop'); });
    page.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); page.classList.remove('file-drop'); uploadFiles(e.dataTransfer.files); } });
    mount(content, page);
  }

  draw();
}

// ---------- Ticket erstellen ----------
export function openCreateDialog(defaults = {}) {
  if (!state.isAgent && !state.boot.allowSelfService) return;
  const agent = state.isAgent;
  const current = state.project;
  const project = select(state.projects.map((p) => [p.id, `${p.name} (${p.key})`]), defaults.projectId || current?.id);
  const type = select(TYPES.map((x) => [x, t(`type.${x}`)]), defaults.type || (agent ? 'task' : 'request'));
  const summary = h('input', { required: true, maxLength: 255 });
  const desc = h('textarea', { rows: 6, placeholder: t('create.descriptionHint') });
  const prio = select(PRIOS.map((x) => [x, t(`priority.${x}`)]), 'medium');
  const assignee = select([['', t('app.unassigned')], ...state.agents.map((a) => [a.id, a.displayName])], '');
  const labels = h('input', { placeholder: t('create.labelsHint') });
  const due = h('input', { type: 'date' });
  const files = h('input', { type: 'file', multiple: true });
  const another = h('input', { type: 'checkbox' });
  const err = h('div.form-error', { role: 'alert', hidden: true });

  const form = h('form#create-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      submitBtn.disabled = true;
      try {
        const body = { projectId: Number(project.value), type: type.value, title: summary.value.trim(), description: desc.value, priority: prio.value };
        if (agent) Object.assign(body, { assigneeId: assignee.value ? Number(assignee.value) : null, labels: labels.value, dueDate: due.value || null });
        const r = await api.createTicket(body);
        if (files.files.length) await api.upload(r.ticket.key, [...files.files]);
        toast(t('create.done', { key: r.ticket.key }), 'success');
        if (another.checked) { summary.value = ''; desc.value = ''; files.value = ''; summary.focus(); }
        else { dlg.close(); navigate(`/browse/${r.ticket.key}`); }
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    },
  },
  err,
  state.projects.length > 1 ? h('div.grid-2', field(t('create.project'), project), field(t('create.type'), type)) : field(t('create.type'), type),
  field(t('create.summary'), summary),
  field(t('create.description'), desc),
  h('div.grid-2', field(t('create.priority'), prio), agent ? field(t('create.assignee'), assignee) : h('div')),
  agent ? h('div.grid-2', field(t('create.labels'), labels), field(t('create.dueDate'), due)) : null,
  field(t('create.attachments'), files),
  );
  const submitBtn = h('button.btn.btn-primary', { type: 'submit', form: 'create-form' }, t('create.submit'));
  const dlg = modal(t('create.title'), form, {
    wide: true,
    footer: [h('label.check-inline', another, t('create.another')), h('span.spacer'),
      h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), submitBtn],
    onClose: () => { if (location.pathname === '/board' || location.pathname === '/issues' || location.pathname === '/requests' || location.pathname === '/my') route(); },
  });
}
