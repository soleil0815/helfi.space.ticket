// Warteschlangen der Seitenleiste: feste Filter auf die Ticketliste (je Projekt).
// count: Feld aus /api/queues
export const QUEUES = [
  { id: 'open', label: 'queue.open', params: { status: 'unresolved' }, count: 'open' },
  { id: 'mine', label: 'queue.mine', params: { assignee: 'me', status: 'unresolved' }, count: 'mine' },
  { id: 'unassigned', label: 'queue.unassigned', params: { assignee: 'none', status: 'unresolved' }, count: 'unassigned' },
  { id: 'waiting', label: 'queue.waiting', params: { status: 'waiting' }, count: 'waiting' },
  { id: 'recent', label: 'queue.recent', params: { status: 'done', resolvedDays: '7' }, count: 'recent' },
  { id: 'all', label: 'queue.all', params: {}, count: 'total' },
];

// Weitere Ansichten mit Zahl: Serviceanfragen und Vorfälle (offen)
export const VIEWS = [
  { id: 'requests', label: 'nav.serviceRequests', icon: 'type-request', params: { type: 'request', status: 'unresolved' }, count: 'requests' },
  { id: 'incidents', label: 'nav.incidents', icon: 'type-incident', params: { type: 'incident', status: 'unresolved' }, count: 'incidents' },
  { id: 'problems', label: 'nav.problems', icon: 'type-problem', params: { type: 'problem', status: 'unresolved' }, count: 'problems' },
  { id: 'slaRisk', label: 'nav.slaRisk', icon: 'warning', params: { sla: 'risk' }, count: 'slaRisk', when: (boot) => boot.sla?.enabled },
];

const FILTER_KEYS = ['status', 'assignee', 'resolvedDays', 'type', 'priority', 'label', 'reporter', 'overdue', 'sla'];

export function queueHref(q, projectKey) {
  const p = new URLSearchParams({ ...(projectKey ? { project: projectKey } : {}), ...q.params });
  return `/issues?${p}`;
}

/** Welche Warteschlange/Ansicht entspricht den aktuellen Filtern? (Suche und Sortierung zählen nicht) */
export function matchQueue(params) {
  const cur = {};
  for (const k of FILTER_KEYS) if (params.get(k)) cur[k] = params.get(k);
  const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
  return [...QUEUES, ...VIEWS].find((q) => same(q.params, cur)) || null;
}
