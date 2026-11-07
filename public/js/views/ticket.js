// Ticket view (two columns) and "Create ticket" dialog
import { rememberTicket } from '../userdata.js';
import { api } from '../api.js';
import {
  h, mount, icon, avatar, lozenge, typeIcon, priorityIcon, fmtDate, relTime, fmtSize,
  richText, toast, modal, dropdown, field, select,
} from '../dom.js';
import { peoplePicker } from '../peoplepicker.js';
import { diffView, diffLegend } from '../diffview.js';
import { t } from '../i18n.js';
import { state, navigate, route, refreshQueueCounts } from '../app.js';
import { openTemplatePicker, templateDialog, fillPlaceholders } from './canned.js';
import { setPageShortcuts, openPalette } from '../shortcuts.js';
import { enableImagePaste, replacePending } from '../paste.js';
import { withEmoji } from '../emoji.js';
import { mailView } from '../mailview.js';
import { activityFieldLabel, activityValue, componentReason, resolutionDetail } from '../activity.js';
import { openResolveDialog } from './resolve.js';
import { linksSection, linkLabel } from './links.js';
import { majorBanner } from './major.js';
import { slaChip } from './sla.js';
import { problemSection, problemHint, createProblemButton } from './problem.js';
import { changeSection } from './change.js';
import { kbSuggestions, kbFromTicketButton } from './kb.js';
import { catalogApprovalBox } from './catalog.js';
import { ciSection } from './cmdb.js';
import { ratingBox } from './survey.js';
import { aiSummarySection, aiComposerTools, editorField } from '../aiassist.js';
import { createCommentField, commentView } from '../commentfield.js';

const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
import { TYPES, typesFor } from '../types.js';
import { projectComponents } from '../components.js';
const PRIOS = ['highest', 'high', 'medium', 'low'];

