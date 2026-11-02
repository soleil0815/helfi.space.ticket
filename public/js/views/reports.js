// Berichte: wer hat wie viele Tickets bearbeitet und erledigt (für alle Bearbeiter sichtbar)
import { api } from '../api.js';
import { h, mount, icon, select, avatar, toast } from '../dom.js';
import { t, getLang as lang } from '../i18n.js';
import { state, navigate } from '../app.js';
import { satisfactionPanel } from './survey.js';
import { itilPanel } from './itilReport.js';

// Farben: Kategorienpalette (validiert), Text bleibt in Textfarben
const C_CREATED = '#2a78d6';
const C_RESOLVED = '#eb6834';
const SVGNS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const isoDay = (d) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
const nf = () => new Intl.NumberFormat(lang() === 'de' ? 'de-DE' : 'en-GB', { maximumFractionDigits: 1 });
const fmtDay = (iso, opts = { day: '2-digit', month: '2-digit' }) => new Date(`${iso}T00:00:00`).toLocaleDateString(lang() === 'de' ? 'de-DE' : 'en-GB', opts);

function duration(hours) {
  if (hours === null || hours === undefined) return '–';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${nf().format(Math.round(hours * 10) / 10)} h`;
  return `${nf().format(Math.round(hours / 2.4) / 10)} ${t('reports.days')}`;
}

// Ein Tooltip für die ganze Seite
function tooltip() {
  const el = h('div.chart-tip', { role: 'tooltip', hidden: true });
  document.body.append(el);
  return {
    show(x, y, content) { mount(el, content); el.hidden = false; const r = el.getBoundingClientRect(); el.style.left = `${Math.min(x + 14, window.innerWidth - r.width - 8) + window.scrollX}px`; el.style.top = `${y + window.scrollY - r.height - 10}px`; },
    hide() { el.hidden = true; },
    remove() { el.remove(); },
  };
}

export async function renderReports(content, params) {
  const f = Object.fromEntries(params);
  const preset = f.from || f.to ? 'custom' : (f.period || '30');
  const today = new Date();
  const range = (() => {
    if (preset === 'custom') return { from: f.from || '', to: f.to || isoDay(today) };
    if (preset === 'year') return { from: `${today.getFullYear()}-01-01`, to: isoDay(today) };
    const days = Number(preset) || 30;
    return { from: isoDay(new Date(today.getTime() - (days - 1) * 864e5)), to: isoDay(today) };
  })();
  const go = (p) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
    navigate(`/reports${q.toString() ? '?' + q : ''}`, { replace: true });
  };

  const fromInput = h('input.input-date', { type: 'date', value: range.from, max: range.to, onchange: () => go({ from: fromInput.value, to: toInput.value, project: f.project }) });
  const toInput = h('input.input-date', { type: 'date', value: range.to, onchange: () => go({ from: fromInput.value, to: toInput.value, project: f.project }) });
  const filters = h('div.toolbar',
    select([['7', t('reports.last7')], ['30', t('reports.last30')], ['90', t('reports.last90')], ['year', t('reports.thisYear')], ['custom', t('reports.custom')]], preset, {
      class: 'select-sm',
      onchange: (e) => (e.target.value === 'custom' ? go({ from: range.from, to: range.to, project: f.project }) : go({ period: e.target.value === '30' ? '' : e.target.value, project: f.project })),
    }),
    preset === 'custom' ? h('span.date-range', fromInput, h('span.muted', '–'), toInput) : h('span.muted.small', `${fmtDay(range.from, {})} – ${fmtDay(range.to, {})}`),
    state.projects.length > 1 ? select([['', t('nav.allProjects')], ...state.projects.map((p) => [p.key, p.name])], f.project || '', {
      class: 'select-sm', onchange: (e) => go({ ...(preset === 'custom' ? { from: range.from, to: range.to } : { period: preset === '30' ? '' : preset }), project: e.target.value }),
    }) : null);

  const host = h('div', h('div.loading', t('app.loading')));
  mount(content, h('div.page-head', h('h1', t('reports.title'))), h('p.muted.page-intro', t('reports.intro')), filters, host);

  let data;
  try { data = await api.reports({ from: range.from, to: range.to, project: f.project || '' }); }
  catch (e) { mount(host, h('p.error-text', e.message)); return; }

  const tip = tooltip();
  // Tooltip beim Seitenwechsel entfernen
  const obs = new MutationObserver(() => { if (!document.body.contains(host)) { tip.remove(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  const n = nf();
  const stat = (value, label) => h('div.stat-tile', h('div.stat-value', n.format(value)), h('div.stat-label', label));
  mount(host,
    h('div.stat-row',
      stat(data.totals.created, t('reports.created')),
      stat(data.totals.resolved, t('reports.resolved')),
      stat(data.totals.open, t('reports.openNow'))),
    h('div.chart-grid',
      h('section.panel.chart-panel', h('h2', t('reports.resolvedByAgent')), barChart(data.agents, tip)),
      h('section.panel.chart-panel', h('h2', t('reports.createdVsResolved')), lineChart(data.series, tip))),
    agentTable(data));
  const q = { from: range.from, to: range.to, project: f.project || '' };
  const [itil, sat] = await Promise.all([itilPanel(q), satisfactionPanel(q)]);
  if (itil) host.append(itil);
  if (sat) host.append(sat);
}

/** Waagerechte Balken: erledigt je Bearbeiter (eine Reihe, Wert direkt am Balken). */
function barChart(agents, tip) {
  const rows = agents.filter((a) => a.resolved > 0 || a.active);
  if (!rows.some((a) => a.resolved > 0)) return h('p.muted.chart-empty', t('reports.noneResolved'));
  const n = nf();
  const max = Math.max(...rows.map((a) => a.resolved), 1);
  const rowH = 30;
  const labelW = 150;
  const W = 520;
  const plotW = W - labelW - 44;
  const H = rows.length * rowH + 8;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': t('reports.resolvedByAgent') });
  rows.forEach((a, i) => {
    const y = i * rowH + 6;
    const w = a.resolved ? Math.max(4, (a.resolved / max) * plotW) : 0;
    const name = a.displayName.length > 22 ? `${a.displayName.slice(0, 21)}…` : a.displayName;
    const g = svg('g', { class: 'bar-row' },
      svg('rect', { x: 0, y: y - 4, width: W, height: rowH, class: 'bar-hit' }),
      svg('text', { x: labelW - 10, y: y + 13, 'text-anchor': 'end', class: 'chart-label' }, name),
      w ? svg('path', { d: roundedBar(labelW, y + 2, w, 18), fill: C_CREATED, class: 'bar' }) : svg('line', { x1: labelW, x2: labelW, y1: y + 2, y2: y + 20, class: 'chart-axis' }),
      svg('text', { x: labelW + w + 6, y: y + 15, class: 'chart-value' }, n.format(a.resolved)));
    g.addEventListener('mousemove', (e) => tip.show(e.clientX, e.clientY, h('div',
      h('strong', a.displayName),
      h('div', `${t('reports.colResolved')}: ${n.format(a.resolved)}`),
      h('div', `${t('reports.colAvg')}: ${duration(a.avgResolutionHours)}`))));
    g.addEventListener('mouseleave', () => tip.hide());
    chart.append(g);
  });
  return chart;
}

// Balken mit 4px abgerundetem Ende, flach an der Grundlinie
function roundedBar(x, y, w, hgt) {
  const r = Math.min(4, w / 2, hgt / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt - r} Q${x + w},${y + hgt} ${x + w - r},${y + hgt} H${x} Z`;
}

