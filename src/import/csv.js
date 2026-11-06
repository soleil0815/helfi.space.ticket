// Import from a CSV file (export of any ticket system or a spreadsheet): adapter for the common
// import (./core.js). The columns are assigned in the administration; a "project/queue" column
// splits the file into projects, otherwise everything goes into one.
import crypto from 'node:crypto';
import { parseCsv } from '../itil/cmdb.js';
import { SourceError } from './http.js';

export const MAX_CSV_BYTES = 50 * 1024 * 1024;

/** Target fields and the column names that are recognised automatically (lower case, de/en) */
export const CSV_FIELDS = {
  id: ['id', 'ticket id', 'ticketid', 'ticket-id', 'nr', 'nr.', 'nummer', 'number', 'ticket number', 'ticketnummer', 'ticket #', 'ticket', 'key', 'schlüssel', '#'],
  title: ['title', 'titel', 'subject', 'betreff', 'summary', 'zusammenfassung', 'issue summary'],
  description: ['description', 'beschreibung', 'body', 'text', 'message', 'nachricht', 'details', 'inhalt', 'problem'],
  status: ['status', 'state', 'zustand', 'ticket status'],
  type: ['type', 'typ', 'ticket type', 'tickettyp', 'issue type', 'vorgangstyp', 'kategorie', 'category'],
  priority: ['priority', 'priorität', 'prioritaet', 'prio', 'dringlichkeit', 'urgency'],
  reporterEmail: ['email', 'e-mail', 'mail', 'reporter email', 'requester email', 'melder e-mail', 'melder email', 'from', 'von', 'customer email', 'kunde e-mail', 'kunden-e-mail', 'user email'],
  reporterName: ['reporter', 'melder', 'requester', 'name', 'customer', 'kunde', 'anfragender', 'antragsteller', 'created by', 'erstellt von', 'user', 'from name', 'full name'],
  assignee: ['assignee', 'bearbeiter', 'agent', 'owner', 'besitzer', 'zugewiesen', 'zugewiesen an', 'assigned to', 'zuständig', 'verantwortlich', 'responsible', 'staff', 'technician', 'techniker'],
  labels: ['labels', 'label', 'tags', 'tag', 'stichwörter', 'schlagwörter', 'schlagworte'],
  created: ['created', 'erstellt', 'created at', 'created on', 'create date', 'erstellt am', 'angelegt', 'date', 'datum', 'opened', 'eröffnet', 'creation date'],
  updated: ['updated', 'aktualisiert', 'last updated', 'updated at', 'geändert', 'changed', 'modified', 'zuletzt geändert', 'last update'],
  resolved: ['resolved', 'erledigt', 'closed', 'geschlossen', 'resolved at', 'closed at', 'close date', 'erledigt am', 'geschlossen am', 'gelöst'],
  due: ['due', 'fällig', 'due date', 'fälligkeit', 'fällig am', 'deadline', 'termin'],
  project: ['project', 'projekt', 'queue', 'gruppe', 'group', 'department', 'abteilung', 'team', 'help topic', 'bereich'],
  comments: ['comments', 'kommentare', 'antworten', 'replies', 'verlauf', 'thread'],
};

/** Headers → suggested assignment { field: header } (each header only once) */
export function suggestColumns(headers) {
  const used = new Set();
  const out = {};
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[_]/g, ' ');
  for (const [field, words] of Object.entries(CSV_FIELDS)) {
    const h = headers.find((x) => !used.has(x) && words.includes(norm(x)));
    if (h !== undefined) { out[field] = h; used.add(h); }
  }
  return out;
}

