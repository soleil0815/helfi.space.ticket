// Central configuration from environment variables.
// Everything configurable in the app (AD, SSO, email ...) lives in the
// database and is managed through the UI – not here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

// Version of docker-compose.yml that matches this code.
// Increased when the file has to change (new required variables or similar).
export const COMPOSE_VERSION = 1;

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|ja|on)$/i.test(String(v).trim());
}

const baseUrl = (process.env.HELFI_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

// Where users get the source code of exactly this program (AGPL-3.0, section 13). Whoever runs a
// modified version must point this to their own source code. Only http(s) URLs.
const DEFAULT_SOURCE = 'https://github.com/soleil0815/helfi.space.ticket';
const sourceUrl = /^https?:\/\/[^\s"'<>]+$/i.test(process.env.HELFI_SOURCE_URL || '') ? process.env.HELFI_SOURCE_URL : DEFAULT_SOURCE;

// HSTS: 'on' (default with an https:// address), 'off' (the reverse proxy sends it), 'preload'
const hstsRaw = String(process.env.HELFI_HSTS || 'on').trim().toLowerCase();
const hsts = ['off', 'no', 'false', '0', 'nein'].includes(hstsRaw) ? 'off' : hstsRaw === 'preload' ? 'preload' : 'on';

export const config = {
  sourceUrl,
  hsts,
  version: pkg.version,
  port: Number(process.env.HELFI_PORT || process.env.PORT || 8080),
  dataDir: path.resolve(process.env.HELFI_DATA_DIR || '/data'),
  baseUrl,
  secureCookies: bool(process.env.HELFI_SECURE_COOKIES, baseUrl.startsWith('https://')),
  // Trust the client IP (X-Forwarded-For) only from explicitly listed proxies, otherwise it can be spoofed
  trustProxy: process.env.HELFI_TRUST_PROXY || 'loopback',
  composeVersion: Number(process.env.HELFI_COMPOSE_VERSION || 0),
  logLevel: process.env.HELFI_LOG_LEVEL || 'info',
  maxUploadMb: Number(process.env.HELFI_MAX_UPLOAD_MB || 25),
  sessionHours: Number(process.env.HELFI_SESSION_HOURS || 12),
  publicDir: path.join(here, '..', 'public'),
};

export const paths = {
  db: path.join(config.dataDir, 'helfi.sqlite'),
  backups: path.join(config.dataDir, 'backups'),
  attachments: path.join(config.dataDir, 'attachments'),
  secretKey: path.join(config.dataDir, 'secret.key'),
};