export async function renderTicket(content, key) {
  let tk = (await api.ticket(key)).ticket;
  rememberTicket(tk); // suggestions of the search field
  // Opening the ticket marks my mentions as seen: update the "Mentions me" count
  if (tk.comments?.some((c) => c.mentionsMe)) setTimeout(() => refreshQueueCounts(), 300);
  let linksEl = null; // links section (agents) – its form also opens from the button in the side panel
  // Navigated away meanwhile (route() has rebuilt): no longer set shortcuts, title or URL
  if (!content.isConnected) return;
  if (tk.key !== key) history.replaceState({}, '', `/browse/${tk.key}`);
  document.title = `[${tk.key}] ${tk.title} – Helfi.Space`;
  const agent = state.isAgent;
  const canEditText = agent || tk.reporter?.id === state.user.id;
  let tab = 'comments';
  // Components of the ticket's project (agents; empty list = field hidden unless one is set)
  let comps = agent ? await projectComponents(tk.projectId) : [];
  if (!content.isConnected) return;
  // A new ticket may still be with the AI (component detection runs in the background): look once more
  if (agent && state.boot.aiFeatures?.classify && comps.length && !tk.component && !tk.componentSuggestion && Date.now() - new Date(tk.createdAt).getTime() < 120000) {
    setTimeout(() => { if (content.isConnected && !tk.component && !tk.componentSuggestion) refresh().catch(() => {}); }, 8000);
  }

  const save = async (patch) => {
    try {
      tk = { ...tk, ...(await api.updateTicket(tk.key, patch)).ticket };
      // New key after project change → update URL
      if (content.isConnected && location.pathname !== `/browse/${tk.key}`) history.replaceState({}, '', `/browse/${tk.key}`);
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  };
  const refresh = async () => {
    tk = (await api.ticket(tk.key)).ticket;
    if (agent) comps = await projectComponents(tk.projectId); // project may have changed
    draw();
  };

  // ---------- Building blocks ----------
  function titleEl() {
    const el = h('h1.ticket-title', { tabindex: canEditText ? 0 : -1, class: canEditText ? 'editable' : '' }, tk.title);
    if (!canEditText) return el;
    const edit = () => {
      const input = h('input.title-input', { value: tk.title, maxLength: 255 });
      let finished = false; // Esc removes the field – the following “blur” must not save anymore
      const done = async (commit) => {
        if (finished) return;
        finished = true;
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
    // HTML email: toggle “Formatted | Text”; editing happens in the text version
    if (tk.descriptionHtml) return mailView(plainDescriptionEl, `/api/tickets/${encodeURIComponent(tk.key)}/mail-html`);
    return plainDescriptionEl();
  }

  function plainDescriptionEl() {
    const box = h('div.desc', { class: canEditText ? 'editable' : '', tabindex: canEditText ? 0 : -1 },
      tk.description ? richText(tk.description) : h('p.placeholder', canEditText ? t('ticket.noDescription') : t('app.emptyValue')));
    if (!canEditText) return box;
    const edit = () => {
      const ta = h('textarea.desc-input', { rows: Math.min(20, Math.max(6, tk.description.split('\n').length + 2)) }, tk.description);
      ta.value = tk.description;
      enableImagePaste(ta, { upload: (files) => api.upload(tk.key, files, { draft: true }) });
      const wrap = h('div.desc-edit', withEmoji(ta), h('div.actions',
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
    items.sort((a, b) => (a.at < b.at ? 1 : -1)); // newest first

    return h('section.ticket-section',
      h('h3', t('ticket.activity')),
      tabs,
      tab !== 'history' ? composer() : null,
      items.length ? h('div.activity', items.map((i) => i.el)) : h('p.muted', t('ticket.noComments')));
  }

  function commentEl(c) {
    return h('div.comment', { class: [c.internal ? 'internal' : '', c.mentionsMe ? 'mentions-me' : ''].filter(Boolean).join(' '), 'data-comment': String(c.id) },
      avatar(c.author, 'md'),
      h('div.comment-main',
        h('div.comment-head',
          h('strong', c.author.displayName),
          c.internal ? h('span.badge.badge-internal', icon('lock'), t('ticket.internal')) : null,
          c.source === 'email' ? h('span.badge', icon('mail'), t('source.email')) : null,
          h('span.muted', { title: fmtDate(c.createdAt) }, relTime(c.createdAt))),
        c.hasHtml ? mailView(() => richText(c.body), `/api/tickets/${encodeURIComponent(tk.key)}/mail-html?comment=${c.id}`) : commentView(c)));
  }

  async function showDescriptionChange(a) {
    try {
      const v = await api.descriptionVersion(tk.key, a.id);
      const diff = diffView(v.old, v.new);
      const old = h('details.prev-version', h('summary', t('ticket.previousVersion')), h('div.prev-text', richText(v.old || '—')));
      modal(t('ticket.descriptionChangeTitle', { who: v.user?.displayName || '—', when: fmtDate(v.createdAt) }),
        h('div', diffLegend(), diff || h('p.muted', t('kb.ver.same')), old), { wide: true });
    } catch (e) { toast(e.message, 'error'); }
  }

  function historyEl(a) {
    const fieldLabel = activityFieldLabel(a);
    const show = (v) => activityValue(a, v);
    return h('div.history',
      avatar(a.user, 'sm'),
      h('div',
        h('strong', a.user?.displayName || (['sla', 'classified', 'autoAssigned'].includes(a.action) ? 'Helfi.Space' : 'E-Mail')), ' ',
        t(`act.${a.action}`, { field: fieldLabel }),
        a.action === 'changed' && a.field !== 'description' ? h('span.change', h('span.old', show(a.oldValue)), ' → ', h('span.new', show(a.newValue))) : null,
        a.action === 'changed' && a.field === 'description' && a.hasText ? h('button.link.small', { type: 'button', onclick: () => showDescriptionChange(a) }, t('ticket.showChange')) : null,
        a.action === 'attached' || a.action === 'detached' ? h('span.change', a.newValue || a.oldValue) : null,
        a.action === 'participantAdded' || a.action === 'participantRemoved' || a.action === 'createdFor' ? h('span.change', a.newValue || a.oldValue) : null,
        a.action === 'rated' ? h('span.change', a.oldValue ? h('span.old', '★'.repeat(Number(a.oldValue))) : null, a.oldValue ? ' → ' : null, h('span.new', '★'.repeat(Number(a.newValue)))) : null,
        a.action === 'ciLinked' || a.action === 'ciUnlinked' ? h('span.change', a.newValue || a.oldValue) : null,
        a.action === 'approvalRequested' ? h('span.change', a.newValue) : null,
        a.action === 'kbCreated' ? h('span.change', h('a', { href: `/kb/${String(a.newValue).replace('KB-', '')}`, 'data-link': '' }, a.newValue)) : null,
        a.action === 'approval' ? h('span.change', t(`change.decision.${a.field}`), a.newValue ? ` – „${a.newValue}“` : '') : null,
        a.action === 'sla' ? h('span.change', t(`sla.kind.${a.field}`), ' ', t(`sla.state.${a.newValue}`)) : null,
        (a.action === 'linked' || a.action === 'unlinked') && a.field ? h('span.change', linkLabel(...a.field.split(':')), ' ', a.newValue || a.oldValue) : null,
        a.action === 'classified' ? h('span.change', h('span.new', a.newValue), ` (${componentReason(a)})`) : null,
        a.action === 'resolution' ? h('span.change', h('span.new', resolutionDetail(a))) : null,
        a.action === 'autoAssigned' ? h('span.change', h('span.new', a.newValue), ` (${t(`comp.role.${a.field}`, { name: a.oldValue })})`) : null,
        a.action === 'imported' ? h('span.change', a.oldValue, a.newValue ? ` · ${t('act.importedAssignee', { value: a.newValue })}` : '') : null,
        h('span.muted', { title: fmtDate(a.createdAt) }, ' · ', relTime(a.createdAt))));
  }

  function composer() {
    let internal = false;
    // Formatted field with one toolbar: AI · formatting · link · image · emoji · @ · canned responses
    const field = createCommentField({
      placeholder: t('ticket.addComment'), label: t('ticket.addComment'),
      onSubmit: () => submit(),
      // pasted/picked images: draft upload of this ticket, visible once the comment is saved
      uploadImage: (f) => api.upload(tk.key, [f], { draft: true }).then((r) => `/api/attachments/${r.ids[0]}`),
      mention: agent ? { getKey: () => tk.key, isInternal: () => internal } : null,
    });
    const hint = h('div.hint');
    const modeBtns = agent ? h('div.composer-modes',
      h('button.mode.active', { type: 'button', onclick: (e) => setMode(false, e.currentTarget) }, t('ticket.reply')),
      h('button.mode', { type: 'button', onclick: (e) => setMode(true, e.currentTarget) }, icon('lock'), t('ticket.internalNote'))) : null;
    // Canned responses (agents only): insert at the cursor position, replace placeholders
    const insertTemplate = (x) => field.insertMarkdown(fillPlaceholders(x.body, tk));
    const templateBtn = agent ? h('button.kb-tb-btn.cm-tb-text', {
      type: 'button', title: t('canned.insertHint'), 'data-shortcut': 'template',
      onmousedown: (e) => e.preventDefault(),
      onclick: (e) => {
        field.remember();
        openTemplatePicker(e.currentTarget, insertTemplate, {
          footer: [{
            label: t('canned.saveAs'), icon: icon('plus'),
            onClick: () => { if (field.isEmpty()) { toast(t('canned.emptyText'), 'error'); return; } templateDialog({ body: field.getValue() }); },
          }],
        });
      },
    }, icon('comment'), h('span.cm-tb-label', t('canned.toolbar')), icon('chevron-down')) : null;
    // AI suggestions (agents, only if set up in the administration)
    const ai = agent && (state.boot.aiFeatures?.reply || state.boot.aiFeatures?.rewrite)
      ? aiComposerTools(editorField(field), tk, { isInternal: () => internal, className: 'kb-tb-btn.cm-tb-text' }) : null;
    if (ai) field.slots.left.append(ai.button, h('span.kb-tb-sep'));
    if (templateBtn) field.slots.right.append(templateBtn);
    const box = h('div.composer', avatar(state.user, 'md'), h('div.composer-main', modeBtns, field.el, hint, ai?.note,
      h('div.actions',
        h('button.btn.btn-primary', { type: 'button', onclick: submit }, t('app.save')),
        h('span.muted.small', `${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter · ${t('paste.hint')}${agent ? ` · ${t('mention.hint')}` : ''}`))));
    function setMode(isInternal, btn) {
      internal = isInternal;
      modeBtns.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b === btn));
      box.classList.toggle('internal', internal);
      hint.textContent = internal ? t('ticket.internalHint') : (tk.reporter?.email && tk.reporter.id !== state.user.id ? t('ticket.replyHint') : '');
    }
    let sending = false;
    async function submit() {
      if (field.isEmpty() || sending) return;
      sending = true;
      try { await api.comment(tk.key, field.getValue(), internal, [], 'md'); field.mentions?.close(); field.destroy(); await refresh(); }
      catch (e) { toast(e.message, 'error'); }
      finally { sending = false; }
    }
    if (agent) setTimeout(() => setMode(false, modeBtns.querySelector('.mode')), 0);
    return box;
  }

  // ---------- Right column ----------
  function statusButton() {
    if (!agent) return lozenge(tk.status, tk.resolution);
    return h(`button.status-btn.status-${tk.status === 'done' && tk.resolution && tk.resolution !== 'done' ? tk.resolution : tk.status}`, {
      type: 'button',
      onclick: (e) => dropdown(e.currentTarget, [
        ...STATUSES.map((s) => ({ label: t(`status.${s}`), active: s === tk.status && !(s === 'done' && tk.resolution && tk.resolution !== 'done'), onClick: () => save({ status: s }) })),
        '-',
        // Close with a resolution: reason / original ticket in a dialog
        { label: t('resolve.rejectMenu'), icon: icon('close'), active: tk.resolution === 'rejected', onClick: () => openResolveDialog({ kind: 'rejected', keys: [tk.key], tk, onDone: refresh }) },
        { label: t('resolve.duplicateMenu'), icon: icon('copy'), active: tk.resolution === 'duplicate', onClick: () => openResolveDialog({ kind: 'duplicate', keys: [tk.key], tk, onDone: refresh }) },
      ]),
    }, tk.status === 'done' && tk.resolution && tk.resolution !== 'done' ? t(`resolution.${tk.resolution}`) : t(`status.${tk.status}`), icon('chevron-down'));
  }

  // AI component suggestion (suggest mode): accept or dismiss
  function suggestionBox() {
    const sg = tk.componentSuggestion;
    const run = async (call) => { try { await call(); await refresh(); } catch (e) { toast(e.message, 'error'); } };
    return h('div.ai-suggest', { title: sg.reason || '' },
      h('span.ai-suggest-text', icon('sparkle'), ' ', t('ai.suggests'), ' ', h('strong', sg.name)),
      sg.reason ? h('span.muted.small.block', sg.reason) : null,
      h('span.ai-suggest-actions',
        h('button.btn.btn-primary.small', { type: 'button', onclick: () => run(() => api.acceptSuggestion(tk.key)) }, t('ai.accept')),
        h('button.btn.btn-subtle.small', { type: 'button', onclick: () => run(() => api.dismissSuggestion(tk.key)) }, t('ai.dismiss'))));
  }

  // AI: "possible duplicate of IT-12" – close as duplicate (dialog with the original filled in) or dismiss
  function duplicateHint() {
    const d = tk.duplicateSuggestion;
    return h('div.ai-duplicate', { role: 'note' },
      h('div.ai-duplicate-text',
        icon('sparkle'), ' ', t('aiDup.hint'), ' ',
        h('a', { href: `/browse/${d.key}`, 'data-link': '' }, d.key), ' – ', h('span', d.title), ' ', lozenge(d.status),
        d.reason ? h('span.muted.block.small', d.reason) : null),
      h('div.ai-suggest-actions',
        h('button.btn.btn-primary.small', { type: 'button', onclick: () => openResolveDialog({ kind: 'duplicate', keys: [tk.key], tk, original: d.key, onDone: refresh }) }, t('resolve.duplicateBtn')),
        h('button.btn.btn-subtle.small', { type: 'button', onclick: async () => { try { await api.dismissDuplicate(tk.key); await refresh(); } catch (e) { toast(e.message, 'error'); } } }, t('aiDup.dismiss'))));
  }

  function detailRow(label, valueEl) { return h('div.detail-row', h('div.detail-label', label), h('div.detail-value', valueEl)); }

  function pick(current, options, onPick, render) {
    if (!agent) return render(current);
    return h('button.detail-pick', {
      type: 'button',
      onclick: (e) => dropdown(e.currentTarget, options.map(([v, label, ic]) => ({ label, icon: ic, active: v === current, onClick: () => onPick(v) }))),
    }, render(current));
  }

  // Request participants: see the ticket, can comment, get notified
  function participantsEl() {
    const list = tk.participants || [];
    const canRemove = (p) => agent || tk.reporter?.id === state.user.id || p.id === state.user.id;
    const chips = list.map((p) => h('span.chip', { title: p.email || p.displayName },
      avatar(p, 'xs'), h('span', p.displayName),
      p.contact && agent ? h('span.chip-mail', { title: t('ticket.contact') }, icon('mail')) : null,
      canRemove(p) ? h('button.chip-x', {
        type: 'button', title: t('ticket.removeParticipant'), 'aria-label': t('ticket.removeParticipant'),
        onclick: async () => {
          try {
            await api.removeParticipant(tk.key, p.id);
            if (p.id === state.user.id && !agent && tk.reporter?.id !== state.user.id) { navigate('/requests'); return; }
            await refresh();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, '×') : null));
    const box = h('div.participants', chips.length ? chips : h('span.muted', t('app.none')));
    if (!tk.canManageParticipants) return box;

    const add = h('button.link', { type: 'button', onclick: () => openPicker() }, icon('plus'), t('ticket.addParticipant'));
    box.append(add);
    function openPicker() {
      const input = h('input.input-inline', { type: 'search', placeholder: agent ? t('ticket.participantSearchAgent') : t('ticket.participantSearch'), 'aria-label': t('ticket.addParticipant') });
      add.replaceWith(input);
      peoplePicker(input, {
        allowEmail: agent,
        ad: agent && !!state.boot?.adPeople,
        exclude: () => new Set([tk.reporter?.id, ...list.map((p) => p.id)]),
        onPick: async (choice) => {
          try { await api.addParticipant(tk.key, choice); await refresh(); }
          catch (e) { toast(e.message, 'error'); draw(); }
        },
        onClose: () => draw(),
      });
      input.focus();
    }
    return box;
  }

  // Reporter: agents can change it (e.g. ticket entered for oneself by mistake)
  function reporterRow() {
    const show = () => h('span.person', avatar(tk.reporter, 'sm'), h('span', tk.reporter?.displayName || '—', tk.reporter?.email && tk.reporter.email !== tk.reporter.displayName ? h('span.muted.block', tk.reporter.email) : null));
    const box = h('div.reporter-row', { 'data-shortcut': 'reporter' }, show());
    if (!agent) return box;
    const change = h('button.link', { type: 'button', onclick: () => openSearch() }, t('ticket.changeReporter'));
    box.append(change);
    function openSearch() {
      const input = h('input.input-inline', { type: 'search', placeholder: t('create.reporterSearch'), 'aria-label': t('ticket.changeReporter') });
      box.replaceChildren(input);
      peoplePicker(input, {
        allowEmail: true,
        ad: !!state.boot?.adPeople,
        exclude: () => new Set([tk.reporter?.id]),
        onPick: (choice, person) => confirmReporter(choice, person?.displayName || choice.email),
        onClose: () => box.replaceChildren(show(), change),
      });
      input.focus();
    }
    function confirmReporter(choice, name) {
      const notify = h('input', { type: 'checkbox', checked: true });
      const ok = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
        ok.disabled = true;
        try {
          const r = await api.setReporter(tk.key, choice, notify.checked);
          dlg.close();
          toast(t('ticket.reporterChanged', { name: r.ticket.reporter?.displayName || name }), 'success');
          await refresh();
        } catch (e) { toast(e.message, 'error'); ok.disabled = false; }
      } }, t('ticket.changeReporter'));
      const dlg = modal(t('ticket.changeReporter'), h('div',
        h('p', t('ticket.changeReporterText', { name, key: tk.key })),
        h('p.muted', t('ticket.changeReporterKeep')),
        h('label.check-inline', notify, t('create.reporterNotify'))), {
        footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')), ok],
        onClose: () => box.replaceChildren(show(), change),
      });
    }
    return box;
  }

  let detailsOpen = false;
  function sidePanel() {
    const assignee = h('div', { 'data-shortcut': 'assignee' },
      pick(tk.assignee?.id ?? null, [[null, t('app.unassigned'), avatar(null, 'sm')], ...state.agents.map((a) => [a.id, a.displayName, avatar(a, 'sm')])],
        (v) => save({ assigneeId: v }),
        () => h('span.person', avatar(tk.assignee, 'sm'), h('span', tk.assignee?.displayName || t('app.unassigned')))),
      agent && tk.assignee?.id !== state.user.id ? h('button.link', { type: 'button', onclick: () => save({ assigneeId: state.user.id }) }, t('ticket.assignToMe')) : null);

    const labels = (() => {
      const view = h('div.labels', tk.labels.length ? tk.labels.map((l) => h('a.label', { href: `/issues?label=${encodeURIComponent(l)}`, 'data-link': '' }, l)) : h('span.muted', t('app.none')));
      if (!agent) return view;
      const wrap = h('div.editable-inline', { tabindex: 0, 'data-shortcut': 'labels' }, view);
      const edit = () => {
        const input = h('input', { value: tk.labels.join(', '), placeholder: t('create.labelsHint') });
        let finished = false; // Esc = cancel, even if “blur” follows
        const done = (commit) => { if (finished) return; finished = true; if (commit) save({ labels: input.value }); else draw(); };
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
        // Duplicate: link to the original (users only if they may see it – the server says 404 otherwise)
        tk.duplicateOf ? h('a.dup-of', { href: `/browse/${tk.duplicateOf}`, 'data-link': '' }, t('resolution.duplicateOf', { key: tk.duplicateOf })) : null,
        h('button.btn-icon', {
          type: 'button', title: t('ticket.copyLink'),
          onclick: async () => { try { await navigator.clipboard.writeText(location.href); toast(t('ticket.linkCopied')); } catch { /* ignore */ } },
        }, icon('link')),
        agent && (tk.type === 'incident' || tk.major) ? h('button.btn.btn-subtle.small', {
          type: 'button', class: tk.major ? 'major-on' : '', title: t('major.toggleHint'),
          onclick: async () => { await save({ major: !tk.major }); try { state.boot = await api.bootstrap(); } catch { /* ignore */ } route(); },
        }, icon('warning'), tk.major ? t('major.end') : t('major.mark')) : null,
        agent ? createProblemButton(tk) : null,
        agent ? kbFromTicketButton(tk) : null,
        // Quick access to links (the section itself is further down in the ticket)
        agent ? h('button.btn.btn-subtle.small', { type: 'button', 'data-shortcut': 'link', onclick: () => linksEl?.openLinkForm() }, icon('link'), t('link.addLink')) : null),
      h('div.details-box', { class: detailsOpen ? 'open' : '' },
        h('button.details-head', {
          type: 'button', 'aria-expanded': String(detailsOpen),
          onclick: (e) => {
            // collapsible only on smartphones; always open on large screens
            detailsOpen = !detailsOpen;
            const box = e.currentTarget.closest('.details-box');
            box.classList.toggle('open', detailsOpen);
            e.currentTarget.setAttribute('aria-expanded', String(detailsOpen));
          },
        }, h('span', t('ticket.details')),
        h('span.details-summary', [tk.assignee?.displayName || t('app.unassigned'), t(`priority.${tk.priority}`), t(`type.${tk.type}`), tk.component?.name].filter(Boolean).join(' · ')),
        icon('chevron-down', 'details-chevron')),
        tk.sla ? detailRow(t('sla.kind.response'), slaChip(tk.sla.response)) : null,
        tk.sla ? detailRow(t('sla.kind.resolve'), slaChip(tk.sla.resolve)) : null,
        detailRow(agent ? t('ticket.assignee') : t('ticket.yourContact'), assignee),
        detailRow(t('ticket.reporter'), reporterRow()),
        detailRow(t('ticket.participants'), participantsEl()),
        agent ? detailRow(t('itil.impact'), pick(tk.impact, [[null, t('app.none')], ...['high', 'medium', 'low'].map((v) => [v, t(`level.${v}`)])], (v) => save({ impact: v }),
          (v) => h('span', v ? t(`level.${v}`) : h('span.muted', t('app.none'))))) : null,
        agent ? detailRow(t('itil.urgency'), pick(tk.urgency, [[null, t('app.none')], ...['high', 'medium', 'low'].map((v) => [v, t(`level.${v}`)])], (v) => save({ urgency: v }),
          (v) => h('span', v ? t(`level.${v}`) : h('span.muted', t('app.none'))))) : null,
        detailRow(t('ticket.priority'), pick(tk.priority, PRIOS.map((p) => [p, t(`priority.${p}`), priorityIcon(p)]), (v) => save({ priority: v }),
          (v) => h('span.person', priorityIcon(v), h('span', t(`priority.${v}`))))),
        detailRow(t('ticket.type'), pick(tk.type, TYPES.map((p) => [p, t(`type.${p}`), typeIcon(p)]), (v) => save({ type: v }),
          (v) => h('span.person', typeIcon(v), h('span', t(`type.${v}`))))),
        agent && (comps.length || tk.component) ? detailRow(t('ticket.component'), h('div',
          pick(tk.component?.id ?? null,
            [[null, t('app.none')], ...comps.map((c) => [c.id, c.name])], (v) => save({ componentId: v }),
            () => (tk.component ? h('span', { title: comps.find((c) => c.id === tk.component.id)?.description || '' }, tk.component.name) : h('span.muted', t('app.none')))),
          tk.componentSuggestion ? suggestionBox() : null)) : null,
        detailRow(t('ticket.labels'), labels),
        detailRow(t('ticket.dueDate'), due),
        detailRow(t('ticket.project'), agent && state.projects.length > 1
          ? pick(tk.projectId, state.projects.map((p) => [p.id, `${p.name} (${p.key})`]), (v) => save({ projectId: v }), () => h('span', tk.projectName))
          : h('span', tk.projectName)),
        detailRow(t('ticket.source'), h('span.person', icon(tk.source === 'email' ? 'mail' : (tk.source === 'jira' || tk.source === 'import' ? 'download' : 'globe')), h('span', t(`source.${tk.source}`)))),
      ),
      h('div.timestamps',
        h('div', `${t('ticket.created')} ${fmtDate(tk.createdAt)}`),
        h('div', `${t('ticket.updated')} ${fmtDate(tk.updatedAt)}`),
        tk.resolvedAt ? h('div', `${t('ticket.resolved')} ${fmtDate(tk.resolvedAt)}`) : null));
  }

  function draw() {
    linksEl = agent ? linksSection(tk, refresh) : null;
    const page = h('div.ticket-page',
      h('div.ticket-main',
        h('div.breadcrumbs',
          h('a', { href: agent ? `/issues?project=${tk.projectKey}` : '/requests', 'data-link': '' }, tk.projectName), ' / ',
          h('span.crumb-key', typeIcon(tk.type), h('a', { href: `/browse/${tk.key}`, 'data-link': '' }, tk.key))),
        titleEl(),
        agent ? majorBanner(tk, refresh) : null,
        agent && tk.duplicateSuggestion ? duplicateHint() : null,
        agent ? problemHint(tk) : null,
        catalogApprovalBox(tk, refresh),
        ratingBox(tk, refresh, agent),
        h('section.ticket-section', h('h3', t('ticket.description')), descriptionEl()),
        agent && state.boot.aiFeatures?.summary ? aiSummarySection(tk) : null,
        agent && tk.type === 'problem' ? problemSection(tk, refresh) : null,
        agent && tk.type === 'change' ? changeSection(tk, refresh) : null,
        attachmentsEl(),
        linksEl,
        agent ? ciSection(tk, refresh) : null,
        activityEl()),
      sidePanel());
    // Files via drag & drop onto the page
    page.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); page.classList.add('file-drop'); } });
    page.addEventListener('dragleave', (e) => { if (!page.contains(e.relatedTarget)) page.classList.remove('file-drop'); });
    page.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); page.classList.remove('file-drop'); uploadFiles(e.dataTransfer.files); } });
    mount(content, page);
  }

  draw();

  // ---------- Keyboard shortcuts ----------
  const focusComment = () => {
    if (tab === 'history') { tab = 'comments'; draw(); }
    const ta = document.querySelector('.composer textarea');
    ta?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ta?.focus();
  };
  const click = (sel) => document.querySelector(sel)?.click();
  const keys = {
    m: focusComment,
    e: () => { if (canEditText) click('.ticket-title.editable'); },
  };
  if (agent) {
    Object.assign(keys, {
      i: () => { if (tk.assignee?.id !== state.user.id) save({ assigneeId: state.user.id }); },
      a: () => click('[data-shortcut=assignee] .detail-pick'),
      l: () => click('[data-shortcut=labels]'),
      '.': () => {
        const g = (k) => t(k);
        openPalette([
          ...STATUSES.filter((x) => x !== tk.status).map((x) => ({ group: g('list.status'), label: t(`status.${x}`), run: () => save({ status: x }) })),
          tk.assignee?.id !== state.user.id ? { group: g('ticket.assignee'), label: t('ticket.assignToMe'), hint: 'i', run: () => save({ assigneeId: state.user.id }) } : null,
          tk.assignee ? { group: g('ticket.assignee'), label: t('app.unassigned'), run: () => save({ assigneeId: null }) } : null,
          ...PRIOS.filter((x) => x !== tk.priority).map((x) => ({ group: g('ticket.priority'), label: t(`priority.${x}`), run: () => save({ priority: x }) })),
          ...TYPES.filter((x) => x !== tk.type).map((x) => ({ group: g('ticket.type'), label: t(`type.${x}`), run: () => save({ type: x }) })),
          ...comps.filter((c) => c.id !== tk.component?.id).map((c) => ({ group: g('ticket.component'), label: c.name, run: () => save({ componentId: c.id }) })),
          { group: g('ticket.comments'), label: t('ticket.addComment'), hint: 'm', run: focusComment },
          { group: g('ticket.comments'), label: t('canned.insertHint'), run: () => { focusComment(); setTimeout(() => click('[data-shortcut=template]'), 50); } },
          { group: g('ticket.labels'), label: t('keys.labels'), hint: 'l', run: () => click('[data-shortcut=labels]') },
          { group: g('link.title'), label: t('link.addLink'), run: () => linksEl?.openLinkForm() },
          { group: g('ticket.details'), label: t('ticket.copyLink'), run: async () => { try { await navigator.clipboard.writeText(location.href); toast(t('ticket.linkCopied')); } catch { /* ignore */ } } },
        ].filter(Boolean));
      },
    });
  }
  if (content.isConnected) setPageShortcuts(keys);
}

