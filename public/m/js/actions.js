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
    current: tk.status,
    className: 'm-sheet-status',
    options: STATUSES.map((s) => ({ value: s, label: t(`status.${s}`), iconEl: h(`span.m-status-dot.status-dot-${s}`) })),
    onPick: (s) => {
      if (s === 'done') openResolveSheet(tk, { onResolved });
      else save({ status: s }, { status: s });
    },
  });
}

/** "Resolve": optional closing reply (with templates), same call as the desktop bulk resolve dialog */
export function openResolveSheet(tk, { onResolved }) {
  const ta = h('textarea.m-textarea', { rows: 5, placeholder: t('bulk.commentPlaceholder'), 'aria-label': t('m.resolve.label') });
  let busy = false;
  const btn = h('button.m-btn.m-btn-primary', { type: 'button', onclick: () => submit() }, icon('check'), t('bulk.resolve'));
  const tpl = state.isAgent ? h('button.m-btn.m-btn-ghost', {
    type: 'button',
    onclick: () => {
      const sel = [ta.selectionStart, ta.selectionEnd];
      const before = ta.value;
      let text = null;
      // The template sheet replaces this one; once it is gone the resolve sheet opens again with the text
      openCannedSheet(tk, (x) => { text = x; }, () => reopen(text === null ? before : before.slice(0, sel[0]) + text + before.slice(sel[1])), { raw: true });
    },
  }, icon('comment'), t('m.reply.template')) : null;
  const reopen = (text) => { const s = openResolveSheet(tk, { onResolved }); const area = s.body.querySelector('textarea'); area.value = text; area.focus(); };
  async function submit() {
    if (busy) return;
    busy = true; btn.disabled = true;
    try {
      // Placeholders like {melder} are filled in by the server for this ticket
      const r = await api.bulk({ keys: [tk.key], changes: { status: 'done' }, comment: ta.value.trim() });
      if (r.failed.length) throw new Error(r.failed.map((x) => x.error).join(', '));
      sheet.close();
      toast(t('m.resolve.done', { key: r.ok[0] || tk.key }), 'success');
      await onResolved?.();
    } catch (e) {
      busy = false; btn.disabled = false;
      toast(e.message, 'error');
    }
  }
  const sheet = openSheet({
    title: t('m.resolve.title'),
    className: 'm-sheet-resolve',
    content: h('div.m-form',
      h('div.m-field', h('label', t('m.resolve.label')), ta, h('p.m-field-hint', t('m.resolve.hint'))),
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
  const others = state.agents.filter((a) => a.id !== me.id);
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
export function openParticipantsSheet(getTicket, { changed, left }) {
  const agent = state.isAgent;
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

  // ---- search (port of peoplePicker) ----
  let options = []; let active = -1; let seq = 0; let timer = null; let picking = false;
  function setActive(i) {
    if (!options.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
    active = (i + options.length) % options.length;
    options.forEach((o, n) => { o.el.classList.toggle('active', n === active); o.el.setAttribute('aria-selected', String(n === active)); });
    input.setAttribute('aria-activedescendant', options[active].el.id);
    options[active].el.scrollIntoView({ block: 'nearest' });
  }
  function render(q, people, adState) {
    const tk = getTicket();
    const taken = new Set([tk.reporter?.id, ...(tk.participants || []).map((p) => p.id)]);
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
    if (agent && looksLikeEmail(q) && !people.some((p) => (p.email || '').toLowerCase() === q.toLowerCase())) {
      add({ email: q }, null, h('span.m-choice-text', h('span.m-choice-label', t('ticket.addEmailParticipant', { email: q }))), h('span.m-row-icon', icon('mail')));
    }
    const note = (content) => rows.push(h('p.m-sheet-empty', { role: 'presentation' }, content));
    if (!options.length && adState !== 'loading') note(t('ticket.noPeopleFound'));
    if (adState === 'loading') note(h('span.m-inline', h('span.m-spinner.m-spinner-sm'), t('people.adSearching')));
    if (adState === 'short') note(t('people.adMinChars'));
    if (adState === 'error') note(h('span.m-inline', icon('warning'), t('ticket.adUnavailable')));
    results.replaceChildren(...rows);
    current.hidden = true;
    input.setAttribute('aria-expanded', 'true');
    if (options.length) setActive(Math.min(Math.max(active, 0), options.length - 1));
    else setActive(-1);
  }
  function reset() {
    seq++; clearTimeout(timer);
    options = []; active = -1;
    results.replaceChildren();
    current.hidden = false;
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
      await api.addParticipant(getTicket().key, o.choice);
      const name = o.person?.displayName || o.choice.email || '';
      toast(t('m.part.added', { name }), 'success');
      input.value = '';
      reset();
      await changed();
      drawCurrent();
      input.focus({ preventScroll: true });
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

// ---------- Links ----------
/** Link this ticket with another (same kinds as on the desktop); onDone after saving */
export function openLinkSheet(tk, { onDone }) {
  const kind = h('select.m-select', { 'aria-label': t('link.thisTicket') }, CHOICES.map(([id]) => h('option', { value: id }, t(`link.choice.${id}`))));
  const input = h('input', {
    type: 'search', placeholder: t('link.targetHint'), autocomplete: 'off', autocapitalize: 'characters', enterkeyhint: 'search', 'aria-label': t('bulk.linkTarget'),
  });
  const hits = h('div.m-choices', { role: 'listbox', 'aria-label': t('bulk.linkTarget') });
  let chosen = null;
  let timer = null;
  let busy = false;
  const btn = h('button.m-btn.m-btn-primary', { type: 'button', onclick: () => submit() }, icon('link'), t('link.add'));
  const pickRow = (x) => h('button.m-choice-row', {
    type: 'button', role: 'option', 'aria-selected': String(chosen === x.key), class: chosen === x.key ? 'active' : '',
    onclick: () => { chosen = x.key; input.value = x.key; draw(lastList); },
  }, h('span.m-choice-text', h('span.m-choice-label', `${x.key} · ${x.title}`), h('span.m-choice-sub', t(`status.${x.status}`))),
  chosen === x.key ? h('span.m-choice-check', icon('check')) : null);
  let lastList = [];
  const draw = (list) => { lastList = list; hits.replaceChildren(...list.map(pickRow)); };
  input.addEventListener('input', () => {
    chosen = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { draw([]); return; }
    timer = setTimeout(async () => {
      try {
        const r = await api.tickets({ q, limit: 8 });
        draw((r.tickets || []).filter((x) => x.key !== tk.key));
      } catch { /* ignore */ }
    }, 200);
  });
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
