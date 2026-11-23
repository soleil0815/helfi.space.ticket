// Simple logging to stdout (ends up in the Docker log).
// Passwords and tokens are never logged – redact() removes them from objects.
import fs from 'node:fs';
import path from 'node:path';
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const current = levels[process.env.HELFI_LOG_LEVEL || 'info'] ?? 20;

const SECRET_KEYS = /pass|secret|token|cookie|authorization|credential/i;

export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (value instanceof Error) return value.message;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, depth + 1);
  }
  return out;
}

// Recent lines in memory (for the diagnosis package) and warnings/errors in a small file in the data
// folder, so they survive a restart. The package anonymizes them; the file stays on the server.
const RECENT_MAX = 1000;
const recent = [];
let logFile = null;
export const LOG_FILE_MAX = 1024 * 1024; // then helfi.log → helfi.log.1 (at most 2 × 1 MB)

/** Also write warnings and errors to this file (called once by the server at startup) */
export function setLogFile(file) {
  if (!file) { logFile = null; return; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    logFile = file;
  } catch (e) {
    console.error(`Log file not available (${e.message})`);
    logFile = null;
  }
}
export const logFilePath = () => logFile;

function toFile(text) {
  if (!logFile) return;
  try {
    let size = 0;
    try { size = fs.statSync(logFile).size; } catch { /* new file */ }
    if (size + text.length > LOG_FILE_MAX) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, `${text}\n`, { mode: 0o600 });
  } catch { /* disk full or read-only: the Docker log still has it */ }
}

/** Last lines of this run (oldest first) */
export const recentLogLines = () => recent.slice();

/**
 * One log entry is one line: line breaks from the message (often text from outside – a user name, an
 * error of a mail server or IdP) are written as a visible \\n, other control characters as a space, so
 * nobody can append a made-up line to the log.
 */
// eslint-disable-next-line no-control-regex
export const oneLine = (s) => String(s).replace(/\r\n|\r|\n/g, '\\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');

function write(level, msg, extra) {
  // The diagnosis package keeps info and above even if HELFI_LOG_LEVEL hides them in the Docker log
  if (levels[level] < Math.min(current, levels.info)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${oneLine(msg)}`;
  const tail = extra === undefined ? '' : ' ' + JSON.stringify(redact(extra));
  recent.push(line + tail);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  if (level === 'error' || level === 'warn') toFile(line + tail);
  if (levels[level] >= current) (level === 'error' || level === 'warn' ? console.error : console.log)(line + tail);
}

export const log = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
