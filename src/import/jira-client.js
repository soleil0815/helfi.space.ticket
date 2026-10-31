// Zugriff auf Jira Cloud (REST API v3) und Jira Server/Data Center (REST API v2).
// Eigener kleiner HTTP-Client, damit auch interne Zertifikate (On-Prem) und
// "nicht prüfen" möglich sind und Anmeldedaten bei Umleitungen zu fremden Hosts
// (Cloud-Anhänge liegen bei api.media.atlassian.com) nicht mitgeschickt werden.
import http from 'node:http';
import https from 'node:https';
import { log } from '../lib/log.js';

const MAX_BODY = 512 * 1024 * 1024; // Anhänge
const MAX_JSON = 64 * 1024 * 1024; // API-Antworten
const MAX_PAGES = 100000;

export class JiraError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * @param {object} c
 * @param {'cloud'|'server'} c.type
 * @param {string} c.baseUrl  z. B. https://firma.atlassian.net oder https://jira.firma.local
 * @param {string} [c.email]  Cloud: E-Mail des Kontos
 * @param {string} [c.token]  Cloud: API-Token · Server/DC: Personal Access Token
 * @param {string} [c.username] Server/DC: Benutzername (statt Token)
 * @param {string} [c.password] Server/DC: Kennwort (statt Token)
 * @param {boolean} [c.verifyTls=true]
 * @param {string} [c.caPem] eigene Zertifizierungsstelle (On-Prem)
 */
