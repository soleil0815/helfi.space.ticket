// Bottom sheets for ticket actions: action list, status (incl. resolve with closing reply),
// choice lists (assignee, priority, type), canned responses and participants.
// Every change goes through the same API calls as the desktop UI; the server decides what is allowed.
import { api } from '/js/api.js';
import { h, icon, avatar, toast } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { fillPlaceholders } from '/js/placeholders.js';
import { openSheet } from './sheet.js';
import { CHOICES } from '/js/views/links.js';

export const STATUSES = ['open', 'in_progress', 'waiting', 'done'];
export const PRIOS = ['highest', 'high', 'medium', 'low'];

/** List of big action rows. items: { icon, label, hint, onClick, danger } (null entries are skipped) */
// An action that opens the next sheet runs only after this one is gone (its history entry too).
export function openActionSheet(title, items) {
  let after = null;
  const sheet = openSheet({
    title,
    className: 'm-sheet-actions',
    onClose: () => after?.(),
    content: h('div.m-actions-list', items.filter(Boolean).map((it) => h('button.m-action', {
      type: 'button', class: it.danger ? 'danger' : '', 'data-action': it.id || undefined,
      onclick: () => { after = it.onClick; sheet.close(); },
    }, h('span.m-action-icon', it.iconEl || icon(it.icon)),
    h('span.m-action-text', h('span.m-action-label', it.label), it.hint ? h('span.m-action-hint', it.hint) : null),
    it.trailing || null))),
  });
  return sheet;
}

/**
 * Choice list with a check mark at the current value; optional search field (focus stays in it).
 * options: [{ value, label, sub, iconEl, keywords }]
 */
export function openChoiceSheet({ title, options, current, onPick, search = false, searchLabel = '', emptyText = t('app.none'), className = '' }) {
  const input = search ? h('input.m-sheet-search-input', { type: 'search', placeholder: searchLabel, 'aria-label': searchLabel, autocomplete: 'off', enterkeyhint: 'search' }) : null;
  const list = h('div.m-choices', { role: 'listbox', 'aria-label': title });
  let after = null;
  const draw = () => {
    const q = (input?.value || '').trim().toLowerCase();
    const hits = options.filter((o) => !q || `${o.label} ${o.sub || ''} ${o.keywords || ''}`.toLowerCase().includes(q));
    list.replaceChildren(...(hits.length ? hits.map((o) => {
      const on = o.value === current;
      return h('button.m-choice-row', {
        type: 'button', role: 'option', 'aria-selected': String(on), class: on ? 'active' : '', 'data-value': String(o.value ?? ''),
        onpointerdown: (e) => { if (input && document.activeElement === input) e.preventDefault(); },
        onclick: () => { if (!on) after = () => onPick(o.value, o); sheet.close(); },
      }, o.iconEl ? h('span.m-choice-icon', o.iconEl) : null,
      h('span.m-choice-text', h('span.m-choice-label', o.label), o.sub ? h('span.m-choice-sub', o.sub) : null),
      on ? h('span.m-choice-check', { 'aria-label': t('m.act.current') }, icon('check')) : null);
    }) : [h('p.m-sheet-empty', emptyText)]));
  };
  input?.addEventListener('input', draw);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.m-choice-row')?.click(); } });
  draw();
  const sheet = openSheet({
    title,
    className: ['m-sheet-choices', search ? 'm-sheet-tall' : '', className].filter(Boolean).join(' '),
    onClose: () => after?.(),
    content: [input ? h('div.m-sheet-search', h('div.m-search', icon('search'), input)) : null, list],
  });
  return sheet;
}

