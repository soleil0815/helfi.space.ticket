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
  {
    id: 7,
    name: 'Eingefügte Bilder',
    sql: `
    -- Per Zwischenablage eingefügte Bilder sind Entwürfe, bis der Kommentar/die Beschreibung gespeichert ist:
    -- nur für Bearbeiter und den Hochladenden sichtbar (z. B. Screenshot in einer internen Notiz)
    ALTER TABLE attachments ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 8,
    name: 'HTML-Mails',
    sql: `
    -- Bereinigtes HTML eingehender Mails (Beschreibung: comment_id NULL). Eigene Tabelle, damit Listen schlank bleiben.
    CREATE TABLE mail_html (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      html TEXT NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_mail_html_ticket ON mail_html(ticket_id);
    -- Eingebettete Bilder (Logos, Signaturen) nur für die formatierte Ansicht, nicht in der Anhangsliste
    ALTER TABLE attachments ADD COLUMN inline INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 9,
    name: 'Verknüpfungen',
    sql: `
    -- Gerichtete Verknüpfungen zwischen Tickets (relates, duplicates, blocks, causes, parent)
    CREATE TABLE ticket_links (
      id INTEGER PRIMARY KEY,
      from_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(from_id, to_id)
    );
    CREATE INDEX idx_links_to ON ticket_links(to_id);
    `,
  },
  {
    id: 10,
    name: 'Auswirkung, Dringlichkeit, Major Incident',
    sql: `
    ALTER TABLE tickets ADD COLUMN impact TEXT;
    ALTER TABLE tickets ADD COLUMN urgency TEXT;
    ALTER TABLE tickets ADD COLUMN major INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 11,
    name: 'SLA-Warnungen',
    sql: `
    -- Je Ticket, Uhr (response/resolve) und Stufe (warning/breached) nur einmal warnen
    CREATE TABLE sla_events (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      level TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (ticket_id, kind, level)
    );
    `,
  },
  {
    id: 12,
    name: 'Zusatzfelder (Problem, Change)',
    // Tabelle tickets neu aufbauen (die Liste erlaubter Typen steckte in einem CHECK). Dafür
    // Fremdschlüssel kurz aus, sonst würden abhängige Zeilen beim DROP mitgelöscht.
    foreignKeysOff: true,
    sql: `
    CREATE TABLE tickets_new (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'request',
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
      impact TEXT,
      urgency TEXT,
      major INTEGER NOT NULL DEFAULT 0,
      UNIQUE (project_id, number)
    );
    INSERT INTO tickets_new (id, project_id, number, title, description, type, status, priority, reporter_id, reporter_email, reporter_name, assignee_id, labels, due_date, source, rank, created_at, updated_at, resolved_at, impact, urgency, major) SELECT id, project_id, number, title, description, type, status, priority, reporter_id, reporter_email, reporter_name, assignee_id, labels, due_date, source, rank, created_at, updated_at, resolved_at, impact, urgency, major FROM tickets;
    DROP TABLE tickets;
    ALTER TABLE tickets_new RENAME TO tickets;
    CREATE INDEX tickets_status ON tickets(status);
    CREATE INDEX tickets_assignee ON tickets(assignee_id);
    CREATE INDEX tickets_reporter ON tickets(reporter_id);

    -- Felder je Tickettyp, z. B. Ursache/Workaround (Problem) oder Rückfallplan (Change)
    CREATE TABLE ticket_fields (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (ticket_id, name)
    );
    `,
  },
  {
    id: 13,
    name: 'Genehmigungen',
    sql: `
    -- Genehmigungen (Change, Servicekatalog): je angefragter Person eine Zeile, Entscheidung später
    CREATE TABLE approvals (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      approver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      round INTEGER NOT NULL DEFAULT 1,
      decision TEXT,
      comment TEXT,
      requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      decided_at TEXT,
      UNIQUE (ticket_id, approver_id, round)
    );
    CREATE INDEX idx_approvals_approver ON approvals(approver_id, decision);
    `,
  },
  {
    id: 14,
    name: 'Wissensdatenbank',
    sql: `
    CREATE TABLE kb_articles (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'internal', -- internal (nur Bearbeiter) | public (alle Angemeldeten)
      category TEXT NOT NULL DEFAULT '',
      source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      views INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    `,
  },
  {
    id: 15,
    name: 'Servicekatalog',
    sql: `
    CREATE TABLE catalog_items (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      emoji TEXT NOT NULL DEFAULT '',
      project_key TEXT NOT NULL DEFAULT '',
      fields TEXT NOT NULL DEFAULT '[]',     -- JSON: [{ id, label, type, required, options }]
      approver_ids TEXT NOT NULL DEFAULT '', -- leer = keine Genehmigung
      approval_mode TEXT NOT NULL DEFAULT 'any',
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    `,
  },
  {
    id: 16,
    name: 'Geräte und Dienste (CI-Verzeichnis)',
    sql: `
    CREATE TABLE config_items (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      kind TEXT NOT NULL DEFAULT 'device',
      status TEXT NOT NULL DEFAULT 'active',
      location TEXT NOT NULL DEFAULT '',
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ip TEXT NOT NULL DEFAULT '',
      serial TEXT NOT NULL DEFAULT '',
      vendor TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE ticket_cis (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      ci_id INTEGER NOT NULL REFERENCES config_items(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (ticket_id, ci_id)
    );
    CREATE INDEX idx_ticket_cis_ci ON ticket_cis(ci_id);
    `,
  },
  {
    id: 17,
    name: 'Zufriedenheitsumfrage',
    sql: `
    CREATE TABLE ticket_ratings (
      ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE,
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      rating INTEGER CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      rated_at TEXT
    );
    CREATE INDEX idx_ticket_ratings_sent ON ticket_ratings(sent_at);
    `,
  },
  {
    id: 18,
    name: 'Bilder in Wissensartikeln',
    sql: `
    CREATE TABLE kb_images (
      id INTEGER PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      article_id INTEGER REFERENCES kb_articles(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_kb_images_article ON kb_images(article_id);
    `,
  },
  {
    id: 19,
    name: 'Wissensartikel: Versionen und Vorlagen',
    sql: `
    CREATE TABLE kb_versions (
      id INTEGER PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'internal',
      note TEXT NOT NULL DEFAULT '',
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (article_id, version)
    );
    -- vorhandene Artikel: heutiger Stand als Version 1
    INSERT INTO kb_versions(article_id, version, title, body, category, visibility, author_id, created_at)
      SELECT id, 1, title, body, category, visibility, COALESCE(updated_by, created_by), updated_at FROM kb_articles;
    CREATE TABLE kb_templates (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    `,
  },
  {
    id: 20,
    name: 'Wissensartikel: Seitenbaum',
    sql: `
    ALTER TABLE kb_articles ADD COLUMN parent_id INTEGER REFERENCES kb_articles(id) ON DELETE SET NULL;
    CREATE INDEX idx_kb_articles_parent ON kb_articles(parent_id);
    `,
  },
  {
    id: 21,
    name: 'Wissensartikel: Kommentare',
    sql: `
    CREATE TABLE kb_comments (
      id INTEGER PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_kb_comments_article ON kb_comments(article_id);
    `,
  },
  {
    id: 22,
    name: 'Volltextsuche für Tickets',
    // Achtung: Baut eine spätere Migration „tickets“, „comments“ oder „attachments“ neu auf,
    // müssen die search_*-Trigger dort neu angelegt werden.
    sql: `
    CREATE VIRTUAL TABLE ticket_fts USING fts5(title, public_text, internal_text, people, tokenize='trigram');
    CREATE TABLE search_dirty (ticket_id INTEGER PRIMARY KEY);
    CREATE TRIGGER search_t_ins AFTER INSERT ON tickets BEGIN INSERT OR IGNORE INTO search_dirty VALUES (NEW.id); END;
    CREATE TRIGGER search_t_upd AFTER UPDATE OF title, description, reporter_id, reporter_email, reporter_name, assignee_id, labels ON tickets
      BEGIN INSERT OR IGNORE INTO search_dirty VALUES (NEW.id); END;
    CREATE TRIGGER search_t_del AFTER DELETE ON tickets BEGIN INSERT OR IGNORE INTO search_dirty VALUES (OLD.id); END;
    CREATE TRIGGER search_c_ins AFTER INSERT ON comments BEGIN INSERT OR IGNORE INTO search_dirty VALUES (NEW.ticket_id); END;
    CREATE TRIGGER search_c_upd AFTER UPDATE ON comments BEGIN INSERT OR IGNORE INTO search_dirty VALUES (NEW.ticket_id); INSERT OR IGNORE INTO search_dirty VALUES (OLD.ticket_id); END;
    CREATE TRIGGER search_c_del AFTER DELETE ON comments BEGIN INSERT OR IGNORE INTO search_dirty VALUES (OLD.ticket_id); END;
    CREATE TRIGGER search_a_ins AFTER INSERT ON attachments BEGIN INSERT OR IGNORE INTO search_dirty VALUES (NEW.ticket_id); END;
    CREATE TRIGGER search_a_upd AFTER UPDATE ON attachments BEGIN INSERT OR IGNORE INTO search_dirty VALUES (NEW.ticket_id); INSERT OR IGNORE INTO search_dirty VALUES (OLD.ticket_id); END;
    CREATE TRIGGER search_a_del AFTER DELETE ON attachments BEGIN INSERT OR IGNORE INTO search_dirty VALUES (OLD.ticket_id); END;
    CREATE TRIGGER search_u_upd AFTER UPDATE OF display_name, email, username ON users
      BEGIN INSERT OR IGNORE INTO search_dirty SELECT id FROM tickets WHERE reporter_id=NEW.id OR assignee_id=NEW.id; END;
    -- vorhandene Tickets: Index beim nächsten Start aufbauen
    INSERT INTO search_dirty SELECT id FROM tickets;
    `,
  },
  {
    id: 23,
    name: 'Tickets nie löschen (Schutz in der Datenbank)',
    // Tickets sind Nachweis: auch ein versehentliches DELETE (oder ON DELETE CASCADE über das Projekt) bricht ab.
    // Hinweis: DROP TABLE löst keine Trigger aus – ein späterer Umbau der Tabelle „tickets“ muss
    // tickets_no_delete danach neu anlegen.
    sql: `
    CREATE TRIGGER tickets_no_delete BEFORE DELETE ON tickets BEGIN SELECT RAISE(ABORT, 'Tickets werden nie gelöscht'); END;
    CREATE TRIGGER projects_no_delete_with_tickets BEFORE DELETE ON projects
      WHEN EXISTS (SELECT 1 FROM tickets WHERE project_id=OLD.id) BEGIN SELECT RAISE(ABORT, 'Projekt hat Tickets'); END;
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

/** Wie viele Sicherungen je Art standardmäßig bleiben (Einstellung backup.keep). */
export const DEFAULT_BACKUP_KEEP = 10;
export const MAX_BACKUP_KEEP = 100;
export function clampBackupKeep(n) {
  const v = Math.round(Number(n));
  if (n === null || n === undefined || n === '' || !Number.isFinite(v)) return DEFAULT_BACKUP_KEEP;
  return Math.min(MAX_BACKUP_KEEP, Math.max(1, v));
}

const BACKUP_NAME = /^helfi-[A-Za-z0-9._-]+\.sqlite$/;

/**
 * Art einer Sicherung: daily (täglich), version (vor Versionswechsel), manual (von Hand),
 * predelete (vor dem Löschen eines Projekts), preimport (vor einem Import). Je Art bleiben die neuesten.
 */
export function backupKind(name) {
  if (!BACKUP_NAME.test(name)) return null;
  if (name.startsWith('helfi-taeglich-')) return 'daily';
  if (name.startsWith('helfi-manuell-')) return 'manual';
  if (name.startsWith('helfi-vor-loeschen-')) return 'predelete';
  if (name.startsWith('helfi-vor-import-')) return 'preimport';
  if (name.startsWith('helfi-vor-')) return 'version';
  return null;
}

/** Sicherungen im Ordner, neueste zuerst. */
export function listBackups(dir = paths.backups) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => backupKind(f))
    .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, kind: backupKind(f), size: st.size, time: st.mtimeMs }; })
    .sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
}

/**
 * Räumt Sicherungen auf: je Art (täglich, vor Versionswechsel, manuell, vor Löschen, vor Import) bleiben die neuesten `keep`.
 * Mindestens eine je Art bleibt immer. Liefert die Anzahl gelöschter Dateien und den frei gewordenen Platz.
 */
export function pruneBackups(keep = DEFAULT_BACKUP_KEEP, dir = paths.backups) {
  const n = clampBackupKeep(keep);
  const seen = {};
  let deleted = 0; let freed = 0;
  for (const b of listBackups(dir)) {
    seen[b.kind] = (seen[b.kind] || 0) + 1;
    if (seen[b.kind] <= n) continue;
    try { fs.unlinkSync(path.join(dir, b.name)); deleted++; freed += b.size; }
    catch (e) { log.warn(`Sicherung ließ sich nicht löschen: ${b.name}`, { error: e.message }); }
  }
  if (deleted) log.info(`Alte Sicherungen gelöscht: ${deleted} (${Math.round(freed / 1048576)} MB frei)`);
  return { deleted, freed };
}

/** Eine Sicherung gezielt löschen (nur Dateien aus dem Sicherungsordner). */
export function deleteBackup(name, dir = paths.backups) {
  if (typeof name !== 'string' || !backupKind(name)) return false;
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  log.info(`Sicherung gelöscht: ${name}`);
  return true;
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
    if (m.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        // Nach einem Umbau müssen alle Verweise noch stimmen, sonst alles zurück
        if (m.foreignKeysOff && db.pragma('foreign_key_check').length) throw new Error(`Migration ${m.id}: Fremdschlüssel verletzt`);
        setMeta(db, 'schema_version', m.id);
      })();
    } finally {
      if (m.foreignKeysOff) db.pragma('foreign_keys = ON');
    }
  }
  setMeta(db, 'app_version', appVersion);
  return db;
}