// ---------- Create ticket ----------
/**
 * Reporter in the create dialog (agents): "Me" by default; search accounts, AD people or enter an
 * email address – e.g. to enter a request that came in by phone or another mailbox for that person.
 * value(): {} (me) or { reporter: choice, notifyReporter }
 */
function reporterField() {
  let choice = null; // null = me
  let person = null;
  const notify = h('input', { type: 'checkbox', checked: true });
  const notifyRow = h('label.check-inline.reporter-notify', { hidden: true }, notify, t('create.reporterNotify'));
  const box = h('div.reporter-field');
  const label = h('label', t('ticket.reporter'));
  function draw() {
    notifyRow.hidden = !choice;
    if (!choice) {
      mount(box, h('span.person', avatar(state.user, 'sm'), h('span', t('create.reporterMe', { name: state.user.displayName }))),
        h('button.link', { type: 'button', onclick: search }, t('create.reporterOther')));
      return;
    }
    const name = person?.displayName || choice.email;
    const sub = person?.email || (person?.source === 'ad' ? person.username : '') || '';
    mount(box, h('span.person', avatar(person || { displayName: name }, 'sm'),
      h('span', name, sub && sub !== name ? h('span.muted.block', sub) : null),
      person?.source === 'ad' ? h('span.badge.badge-ad', { title: t('ticket.fromAd') }, 'AD') : null),
    h('button.link', { type: 'button', onclick: search }, t('create.reporterChange')),
    h('button.link', { type: 'button', onclick: () => { choice = null; person = null; draw(); } }, t('create.reporterReset')));
  }
  function search() {
    const input = h('input', { type: 'search', placeholder: t('create.reporterSearch'), 'aria-label': t('ticket.reporter') });
    mount(box, input);
    // Enter without a match must not send the form (the ticket would be created for oneself)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    peoplePicker(input, {
      allowEmail: true,
      ad: !!state.boot?.adPeople,
      onPick: (c, p) => {
        if (c.userId && c.userId === state.user.id) { choice = null; person = null; } else { choice = c; person = p; }
        draw();
      },
      onClose: () => draw(),
    });
    input.focus();
  }
  draw();
  return {
    el: h('div.field', label, box, notifyRow),
    value: () => (choice ? { reporter: choice, notifyReporter: notify.checked } : {}),
  };
}