/** Dates as in exports: ISO, "02.01.2026 10:11", "2026-01-02 10:11:12", Unix seconds */
export function csvDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (m) {
    const time = m[2].length <= 5 ? m[2].padStart(5, '0') : m[2].padStart(8, '0'); // "9:05" → "09:05"
    const d = new Date(`${m[1]}T${time}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function csvCategory(name) {
  const n = String(name || '').toLowerCase();
  if (/wait|warte|pending|hold|rückmeldung|feedback/.test(n)) return 'waiting';
  if (/closed|resolved|done|erledigt|geschlossen|gelöst|fertig|abgeschlossen|archiv/.test(n)) return 'done';
  if (/^(new|neu|open|offen|eröffnet)$/.test(n.trim()) || !n.trim()) return 'new';
  return 'indeterminate';
}

/** Read a file: headers, rows (as objects) and a preview */
export function readCsv(text) {
  if (Buffer.byteLength(String(text || '')) > MAX_CSV_BYTES) throw new SourceError('Die Datei ist zu groß (höchstens 50 MB).', 413);
  const rows = parseCsv(text);
  if (rows.length < 2) throw new SourceError('Die Datei enthält keine Zeilen unter der Kopfzeile.', 400);
  const headers = rows[0].map((h, i) => String(h || '').trim() || `Spalte ${i + 1}`);
  // duplicate header names get a number, so every column stays reachable
  const seen = new Map();
  const unique = headers.map((h) => { const n = (seen.get(h) || 0) + 1; seen.set(h, n); return n > 1 ? `${h} (${n})` : h; });
  const records = rows.slice(1).map((r) => Object.fromEntries(unique.map((h, i) => [h, String(r[i] ?? '')])));
  return { headers: unique, records };
}

/**
 * c.text: file contents · c.name: name of the source (for repeat imports) · c.columns: { field: header }
 */
export function csvAdapter(c) {
  const { headers, records } = readCsv(c.text);
  const cols = Object.fromEntries(Object.entries(c.columns || {}).filter(([f, h]) => CSV_FIELDS[f] && headers.includes(h)));
  if (!cols.title) throw new SourceError('Bitte die Spalte für den Titel zuordnen.', 400);
  const name = String(c.name || 'CSV').trim().slice(0, 60) || 'CSV';
  const get = (r, f) => (cols[f] ? String(r[cols[f]] ?? '').trim() : '');
  const projectOf = (r) => get(r, 'project') || '*';
  const extIdOf = (r) => get(r, 'id') || crypto.createHash('sha256').update(JSON.stringify([get(r, 'title'), get(r, 'created'), get(r, 'reporterEmail'), get(r, 'reporterName'), get(r, 'description').slice(0, 200)])).digest('hex').slice(0, 24);
  const rows = records.filter((r) => get(r, 'title') || get(r, 'description'));

  return {
    kind: 'csv',
    sourceId: `csv:${name.toLowerCase()}`,
    host: name,
    ticketSource: 'import',
    keyPrefix: 'C',
    async info() { return { title: name, version: '', user: '' }; },
    async projects() {
      const by = new Map();
      for (const r of rows) { const k = projectOf(r); by.set(k, (by.get(k) || 0) + 1); }
      return [...by].map(([k, n]) => ({ key: k, name: k === '*' ? name : k, suggestKey: k === '*' ? name : k, count: n }));
    },
    async inspect(keys) {
      const want = new Set(keys.map(String));
      const statuses = new Map();
      const types = new Set();
      const counts = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const r of rows) {
        const k = projectOf(r);
        if (!want.has(k)) continue;
        counts[k]++;
        const s = get(r, 'status');
        statuses.set(s, csvCategory(s));
        types.add(get(r, 'type'));
      }
      return { statuses: [...statuses].map(([n, category]) => ({ name: n, category })), types: [...types], counts };
    },
    async count(key) { return rows.filter((r) => projectOf(r) === String(key)).length; },
    async *tickets(key) {
      for (const r of rows) {
        if (projectOf(r) !== String(key)) continue;
        const extId = extIdOf(r);
        const email = get(r, 'reporterEmail');
        const reporterName = get(r, 'reporterName');
        const assignee = get(r, 'assignee');
        const status = get(r, 'status');
        const commentText = get(r, 'comments');
        yield {
          extId,
          extKey: get(r, 'id') || get(r, 'title').slice(0, 40),
          ...(get(r, 'id') ? {} : { number: null }),
          title: get(r, 'title') || get(r, 'description').split('\n')[0].slice(0, 120),
          description: get(r, 'description'),
          typeName: get(r, 'type'),
          statusName: status,
          statusCategory: csvCategory(status),
          priorityName: get(r, 'priority'),
          labels: get(r, 'labels').split(/[,;|]/).map((x) => x.trim()).filter(Boolean),
          due: csvDate(get(r, 'due'))?.slice(0, 10) || null,
          created: csvDate(get(r, 'created')),
          updated: csvDate(get(r, 'updated')) || csvDate(get(r, 'resolved')) || csvDate(get(r, 'created')),
          resolved: csvDate(get(r, 'resolved')),
          reporter: email || reporterName ? { email: /@/.test(email) ? email : '', name: reporterName || email } : null,
          assignee: assignee ? { email: /@/.test(assignee) ? assignee : '', username: /@/.test(assignee) ? '' : assignee, name: assignee, ref: `csv:${assignee.toLowerCase()}` } : null,
          // One comment column: everything as one internal note (it is unclear who wrote what and for whom)
          comments: commentText ? async () => [{ extId: `${extId}:c`, author: null, body: commentText, internal: true, created: csvDate(get(r, 'updated')) || csvDate(get(r, 'created')) }] : null,
          attachments: null,
        };
      }
    },
  };
}