/** Linien: erstellt und erledigt je Tag/Woche, eine Achse, Fadenkreuz mit Tooltip. */
function lineChart(series, tip) {
  const pts = series.points;
  if (!pts.length) return h('p.muted.chart-empty', t('reports.noData'));
  const n = nf();
  const W = 560; const H = 240;
  const m = { l: 36, r: 76, t: 12, b: 28 };
  const pw = W - m.l - m.r; const ph = H - m.t - m.b;
  const maxV = Math.max(1, ...pts.map((p) => Math.max(p.created, p.resolved)));
  const step = niceStep(maxV);
  const top = Math.ceil(maxV / step) * step;
  const x = (i) => m.l + (pts.length === 1 ? pw / 2 : (i / (pts.length - 1)) * pw);
  const y = (v) => m.t + ph - (v / top) * ph;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': t('reports.createdVsResolved') });

  for (let v = 0; v <= top; v += step) {
    chart.append(svg('line', { x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v), class: v === 0 ? 'chart-axis' : 'chart-grid' }),
      svg('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-tick' }, n.format(v)));
  }
  const ticks = Math.min(6, pts.length);
  for (let k = 0; k < ticks; k++) {
    const i = ticks === 1 ? 0 : Math.round((k / (ticks - 1)) * (pts.length - 1));
    chart.append(svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'chart-tick' }, fmtDay(pts[i].date)));
  }
  const line = (key, color) => svg('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  chart.append(line('created', C_CREATED), line('resolved', C_RESOLVED));
  // Direkte Beschriftung am Linienende (Textfarbe, Farbpunkt trägt die Zuordnung)
  const last = pts.length - 1;
  const ends = [['created', C_CREATED, t('reports.created')], ['resolved', C_RESOLVED, t('reports.resolved')]]
    .map(([k, c, label]) => ({ c, label, y: y(pts[last][k]) })).sort((a, b) => a.y - b.y);
  if (ends[1].y - ends[0].y < 14) ends[1].y = ends[0].y + 14;
  for (const e of ends) chart.append(svg('circle', { cx: x(last) + 8, cy: e.y, r: 4, fill: e.c }), svg('text', { x: x(last) + 15, y: e.y + 4, class: 'chart-label' }, e.label));

  // Fadenkreuz
  const cross = svg('line', { y1: m.t, y2: m.t + ph, class: 'chart-cross', visibility: 'hidden' });
  const dots = [C_CREATED, C_RESOLVED].map((c) => svg('circle', { r: 4.5, fill: c, stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }));
  const hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, class: 'chart-hit' });
  chart.append(cross, ...dots, hit);
  hit.addEventListener('mousemove', (e) => {
    const r = chart.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(last, Math.round(((sx - m.l) / pw) * last)));
    const p = pts[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    [['created', 0], ['resolved', 1]].forEach(([k, j]) => { dots[j].setAttribute('cx', x(i)); dots[j].setAttribute('cy', y(p[k])); dots[j].setAttribute('visibility', 'visible'); });
    const label = series.unit === 'week' ? `${t('reports.weekOf')} ${fmtDay(p.date, {})}` : fmtDay(p.date, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    tip.show(e.clientX, e.clientY, h('div', h('strong', label),
      h('div.tip-row', h('span.tip-dot', { style: { background: C_CREATED } }), `${t('reports.created')}: ${n.format(p.created)}`),
      h('div.tip-row', h('span.tip-dot', { style: { background: C_RESOLVED } }), `${t('reports.resolved')}: ${n.format(p.resolved)}`)));
  });
  hit.addEventListener('mouseleave', () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });

  const legend = h('div.chart-legend',
    h('span', h('span.legend-swatch', { style: { background: C_CREATED } }), t('reports.created')),
    h('span', h('span.legend-swatch', { style: { background: C_RESOLVED } }), t('reports.resolved')),
    h('span.muted.small', series.unit === 'week' ? t('reports.perWeek') : t('reports.perDay')));
  return h('div', legend, chart);
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / pow;
  return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow);
}

