// SQLite database: opening, backup before version change, migrations.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import Database from 'better-sqlite3';
import { config, paths } from './config.js';
import { log } from './lib/log.js';
import { encrypt, decrypt } from './lib/crypto.js';

// Each migration gets a sequential number. NEVER change existing entries,
// only append new ones.
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

    -- Processed and sent emails (avoid duplicates, match replies)
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
    -- Which foreign record (Jira issue, comment, attachment) became which local one?
    -- This allows repeating an import without creating duplicates.
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
    ALTER TABLE users ADD COLUMN totp_secret TEXT;          -- encrypted
    ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN recovery_codes TEXT;       -- JSON list of SHA-256 hashes
    ALTER TABLE sessions ADD COLUMN mfa INTEGER NOT NULL DEFAULT 0;  -- second factor provided in this session
    `,
  },
  {
    id: 4,
    name: 'Anfrage-Teilnehmer',
    sql: `
    -- Additional people who see a ticket, comment and get notified
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
    -- Templates for frequent replies. owner_id NULL = for all agents, otherwise personal.
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
    -- Addresses that caused a non-delivery report: no mails there for a while (against mail ping-pong)
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
    -- Images pasted from the clipboard are drafts until the comment/description is saved:
    -- visible only to agents and the uploader (e.g. screenshot in an internal note)
    ALTER TABLE attachments ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 8,
    name: 'HTML-Mails',
    sql: `
    -- Sanitized HTML of incoming mails (description: comment_id NULL). Separate table so lists stay lean.
    CREATE TABLE mail_html (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      html TEXT NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_mail_html_ticket ON mail_html(ticket_id);
    -- Embedded images (logos, signatures) only for the formatted view, not in the attachment list
    ALTER TABLE attachments ADD COLUMN inline INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 9,
    name: 'Verknüpfungen',
    sql: `
    -- Directed links between tickets (relates, duplicates, blocks, causes, parent)
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
    -- Warn only once per ticket, clock (response/resolve) and level (warning/breached)
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
    // Rebuild table tickets (the list of allowed types was in a CHECK). For that,
    // foreign keys briefly off, otherwise dependent rows would be deleted along with the DROP.
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

    -- Fields per ticket type, e.g. root cause/workaround (problem) or backout plan (change)
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
    -- Approvals (change, service catalog): one row per requested person, decision later
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
      visibility TEXT NOT NULL DEFAULT 'internal', -- internal (agents only) | public (all signed-in users)
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
      approver_ids TEXT NOT NULL DEFAULT '', -- empty = no approval
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
    -- existing articles: current state as version 1
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
    // Note: if a later migration rebuilds "tickets", "comments" or "attachments",
    // the search_* triggers must be recreated there.
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
    -- existing tickets: build the index on next start
    INSERT INTO search_dirty SELECT id FROM tickets;
    `,
  },
  {
    id: 23,
    name: 'Tickets nie löschen (Schutz in der Datenbank)',
    // Tickets are records: even an accidental DELETE (or ON DELETE CASCADE via the project) aborts.
    // Note: DROP TABLE does not fire triggers – a later rebuild of the table "tickets" must
    // recreate tickets_no_delete afterwards.
    sql: `
    CREATE TRIGGER tickets_no_delete BEFORE DELETE ON tickets BEGIN SELECT RAISE(ABORT, 'Tickets werden nie gelöscht'); END;
    CREATE TRIGGER projects_no_delete_with_tickets BEFORE DELETE ON projects
      WHEN EXISTS (SELECT 1 FROM tickets WHERE project_id=OLD.id) BEGIN SELECT RAISE(ABORT, 'Projekt hat Tickets'); END;
    `,
  },
  {
    id: 24,
    name: 'AD-Kennung, Bearbeiter-Mails, Suche nach Namen, Neuigkeiten, SSO als zweiter Faktor',
    sql: `
    -- objectSid of AD accounts (merging with SSO via a stable identifier)
    ALTER TABLE users ADD COLUMN ad_sid TEXT;
    CREATE INDEX idx_users_ad_sid ON users(ad_sid) WHERE ad_sid IS NOT NULL;
    -- last seen news (version). Existing accounts (NULL) see the news once after the
    -- update; new accounts start at the current state (no notice about old items)
    ALTER TABLE users ADD COLUMN news_seen TEXT;
    CREATE TRIGGER users_news_seen AFTER INSERT ON users WHEN NEW.news_seen IS NULL
      BEGIN UPDATE users SET news_seen=(SELECT value FROM meta WHERE key='app_version') WHERE id=NEW.id; END;

    -- Mail went only to an agent: separate column instead of a marker in the Message-ID
    ALTER TABLE mail_messages ADD COLUMN agent_only INTEGER NOT NULL DEFAULT 0;
    UPDATE mail_messages SET agent_only=1 WHERE direction='out' AND message_id LIKE 'helfi.%.agent@%';

    -- Search index with its own column for visible names (for users); rebuild
    DROP TABLE ticket_fts;
    CREATE VIRTUAL TABLE ticket_fts USING fts5(title, public_text, internal_text, people, people_public, tokenize='trigram');
    INSERT OR IGNORE INTO search_dirty SELECT id FROM tickets;

    -- SSO as second factor: existing installations with active SSO keep their behaviour
    INSERT OR IGNORE INTO settings(key, value, secret)
      SELECT 'mfa.ssoSecondFactor',
        CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key='mfa.trustSso' AND value='false') THEN '"never"' ELSE '"always"' END, 0
      WHERE EXISTS (SELECT 1 FROM settings WHERE key='oidc.enabled' AND value='true');
    INSERT OR IGNORE INTO settings(key, value, secret)
      SELECT 'mfa.ssoSecondFactor', '"never"', 0
      WHERE EXISTS (SELECT 1 FROM settings WHERE key='mfa.trustSso' AND value='false');
    `,
  },
  {
    id: 25,
    name: 'Selbstregistrierung und Kennwort vergessen',
    sql: `
    -- Self-registered account (shown in the user list) and waiting for approval by an admin
    ALTER TABLE users ADD COLUMN self_registered INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN approval_pending INTEGER NOT NULL DEFAULT 0;
    -- One-time links from mails: confirm a registration, reset a password.
    -- Only the SHA-256 of the token is stored; a pending registration has no user row yet.
    CREATE TABLE account_tokens (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('register','reset')),
      token_hash TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT,
      password_hash TEXT,
      language TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_account_tokens_email ON account_tokens(email, kind);
    CREATE INDEX idx_account_tokens_exp ON account_tokens(expires_at);
    `,
  },
  {
    id: 26,
    name: 'KI-Zusammenfassungen',
    sql: `
    -- Last AI summary per ticket; "basis" = fingerprint of the text it was made from (outdated if it differs)
    CREATE TABLE ai_summaries (
      ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      model TEXT NOT NULL,
      lang TEXT NOT NULL,
      basis TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    `,
  },
  {
    id: 27,
    name: 'Automatische Abmeldung nach Inaktivität',
    sql: `
    -- Last activity of a session (idle check per request: the period depends on role and network)
    ALTER TABLE sessions ADD COLUMN last_seen INTEGER;
    -- Existing sessions count as active now (otherwise long-running ones would end at once)
    UPDATE sessions SET last_seen = CAST(strftime('%s','now') AS INTEGER) * 1000;
    `,
  },
  {
    id: 28,
    name: '@-Erwähnungen in Kommentaren',
    sql: `
    -- Who was mentioned in which comment; seen_at = the person has opened the ticket since
    CREATE TABLE comment_mentions (
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      seen_at TEXT,
      PRIMARY KEY (comment_id, user_id)
    );
    CREATE INDEX idx_comment_mentions_user ON comment_mentions(user_id, ticket_id);
    `,
  },
  {
    id: 29,
    name: 'Bewertung von Wissensartikeln (hilfreich / nicht hilfreich)',
    sql: `
    -- one vote per account and article (+1 helpful, -1 not helpful)
    CREATE TABLE kb_votes (
      article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (article_id, user_id)
    );
    -- what was missing (only for agents); archived = from before the rating was reset
    CREATE TABLE kb_feedback (
      id INTEGER PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_kb_feedback_article ON kb_feedback(article_id, archived);
    `,
  },
  {
    id: 30,
    name: 'Komponenten pro Projekt (Zuständigkeit, Schlagwörter, Absender)',
    sql: `
    -- sub-areas of a project with a responsible person; tickets are matched by keywords or sender
    CREATE TABLE components (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      lead_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deputy_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      keywords TEXT NOT NULL DEFAULT '',
      senders TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (project_id, name)
    );
    ALTER TABLE tickets ADD COLUMN component_id INTEGER REFERENCES components(id) ON DELETE SET NULL;
    CREATE INDEX idx_tickets_component ON tickets(component_id);
    `,
  },
  {
    id: 31,
    name: 'Gespeicherte Filter und geteilte Warteschlangen',
    sql: `
    -- owner_id NULL = queue shared by an admin with all agents
    CREATE TABLE saved_filters (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      query TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_saved_filters_owner ON saved_filters(owner_id, position);
    `,
  },
  {
    id: 32,
    name: 'KI-Vorschläge für Komponenten (mit Trefferquote)',
    sql: `
    -- one entry per ticket: what the AI suggested and what became of it
    -- state: pending (waiting for an agent) | accepted | rejected | auto (set by the AI) | corrected (changed by an agent) | none (nothing fits)
    CREATE TABLE component_suggestions (
      ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
      component_name TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      decided_at TEXT,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_component_suggestions_state ON component_suggestions(state);
    `,
  },
  {
    id: 33,
    name: 'Formatierte Kommentare (Markdown) für Tickets und Wissensartikel',
    sql: `
    -- text = as before (plain text, links and **bold**), md = written with the formatting toolbar
    ALTER TABLE comments ADD COLUMN format TEXT NOT NULL DEFAULT 'text';
    ALTER TABLE kb_comments ADD COLUMN format TEXT NOT NULL DEFAULT 'text';
    `,
  },
  {
    id: 34,
    name: 'Farbschema pro Konto (System/Hell/Dunkel)',
    sql: `
    -- NULL = follow the device (system)
    ALTER TABLE users ADD COLUMN theme TEXT;
    `,
  },
  {
    id: 35,
    name: 'Suche: Umbenennung von Kommentierenden',
    sql: `
    -- The search columns people/people_public also contain the names of repliers:
    -- a renamed account must also mark the tickets it commented on
    DROP TRIGGER search_u_upd;
    CREATE TRIGGER search_u_upd AFTER UPDATE OF display_name, email, username ON users
      BEGIN INSERT OR IGNORE INTO search_dirty SELECT id FROM tickets WHERE reporter_id=NEW.id OR assignee_id=NEW.id
        OR id IN (SELECT ticket_id FROM comments WHERE author_id=NEW.id); END;
    -- renames before this version may have left stale names: rebuild tickets with replies from accounts once
    INSERT OR IGNORE INTO search_dirty SELECT DISTINCT ticket_id FROM comments WHERE author_id IS NOT NULL;
    `,
  },
  {
    id: 36,
    name: 'Mail: Empfänger je gesendeter Mail',
    sql: `
    -- Recipient of each outgoing mail: a delivery report may only block the address the mail went to
    ALTER TABLE mail_messages ADD COLUMN recipient TEXT;
    `,
  },
  {
    id: 37,
    name: 'KI-Vorschläge: nachträgliche Einordnung',
    sql: `
    -- 1 = from sorting existing tickets afterwards: accepting it neither assigns the lead nor
    -- moves the ticket's "updated" time
    ALTER TABLE component_suggestions ADD COLUMN backfill INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 38,
    name: 'Lösung: erledigt, abgelehnt, Duplikat',
    sql: `
    -- Resolution of a ticket in status "done": done | rejected | duplicate (NULL while open);
    -- duplicate_of: the original ticket of a duplicate
    ALTER TABLE tickets ADD COLUMN resolution TEXT;
    ALTER TABLE tickets ADD COLUMN duplicate_of INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
    UPDATE tickets SET resolution='done' WHERE status='done';
    CREATE INDEX idx_tickets_resolution ON tickets(resolution);
    `,
  },
  {
    id: 39,
    name: 'KI: mögliche Duplikate',
    sql: `
    -- One entry per new ticket the AI looked at: which open ticket it may duplicate, and what came of it
    -- state: pending (hint shown to agents) | accepted (closed as duplicate of it) | corrected (duplicate
    -- of another ticket) | rejected ("not a duplicate") | none (no duplicate among the candidates)
    CREATE TABLE duplicate_suggestions (
      ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      original_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      decided_at TEXT,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_duplicate_suggestions_state ON duplicate_suggestions(state);
    `,
  },
  {
    id: 40,
    name: 'Sitzungen: nur noch der Hash der Kennung',
    sql: `
    -- Sessions are looked up by SHA-256 of the cookie value (src/auth/session.js sessionKey):
    -- the database and its backups no longer contain anything that signs anyone in.
    -- Existing sessions are ended (everyone signs in once more): converting them would keep the
    -- plaintext ids in the backup made right before this migration (and older ones) usable.
    DELETE FROM sessions;
    `,
  },
  {
    id: 41,
    name: 'Projektrechte für Bearbeiter',
    sql: `
    -- Which projects an agent works on. agent_scope: all (every project, the behaviour up to now –
    -- existing agents keep it) | projects (only the projects in project_agents).
    ALTER TABLE users ADD COLUMN agent_scope TEXT NOT NULL DEFAULT 'all';
    -- AD/SSO group whose members become agents of this project on sign-in
    ALTER TABLE projects ADD COLUMN agent_group TEXT NOT NULL DEFAULT '';
    -- source: manual (set by an admin) | group (from the project group, synced on every sign-in)
    CREATE TABLE project_agents (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id, source)
    );
    CREATE INDEX idx_project_agents_user ON project_agents(user_id);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;

export class DatabaseTooNewError extends Error {}
export class WrongKeyError extends Error {}

/** Does the key (secret.key / HELFI_SECRET) match the database? Otherwise abort clearly instead of crashing later. */
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

/**
 * Flush a file (or directory entry) to disk. A rename is only durable once the data and the
 * directory are written: otherwise a power loss right after "rename, delete the original" can leave
 * an empty or truncated backup and no original. File systems without fsync support are tolerated.
 */
const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR', 'EBADF']);
export function fsyncPath(file, { dir = false } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (dir) return; throw e; }
  try { fs.fsyncSync(fd); } catch (e) { if (!dir && !FSYNC_UNSUPPORTED.has(e.code)) throw e; } finally { fs.closeSync(fd); }
}

/**
 * Packs a file with gzip into `dest` (written as dest.part, then renamed) and checks the result:
 * unpacked again it must be byte for byte the original (SHA-256). Returns the packed size.
 */
async function gzipVerified(src, dest) {
  const part = `${dest}.part`;
  try {
    const want = crypto.createHash('sha256');
    const read = fs.createReadStream(src);
    read.on('data', (c) => want.update(c));
    await pipeline(read, zlib.createGzip({ level: 6 }), fs.createWriteStream(part, { mode: 0o600 }));
    const got = crypto.createHash('sha256');
    const check = zlib.createGunzip();
    check.on('data', (c) => got.update(c));
    await pipeline(fs.createReadStream(part), check);
    if (got.digest('hex') !== want.digest('hex')) throw new Error(`packed backup differs from the original: ${path.basename(src)}`);
    try { fs.chmodSync(part, 0o600); } catch { /* e.g. file system without permissions */ }
    fsyncPath(part);
    fs.renameSync(part, dest);
    fsyncPath(path.dirname(dest), { dir: true });
    return fs.statSync(dest).size;
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Backs up the database (consistent, also while running) and stores it packed (helfi-….sqlite.gz).
 * Exception: the backup before a version change (helfi-vor-<version>-….sqlite) stays unpacked for a
 * day – update.sh (also older ones) restores exactly this file if the new version does not start;
 * packPendingBackups packs it afterwards.
 */
export async function backupDatabase(db, label, dir = paths.backups, { compress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `helfi-${label}-${stamp()}.sqlite`);
  const pack = compress ?? backupKind(path.basename(file)) !== 'version';
  // Write under a temporary name first, then rename: if startup is aborted midway,
  // there is never a half-written backup under the final name (update.sh would otherwise restore it)
  const part = `${file}.part`;
  let out = file;
  try {
    await db.backup(part);
    // Contains password hashes and personal data → readable by the owner only
    try { fs.chmodSync(part, 0o600); } catch { /* e.g. file system without permissions */ }
    if (pack) {
      out = `${file}.gz`;
      await gzipVerified(part, out);
      fs.rmSync(part, { force: true });
    } else {
      fsyncPath(part);
      fs.renameSync(part, file);
      fsyncPath(dir, { dir: true });
    }
  } catch (e) {
    for (const f of [part, `${part}-journal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    throw e;
  }
  log.info(`Backup created: ${out}`);
  return out;
}

/** How long the unpacked backup before a version change is kept for update.sh (then packed). */
export const VERSION_BACKUP_UNPACKED_MS = 24 * 3600 * 1000;

/**
 * Packs unpacked backups (from older versions, or the one before a version change after a day).
 * One after another; the original is only removed once the packed copy is complete and checked.
 * The time stamp stays, so order and cleanup do not change. Returns { packed, saved }.
 */
let packing = false;
export async function packPendingBackups(dir = paths.backups, { now = Date.now() } = {}) {
  if (packing) return { packed: 0, saved: 0 }; // one run at a time (start and daily job)
  packing = true;
  try { return await packAll(dir, now); } finally { packing = false; }
}

async function packAll(dir, now) {
  let packed = 0; let saved = 0;
  for (const b of listBackups(dir)) {
    if (b.name.endsWith('.gz')) continue;
    if (b.kind === 'version' && now - b.time < VERSION_BACKUP_UNPACKED_MS) continue;
    const src = path.join(dir, b.name);
    // Still being written (journal next to it) → leave it alone
    if (fs.existsSync(`${src}-journal`) || fs.existsSync(`${src}-wal`)) continue;
    const dest = `${src}.gz`;
    if (fs.existsSync(dest)) continue;
    try {
      const size = await gzipVerified(src, dest);
      const t = new Date(b.time);
      fs.utimesSync(dest, t, t);
      fs.rmSync(src, { force: true });
      packed++; saved += b.size - size;
    } catch (e) { log.warn(`Could not pack backup: ${b.name}`, { error: e.message }); }
  }
  if (packed) log.info(`Backups packed: ${packed} (${Math.round(saved / 1048576)} MB saved)`);
  return { packed, saved };
}

/** How many backups per kind are kept by default (setting backup.keep). */
export const DEFAULT_BACKUP_KEEP = 10;
export const MAX_BACKUP_KEEP = 100;
export function clampBackupKeep(n) {
  const v = Math.round(Number(n));
  if (n === null || n === undefined || n === '' || !Number.isFinite(v)) return DEFAULT_BACKUP_KEEP;
  return Math.min(MAX_BACKUP_KEEP, Math.max(1, v));
}

const BACKUP_NAME = /^helfi-[A-Za-z0-9._-]+\.sqlite(\.gz)?$/;

/**
 * Kind of backup: daily, version (before version change), manual,
 * predelete (before deleting a project), preimport (before an import). The newest are kept per kind.
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

/** Backups in the folder, newest first. */
export function listBackups(dir = paths.backups) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!backupKind(f)) continue;
    // A file can vanish between readdir and stat (just packed and removed, deleted) → skip it
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    out.push({ name: f, kind: backupKind(f), size: st.size, time: st.mtimeMs });
  }
  return out.sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
}