// ---------- Status ----------
/** save(patch, optimistic) applies a field change; resolved(text) after resolving */
export function openStatusSheet(tk, { save, onResolved }) {
  return openChoiceSheet({
    title: t('m.act.status'),
    current: tk.status === 'done' && tk.resolution && tk.resolution !== 'done' ? tk.resolution : tk.status,
    className: 'm-sheet-status',
    options: [
      ...STATUSES.map((s) => ({ value: s, label: t(`status.${s}`), iconEl: h(`span.m-status-dot.status-dot-${s}`) })),
      // Close with a resolution: rejected (reason required) or duplicate of another ticket
      { value: 'rejected', label: t('resolve.rejectMenu'), iconEl: h('span.m-status-dot.status-dot-rejected') },
      { value: 'duplicate', label: t('resolve.duplicateMenu'), iconEl: h('span.m-status-dot.status-dot-duplicate') },
    ],
    onPick: (s) => {
      if (s === 'done' || s === 'rejected' || s === 'duplicate') openResolveSheet(tk, { onResolved, kind: s });
      else save({ status: s }, { status: s });
    },
  });
}

/**
 * "Resolve": optional closing reply (with templates), same call as the desktop bulk resolve dialog.
 * kind 'rejected': reason required; 'duplicate': key of the original ticket required, note optional.
 */
