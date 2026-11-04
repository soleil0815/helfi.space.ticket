// Simple logging to stdout (ends up in the Docker log).
// Passwords and tokens are never logged – redact() removes them from objects.
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

function write(level, msg, extra) {
  if (levels[level] < current) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const tail = extra === undefined ? '' : ' ' + JSON.stringify(redact(extra));
  (level === 'error' || level === 'warn' ? console.error : console.log)(line + tail);
}

export const log = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
