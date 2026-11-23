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

/**
 * File names a Jira text refers to: ADF (Cloud) media nodes (their alt is the file name), wiki markup
 * (Server/Data Center) !name! / !name|…! for pictures and [^name] for files.
 */
export function referencedFiles(body) {
  const names = new Set();
  if (typeof body === 'string') {
    for (const m of body.matchAll(/!([^!|\n]{1,255})(?:\|[^!\n]{0,200})?!/g)) names.add(m[1].trim());
    for (const m of body.matchAll(/\[\^([^\]\n]{1,255})\]/g)) names.add(m[1].trim());
    return names;
  }
  const stack = body && typeof body === 'object' ? [body] : [];
  let seen = 0;
  while (stack.length && seen++ < 100000) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if ((n.type === 'media' || n.type === 'mediaInline') && n.attrs?.alt) names.add(String(n.attrs.alt).trim());
    if (Array.isArray(n.content)) stack.push(...n.content);
  }
  return names;
}

/**
 * Visibility of the files of one issue. Jira files belong to the issue, not to a comment – a file
 * shown only in an internal comment must stay internal. Public: referenced by the description or a
 * public comment, or uploaded by the reporter. Referenced only by internal comments: belongs to the
 * first of them. Otherwise (nobody refers to it): internal as soon as the issue has internal comments
 * (with the uploader's internal comment, else the one closest in time) – when in doubt, internal.
 */
export function attachmentVisibility(files, { description, comments, reporterRef }) {
  const pub = referencedFiles(description);
  for (const c of comments) if (!c.internal) for (const n of referencedFiles(c.raw)) pub.add(n);
  const internals = comments.filter((c) => c.internal);
  const time = (x) => Date.parse(x) || 0;
  return files.map((a) => {
    if (pub.has(a.filename) || (reporterRef && a.authorRef === reporterRef)) return { commentExtId: null, internal: false };
    const ref = internals.find((c) => referencedFiles(c.raw).has(a.filename));
    if (ref) return { commentExtId: ref.extId, internal: true };
    if (!internals.length) return { commentExtId: null, internal: false };
    const own = internals.find((c) => a.authorRef && c.authorRef === a.authorRef);
    const near = own || internals.reduce((best, c) => (Math.abs(time(c.created) - time(a.created)) < Math.abs(time(best.created) - time(a.created)) ? c : best));
    return { commentExtId: near.extId, internal: true };
  });
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
        // Comments are needed twice (comments, visibility of the files): fetched once per issue
        let commentsOnce = null;
        const rawComments = () => (commentsOnce ||= client.comments(issue.id));
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
          // Jira allows several components – Helfi.Space has one per ticket: the first one
          component: Array.isArray(f.components) && f.components[0]?.name ? f.components[0].name : null,
          due: f.duedate,
          created: f.created,
          updated: f.updated,
          resolved: f.resolutiondate,
          resolutionName: f.resolution?.name || '',
          reporter: jiraPerson(f.reporter || f.creator),
          assignee: jiraPerson(f.assignee),
          comments: async () => (await rawComments()).map((c) => ({
            extId: String(c.id), author: jiraPerson(c.author), body: jiraText(c.body), internal: isInternalComment(c), created: c.created,
          })),
          attachments: async () => {
            const files = f.attachment || [];
            const comments = (await rawComments()).map((c) => ({ extId: String(c.id), internal: isInternalComment(c), raw: c.body, created: c.created, authorRef: jiraPerson(c.author)?.ref }));
            const vis = attachmentVisibility(files.map((a) => ({ filename: a.filename, created: a.created, authorRef: jiraPerson(a.author)?.ref })),
              { description: f.description, comments, reporterRef: jiraPerson(f.reporter || f.creator)?.ref });
            return files.map((a, i) => ({
              extId: String(a.id), filename: a.filename, mime: a.mimeType, size: a.size, created: a.created, author: jiraPerson(a.author),
              commentExtId: vis[i].commentExtId, internal: vis[i].internal,
              load: (maxBytes) => client.download(a.content, maxBytes),
            }));
          },
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