export function createJiraClient(c) {
  const base = new URL(String(c.baseUrl || '').trim().replace(/\/+$/, '') + '/');
  if (!/^https?:$/.test(base.protocol)) throw new JiraError('Nur http:// oder https:// Adressen sind erlaubt.', 400);
  const cloud = c.type === 'cloud';
  const api = cloud ? '/rest/api/3' : '/rest/api/2';
  const basePath = base.pathname.replace(/\/$/, ''); // Kontextpfad, z. B. /jira

  let auth;
  if (cloud) auth = `Basic ${Buffer.from(`${c.email || ''}:${c.token || ''}`).toString('base64')}`;
  else if (c.token) auth = `Bearer ${c.token}`;
  else auth = `Basic ${Buffer.from(`${c.username || ''}:${c.password || ''}`).toString('base64')}`;

  const tlsOpts = { rejectUnauthorized: c.verifyTls !== false, ...(c.caPem ? { ca: c.caPem } : {}) };

  function raw(urlStr, { method = 'GET', body, headers = {}, withAuth = true, redirects = 5, timeoutMs = 60000, maxBytes = MAX_BODY } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const mod = url.protocol === 'https:' ? https : http;
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = mod.request(url, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Helfi.Space-Import',
          ...(withAuth ? { Authorization: auth } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
        timeout: timeoutMs,
        ...(url.protocol === 'https:' ? tlsOpts : {}),
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url);
          // Anmeldedaten nur an denselben Host weitergeben
          const sameOrigin = next.origin === base.origin;
          return resolve(raw(next.href, { method: res.statusCode === 303 ? 'GET' : method, body: res.statusCode === 303 ? undefined : body, headers, withAuth: withAuth && sameOrigin, redirects: redirects - 1, timeoutMs, maxBytes }));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (d) => {
          size += d.length;
          if (size > maxBytes) { req.destroy(new JiraError('Antwort zu groß', 413)); return; }
          chunks.push(d);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new JiraError(`Zeitüberschreitung bei ${url.host}`, 504)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** JSON-Aufruf mit Wiederholung bei 429/503 (Retry-After) */
  async function json(path, opts = {}) {
    const url = path.startsWith('http') ? path : `${base.origin}${basePath}${path}`;
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await raw(url, { maxBytes: MAX_JSON, ...opts });
      } catch (e) {
        if (e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN' || e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          throw new JiraError(`Zertifikat von ${base.host} wird nicht vertraut (${e.code}). Eigene CA eintragen oder Prüfung abschalten.`, 495);
        }
        // Kurze Netzstörung: ein paar Mal wiederholen, statt den ganzen Import abzubrechen
        if (attempt < 3 && !(e instanceof JiraError && e.status === 413)) { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); continue; }
        throw new JiraError(`${base.host} nicht erreichbar: ${e.message}`, 502);
      }
      if ([502, 504].includes(r.status) && attempt < 3) { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); continue; }
      if ((r.status === 429 || r.status === 503) && attempt < 6) {
        const wait = Math.min(60, Number(r.headers['retry-after']) || 2 ** attempt) * 1000;
        log.info(`Quellsystem bremst (HTTP ${r.status}), warte ${wait / 1000}s`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      const text = r.body.toString('utf8');
      if (r.status === 401) throw new JiraError('Anmeldung beim Quellsystem fehlgeschlagen (Benutzer/Token prüfen).', 401);
      if (r.status === 403) throw new JiraError('Keine Berechtigung im Quellsystem für diese Abfrage.', 403);
      if (r.status >= 400) {
        let msg = text.slice(0, 300);
        try { const j = JSON.parse(text); msg = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join('; ') || msg; } catch { /* kein JSON */ }
        throw new JiraError(`Quellsystem antwortet mit HTTP ${r.status}: ${msg}`, r.status);
      }
      try { return text ? JSON.parse(text) : null; }
      catch { throw new JiraError(`Unerwartete Antwort von ${base.host} (kein JSON) – ist die Adresse richtig?`, 502); }
    }
  }

  const FIELDS = ['summary', 'description', 'issuetype', 'status', 'priority', 'labels', 'created', 'updated',
    'resolutiondate', 'duedate', 'reporter', 'creator', 'assignee', 'attachment'];

  return {
    type: cloud ? 'cloud' : 'server',
    host: base.host,
    /** Eindeutige Kennung der Quelle für die Zuordnungstabelle */
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

    /** Status und Vorgangstypen eines Projekts (für die Zuordnung) */
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

    /** Alle Vorgänge eines Projekts seitenweise (älteste zuerst) */
    async *issues(projectKey) {
      const jql = `project = "${projectKey.replace(/"/g, '')}" ORDER BY created ASC`;
      if (cloud) {
        let nextPageToken;
        const seenTokens = new Set();
        do {
          const r = await json(`${api}/search/jql`, { method: 'POST', body: { jql, fields: FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) } });
          for (const i of r.issues || []) yield i;
          nextPageToken = r.nextPageToken;
          // Schutz vor Endlosschleife: gleiches Token zweimal oder leere Seite mit Token
          if (nextPageToken && (seenTokens.has(nextPageToken) || !(r.issues || []).length)) throw new JiraError('Das Quellsystem liefert beim Blättern immer wieder dieselbe Seite – Abbruch.', 502);
          if (nextPageToken) seenTokens.add(nextPageToken);
          if (seenTokens.size > MAX_PAGES) throw new JiraError('Zu viele Seiten – Abbruch.', 502);
        } while (nextPageToken);
        return;
      }
      // Server/DC: um die tatsächlich gelieferte Anzahl weiterblättern (Server können kleinere Seiten liefern)
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

    /** Anhang herunterladen (folgt der Umleitung ohne Anmeldedaten zu fremden Hosts) */
    async download(contentUrl, maxBytes) {
      const url = new URL(contentUrl, base);
      const r = await raw(url.href, { headers: { Accept: '*/*' }, withAuth: url.origin === base.origin, maxBytes, timeoutMs: 300000 });
      if (r.status >= 400) throw new JiraError(`Anhang nicht ladbar (HTTP ${r.status})`, r.status);
      return r.body;
    },
  };
}

/** Typ automatisch erkennen (Cloud: *.atlassian.net oder deploymentType "Cloud") */
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
