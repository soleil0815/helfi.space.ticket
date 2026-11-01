// SQLite-Datenbank: Öffnen, Sicherung vor Versionswechsel, Migrationen.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, paths } from './config.js';
import { log } from './lib/log.js';
import { encrypt, decrypt } from './lib/crypto.js';

// Jede Migration bekommt eine fortlaufende Nummer. Bestehende Einträge NIE ändern,
// nur neue anhängen.
export const MIGRATIONS = [
  {
    id: 1,
    name: 'Grundschema',
    sql: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      email TEXT COLLATE NOCASE,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','agent','user')),
      source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','ldap','oidc','email')),
      password_hash TEXT,
      external_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      role_locked INTEGER NOT NULL DEFAULT 0,
      language TEXT CHECK (language IS NULL OR language IN ('de','en')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_login TEXT
    );
    CREATE INDEX users_email ON users(email);

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      ip TEXT,
      auth_method TEXT
    );
    CREATE INDEX sessions_exp ON sessions(expires_at);

    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, secret INTEGER NOT NULL DEFAULT 0);

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lead_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      next_number INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE tickets (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'request' CHECK (type IN ('incident','request','task','question')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','done')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('highest','high','medium','low')),
      reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reporter_email TEXT,
      reporter_name TEXT,
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      labels TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      rank REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      resolved_at TEXT,
      UNIQUE (project_id, number)
    );
    CREATE INDEX tickets_status ON tickets(status);
    CREATE INDEX tickets_assignee ON tickets(assignee_id);
    CREATE INDEX tickets_reporter ON tickets(reporter_id);

    CREATE TABLE comments (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_email TEXT,
      author_name TEXT,
      body TEXT NOT NULL,
      internal INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'web',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX comments_ticket ON comments(ticket_id);

    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      comment_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL,
      storage_name TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX attachments_ticket ON attachments(ticket_id);

    CREATE TABLE activity (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX activity_ticket ON activity(ticket_id);

    -- Verarbeitete und versendete E-Mails (Doppelte vermeiden, Antworten zuordnen)
    CREATE TABLE mail_messages (
      message_id TEXT PRIMARY KEY,
      ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    `,
  },
  {
    id: 2,
    name: 'Import-Zuordnung',
    sql: `
    -- Welcher fremde Datensatz (Jira-Vorgang, -Kommentar, -Anhang) wurde zu welchem lokalen?
    -- Damit lässt sich ein Import wiederholen, ohne Doppelte anzulegen.
    CREATE TABLE import_map (
      source TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('issue','comment','attachment')),
      external_id TEXT NOT NULL,
      local_id INTEGER NOT NULL,
      external_key TEXT,
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (source, kind, external_id)
    );
    CREATE INDEX import_map_local ON import_map(kind, local_id);
    `,
  },
  {
    id: 3,
    name: 'Zwei-Faktor-Anmeldung',
    sql: `
    ALTER TABLE users ADD COLUMN totp_secret TEXT;          -- verschlüsselt
    ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN recovery_codes TEXT;       -- JSON-Liste von SHA-256-Hashes
    ALTER TABLE sessions ADD COLUMN mfa INTEGER NOT NULL DEFAULT 0;  -- zweiter Faktor in dieser Sitzung erbracht
    `,
  },
  {
    id: 4,
    name: 'Anfrage-Teilnehmer',
    sql: `
    -- Weitere Personen, die ein Ticket sehen, kommentieren und benachrichtigt werden
    CREATE TABLE ticket_participants (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (ticket_id, user_id)
    );
    CREATE INDEX ticket_participants_user ON ticket_participants(user_id);
    `,
  },
  {
    id: 5,
    name: 'Antwortvorlagen',
    sql: `
    -- Vorlagen für häufige Antworten. owner_id NULL = für alle Bearbeiter, sonst persönlich.
    CREATE TABLE canned_responses (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX canned_responses_owner ON canned_responses(owner_id);
    `,
  },
  {
    id: 6,
    name: 'Gesperrte Empfänger',
    sql: `
    -- Adressen, für die ein Unzustellbarkeitsbericht kam: eine Zeit lang keine Mails dorthin (gegen Mail-Ping-Pong)
    CREATE TABLE mail_suppressions (
      address TEXT PRIMARY KEY,
      reason TEXT,
      until TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;

export class DatabaseTooNewError extends Error {}
export class WrongKeyError extends Error {}

/** Passt der Schlüssel (secret.key / HELFI_SECRET) zur Datenbank? Sonst klar abbrechen statt später abzustürzen. */
export function verifyKey(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key='key_check'").get();
  if (!row) {
    db.prepare("INSERT INTO meta(key,value) VALUES('key_check',?)").run(encrypt('helfi-key-check'));
    return;
  }
  let ok = false;
  try { ok = decrypt(row.value) === 'helfi-key-check'; } catch { ok = false; }
  if (!ok) {
    throw new WrongKeyError(
      'Der Schlüssel passt nicht zur Datenbank: Gespeicherte Kennwörter und 2FA-Schlüssel lassen sich nicht entschlüsseln. ' +
      'Bitte die ursprüngliche data/secret.key zurücklegen bzw. den alten HELFI_SECRET-Wert wieder eintragen (siehe README, „Sicherung“).',
    );
  }
}

function getMeta(db, key) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return null;
  return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** Sichert die Datenbank (konsistent, auch im laufenden Betrieb). */
export async function backupDatabase(db, label, dir = paths.backups) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `helfi-${label}-${stamp()}.sqlite`);
  await db.backup(file);
  // Enthält Kennwort-Hashes und personenbezogene Daten → nur für den Besitzer lesbar
  try { fs.chmodSync(file, 0o600); } catch { /* z. B. Dateisystem ohne Rechte */ }
  log.info(`Sicherung erstellt: ${file}`);
  return file;
}

/** Löscht automatische Tagessicherungen, die älter als keepDays sind (Versions-Sicherungen bleiben). */
/**
 * Räumt Sicherungen auf: tägliche nach keepDays (mind. 1 Tag, die neueste bleibt immer),
 * Sicherungen vor Versionswechseln: die letzten KEEP_VERSION_BACKUPS bleiben. Manuelle bleiben immer.
 */
export const KEEP_VERSION_BACKUPS = 10;
export function pruneBackups(keepDays, dir = paths.backups) {
  if (!fs.existsSync(dir)) return;
  const days = Math.max(1, Number(keepDays) || 14);
  const limit = Date.now() - days * 86400000;
  const list = (re) => fs.readdirSync(dir).filter((f) => re.test(f))
    .map((f) => ({ f, full: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const daily = list(/^helfi-taeglich-.*\.sqlite$/);
  for (const b of daily.slice(1)) if (b.t < limit) fs.unlinkSync(b.full);
  for (const b of list(/^helfi-vor-.*\.sqlite$/).slice(KEEP_VERSION_BACKUPS)) fs.unlinkSync(b.full);
}

/**
 * Öffnet die Datenbank, sichert vor einem Versionswechsel und führt Migrationen aus.
 * Bricht mit klarer Meldung ab, wenn die Datenbank von einer neueren Version stammt.
 */
export async function openDatabase(file = paths.db, { appVersion = config.version, backupDir = paths.backups } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const dbSchema = Number(getMeta(db, 'schema_version') || 0);
  const dbApp = getMeta(db, 'app_version');

  if (dbSchema > SCHEMA_VERSION) {
    db.close();
    throw new DatabaseTooNewError(
      `Die Datenbank stammt von einer neueren Helfi.Space-Version (${dbApp || 'unbekannt'}, Schema ${dbSchema}) ` +
      `als dieses Programm (${appVersion}, Schema ${SCHEMA_VERSION}). ` +
      `Entweder wieder die neuere Version starten oder die passende Sicherung zurückspielen: ` +
      `${backupDir}/helfi-vor-${dbApp || '<neuere Version>'}-*.sqlite (siehe README, „Version festhalten und zurückgehen“).`,
    );
  }

  // Sichern vor Versionswechsel UND vor jeder ausstehenden Migration
  if (existed && dbSchema > 0 && (dbApp !== appVersion || dbSchema < SCHEMA_VERSION)) {
    await backupDatabase(db, `vor-${appVersion}`, backupDir);
  }

  const pending = MIGRATIONS.filter((m) => m.id > dbSchema);
  for (const m of pending) {
    log.info(`Datenbank-Migration ${m.id}: ${m.name}`);
    db.transaction(() => {
      db.exec(m.sql);
      setMeta(db, 'schema_version', m.id);
    })();
  }
  setMeta(db, 'app_version', appVersion);
  return db;
}