export function openCreateDialog(defaults = {}) {
  if (!state.isAgent && !state.boot.allowSelfService) return;
  const agent = state.isAgent;
  const current = state.project;
  const project = select(state.projects.map((p) => [p.id, `${p.name} (${p.key})`]), defaults.projectId || current?.id);
  const type = select(typesFor(agent).map((x) => [x, t(`type.${x}`)]), defaults.type || (agent ? 'task' : 'request'));
  const summary = h('input', { required: true, maxLength: 255, value: defaults.title || '' });
  const desc = h('textarea', { rows: 6, placeholder: t('create.descriptionHint') });
  const descPaste = enableImagePaste(desc); // no ticket yet: upload images after creation
  const prio = select(PRIOS.map((x) => [x, t(`priority.${x}`)]), 'medium');
  const assignee = select([['', t('app.unassigned')], ...state.agents.map((a) => [a.id, a.displayName])], '');
  const labels = h('input', { placeholder: t('create.labelsHint') });
  const due = h('input', { type: 'date' });
  // Component (agents): empty = "by rules" – keywords/sender decide after saving
  const component = select([['', t('create.componentAuto')]], '');
  const componentField = field(t('create.component'), component);
  componentField.hidden = true;
  const loadComponents = async () => {
    const list = await projectComponents(Number(project.value));
    component.replaceChildren(...[['', t('create.componentAuto')], ...list.map((c) => [c.id, c.name])].map(([v, l]) => h('option', { value: v }, l)));
    componentField.hidden = !list.length;
  };
  if (agent) { loadComponents(); project.addEventListener('change', loadComponents); }
  const reporter = agent ? reporterField() : null;
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
        if (agent) Object.assign(body, { assigneeId: assignee.value ? Number(assignee.value) : null, labels: labels.value, dueDate: due.value || null, componentId: component.value ? Number(component.value) : null, ...reporter.value() });
        const pend = descPaste.takePending();
        if (pend.length) body.description = replacePending(body.description, new Map()); // replace placeholders only after uploading
        const r = await api.createTicket(body);
        if (files.files.length) await api.upload(r.ticket.key, [...files.files]);
        if (pend.length) {
          // upload pasted images and insert them into the description
          const { ids } = await api.upload(r.ticket.key, pend.map(([, f]) => f), { draft: true });
          const map = new Map(pend.map(([token], i) => [token, ids[i]]));
          await api.updateTicket(r.ticket.key, { description: replacePending(desc.value, map) });
        }
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
  agent ? reporter.el : null,
  state.projects.length > 1 ? h('div.grid-2', field(t('create.project'), project), field(t('create.type'), type)) : field(t('create.type'), type),
  field(t('create.summary'), summary),
  kbSuggestions(summary),
  field(t('create.description'), withEmoji(desc)),
  h('div.grid-2', field(t('create.priority'), prio), agent ? field(t('create.assignee'), assignee) : h('div')),
  agent ? h('div.grid-2', field(t('create.labels'), labels), field(t('create.dueDate'), due)) : null,
  agent ? componentField : null,
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