/**
 * Cleans up backups: per kind (daily, before version change, manual, before deletion, before import) the newest `keep` remain.
 * At least one per kind always remains. Returns the number of deleted files and the space freed.
 */
export function pruneBackups(keep = DEFAULT_BACKUP_KEEP, dir = paths.backups) {
  const n = clampBackupKeep(keep);
  const seen = {};
  let deleted = 0; let freed = 0;
  for (const b of listBackups(dir)) {
    seen[b.kind] = (seen[b.kind] || 0) + 1;
    if (seen[b.kind] <= n) continue;
    try { fs.unlinkSync(path.join(dir, b.name)); deleted++; freed += b.size; }
    catch (e) { log.warn(`Could not delete backup: ${b.name}`, { error: e.message }); }
  }
  // Remove leftover partial backups (aborted while writing) after one hour
  // (also the cleaned copies of downloads, helfi-download-….sqlite.part, left over after a crash)
  const PART = /^helfi-[A-Za-z0-9._-]+\.sqlite(\.gz)?\.part(-journal|-wal|-shm)?$/;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* folder missing */ }
  for (const name of names) {
    if (!PART.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || Date.now() - st.mtimeMs < 3600_000) continue;
      fs.unlinkSync(file); deleted++; freed += st.size;
    } catch (e) { log.warn(`Could not delete partial backup: ${name}`, { error: e.message }); }
  }
  if (deleted) log.info(`Old backups deleted: ${deleted} (${Math.round(freed / 1048576)} MB freed)`);
  return { deleted, freed };
}

