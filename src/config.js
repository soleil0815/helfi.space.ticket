// Zentrale Konfiguration aus Umgebungsvariablen.
// Alles, was sich im Programm einstellen lässt (AD, SSO, E-Mail ...), liegt in der
// Datenbank und wird über die Oberfläche gepflegt – nicht hier.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

// Version der docker-compose.yml, die zu diesem Programmstand passt.
// Wird erhöht, wenn die Datei sich ändern muss (neue Pflicht-Variablen o. Ä.).
export const COMPOSE_VERSION = 1;

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|ja|on)$/i.test(String(v).trim());
}

const baseUrl = (process.env.HELFI_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

export const config = {
  version: pkg.version,
  port: Number(process.env.HELFI_PORT || process.env.PORT || 8080),
  dataDir: path.resolve(process.env.HELFI_DATA_DIR || '/data'),
  baseUrl,
  secureCookies: bool(process.env.HELFI_SECURE_COOKIES, baseUrl.startsWith('https://')),
  // Nur ausdrücklich genannten Proxys die Client-IP glauben (X-Forwarded-For), sonst ist sie fälschbar
  trustProxy: process.env.HELFI_TRUST_PROXY || 'loopback',
  composeVersion: Number(process.env.HELFI_COMPOSE_VERSION || 0),
  logLevel: process.env.HELFI_LOG_LEVEL || 'info',
  maxUploadMb: Number(process.env.HELFI_MAX_UPLOAD_MB || 25),
  backupKeepDays: Number(process.env.HELFI_BACKUP_KEEP_DAYS || 14),
  sessionHours: Number(process.env.HELFI_SESSION_HOURS || 12),
  publicDir: path.join(here, '..', 'public'),
};

export const paths = {
  db: path.join(config.dataDir, 'helfi.sqlite'),
  backups: path.join(config.dataDir, 'backups'),
  attachments: path.join(config.dataDir, 'attachments'),
  secretKey: path.join(config.dataDir, 'secret.key'),
};
