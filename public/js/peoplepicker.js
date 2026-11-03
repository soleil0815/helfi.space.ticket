// Personensuche mit Vorschlagsliste (Teilnehmer, Verantwortliche).
// Der Fokus bleibt immer im Eingabefeld: Die Liste nimmt ihn nie weg, Auswahl mit Maus oder ↑/↓ + Enter.
import { api } from './api.js';
import { h, mount, icon, avatar } from './dom.js';
import { t } from './i18n.js';
import { state } from './app.js';

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
let uid = 0;

/**
 * input: Textfeld. Optionen:
 *  - onPick(choice, person): choice = { userId } | { adId } | { email }
 *  - exclude(): Set der Benutzer-IDs, die nicht angeboten werden
 *  - allowEmail: freie Mailadresse anbieten (nur Bearbeiter)
 *  - ad: AD-Treffer zulassen (Standard: wenn für dieses Konto verfügbar)
 *  - onClose(): Liste geschlossen und Feld verlassen
 */
export function peoplePicker(input, { onPick, exclude = () => new Set(), allowEmail = false, ad = !!state.boot?.adPeople, onClose } = {}) {
  const listId = `pp-${++uid}`;
  const menu = h('div.menu.picker-menu', { id: listId, role: 'listbox' });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';

  let options = []; // { el, choice, person }
  let active = -1;
  let seq = 0;
  let timer = null;
  let picking = false;

  function place() {
    if (!menu.isConnected) return;
    const r = input.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 300), document.documentElement.clientWidth - 16);
    const left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - width - 8));
    menu.style.width = `${width}px`;
    menu.style.left = `${left + window.scrollX}px`;
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  }
  function open() {
    if (!menu.isConnected) {
      document.body.append(menu);
      input.setAttribute('aria-expanded', 'true');
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
    }
    place();
  }
  function close() {
    seq++;
    clearTimeout(timer);
    hide();
  }
  function hide() {
    menu.remove();
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    options = []; active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function setActive(i) {
    if (!options.length) { active = -1; return; }
    active = (i + options.length) % options.length;
    options.forEach((o, n) => { o.el.classList.toggle('active', n === active); o.el.setAttribute('aria-selected', String(n === active)); });
    input.setAttribute('aria-activedescendant', options[active].el.id);
    options[active].el.scrollIntoView({ block: 'nearest' });
  }
  async function choose(o) {
    if (!o || picking) return;
    picking = true;
    close();
    try { await onPick(o.choice, o.person); } finally { picking = false; }
  }

  function render(q, people, adState) {
    const taken = exclude();
    const rows = [];
    options = [];
    const add = (choice, person, content, iconEl) => {
      const el = h('div.menu-item', { id: `${listId}-${options.length}`, role: 'option', 'aria-selected': 'false' }, iconEl, content);
      const o = { el, choice, person };
      // mousedown: Fokus bleibt im Feld; erst der Klick wählt aus
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => choose(o));
      el.addEventListener('mousemove', () => { const n = options.indexOf(o); if (n !== active) setActive(n); });
      options.push(o);
      rows.push(el);
    };
    for (const p of people) {
      if (p.id && taken.has(p.id)) continue;
      const sub = p.email || (p.source === 'ad' ? p.username : '');
      const text = h('span.person-hit', h('span.person-text', h('span.person-name', p.displayName), sub ? h('span.person-sub', sub) : null),
        p.source === 'ad' ? h('span.badge.badge-ad', { title: t('ticket.fromAd') }, 'AD') : null);
      add(p.source === 'ad' ? { adId: p.adId } : { userId: p.id }, p, text, avatar(p, 'xs'));
    }
    if (allowEmail && looksLikeEmail(q) && !people.some((p) => (p.email || '').toLowerCase() === q.toLowerCase())) {
      add({ email: q }, null, h('span', t('ticket.addEmailParticipant', { email: q })), icon('mail'));
    }
    const note = (text, cls = '') => rows.push(h(`div.menu-empty${cls}`, { role: 'presentation' }, text));
    if (!options.length && adState !== 'loading') note(t('ticket.noPeopleFound'));
    if (adState === 'loading') note(h('span.picker-loading', h('span.spinner'), t('people.adSearching')));
    if (adState === 'short') note(t('people.adMinChars'));
    if (adState === 'error') note(h('span', icon('warning'), ' ', t('ticket.adUnavailable')));
    mount(menu, rows);
    open();
    if (options.length) setActive(Math.min(Math.max(active, 0), options.length - 1));
    else { active = -1; input.removeAttribute('aria-activedescendant'); }
  }

  async function search(q) {
    const my = ++seq;
    const useAd = ad && q.length >= 3;
    let first;
    try { first = await api.people(q, { ad: false }); } catch { first = { people: [] }; }
    if (my !== seq) return;
    active = -1;
    render(q, first.people || [], useAd ? 'loading' : (ad ? 'short' : null));
    if (!useAd) return;
    let full;
    try { full = await api.people(q); } catch { full = { people: first.people || [], adError: true }; }
    if (my !== seq) return; // inzwischen weitergetippt
    render(q, full.people || [], full.adError ? 'error' : null);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { seq++; hide(); return; }
    timer = setTimeout(() => search(q), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return;
      e.preventDefault();
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      if (!menu.isConnected) return;
      e.preventDefault();
      choose(options[active] || options[0]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      onClose?.();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement === input || picking) return;
    close();
    onClose?.();
  }, 150));

  return { close };
}