/** Tabelle je Bearbeiter, nach jeder Spalte sortierbar, als CSV herunterladbar. */
function agentTable(data) {
  const cols = [
    ['displayName', t('reports.colAgent'), 'text'],
    ['resolved', t('reports.colResolved'), 'num'],
    ['openAssigned', t('reports.colOpen'), 'num'],
    ['touched', t('reports.colTouched'), 'num'],
    ['replies', t('reports.colReplies'), 'num'],
    ['notes', t('reports.colNotes'), 'num'],
    ['avgResolutionHours', t('reports.colAvg'), 'dur'],
  ];
  let sortKey = 'resolved';
  let dir = -1;
  const n = nf();
  const wrap = h('section.panel');
  const draw = () => {
    const rows = [...data.agents].sort((a, b) => {
      const va = a[sortKey]; const vb = b[sortKey];
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * ((va ?? -1) - (vb ?? -1));
    });
    const th = ([k, label, type]) => h('th', { class: type === 'text' ? '' : 'num', 'aria-sort': k === sortKey ? (dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button.th-sort', { type: 'button', onclick: () => { if (sortKey === k) dir = -dir; else { sortKey = k; dir = type === 'text' ? 1 : -1; } draw(); } },
        label, k === sortKey ? h('span.sort-arrow', dir > 0 ? '▲' : '▼') : null));
    mount(wrap,
      h('div.section-head', h('h2', t('reports.byAgent')),
        h('button.btn.btn-subtle.small', { type: 'button', onclick: () => downloadCsv(data, cols) }, icon('download'), t('reports.csv'))),
      h('div.table-wrap', h('table.data.report-table',
        h('thead', h('tr', cols.map(th))),
        h('tbody', rows.map((a) => h('tr', { class: a.active ? '' : 'inactive' },
          h('td', h('span.person', avatar(a, 'sm'), h('span', a.displayName, a.active ? null : h('span.muted.small', ` (${t('reports.inactive')})`)))),
          ...cols.slice(1).map(([k, , type]) => h('td.num', type === 'dur' ? duration(a[k]) : n.format(a[k])))))))),
      h('p.muted.small', t('reports.legend')));
  };
  draw();
  return wrap;
}

function downloadCsv(data, cols) {
  const de = lang() === 'de';
  const sep = de ? ';' : ',';
  const num = (v) => (v === null || v === undefined ? '' : (de ? String(v).replace('.', ',') : String(v)));
  const esc = (v) => (/[";,\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = cols.map(([k, label]) => (k === 'avgResolutionHours' ? `${label} (h)` : label));
  const lines = [head.map(esc).join(sep), ...data.agents.map((a) => cols.map(([k, , type]) => (type === 'text' ? esc(a[k]) : num(a[k]))).join(sep))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `helfi-bericht-${data.range.from}-${data.range.to}${data.project ? '-' + data.project : ''}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(t('reports.csvDone'));
}
