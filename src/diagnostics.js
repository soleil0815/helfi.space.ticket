// Diagnosis package: one anonymous text file (Markdown) about the state of this installation, for
// handing to support. Administration → System → "Diagnosis package" or `helfi-admin diagnose`.
//
// Anonymous by design:
// - No ticket contents, subjects, comments or attachments – only counts.
// - Settings: switches, numbers and known choices are shown; free text (host names, addresses, DNs,
//   groups, filters, …) only as "set"/"empty"; secrets never. New settings are covered automatically
//   (by type) – free text is always treated as confidential.
// - Log lines and error messages: names, user names, mail addresses, IP addresses, host names, domains
//   and AD DNs become placeholders such as <person-3>, <mail-2>, <ip-5 private>, <host-1>. Within one
//   package the same value always gets the same placeholder (so flows can be followed); a new
//   package numbers anew.
//
// Keeping it current: further parts of the program add their own section with
//   ctx.diagnostics.register('Title', () => ({ key: value, … }))
// The values are anonymized like everything else.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { config, paths } from './config.js';
import { DEFAULTS, SECRET_KEYS } from './settings.js';
import { MIGRATIONS, SCHEMA_VERSION } from './db.js';
import { recentLogLines } from './lib/log.js';
import { readEmergencyLog } from './emergency.js';

export const LOG_LINES = 1000;
const MAX_LINE = 2000;
const FILE_LINES = 500;

// Settings with a fixed set of values: shown as they are (anything else as "changed")
const CHOICES = {
  'general.userStart': ['portal', 'requests'],
  'general.defaultLanguage': ['de', 'en'],
  'change.approvalMode': ['any', 'all'],
  'brand.header': ['light', 'color'],
  'ai.reasoning': ['off', 'low', 'medium', 'high'],
  'ai.classifyMode': ['suggest', 'auto'],
  'register.passwordReset': ['off', 'users', 'all'],
  'mfa.mode': ['off', 'external', 'always'],
  'mfa.external': ['', 'all', 'agents', 'admins', 'none'],
  'mfa.internal': ['', 'none', 'admins', 'agents', 'all'],
  'mfa.ssoSecondFactor': ['never', 'confirmed', 'always'],
  'ldap.security': ['ldaps', 'starttls', 'none'],
  'ldap.tlsMode': ['pinned', 'system', 'insecure'],
  'imap.security': ['tls', 'starttls', 'none'],
  'smtp.security': ['tls', 'starttls', 'none'],
  'reminder.time': null, // HH:MM
};
// JSON settings without personal data: shown in full
const SAFE_JSON = new Set(['sla.hours', 'sla.targets']);
// Environment variables whose value is harmless (others only "set")
const ENV_VALUES = new Set(['HELFI_LOG_LEVEL', 'HELFI_PORT', 'HELFI_SECURE_COOKIES', 'HELFI_FORCE_HTTPS', 'HELFI_HSTS',
  'HELFI_COMPOSE_VERSION', 'HELFI_MAX_UPLOAD_MB', 'HELFI_SESSION_HOURS', 'HELFI_TRUST_PROXY', 'NODE_ENV', 'TZ']);

// Host names in free text: only with a usual top-level domain (code names such as "ctx.poller" stay);
// host names from the settings and the own address are replaced in any case
const TLDS = 'com|net|org|de|at|ch|eu|io|me|tv|xyz|info|biz|co|uk|fr|nl|be|it|es|pl|dk|se|no|fi|cz|lu|li|us|gov|edu|int|cloud|app|dev|online|site|tech|local|lan|intern|internal|intra|corp|home|arpa|localdomain|test|example|invalid';
const HOST_RE = new RegExp(`(?<![\\w.@<-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})(?![\\w-]|\\.\\w)`, 'gi');

/** Replaces personal and identifying values by numbered placeholders (stable within one instance). */
export class Anonymizer {
  constructor() {
    this.known = []; // [value, kind] – exact strings (names, settings values)
    this.knownKind = null; // lower-case value → [value, kind] (built with the pattern)
    this.maps = new Map(); // kind → Map(value → placeholder)
  }

