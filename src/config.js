// Central configuration from environment variables.
// Everything configurable in the app (AD, SSO, email ...) lives in the
// database and is managed through the UI – not here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseForceHttps } from './https.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

// Version of docker-compose.yml that matches this code.
// Increased when the file has to change (new required variables or similar).
export const COMPOSE_VERSION = 1;

const TRUE = ['1', 'true', 'yes', 'ja', 'on'];
const FALSE = ['0', 'false', 'no', 'nein', 'off'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Reads the environment and notes every variable whose value cannot be used. An unknown value never silently
 * means "off": the default applies and the variable is listed (log at start, admin warning, diagnosis package).
 * Typical cause: an old env.example (up to 1.11) had the explanation in the same line as the value
 * ("# HELFI_SECURE_COOKIES=true cookies over HTTPS only …") – removing only the "#" made the whole sentence the
 * value. Only names are noted, never values (some are secrets).
 */
export function readEnv(env = process.env) {
  const problems = [];
  const note = (name) => { if (!problems.includes(name)) problems.push(name); };
  const raw = (name) => (env[name] === undefined ? '' : String(env[name]).trim());
  // No HELFI_* value contains blanks (lists are "a, b"): text after the value is a comment that slipped in
  for (const [name, v] of Object.entries(env)) {
    if (name.startsWith('HELFI_') && /\s/.test(String(v ?? '').trim().replace(/,\s+/g, ','))) note(name);
  }
  const bool = (name, def) => {
    const v = raw(name).toLowerCase();
    if (!v) return def;
    if (TRUE.includes(v)) return true;
    if (FALSE.includes(v)) return false;
    note(name);
    return def;
  };
  const num = (name, def, min = 1) => {
    const v = raw(name);
    if (!v) return def;
    const n = Number(v);
    if (Number.isFinite(n) && n >= min) return n;
    note(name);
    return def;
  };
  const baseUrl = (raw('HELFI_BASE_URL') || 'http://localhost:8080').replace(/\/+$/, '');
  // HSTS: 'on' (default: only where Helfi.Space had to redirect itself), 'off' (never), 'preload' (always, with
  // includeSubDomains; preload)
  const hstsRaw = (raw('HELFI_HSTS') || 'on').toLowerCase();
  const hsts = FALSE.includes(hstsRaw) ? 'off' : hstsRaw === 'preload' ? 'preload' : 'on';
  if (hsts === 'on' && !['on', ...TRUE].includes(hstsRaw)) note('HELFI_HSTS');
  const forceRaw = raw('HELFI_FORCE_HTTPS').toLowerCase();
  if (forceRaw && forceRaw !== 'auto' && parseForceHttps(forceRaw) === 'auto') note('HELFI_FORCE_HTTPS');
  const logLevel = raw('HELFI_LOG_LEVEL').toLowerCase();
  if (logLevel && !LOG_LEVELS.includes(logLevel)) note('HELFI_LOG_LEVEL');
  const proxy = raw('HELFI_TRUST_PROXY');
  return {
    baseUrl,
    hsts,
    secureCookies: bool('HELFI_SECURE_COOKIES', baseUrl.startsWith('https://')),
    port: num('HELFI_PORT', Number(raw('PORT')) || 8080),
    composeVersion: num('HELFI_COMPOSE_VERSION', 0, 0),
    logLevel: LOG_LEVELS.includes(logLevel) ? logLevel : 'info',
    maxUploadMb: num('HELFI_MAX_UPLOAD_MB', 25),
    sessionHours: num('HELFI_SESSION_HOURS', 12),
    // Invalid lists are caught in app.js (applyTrustProxy → "loopback" with a warning)
    trustProxy: proxy || 'loopback',
    problems,
  };
}

const env = readEnv();
/** Names of environment variables whose value could not be used (the default applies instead). */
export const envProblems = env.problems;
const baseUrl = env.baseUrl;

// Where users get the source code of exactly this program (AGPL-3.0, section 13). Whoever runs a
// modified version must point this to their own source code. Only http(s) URLs.
const DEFAULT_SOURCE = 'https://github.com/soleil0815/helfi.space.ticket';
const sourceUrl = /^https?:\/\/[^\s"'<>]+$/i.test(process.env.HELFI_SOURCE_URL || '') ? process.env.HELFI_SOURCE_URL : DEFAULT_SOURCE;

export const config = {
  sourceUrl,
  hsts: env.hsts,
  // HTTPS behind the reverse proxy: 'auto' (default) | '1' | '0' – see src/https.js
  forceHttps: parseForceHttps(process.env.HELFI_FORCE_HTTPS),
  version: pkg.version,
  port: env.port,
  dataDir: path.resolve(process.env.HELFI_DATA_DIR || '/data'),
  baseUrl,
  secureCookies: env.secureCookies,
  // Trust the client IP (X-Forwarded-For) only from explicitly listed proxies, otherwise it can be spoofed
  trustProxy: env.trustProxy,
  composeVersion: env.composeVersion,
  logLevel: env.logLevel,
  maxUploadMb: env.maxUploadMb,
  sessionHours: env.sessionHours,
  publicDir: path.join(here, '..', 'public'),
};

export const paths = {
  db: path.join(config.dataDir, 'helfi.sqlite'),
  backups: path.join(config.dataDir, 'backups'),
  attachments: path.join(config.dataDir, 'attachments'),
  secretKey: path.join(config.dataDir, 'secret.key'),
  httpsHosts: path.join(config.dataDir, 'https-hosts.txt'),
  logFile: path.join(config.dataDir, 'logs', 'helfi.log'), // warnings/errors (see src/lib/log.js)
};
