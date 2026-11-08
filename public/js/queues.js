// Sidebar queues: fixed filters on the ticket list (per project).
// count: field from /api/queues
export const QUEUES = [
  { id: 'open', label: 'queue.open', params: { status: 'unresolved' }, count: 'open' },
  { id: 'mine', label: 'queue.mine', params: { assignee: 'me', status: 'unresolved' }, count: 'mine' },
  { id: 'unassigned', label: 'queue.unassigned', params: { assignee: 'none', status: 'unresolved' }, count: 'unassigned' },
  { id: 'waiting', label: 'queue.waiting', params: { status: 'waiting' }, count: 'waiting' },
  { id: 'recent', label: 'queue.recent', params: { status: 'done', resolvedDays: '7' }, count: 'recent' },
  { id: 'all', label: 'queue.all', params: {}, count: 'total' },
];

// More views with a count: service requests and incidents (open)
export const VIEWS = [
  { id: 'requests', label: 'nav.serviceRequests', icon: 'type-request', params: { type: 'request', status: 'unresolved' }, count: 'requests' },
  { id: 'incidents', label: 'nav.incidents', icon: 'type-incident', params: { type: 'incident', status: 'unresolved' }, count: 'incidents' },
  { id: 'problems', label: 'nav.problems', icon: 'type-problem', params: { type: 'problem', status: 'unresolved' }, count: 'problems' },
  { id: 'changes', label: 'nav.changes', icon: 'type-change', params: { type: 'change', status: 'unresolved' }, count: 'changes' },
  { id: 'mentions', label: 'nav.mentions', icon: 'at', params: { mentioned: 'me' }, count: 'mentions' },
  { id: 'approvals', label: 'nav.approvals', icon: 'check', params: { approval: 'mine' }, count: 'approvals', when: (boot, counts) => !counts || counts.approvals > 0 },
  { id: 'slaRisk', label: 'nav.slaRisk', icon: 'warning', params: { sla: 'risk' }, count: 'slaRisk', when: (boot) => boot.sla?.enabled },
];

const FILTER_KEYS = ['status', 'assignee', 'resolvedDays', 'resolution', 'type', 'priority', 'label', 'reporter', 'overdue', 'sla', 'approval', 'mentioned', 'participant', 'component'];

// Saved filters: same keys and order as the server (src/filters.js)
export const SAVED_KEYS = ['project', 'status', 'type', 'priority', 'assignee', 'reporter', 'participant', 'mentioned', 'label', 'overdue', 'resolvedDays', 'resolution', 'component', 'q', 'sort'];

/** Canonical query of a filter set; withSort=false for "is this the saved filter?" */
export function savedQuery(params, withSort = true) {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const out = new URLSearchParams();
  for (const k of SAVED_KEYS) if ((withSort || k !== 'sort') && p.get(k)) out.set(k, p.get(k).trim());
  return out.toString();
}

/** Saved filter that matches the current list (sorting does not count) */
export function matchSaved(filters, params) {
  const cur = savedQuery(params, false);
  if (!cur) return null;
  return (filters || []).find((f) => savedQuery(f.query, false) === cur) || null;
}

export function queueHref(q, projectKey) {
  const p = new URLSearchParams({ ...(projectKey ? { project: projectKey } : {}), ...q.params });
  return `/issues?${p}`;
}

/** Which queue/view matches the current filters? (search and sorting do not count) */
export function matchQueue(params) {
  const cur = {};
  for (const k of FILTER_KEYS) if (params.get(k)) cur[k] = params.get(k);
  const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
  return [...QUEUES, ...VIEWS].find((q) => same(q.params, cur)) || null;
}
