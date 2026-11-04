// SLA: display in the ticket and in lists, settings page
import { h, mount, field, fmtDate } from '../dom.js';
import { t } from '../i18n.js';

/** Business minutes in readable form: “2 Std 10 Min”, “45 Min” */
export function fmtMinutes(min) {
  const m = Math.abs(Math.round(min));
  const hh = Math.floor(m / 60); const mm = m % 60;
  if (!hh) return t('sla.min', { m: mm });
  return mm ? t('sla.hmin', { h: hh, m: mm }) : t('sla.h', { h: hh });
}

const label = (c) => {
  if (c.paused) return t('sla.paused');
  if (c.state === 'met') return t('sla.met');
  if (c.state === 'missed') return t('sla.missed', { time: fmtMinutes(c.elapsed - c.target) });
  if (c.state === 'breached') return t('sla.breachedBy', { time: fmtMinutes(-c.remaining) });
  return t('sla.left', { time: fmtMinutes(c.remaining) });
};

/** Line in the ticket: traffic light + remaining time, due date as tooltip */
export function slaChip(c) {
  return h(`span.sla.sla-${c.paused ? 'paused' : c.state}`, { title: c.due ? t('sla.due', { when: fmtDate(c.due) }) : t('sla.target', { time: fmtMinutes(c.target) }) }, label(c));
}

/** Short form for lists */
export function slaBadge(w) {
  if (!w || w.state === 'met') return h('span');
  if (w.state === 'missed') return h('span.sla.sla-missed', t('sla.missedShort'));
  return h(`span.sla.sla-${w.paused ? 'paused' : w.state}`, { title: t(`sla.kind.${w.kind}`) }, w.paused ? t('sla.paused') : (w.state === 'breached' ? `−${fmtMinutes(-w.remaining)}` : fmtMinutes(w.remaining)));
}

// ---------- Administration → Service Level ----------
const PRIOS = ['highest', 'high', 'medium', 'low'];
const DAYS = [1, 2, 3, 4, 5, 6, 0];
export function slaPage(body, s, { saveBar, saveKeys, bindCheck }) {
  let hours; let targets;
  try { hours = JSON.parse(s['sla.hours']); } catch { hours = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' }; }
  try { targets = JSON.parse(s['sla.targets']); } catch { targets = {}; }
  const sync = () => { s['sla.hours'] = JSON.stringify(hours); s['sla.targets'] = JSON.stringify(targets); };
  const dayBoxes = DAYS.map((d) => {
    const cb = h('input', { type: 'checkbox', checked: hours.days.includes(d) });
    cb.addEventListener('change', () => { hours.days = DAYS.filter((x, i) => (x === d ? cb.checked : hours.days.includes(x))); sync(); });
    return h('label.day-box', cb, ' ', t(`day.${d}`));
  });
  const time = (k) => { const i = h('input', { type: 'time', value: hours[k] }); i.addEventListener('change', () => { hours[k] = i.value; sync(); }); return i; };
  const hoursInput = (p, k) => {
    const i = h('input.num', { type: 'number', min: 0.25, step: 0.25, value: (targets[p]?.[k] ?? 60) / 60 });
    i.addEventListener('input', () => { targets[p] = { ...(targets[p] || {}), [k]: Math.max(1, Math.round(Number(i.value) * 60)) }; sync(); });
    return i;
  };
  const holidays = h('textarea.mono', { rows: 6, placeholder: '2026-12-24 Heiligabend\n2026-12-25 1. Weihnachtstag' });
  holidays.value = s['sla.holidays'] || '';
  holidays.addEventListener('input', () => { s['sla.holidays'] = holidays.value; });
  const warn = h('input.num', { type: 'number', min: 10, max: 99, value: s['sla.warnPercent'] });
  warn.addEventListener('input', () => { s['sla.warnPercent'] = Number(warn.value); });
  sync();
  mount(body, h('section.panel',
    h('h2', t('sla.title')),
    h('p.muted', t('sla.intro')),
    field(t('sla.enabled'), bindCheck(s, 'sla.enabled')),
    h('h3', t('sla.targets')),
    h('table.data.sla-targets',
      h('thead', h('tr', h('th', t('ticket.priority')), h('th', t('sla.kind.response')), h('th', t('sla.kind.resolve')))),
      h('tbody', PRIOS.map((p) => h('tr', h('td', t(`priority.${p}`)), h('td', hoursInput(p, 'response'), ' ', t('sla.hoursUnit')), h('td', hoursInput(p, 'resolve'), ' ', t('sla.hoursUnit')))))),
    h('p.muted.small', t('sla.targetsHint')),
    h('h3', t('sla.hours')),
    h('div.day-row', dayBoxes),
    h('div.grid-2', field(t('sla.start'), time('start')), field(t('sla.end'), time('end'))),
    field(t('sla.holidays'), holidays, t('sla.holidaysHint')),
    field(t('sla.pauseWaiting'), bindCheck(s, 'sla.pauseWaiting'), t('sla.pauseWaitingHint')),
    field(t('sla.warnPercent'), warn, t('sla.warnPercentHint')),
    saveBar(() => saveKeys(s, ['sla.']))));
}
