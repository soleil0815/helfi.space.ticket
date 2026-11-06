// Import from Jira (Cloud or Server/Data Center): adapter for the common import (./core.js).
import { jiraText } from './jira-text.js';
import { createJiraClient } from './jira-client.js';

export { STATUS_TARGETS, TYPE_TARGETS, suggestStatus, suggestType, mapPriority, sanitizeProjectKey, iso } from './core.js';

/** Internal comment? (Jira Service Management "internal comment" or restricted visibility) */
export function isInternalComment(c) {
  if (c.jsdPublic === false) return true;
  if (c.visibility) return true;
  const prop = (c.properties || []).find((p) => p.key === 'sd.public.comment');
  return !!prop?.value?.internal;
}

const jiraPerson = (p) => (p ? { email: p.emailAddress || '', name: p.displayName || p.name || p.emailAddress || '', username: p.name || '', ref: p.accountId || p.key || p.name || p.emailAddress } : null);

/** Adapter: Jira client → tickets in the common shape */
export function jiraAdapter(conn) {
  const client = createJiraClient(conn);
  return {
    kind: 'jira',
    sourceId: client.sourceId,
    host: client.host,
    ticketSource: 'jira',
    keyPrefix: 'J',
    client,
    async info() {
      const [info, me] = await Promise.all([client.serverInfo(), client.myself()]);
      return { title: info?.serverTitle || '', version: info?.version || '', deploymentType: info?.deploymentType || '', user: me?.displayName || me?.name || me?.emailAddress || '' };
    },
    async projects() { return client.projects(); },
    async inspect(projectKeys) {
      const statuses = new Map();
      const types = new Set();
      const counts = {};
      for (const key of projectKeys) {
        const r = await client.projectStatuses(key);
        for (const s of r.statuses) statuses.set(s.name, s.category);
        r.types.forEach((x) => types.add(x));
        try { counts[key] = await client.countIssues(key); } catch { counts[key] = null; }
      }
      return { statuses: [...statuses].map(([name, category]) => ({ name, category })), types: [...types], counts };
    },
    count: (key) => client.countIssues(key),
    async *tickets(projectKey) {
      for await (const issue of client.issues(projectKey)) {
        const f = issue.fields || {};
        yield {
          extId: String(issue.id),
          extKey: issue.key,
          title: f.summary || issue.key,
          description: jiraText(f.description),
          typeName: f.issuetype?.name || '',
          statusName: f.status?.name || '',
          statusCategory: f.status?.statusCategory?.key,
          priorityName: f.priority?.name,
          labels: f.labels || [],
          due: f.duedate,
          created: f.created,
          updated: f.updated,
          resolved: f.resolutiondate,
          reporter: jiraPerson(f.reporter || f.creator),
          assignee: jiraPerson(f.assignee),
          comments: async () => (await client.comments(issue.id)).map((c) => ({
            extId: String(c.id), author: jiraPerson(c.author), body: jiraText(c.body), internal: isInternalComment(c), created: c.created,
          })),
          attachments: async () => (f.attachment || []).map((a) => ({
            extId: String(a.id), filename: a.filename, mime: a.mimeType, size: a.size, created: a.created, author: jiraPerson(a.author),
            load: (maxBytes) => client.download(a.content, maxBytes),
          })),
        };
      }
    },
  };
}

/** Jira importer (kept for the existing routes): connection data → adapter → common import */
export function createJiraImporter({ core }) {
  return {
    status: core.status,
    async connect(conn) {
      const a = jiraAdapter(conn);
      return core.connect(a, { type: a.client.type });
    },
    inspect: (conn, projectKeys) => core.inspect(jiraAdapter(conn), projectKeys),
    start: (conn, opts, userId) => core.start(jiraAdapter(conn), opts, userId),
    cancel: core.cancel,
    wait: core.wait,
  };
}