export function openResolveSheet(tk, { onResolved, kind = 'done', original = '', internal: startInternal = false }) {
  // "Done": closing reply to the reporter (default) or internal note – like on the desktop
  const agentHere = tk.agentView ?? state.isAgent;
  let internal = kind === 'done' && agentHere && startInternal;
  const labelEl = h('label');
  const hintEl = h('p.m-field-hint');
  const kindBtns = kind === 'done' && agentHere ? [
    h('button', { type: 'button', 'data-done-kind': 'reply', onclick: () => setKind(false) }, t('bulk.asReply')),
    h('button', { type: 'button', 'data-done-kind': 'note', onclick: () => setKind(true) }, t('bulk.asNote')),
  ] : null;
  function setKind(isInternal) {
    internal = isInternal;
    kindBtns?.forEach((b, i) => { const on = i === (internal ? 1 : 0); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    labelEl.textContent = kind === 'rejected' ? t('resolve.reason') : kind === 'duplicate' ? t('resolve.note') : t(internal ? 'done.noteLabel' : 'm.resolve.label');
    hintEl.textContent = kind === 'rejected' ? t('resolve.reasonHint') : kind === 'duplicate' ? t('resolve.noteHint') : t(internal ? 'done.noteHint' : 'm.resolve.hint');
    ta?.classList.toggle('m-internal', internal);
  }
  const label = kind === 'rejected' ? t('resolve.reason') : kind === 'duplicate' ? t('resolve.note') : t('m.resolve.label');
  const ta = h('textarea.m-textarea', { rows: 5, placeholder: kind === 'rejected' ? t('resolve.reasonPlaceholder') : kind === 'duplicate' ? t('resolve.notePlaceholder') : t('bulk.commentPlaceholder'), 'aria-label': label });
  const orig = kind === 'duplicate' ? h('input.m-input', { type: 'text', value: original, autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, placeholder: t('resolve.originalPlaceholder'), 'aria-label': t('resolve.original') }) : null;
  let busy = false;
  const btn = h('button.m-btn.m-btn-primary', { type: 'button', onclick: () => submit() }, icon(kind === 'done' ? 'check' : kind === 'rejected' ? 'close' : 'copy'), kind === 'rejected' ? t('resolve.rejectBtn') : kind === 'duplicate' ? t('resolve.duplicateBtn') : t('bulk.resolve'));
  const tpl = agentHere ? h('button.m-btn.m-btn-ghost', {
    type: 'button',
    onclick: () => {
      const sel = [ta.selectionStart, ta.selectionEnd];
      const before = ta.value;
      let text = null;
      // The template sheet replaces this one; once it is gone the resolve sheet opens again with the text
      const keep = orig?.value || '';
      openCannedSheet(tk, (x) => { text = x; }, () => reopen(text === null ? before : before.slice(0, sel[0]) + text + before.slice(sel[1]), keep), { raw: true });
    },
  }, icon('comment'), t('m.reply.template')) : null;
  const reopen = (text, keep = '') => { const s = openResolveSheet(tk, { onResolved, kind, original: keep, internal }); const area = s.body.querySelector('textarea'); area.value = text; area.focus(); };
  async function submit() {
    if (busy) return;
    const text = ta.value.trim();
    if (kind === 'rejected' && !text) { toast(t('resolve.reasonRequired'), 'error'); ta.focus(); return; }
    if (orig && !orig.value.trim()) { toast(t('resolve.originalRequired'), 'error'); orig.focus(); return; }
    busy = true; btn.disabled = true;
    try {
      // Placeholders like {melder} are filled in by the server for this ticket
      const r = kind === 'done'
        ? await api.bulk({ keys: [tk.key], changes: { status: 'done' }, ...(text ? { comment: text, internal } : {}) })
        : await api.bulk({ keys: [tk.key], comment: text, resolve: { resolution: kind, duplicateOf: orig ? orig.value.trim().toUpperCase() : null } });
      if (r.failed.length) throw new Error(r.failed.map((x) => x.error).join(', '));
      sheet.close();
      toast(kind === 'done' ? t('m.resolve.done', { key: r.ok[0] || tk.key }) : kind === 'rejected' ? t('resolve.rejected') : t('resolve.duplicated', { key: orig.value.trim().toUpperCase() }), 'success');
      await onResolved?.();
    } catch (e) {
      busy = false; btn.disabled = false;
      toast(e.message, 'error');
    }
  }
  setKind(internal);
  const sheet = openSheet({
    title: kind === 'rejected' ? t('resolve.rejectTitle', { key: tk.key }) : kind === 'duplicate' ? t('resolve.duplicateTitle', { key: tk.key }) : t('m.resolve.title'),
    className: 'm-sheet-resolve',
    content: h('div.m-form',
      orig ? h('div.m-field', h('label', t('resolve.original')), orig, h('p.m-field-hint', t('resolve.originalHint'))) : null,
      kindBtns ? h('div.m-segmented.m-done-kind', { role: 'group', 'aria-label': t('bulk.kind') }, ...kindBtns) : null,
      h('div.m-field', labelEl, ta, hintEl),
      tpl ? h('div.m-form-tools', tpl) : null),
    footer: [h('button.m-btn', { type: 'button', onclick: () => sheet.close() }, t('app.cancel')), btn],
  });
  return sheet;
}

// ---------- Canned responses ----------
let cannedCache = null;
/** Per-account data kept in this module: dropped on sign-in, sign-out and expired sessions */
export function resetActionCaches() { cannedCache = null; }
/**
 * Template list with search (agents). onPick(text) gets the text with placeholders filled in
 * (opts.raw: unchanged, e.g. for the resolve reply where the server fills them in).
 * onClose runs after the sheet is gone (focus back to the text field there).
 */
export function openCannedSheet(tk, onPick, onClose, { raw = false } = {}) {
  const input = h('input.m-sheet-search-input', { type: 'search', placeholder: t('canned.search'), 'aria-label': t('canned.search'), autocomplete: 'off', enterkeyhint: 'search' });
  const list = h('div.m-canned', h('div.m-spinner'));
  let items = null;
  const draw = () => {
    if (!items) return;
    const q = input.value.trim().toLowerCase();
    // Matches in the name before matches in the text (as on the desktop)
    const score = (x) => {
      const ti = x.title.toLowerCase();
      if (!q) return 0;
      if (ti.startsWith(q)) return 3;
      if (ti.includes(q)) return 2;
      return x.body.toLowerCase().includes(q) ? 1 : -1;
    };
    const hits = items.map((x) => [score(x), x]).filter(([n]) => n >= 0).sort((a, b) => b[0] - a[0]).map(([, x]) => x);
    const row = (x) => h('button.m-canned-item', {
      type: 'button',
      onpointerdown: (e) => { if (document.activeElement === input) e.preventDefault(); },
      onclick: () => {
        onPick(raw ? x.body : fillPlaceholders(x.body, tk, state.user));
        sheet.close();
      },
    }, h('span.m-canned-title', x.title), h('span.m-canned-text', x.body.replace(/\s+/g, ' ').slice(0, 140)));
    const group = (label, arr) => (arr.length ? [h('h3.m-canned-group', label), ...arr.map(row)] : []);
    const nodes = q ? group(t('canned.results'), hits)
      : [...group(t('canned.shared'), hits.filter((x) => x.shared)), ...group(t('canned.personal'), hits.filter((x) => !x.shared))];
    list.replaceChildren(...(nodes.length ? nodes : [h('p.m-sheet-empty', items.length ? t('canned.noMatch') : t('canned.empty'))]));
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.m-canned-item')?.click(); } });
  const sheet = openSheet({
    title: t('canned.insertHint'),
    className: 'm-sheet-canned m-sheet-tall',
    content: [h('div.m-sheet-search', h('div.m-search', icon('search'), input)), list],
    onClose: () => onClose?.(),
  });
  (async () => {
    try {
      if (!cannedCache) cannedCache = (await api.canned.list()).responses;
      items = cannedCache;
      draw();
    } catch (e) { toast(e.message, 'error'); list.replaceChildren(h('p.m-sheet-empty', e.message)); }
  })();
  return sheet;
}

// ---------- Assignee, priority, type ----------
export function openAssigneeSheet(tk, save) {
  const me = state.user;
  // agents of the ticket's project only
  const others = state.agents.filter((a) => a.id !== me.id && (!Array.isArray(tk.assignableIds) || tk.assignableIds.includes(a.id)));
  const options = [
    { value: me.id, label: me.displayName, sub: t('m.assignee.me'), iconEl: avatar(me, 'sm'), keywords: me.username },
    ...others.map((a) => ({ value: a.id, label: a.displayName, sub: a.username !== a.displayName ? a.username : '', iconEl: avatar(a, 'sm'), keywords: a.email || '' })),
    { value: null, label: t('app.unassigned'), iconEl: avatar(null, 'sm') },
  ];
  return openChoiceSheet({
    title: t('m.act.assignee'), current: tk.assignee?.id ?? null, options, search: true,
    searchLabel: t('m.assignee.search'), emptyText: t('m.assignee.none'),
    onPick: (v, o) => save({ assigneeId: v }, { assignee: v ? { id: v, displayName: o.label } : null }),
  });
}

export function openPrioritySheet(tk, save) {
  return openChoiceSheet({
    title: t('m.act.priority'), current: tk.priority,
    options: PRIOS.map((p) => ({ value: p, label: t(`priority.${p}`), iconEl: h(`span.prio.prio-${p}`, icon(`prio-${p}`)) })),
    onPick: (v) => save({ priority: v }, { priority: v }),
  });
}

export function openTypeSheet(tk, save, types) {
  return openChoiceSheet({
    title: t('m.act.type'), current: tk.type,
    options: types.map((x) => ({ value: x, label: t(`type.${x}`), iconEl: h(`span.type-icon.type-${x}`, icon(`type-${x}`)) })),
    onPick: (v) => save({ type: v }, { type: v }),
  });
}

// ---------- Participants ----------
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/**
 * Participants: current list with × (same rules as the desktop) and a people search to add
 * (as peoplePicker: focus stays in the field, AD results for agents, email address for agents).
 * changed() reloads the ticket; left() when the user removed themselves and no longer sees the ticket.
 */
/**
 * People search in a sheet (port of the desktop peoplePicker): accounts, AD people (agents) and,
 * if allowed, a free email address. onChoose(choice, person) – return false to keep the input.
 */
function peopleSearch({ input, results, current = null, adOn, allowEmail, exclude = () => new Set(), onChoose }) {
  let options = []; let active = -1; let seq = 0; let timer = null; let picking = false;
  function setActive(i) {
    if (!options.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
    active = (i + options.length) % options.length;
    options.forEach((o, n) => { o.el.classList.toggle('active', n === active); o.el.setAttribute('aria-selected', String(n === active)); });
    input.setAttribute('aria-activedescendant', options[active].el.id);
    options[active].el.scrollIntoView({ block: 'nearest' });
  }
  function render(q, people, adState) {
    const taken = exclude();
    const rows = [];
    options = [];
    const add = (choice, person, content, iconEl) => {
      const el = h('button.m-person-row.m-person-hit', { type: 'button', id: `${results.id}-${options.length}`, role: 'option', 'aria-selected': 'false' }, iconEl, content);
      const o = { el, choice, person };
      // pointerdown: the field keeps the focus (and the keyboard stays open); the click picks
      el.addEventListener('pointerdown', (e) => e.preventDefault());
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => choose(o));
      options.push(o);
      rows.push(el);
    };
    for (const p of people) {
      if (p.id && taken.has(p.id)) continue;
      const sub = p.email || (p.source === 'ad' ? p.username : '');
      add(p.source === 'ad' ? { adId: p.adId } : { userId: p.id }, p,
        h('span.m-choice-text', h('span.m-choice-label', p.displayName), sub ? h('span.m-choice-sub', sub) : null),
        avatar(p, 'sm'));
      if (p.source === 'ad') options[options.length - 1].el.append(h('span.m-badge-ad', { title: t('ticket.fromAd') }, 'AD'));
    }
    if (allowEmail && looksLikeEmail(q) && !people.some((p) => (p.email || '').toLowerCase() === q.toLowerCase())) {
      add({ email: q }, null, h('span.m-choice-text', h('span.m-choice-label', t('ticket.addEmailParticipant', { email: q }))), h('span.m-row-icon', icon('mail')));
    }
    const note = (content) => rows.push(h('p.m-sheet-empty', { role: 'presentation' }, content));
    if (!options.length && adState !== 'loading') note(t('ticket.noPeopleFound'));
    if (adState === 'loading') note(h('span.m-inline', h('span.m-spinner.m-spinner-sm'), t('people.adSearching')));
    if (adState === 'short') note(t('people.adMinChars'));
    if (adState === 'error') note(h('span.m-inline', icon('warning'), t('ticket.adUnavailable')));
    results.replaceChildren(...rows);
    if (current) current.hidden = true;
    input.setAttribute('aria-expanded', 'true');
    if (options.length) setActive(Math.min(Math.max(active, 0), options.length - 1));
    else setActive(-1);
  }
  function reset() {
    seq++; clearTimeout(timer);
    options = []; active = -1;
    results.replaceChildren();
    if (current) current.hidden = false;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  async function search(q) {
    const my = ++seq;
    const useAd = adOn && q.length >= 3;
    let first;
    try { first = await api.people(q, { ad: false }); } catch { first = { people: [] }; }
    if (my !== seq) return;
    active = -1;
    render(q, first.people || [], useAd ? 'loading' : (adOn ? 'short' : null));
    if (!useAd) return;
    let full;
    try { full = await api.people(q); } catch { full = { people: first.people || [], adError: true }; }
    if (my !== seq) return; // typed on meanwhile
    render(q, full.people || [], full.adError ? 'error' : null);
  }
  async function choose(o) {
    if (!o || picking) return;
    picking = true;
    try {
      if (await onChoose(o.choice, o.person) === false) return;
      input.value = '';
      reset();
      if (input.isConnected) input.focus({ preventScroll: true });
    } catch (e) { toast(e.message, 'error'); } finally { picking = false; }
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { reset(); return; }
    timer = setTimeout(() => search(q), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return;
      e.preventDefault();
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (options.length) choose(options[active] || options[0]);
    }
  });

  return { reset };
}

export function openParticipantsSheet(getTicket, { changed, left }) {
  const agent = getTicket()?.agentView ?? state.isAgent;
  const adOn = agent && !!state.boot?.adPeople;
  const canRemove = (tk, p) => agent || tk.reporter?.id === state.user.id || p.id === state.user.id;
  const input = h('input.m-sheet-search-input', {
    type: 'search', autocomplete: 'off', enterkeyhint: 'search', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
    placeholder: agent ? t('ticket.participantSearchAgent') : t('ticket.participantSearch'), 'aria-label': t('m.part.add'),
  });
  const results = h('div.m-people-results', { role: 'listbox', id: `pp-m-${Date.now()}`, 'aria-label': t('m.part.add') });
  input.setAttribute('aria-controls', results.id);
  const current = h('div.m-people-current');
  const canAdd = () => getTicket().canManageParticipants;

  function drawCurrent() {
    const tk = getTicket();
    const list = tk.participants || [];
    current.replaceChildren(
      h('h3.m-canned-group', t('ticket.participants')),
      list.length ? h('div.m-people-list', list.map((p) => h('div.m-person-row', { 'data-id': String(p.id) },
        avatar(p, 'sm'),
        h('span.m-choice-text', h('span.m-choice-label', p.displayName), agent && p.email ? h('span.m-choice-sub', p.email) : null),
        canRemove(tk, p) ? h('button.m-iconbtn.m-person-x', {
          type: 'button', 'aria-label': t('m.reply.remove', { name: p.displayName }), title: t('ticket.removeParticipant'),
          onclick: () => remove(p),
        }, icon('close')) : null))) : h('p.m-sheet-empty', t('m.part.none')));
  }

  async function remove(p) {
    const tk = getTicket();
    try {
      await api.removeParticipant(tk.key, p.id);
      toast(t('m.part.removed', { name: p.displayName }));
      if (p.id === state.user.id && !agent && tk.reporter?.id !== state.user.id) { sheet.close(); left?.(); return; }
      await changed();
      drawCurrent();
    } catch (e) { toast(e.message, 'error'); }
  }

  peopleSearch({
    input, results, current, adOn, allowEmail: agent,
    exclude: () => { const tk = getTicket(); return new Set([tk.reporter?.id, ...(tk.participants || []).map((p) => p.id)]); },
    onChoose: async (choice, person) => {
      await api.addParticipant(getTicket().key, choice);
      toast(t('m.part.added', { name: person?.displayName || choice.email || '' }), 'success');
      await changed();
      drawCurrent();
    },
  });

  drawCurrent();
  const sheet = openSheet({
    title: t('ticket.participants'),
    className: 'm-sheet-people m-sheet-tall',
    content: [
      canAdd() ? h('div.m-sheet-search', h('div.m-search', icon('search'), input), h('p.m-sheet-note.m-sheet-note-plain', t('m.part.intro'))) : null,
      results, current],
  });
  if (canAdd()) setTimeout(() => input.focus({ preventScroll: true }), 320);
  return sheet;
}

// ---------- Reporter (agents) ----------
/** Choose the reporter: accounts, AD people or an email address. onPick(choice, person) after the choice. */
export function openReporterSheet({ exclude = () => new Set(), onPick, intro = '' }) {
  const input = h('input.m-sheet-search-input', {
    type: 'search', autocomplete: 'off', enterkeyhint: 'search', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
    placeholder: t('create.reporterSearch'), 'aria-label': t('ticket.reporter'),
  });
  const results = h('div.m-people-results', { role: 'listbox', id: `rp-m-${Date.now()}`, 'aria-label': t('ticket.reporter') });
  input.setAttribute('aria-controls', results.id);
  peopleSearch({
    input, results, adOn: !!state.boot?.adPeople, allowEmail: true, exclude,
    onChoose: async (choice, person) => { sheet.close(); await onPick(choice, person); return false; },
  });
  const sheet = openSheet({
    title: t('ticket.reporter'),
    className: 'm-sheet-people m-sheet-tall',
    content: [h('div.m-sheet-search', h('div.m-search', icon('search'), input), intro ? h('p.m-sheet-note.m-sheet-note-plain', intro) : null), results],
  });
  setTimeout(() => input.focus({ preventScroll: true }), 320);
  return sheet;
}

// ---------- Links ----------
/** Link this ticket with another (same kinds as on the desktop); onDone after saving */
export function openLinkSheet(tk, { onDone }) {
  const kind = h('select.m-select', { 'aria-label': t('link.thisTicket') }, CHOICES.map(([id]) => h('option', { value: id }, t(`link.choice.${id}`))));
  const input = h('input', {
    type: 'search', placeholder: t('link.searchHint'), autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'search', 'aria-label': t('bulk.linkTarget'),
  });
  const hits = h('div.m-choices', { role: 'listbox', 'aria-label': t('bulk.linkTarget') });
  let chosen = null;
  let timer = null;
  let busy = false;
  let seq = 0;
  let suggestions = null;
  const btn = h('button.m-btn.m-btn-primary', { type: 'button', onclick: () => submit() }, icon('link'), t('link.add'));
  const pickRow = (x) => h('button.m-choice-row', {
    type: 'button', role: 'option', 'aria-selected': String(chosen === x.key), class: chosen === x.key ? 'active' : '',
    onclick: () => { chosen = x.key; input.value = x.key; redraw(); },
  }, h('span.m-choice-text', h('span.m-choice-label', `${x.key} · ${x.title}`), h('span.m-choice-sub', t(`status.${x.status}`))),
  chosen === x.key ? h('span.m-choice-check', icon('check')) : null);
  let groups = [];
  /** groups = [[label, tickets], …] – the ticket itself is never offered */
  const draw = (g, emptyText = null) => {
    groups = g;
    const parts = [];
    for (const [label, list] of g) {
      const shown = list.filter((x) => x.key !== tk.key);
      if (!shown.length) continue;
      parts.push(h('div.m-choice-group', label), ...shown.map(pickRow));
    }
    if (!parts.length && emptyText) parts.push(h('p.m-sheet-empty', emptyText));
    hits.replaceChildren(...parts);
  };
  const redraw = () => draw(groups);
  async function showSuggestions() {
    if (!suggestions) {
      try { suggestions = await api.linkSuggestions([tk.key]); } catch { suggestions = { causes: [], similar: [] }; }
    }
    if (!input.value.trim()) draw([[t('link.suggestCause'), suggestions.causes], [t('link.suggestSimilar'), suggestions.similar]]);
  }
  input.addEventListener('input', () => {
    chosen = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { showSuggestions(); return; }
    if (q.length < 2) { draw([]); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await api.tickets({ q, limit: 10 });
        if (my === seq) draw([[t('link.searchResults'), r.tickets || []]], t('link.noResults'));
      } catch { /* ignore */ }
    }, 200);
  });
  showSuggestions();
  async function submit() {
    const target = (chosen || input.value).trim().toUpperCase();
    if (!target || busy) { if (!target) input.focus(); return; }
    busy = true; btn.disabled = true;
    try {
      const [, k, reverse] = CHOICES.find(([id]) => id === kind.value);
      if (reverse) await api.link(target, { kind: k, target: tk.key });
      else await api.link(tk.key, { kind: k, target });
      sheet.close();
      toast(t('m.link.done', { key: target }), 'success');
      await onDone?.();
    } catch (e) {
      busy = false; btn.disabled = false;
      toast(e.message, 'error');
    }
  }
  const sheet = openSheet({
    title: t('link.addLink'),
    className: 'm-sheet-tall m-sheet-link',
    content: h('div.m-form',
      h('div.m-field', h('label', t('link.thisTicket')), kind),
      h('div.m-field', h('label', t('bulk.linkTarget')), input),
      hits),
    footer: [h('button.m-btn', { type: 'button', onclick: () => sheet.close() }, t('app.cancel')), btn],
  });
  return sheet;
}