/** Delete a specific backup (only files from the backup folder). */
/**
 * A backup for download: looked up in the folder listing (never a path built from the request).
 * Returns { name, kind, size, time, file } or null.
 */
export function findBackup(name, dir = paths.backups) {
  if (typeof name !== 'string' || !backupKind(name)) return null;
  const b = listBackups(dir).find((x) => x.name === name);
  return b ? { ...b, file: path.join(dir, b.name) } : null;
}

/**
 * Copy of a backup for download, without anything that grants access by itself: the sessions table
 * holds the session ids in plain text (they are the cookie values), so a downloaded ZIP would otherwise
 * let anyone holding it take over every active session – including admins, without password and 2FA.
 * The copy (unpacked) is written into the backup folder as helfi-download-….sqlite.part – never listed
 * as a backup, removed by the caller afterwards and by pruneBackups after a crash. Freed pages are
 * overwritten (secure_delete), so the ids are not left in the file either. Returns the path.
 */
export async function backupDownloadCopy(backup, dir = paths.backups, { maxBytes = Infinity } = {}) {
  const tmp = path.join(dir, `helfi-download-${crypto.randomBytes(8).toString('hex')}.sqlite.part`);
  try {
    const read = fs.createReadStream(backup.file);
    const write = fs.createWriteStream(tmp, { mode: 0o600, flags: 'wx' });
    // Stop as soon as the (unpacked) copy grows beyond maxBytes – never fill the disk with a copy
    // that cannot be downloaded anyway
    let total = 0;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length;
        if (total > maxBytes) { const e = new Error('Backup copy too large'); e.code = 'ETOOLARGE'; cb(e); return; }
        cb(null, chunk);
      },
    });
    if (backup.name.endsWith('.gz')) await pipeline(read, zlib.createGunzip(), limit, write);
    else await pipeline(read, limit, write);
    const d = new Database(tmp, { fileMustExist: true });
    try {
      d.pragma('journal_mode = DELETE');
      d.pragma('secure_delete = ON');
      const has = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (has('sessions')) d.exec('DELETE FROM sessions');
    } finally { d.close(); }
    return tmp;
  } catch (e) {
    removeDownloadCopy(tmp);
    throw e;
  }
}