  placeholder(kind, value, note = '') {
    const key = String(value).toLowerCase();
    if (!this.maps.has(kind)) this.maps.set(kind, new Map());
    const m = this.maps.get(kind);
    if (!m.has(key)) m.set(key, `<${kind}-${m.size + 1}${note ? ` ${note}` : ''}>`);
    return m.get(key);
  }

  /** Exact values to replace wherever they appear as a whole word (at least 3 characters) */
  add(value, kind) {
    const v = String(value ?? '').trim();
    if (v.length < 3 || this.knownKind?.has(v.toLowerCase())) return;
    this.known.push([v, kind]);
    this.knownKind = null; // rebuild the combined pattern
  }

  /** One pattern for all known values (longest first, so "Max Muster" goes before "Max") */
  knownPattern() {
    if (this.knownKind) return this.knownRe;
    this.knownKind = new Map();
    const sorted = this.known.slice().sort((a, b) => b[0].length - a[0].length);
    for (const [v, kind] of sorted) if (!this.knownKind.has(v.toLowerCase())) this.knownKind.set(v.toLowerCase(), [v, kind]);
    const alt = [...this.knownKind.values()].map(([v]) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    this.knownRe = alt ? new RegExp(`(?<![\\w<])(?:${alt})(?![\\w>])`, 'gi') : null;
    return this.knownRe;
  }

  ipNote(ip) {
    if (/^127\.|^::1$|^::ffff:127\./.test(ip)) return 'loopback';
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^f[cd][0-9a-f]{2}:|^fe80:|^::ffff:(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./i.test(ip)) return 'private';
    return 'public';
  }

  /** Anonymize text line by line; overlong lines are cut (also keeps the patterns fast) */
  text(input) {
    const s = String(input ?? '');
    if (!s) return s;
    return s.split('\n').map((line) => this.line(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} …[${line.length - MAX_LINE} characters cut]` : line)).join('\n');
  }

  line(input) {
    let s = input;
    // 1. Known values
    const re = this.knownPattern();
    if (re) s = s.replace(re, (m) => { const [v, kind] = this.knownKind.get(m.toLowerCase()); return this.placeholder(kind, v); });
    // 2. Patterns
    s = s.replace(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g, (m) => this.placeholder('mail', m));
    // AD distinguished names (CN=…,OU=…,DC=…)
    // (AD DNs end with DC=…; values of the other parts may contain spaces)
    s = s.replace(/\b(?:(?:CN|OU|DC|O|L|ST|C|UID)=[^,;"'\n=]+,\s*)+DC=[^,;"'\s]+/gi, (m) => this.placeholder('dn', m));
    // URLs: keep scheme and path, hide the host
    s = s.replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)(\[[0-9a-f:.]+\]|[^/\s:'"<>]+)/gi, (m, scheme, host) => {
      if (host.startsWith('<')) return m;
      const h = host.replace(/^\[|\]$/g, '');
      return scheme + (net.isIP(h) ? this.placeholder('ip', h, this.ipNote(h)) : this.placeholder('host', h));
    });
    // IPv6 (also ::ffff:10.0.0.1) and IPv4 addresses
    // (bounded repetitions: no slow backtracking on long hex strings such as tokens or hashes)
    s = s.replace(/(?<![\w:<-])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f.]{0,15}(?![\w:])/gi, (m) => (net.isIPv6(m) && m !== '::' ? this.placeholder('ip', m, this.ipNote(m)) : m));
    s = s.replace(/(?<![\w.:<-])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, (m) => (net.isIPv4(m) ? this.placeholder('ip', m, this.ipNote(m)) : m));
    // Host names / domains
    s = s.replace(HOST_RE, (m) => this.placeholder('host', m));
    return s;
  }

  /** Recursively anonymize strings in an object */
  value(v, depth = 0) {
    if (typeof v === 'string') return this.text(v);
    if (v === null || typeof v !== 'object' || depth > 6) return v;
    if (Array.isArray(v)) return v.map((x) => this.value(x, depth + 1));
    const out = {};
    // Key names that point to a secret (but not "passkey", "Secure cookies" & co.)
    for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'string' && x && /password|passwd|secret|token|apikey|api_key|credential|authorization/i.test(k) ? '[hidden]' : this.value(x, depth + 1);
    return out;
  }
}

/** One settings value for the package */
export function describeSetting(key, value) {
  const def = DEFAULTS[key];
  if (SECRET_KEYS.has(key)) return value ? 'secret, set' : 'secret, empty';
  if (typeof def === 'boolean' || typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof def === 'number') return String(value);
  const v = String(value ?? '');
  if (v === String(def ?? '')) return v === '' ? 'empty (default)' : `default (${v.length > 80 ? `${v.slice(0, 77)}…` : v})`;
  if (v === '') return 'empty';
  if (key in CHOICES) {
    const allowed = CHOICES[key];
    if (allowed === null ? /^\d{1,2}:\d{2}$/.test(v) : allowed.includes(v)) return v;
  }
  if (SAFE_JSON.has(key)) return v;
  if (/^\s*[[{]/.test(v)) {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j) ? `set (JSON, ${j.length} entries)` : `set (JSON, ${Object.keys(j).length} keys)`;
    } catch { return 'set (invalid JSON)'; }
  }
  const lines = v.split(/[\n,]+/).filter((x) => x.trim()).length;
  return lines > 1 ? `set (${lines} entries)` : 'set';
}

export function createDiagnostics(ctx) {
  const sections = []; // [title, fn]

  function register(title, fn) { sections.push([title, fn]); }

  /** All exact values that must not appear: people, settings free text, address of this installation */
  function anonymizer() {
    const a = new Anonymizer();
    const { db, settings } = ctx;
    try {
      for (const u of db.prepare('SELECT username, display_name, email FROM users').iterate()) {
        a.add(u.email, 'mail');
        a.add(u.display_name, 'person');
        a.add(u.username, 'person');
        // Also the parts of "Vorname Nachname"
        for (const part of String(u.display_name || '').split(/\s+/)) if (part.length >= 4) a.add(part, 'person');
      }
      for (const p of db.prepare('SELECT name, key FROM projects').iterate()) { a.add(p.name, 'project'); }
    } catch { /* tables missing (very old database) */ }
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[key] !== 'string' || SECRET_KEYS.has(key) || SAFE_JSON.has(key)) continue;
      const v = String(settings.get(key) ?? '');
      // Default values and known choices are not personal (anything else in a choice field is treated as free text)
      if (v === DEFAULTS[key] || !describeSetting(key, v).startsWith('set')) continue;
      for (const part of v.split(/[\n,;]+/)) a.add(part.trim(), key.startsWith('ldap.') || key.startsWith('oidc.') ? 'directory' : 'setting');
    }
    try { a.add(new URL(config.baseUrl).hostname, 'host'); } catch { /* invalid */ }
    return a;
  }

  function safe(fn) {
    try { return fn(); } catch (e) { return { error: e.message }; }
  }

  function systemInfo() {
    const mem = process.memoryUsage();
    const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;
    return {
      'Helfi.Space': config.version,
      Node: process.version,
      'OS / architecture': `${os.type()} ${os.release()} / ${process.arch}`,
      'In Docker': fs.existsSync('/.dockerenv') ? 'yes' : 'no',
      'Running since': `${Math.round(process.uptime() / 60)} min`,
      'Memory (process)': `${mb(mem.rss)} (heap ${mb(mem.heapUsed)} / ${mb(mem.heapTotal)})`,
      'Memory (system)': `${mb(os.freemem())} free of ${mb(os.totalmem())}`,
      CPUs: os.cpus().length,
      'Load (1/5/15 min)': os.loadavg().map((n) => n.toFixed(2)).join(' / '),
      Timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      'Time (server)': new Date().toISOString(),
      'HTTPS address': config.baseUrl.startsWith('https://') ? 'yes' : 'no',
      'Secure cookies': config.secureCookies ? 'yes' : 'no',
      'Trust proxy': String(config.trustProxy),
      'Compose file version': `${config.composeVersion || 'unknown'}`,
    };
  }

  function environment() {
    const out = {};
    for (const k of Object.keys(process.env).filter((x) => x.startsWith('HELFI_') || x === 'NODE_ENV' || x === 'TZ').sort()) {
      out[k] = ENV_VALUES.has(k) ? process.env[k] : 'set';
    }
    return out;
  }

  function database() {
    const { db } = ctx;
    const one = (sql) => safe(() => db.prepare(sql).get());
    const dbSchema = safe(() => Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0));
    const all = (sql) => safe(() => Object.fromEntries(db.prepare(sql).all().map((r) => [r.k ?? '(none)', r.n])));
    let attachments = null;
    try {
      let n = 0; let size = 0;
      for (const f of fs.readdirSync(paths.attachments)) { const st = fs.statSync(`${paths.attachments}/${f}`); if (st.isFile()) { n++; size += st.size; } }
      attachments = `${n} files, ${Math.round(size / 1024 / 1024)} MB`;
    } catch { attachments = 'folder not readable'; }
    return {
      'File size': safe(() => `${Math.round(fs.statSync(paths.db).size / 1024 / 1024 * 10) / 10} MB`),
      'Schema (program / database)': `${SCHEMA_VERSION} / ${typeof dbSchema === 'number' ? dbSchema : '?'}`,
      'Missing migrations': typeof dbSchema === 'number' ? MIGRATIONS.filter((m) => m.id > dbSchema).map((m) => m.id).join(', ') || 'none' : '?',
      'Integrity check': safe(() => db.pragma('quick_check', { simple: true })),
      'Journal mode': safe(() => db.pragma('journal_mode', { simple: true })),
      'Tickets by status': all('SELECT status k, COUNT(*) n FROM tickets GROUP BY status'),
      'Tickets by type': all('SELECT type k, COUNT(*) n FROM tickets GROUP BY type'),
      'Comments': one('SELECT COUNT(*) n FROM comments')?.n,
      'Accounts by role': all("SELECT role k, COUNT(*) n FROM users WHERE source<>'email' GROUP BY role"),
      'Accounts by source': all('SELECT source k, COUNT(*) n FROM users GROUP BY source'),
      'Inactive accounts': one("SELECT COUNT(*) n FROM users WHERE active=0 AND source<>'email'")?.n,
      'With 2FA': one('SELECT COUNT(*) n FROM users WHERE totp_enabled=1')?.n,
      'With passkey': one('SELECT COUNT(DISTINCT user_id) n FROM user_passkeys')?.n,
      Projects: one('SELECT COUNT(*) n FROM projects')?.n,
      'Knowledge articles': one('SELECT COUNT(*) n FROM kb_articles')?.n,
      'Active sessions': safe(() => db.prepare('SELECT COUNT(*) n FROM sessions WHERE expires_at > ?').get(Date.now()).n),
      Attachments: attachments,
    };
  }

  function settingsTable() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) out[key] = describeSetting(key, ctx.settings.get(key));
    return out;
  }

  function services() {
    const ps = safe(() => ctx.poller.status());
    return {
      'Mail fetching (IMAP)': ps && {
        running: ps.running, lastRun: ps.lastRun, lastError: ps.lastError, lastResult: ps.lastResult,
        processedTotal: ps.processedTotal, lastPurge: ps.lastPurge,
        // Only the reasons, never sender or subject
        recentSkipped: (ps.recentSkipped || []).reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
      },
      'AI component detection': safe(() => ctx.aiClassifier?.stats()),
      'AI duplicate hints': safe(() => ctx.aiDuplicates?.stats()),
      'Import': safe(() => { const j = ctx.importer?.status(); return j ? { state: j.state, source: j.source, startedAt: j.startedAt, finishedAt: j.finishedAt, counts: j.counts, errors: Array.isArray(j.errors) ? j.errors.length : j.errors } : null; }),
      'Mail suppressions (bounces)': safe(() => ctx.suppressions?.list().length),
      'Backups': safe(() => {
        if (!fs.existsSync(paths.backups)) return { count: 0, newest: null };
        const files = fs.readdirSync(paths.backups).filter((f) => !f.startsWith('.'));
        const times = files.map((f) => fs.statSync(`${paths.backups}/${f}`).mtimeMs).sort((x, y) => y - x);
        return { count: files.length, newest: times[0] ? new Date(times[0]).toISOString() : null };
      }),
      'Emergency access used': safe(() => readEmergencyLog(ctx.db).length),
    };
  }

  function logFileLines() {
    const read = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    return [...read(`${paths.logFile}.1`), ...read(paths.logFile)].slice(-FILE_LINES);
  }

  /** Error overview: same message (without time and numbers) counted */
  function errorSummary(lines) {
    const counts = new Map();
    for (const l of lines) {
      const m = /^\S+ (WARN |ERROR) (.*)$/.exec(l);
      if (!m) continue;
      const key = `${m[1].trim()} ${m[2].replace(/\d+/g, '#').slice(0, 160)}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30);
  }

  /** The package as Markdown text */
  function build({ now = new Date() } = {}) {
    const a = anonymizer();
    const out = [];
    const table = (obj) => {
      const rows = Object.entries(obj || {}).filter(([, v]) => v !== undefined);
      if (!rows.length) return '_(none)_\n';
      return `| | |\n|---|---|\n${rows.map(([k, v]) => `| ${cell(k)} | ${cell(fmt(v))} |`).join('\n')}\n`;
    };
    // Markdown table cell: backslash and | escaped, one line
    const cell = (x) => String(x).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const fmt = (v) => (v === null ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    const block = (lines) => `\`\`\`\n${lines.join('\n').replace(/```/g, "'''")}\n\`\`\`\n`;

    out.push('# Helfi.Space – diagnosis package', '');
    out.push(`Created: ${now.toISOString()} · Version ${config.version} · schema ${SCHEMA_VERSION}`, '');
    out.push('Anonymous: no ticket contents; names, accounts, mail and IP addresses, host names and AD DNs are replaced by placeholders (<person-1>, <mail-1>, <ip-1 private>, <host-1>, …) that are only consistent within this file. Secrets are never included.', '');
    out.push('## System', '', table(a.value(systemInfo())));
    out.push('## Environment variables', '', '_Values only for harmless variables; the rest only "set"._', '', table(a.value(environment())));
    out.push('## Database', '', table(a.value(database())));
    out.push('## Settings', '', '_Switches, numbers and choices as they are; free text only "set"/"empty"; secrets only whether set._', '', table(settingsTable()));
    out.push('## Services', '', table(a.value(services())));
    for (const [title, fn] of sections) out.push(`## ${title}`, '', table(a.value(safe(fn))));
    const fileLines = logFileLines();
    const recentLines = recentLogLines().slice(-LOG_LINES);
    out.push('## Error overview', '', '_Warnings and errors of the saved log (also from earlier runs), most frequent first._', '');
    const summary = errorSummary([...fileLines, ...recentLines.filter((l) => !fileLines.includes(l))]);
    out.push(summary.length ? summary.map(([k, n]) => `- ${n}× ${a.text(k)}`).join('\n') + '\n' : '_(none)_\n');
    out.push(`## Warnings and errors (saved, last ${FILE_LINES})`, '', fileLines.length ? block(fileLines.map((l) => a.text(l))) : '_(none)_\n');
    out.push(`## Log of this run (last ${LOG_LINES} lines)`, '', recentLines.length ? block(recentLines.map((l) => a.text(l))) : '_(empty)_\n');
    return out.join('\n');
  }

  return { register, build, anonymizer };
}
