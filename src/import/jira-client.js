// Access to Jira Cloud (REST API v3) and Jira Server/Data Center (REST API v2).
// HTTP via ./http.js: internal certificates, no credentials on redirects to other hosts
// (Cloud attachments are hosted at api.media.atlassian.com).
import { createSourceHttp, SourceError } from './http.js';

const MAX_PAGES = 100000;

export class JiraError extends SourceError {}

/**
 * @param {object} c
 * @param {'cloud'|'server'} c.type
 * @param {string} c.baseUrl  e.g. https://firma.atlassian.net or https://tickets.firma.local
 * @param {string} [c.email]  Cloud: email of the account
 * @param {string} [c.token]  Cloud: API token · Server/DC: personal access token
 * @param {string} [c.username] Server/DC: username (instead of token)
 * @param {string} [c.password] Server/DC: password (instead of token)
 * @param {boolean} [c.verifyTls=true]
 * @param {string} [c.caPem] custom certificate authority (on-prem)
 */
export function createJiraClient(c) {
  const cloud = c.type === 'cloud';
  const api = cloud ? '/rest/api/3' : '/rest/api/2';

  let auth;
  if (cloud) auth = `Basic ${Buffer.from(`${c.email || ''}:${c.token || ''}`).toString('base64')}`;
  else if (c.token) auth = `Bearer ${c.token}`;
  else auth = `Basic ${Buffer.from(`${c.username || ''}:${c.password || ''}`).toString('base64')}`;

  const { base, basePath, json, download } = createSourceHttp({
    baseUrl: c.baseUrl, headers: () => ({ Authorization: auth }), verifyTls: c.verifyTls, caPem: c.caPem, ErrorClass: JiraError,
  });

  const FIELDS = ['summary', 'description', 'issuetype', 'status', 'priority', 'labels', 'created', 'updated',
    'resolutiondate', 'duedate', 'reporter', 'creator', 'assignee', 'attachment', 'components'];

  return {
    type: cloud ? 'cloud' : 'server',
    host: base.host,
    /** Unique identifier of the source for the mapping table */
    sourceId: `jira:${base.host}${basePath}`,

    async serverInfo() { return json(`${api}/serverInfo`); },
    async myself() { return json(`${api}/myself`); },

    async projects() {
      if (cloud) {
        const out = [];
        for (let startAt = 0, pages = 0; pages < MAX_PAGES; pages++) {
          const r = await json(`${api}/project/search?startAt=${startAt}&maxResults=50&orderBy=key`);
          out.push(...(r.values || []));
          startAt += (r.values || []).length;
          if (r.isLast || !r.values?.length || (r.total !== undefined && startAt >= r.total)) break;
        }
        return out.map((p) => ({ id: p.id, key: p.key, name: p.name }));
      }
      const r = await json(`${api}/project`);
      return (r || []).map((p) => ({ id: p.id, key: p.key, name: p.name }));
    },

    async countIssues(projectKey) {
      const jql = `project = "${projectKey.replace(/"/g, '')}"`;
      if (cloud) return (await json(`${api}/search/approximate-count`, { method: 'POST', body: { jql } })).count;
      return (await json(`${api}/search?jql=${encodeURIComponent(jql)}&maxResults=0`)).total;
    },

    /** Statuses and issue types of a project (for the mapping) */
    async projectStatuses(projectKey) {
      const r = await json(`${api}/project/${encodeURIComponent(projectKey)}/statuses`);
      const statuses = new Map();
      const types = new Set();
      for (const t of r || []) {
        types.add(t.name);
        for (const s of t.statuses || []) statuses.set(s.name, s.statusCategory?.key || 'indeterminate');
      }
      return { statuses: [...statuses].map(([name, category]) => ({ name, category })), types: [...types] };
    },

    /** All issues of a project page by page (oldest first) */
    async *issues(projectKey) {
      const jql = `project = "${projectKey.replace(/"/g, '')}" ORDER BY created ASC`;
      if (cloud) {
        let nextPageToken;
        const seenTokens = new Set();
        do {
          const r = await json(`${api}/search/jql`, { method: 'POST', body: { jql, fields: FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) } });
          for (const i of r.issues || []) yield i;
          nextPageToken = r.nextPageToken;
          // Protection against an endless loop: same token twice or empty page with token
          if (nextPageToken && (seenTokens.has(nextPageToken) || !(r.issues || []).length)) throw new JiraError('Das Quellsystem liefert beim Blättern immer wieder dieselbe Seite – Abbruch.', 502);
          if (nextPageToken) seenTokens.add(nextPageToken);
          if (seenTokens.size > MAX_PAGES) throw new JiraError('Zu viele Seiten – Abbruch.', 502);
        } while (nextPageToken);
        return;
      }
      // Server/DC: advance by the number actually returned (servers may return smaller pages)
      for (let startAt = 0, pages = 0; pages < MAX_PAGES; pages++) {
        const r = await json(`${api}/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=100&fields=${FIELDS.join(',')}`);
        const list = r.issues || [];
        for (const i of list) yield i;
        startAt += list.length;
        if (!list.length || startAt >= (r.total ?? 0)) break;
      }
    },

    async comments(issueIdOrKey) {
      const out = [];
      for (let startAt = 0; ; ) {
        const r = await json(`${api}/issue/${encodeURIComponent(issueIdOrKey)}/comment?startAt=${startAt}&maxResults=100&expand=properties`);
        const list = r.comments || [];
        out.push(...list);
        if (out.length > 50000) break;
        startAt += list.length;
        if (!list.length || startAt >= (r.total ?? 0)) break;
      }
      return out;
    },

    /** Download an attachment (follows the redirect to other hosts without credentials) */
    download,
  };
}

/** Detect the type automatically (Cloud: *.atlassian.net or deploymentType "Cloud") */
export async function detectJira(conn) {
  const guessCloud = /\.atlassian\.net$|\.jira\.com$/i.test(new URL(conn.baseUrl).hostname);
  const type = conn.type && conn.type !== 'auto' ? conn.type : (guessCloud ? 'cloud' : 'server');
  const client = createJiraClient({ ...conn, type });
  const info = await client.serverInfo();
  const isCloud = /cloud/i.test(info?.deploymentType || '');
  if (isCloud !== (type === 'cloud') && (!conn.type || conn.type === 'auto')) {
    return { client: createJiraClient({ ...conn, type: isCloud ? 'cloud' : 'server' }), info };
  }
  return { client, info };
}