/**
 * Bytes a download copy may use in `dir` without endangering the live database on the same volume:
 * free space minus a reserve (at least 256 MB or 5 % of the volume). Infinity if the file system
 * cannot tell.
 */
export function downloadCopyBudget(dir = paths.backups) {
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    const reserve = Math.max(256 * 1024 * 1024, Number(st.blocks) * Number(st.bsize) * 0.05);
    return Math.max(0, free - reserve);
  } catch { return Infinity; }
}

/** Remove a copy made by backupDownloadCopy (with a journal that may be left over). */
export function removeDownloadCopy(file) {
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}

/** INFO.txt for a downloaded backup (German and English): what is in it and how to restore it. */
export function backupInfoText({ name, created, version = config.version }) {
  const when = created.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return [
    `Helfi.Space ${version}`,
    `Sicherung / Backup: ${name}`,
    `Erstellt / Created: ${when}`,
    '',
    '--- Deutsch ---',
    'Inhalt: die Datenbank (helfi.sqlite). Nicht enthalten: Anhänge (data/attachments/) und secret.key.',
    'Die Anmeldesitzungen sind entfernt (sonst ließe sich mit der Datei jede angemeldete Sitzung übernehmen):',
    'nach dem Zurückspielen melden sich alle neu an.',
    'secret.key fehlt mit Absicht: Damit ließen sich die verschlüsselt gespeicherten Kennwörter',
    '(Postfach, Dienstkonto, SSO, KI-Schlüssel) und 2FA-Schlüssel entschlüsseln.',
    '',
    'Wiederherstellen (auf derselben Installation, secret.key bleibt dort liegen):',
    '  docker compose down',
    '  cp data/helfi.sqlite data/helfi.sqlite.alt',
    '  unzip -o <diese Datei>.zip helfi.sqlite -d data/',
    '  rm -f data/helfi.sqlite-wal data/helfi.sqlite-shm',
    '  docker compose up -d',
    'Auf einer neuen Installation zusätzlich die ursprüngliche secret.key (oder HELFI_SECRET) übernehmen,',
    'sonst startet Helfi.Space nicht. Dafür den ganzen Ordner data/ vom Docker-Host sichern.',
    '',
    '--- English ---',
    'Contents: the database (helfi.sqlite). Not included: attachments (data/attachments/) and secret.key.',
    'Sign-in sessions are removed (otherwise the file would let anyone take over every signed-in session):',
    'after restoring, everyone signs in again.',
    'secret.key is left out on purpose: it would decrypt the stored passwords',
    '(mailbox, service account, SSO, AI key) and 2FA keys.',
    '',
    'Restore (on the same installation, secret.key stays in place):',
    '  docker compose down',
    '  cp data/helfi.sqlite data/helfi.sqlite.old',
    '  unzip -o <this file>.zip helfi.sqlite -d data/',
    '  rm -f data/helfi.sqlite-wal data/helfi.sqlite-shm',
    '  docker compose up -d',
    'On a new installation, also take over the original secret.key (or HELFI_SECRET),',
    'otherwise Helfi.Space does not start. Back up the whole data/ folder on the Docker host for that.',
    '',
  ].join('\r\n');
}

export function deleteBackup(name, dir = paths.backups) {
  if (typeof name !== 'string' || !backupKind(name)) return false;
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  log.info(`Backup deleted: ${name}`);
  return true;
}

/**
 * Opens the database, backs up before a version change and runs migrations.
 * Aborts with a clear message if the database comes from a newer version.
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
      `${backupDir}/helfi-vor-${dbApp || '<neuere Version>'}-*.sqlite bzw. *.sqlite.gz (siehe README, „Version festhalten und zurückgehen“).`,
    );
  }

  // Back up before a version change AND before any pending migration
  if (existed && dbSchema > 0 && (dbApp !== appVersion || dbSchema < SCHEMA_VERSION)) {
    await backupDatabase(db, `vor-${appVersion}`, backupDir);
  }

  const pending = MIGRATIONS.filter((m) => m.id > dbSchema);
  for (const m of pending) {
    log.info(`Database migration ${m.id}: ${m.name}`);
    if (m.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        // After a rebuild all references must still be valid, otherwise roll everything back
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
