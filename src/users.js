// Benutzerverwaltung: lokale Konten, Übernahme aus AD/SSO, Rollen.
import { hashPassword } from './lib/crypto.js';
import { HttpError } from './lib/http.js';

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email || '',
    role: u.role,
    source: u.source,
    active: !!u.active,
    roleLocked: !!u.role_locked,
    language: u.language || null,
    lastLogin: u.last_login || null,
    hasPassword: !!u.password_hash,
    mfaEnabled: !!u.totp_enabled,
  };
}

/** Kurzform für Listen (Zuweisung, Avatare) – ohne Anmeldedetails. */
export function userRef(u) {
  if (!u) return null;
  return { id: u.id, displayName: u.display_name, username: u.username, email: u.email || '' };
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** E-Mail-Adresse prüfen und vereinheitlichen (klein geschrieben). Leer = keine Adresse. */
export function normalizeEmail(value) {
  const e = String(value ?? '').trim().toLowerCase();
  if (!e) return '';
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, 'err.invalidEmail');
  return e;
}

export function createUsers(db) {
  const byId = db.prepare('SELECT * FROM users WHERE id=?');
  const byName = db.prepare('SELECT * FROM users WHERE username=?');
  // Groß-/Kleinschreibung egal: AD liefert z. B. "Max.Muster@firma.local", Mails kommen klein geschrieben
  const byEmail = db.prepare("SELECT * FROM users WHERE lower(email)=lower(?) AND email<>'' ORDER BY (source='email'), id LIMIT 1");

  function countActiveAdmins(exceptId = 0) {
    return db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?").get(exceptId).n;
  }

  function createLocal({ username, displayName, email, role = 'user', password, language = null }) {
    if (!password || password.length < 10) throw new HttpError(400, 'err.passwordWeak');
    if (byName.get(username)) throw new HttpError(409, 'err.usernameTaken');
    const mail = normalizeEmail(email);
    return db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO users(username,display_name,email,role,source,password_hash,language) VALUES(?,?,NULL,?,'local',?,?)`,
      ).run(username, displayName || username, role, hashPassword(password), language);
      if (mail) setEmail(info.lastInsertRowid, mail);
      return byId.get(info.lastInsertRowid);
    })();
  }

  /**
   * E-Mail-Adresse eines Kontos setzen. Eingehende Mails werden über die Adresse zugeordnet, deshalb:
   * gehört sie einem anderen Konto → 409; gehört sie einem E-Mail-Kontakt (aus Mails entstanden),
   * wird der Kontakt mit seinen Tickets, Kommentaren und Teilnahmen in dieses Konto übernommen.
   */
  function setEmail(userId, email) {
    const mail = normalizeEmail(email);
    db.transaction(() => {
      if (mail) {
        const others = db.prepare('SELECT * FROM users WHERE lower(email)=? AND id<>?').all(mail, userId);
        if (others.some((o) => o.source !== 'email')) throw new HttpError(409, 'err.emailTaken');
        for (const c of others) mergeContact(c.id, userId);
      }
      db.prepare('UPDATE users SET email=? WHERE id=?').run(mail || null, userId);
    })();
    return byId.get(userId);
  }

  /** E-Mail-Kontakt in ein Konto übernehmen und den Kontakt löschen. */
  function mergeContact(fromId, intoId) {
    const from = byId.get(fromId);
    if (!from || from.source !== 'email') throw new Error('Nur E-Mail-Kontakte lassen sich übernehmen');
    db.prepare('UPDATE tickets SET reporter_id=? WHERE reporter_id=?').run(intoId, fromId);
    db.prepare('UPDATE comments SET author_id=? WHERE author_id=?').run(intoId, fromId);
    db.prepare('UPDATE attachments SET uploaded_by=? WHERE uploaded_by=?').run(intoId, fromId);
    db.prepare('UPDATE activity SET user_id=? WHERE user_id=?').run(intoId, fromId);
    // Teilnahmen übernehmen, aber nicht bei eigenen Tickets (dort ist das Konto schon Melder)
    db.prepare(`INSERT OR IGNORE INTO ticket_participants(ticket_id,user_id,added_by,created_at)
      SELECT p.ticket_id, ?, p.added_by, p.created_at FROM ticket_participants p JOIN tickets t ON t.id=p.ticket_id
      WHERE p.user_id=? AND (t.reporter_id IS NULL OR t.reporter_id<>?)`).run(intoId, fromId, intoId);
    // Alle übrigen Verweise umhängen, sonst würde das Löschen sie leeren (SET NULL) oder mitlöschen (CASCADE),
    // z. B. offene Genehmigungen: die Anfrage bliebe sonst für immer „ausstehend“.
    // Genehmigungen: war das Konto in derselben Runde schon angefragt, bleibt dessen Zeile (OR IGNORE).
    db.prepare('UPDATE OR IGNORE approvals SET approver_id=? WHERE approver_id=?').run(intoId, fromId);
    for (const [table, col] of [
      ['tickets', 'assignee_id'], ['projects', 'lead_id'], ['ticket_participants', 'added_by'],
      ['canned_responses', 'owner_id'], ['canned_responses', 'created_by'], ['ticket_links', 'created_by'],
      ['config_items', 'owner_id'], ['ticket_ratings', 'assignee_id'],
      ['kb_articles', 'created_by'], ['kb_articles', 'updated_by'], ['kb_images', 'created_by'], ['kb_versions', 'author_id'],
      ['kb_templates', 'created_by'], ['kb_templates', 'updated_by'], ['kb_comments', 'author_id'], ['kb_comments', 'resolved_by'],
    ]) db.prepare(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`).run(intoId, fromId);
    // Genehmiger-Listen als Text (Servicekatalog, Change-Genehmiger in den Einstellungen)
    const swap = (list, sep) => [...new Set(String(list).split(sep).filter(Boolean).map((x) => (Number(x) === fromId ? String(intoId) : x.trim())))].join(',');
    for (const it of db.prepare("SELECT id, approver_ids FROM catalog_items WHERE ','||approver_ids||',' LIKE ?").all(`%,${fromId},%`)) {
      db.prepare('UPDATE catalog_items SET approver_ids=? WHERE id=?').run(swap(it.approver_ids, ','), it.id);
    }
    const cab = db.prepare("SELECT value FROM settings WHERE key='change.approvers' AND secret=0").get();
    if (cab) {
      const ids = String(JSON.parse(cab.value) || '');
      if (ids.split(/[\s,;]+/).map(Number).includes(fromId)) {
        db.prepare("UPDATE settings SET value=? WHERE key='change.approvers'").run(JSON.stringify(swap(ids, /[\s,;]+/)));
      }
    }
    db.prepare('DELETE FROM users WHERE id=?').run(fromId);
  }

  /**
   * Legt Benutzer aus AD/SSO an oder aktualisiert sie.
   * role: gewünschte Rolle aus Gruppen; null = Rolle nicht aus Gruppen ableiten.
   * trustName: Benutzername ist von einer vertrauenswürdigen Quelle (AD bzw. SSO mit eigener Domäne)
   *            und darf mit einem bestehenden AD-/SSO-Konto gleichen Namens zusammengeführt werden.
   * trustEmail: E-Mail-Adresse ist bestätigt – E-Mail-Kontakte dürfen übernommen werden.
   * allowCreate: false = nur bestehende Konten anmelden.
   */
  function upsertExternal({ source, username, displayName, email, externalId, role, trustName = true, trustEmail = true, allowCreate = true }) {
    // Unbestätigte Adressen nie speichern: Mails von dieser Adresse würden sonst diesem Konto zugeordnet
    if (!trustEmail) email = '';
    let u = externalId ? db.prepare('SELECT * FROM users WHERE source=? AND external_id=?').get(source, externalId) : null;

    if (!u) {
      const byUsername = byName.get(username);
      const mergeable = byUsername && trustName && byUsername.source !== 'local'
        // nie ein Konto derselben Quelle mit anderer Identität übernehmen
        && !(byUsername.source === source && byUsername.external_id && byUsername.external_id !== externalId)
        // Konten im Namensraum "oidc:" (nicht vertrauenswürdige SSO-Namen) nie übernehmen
        && !String(byUsername.username).startsWith('oidc:');
      if (mergeable) u = byUsername;
      else if (byUsername) {
        // Namenskonflikt (lokales Konto oder andere Identität): eigenes Konto mit Präfix
        const base = `${source}:${username}`;
        for (let i = 1; i < 100; i++) {
          const candidate = i === 1 ? base : `${base}-${i}`;
          const existing = byName.get(candidate);
          if (!existing) { username = candidate; break; }
          if (existing.source === source && (!existing.external_id || existing.external_id === externalId)) { u = existing; username = candidate; break; }
        }
      }
    }
    if (!u && email && trustEmail) {
      // Per E-Mail nur reine Kontakte übernehmen (aus Mails entstanden), nie fremde Konten
      const contact = byEmail.get(email);
      if (contact && contact.source === 'email') u = contact;
    }

    if (!u) {
      if (!allowCreate) return null;
      if (byName.get(username)) throw new HttpError(409, 'err.usernameTaken');
      const info = db.prepare(
        'INSERT INTO users(username,display_name,email,role,source,external_id) VALUES(?,?,?,?,?,?)',
      ).run(username, displayName || username, email || null, role || 'user', source, externalId || null);
      return byId.get(info.lastInsertRowid);
    }

    const newRole = u.role_locked || !role ? u.role : role;
    // Den letzten Admin nicht durch eine Gruppenänderung herabstufen
    const safeRole = u.role === 'admin' && newRole !== 'admin' && countActiveAdmins(u.id) === 0 ? 'admin' : newRole;
    // Herkunft nur übernehmen, wenn das Konto ein E-Mail-Kontakt war oder schon dieser Quelle gehört
    const adopt = u.source === 'email' || u.source === source;
    db.prepare(
      `UPDATE users SET display_name=?, email=COALESCE(NULLIF(?,''),email), role=?, source=?, external_id=? WHERE id=?`,
    ).run(displayName || u.display_name, email || '', safeRole,
      adopt ? source : u.source, adopt ? (externalId || u.external_id) : u.external_id, u.id);
    if (adopt && u.source === 'email' && u.username !== username && !byName.get(username)) {
      db.prepare('UPDATE users SET username=? WHERE id=?').run(username, u.id);
    }
    return byId.get(u.id);
  }

  /** Absender einer E-Mail ohne Konto: als "email"-Kontakt anlegen (kann sich nicht anmelden). */
  function contactForEmail(email, name) {
    const existing = byEmail.get(email);
    if (existing) return existing;
    let username = email.toLowerCase();
    if (byName.get(username)) username = `mail:${username}`;
    const info = db.prepare(
      "INSERT INTO users(username,display_name,email,role,source) VALUES(?,?,?,'user','email')",
    ).run(username, name || email, email);
    return byId.get(info.lastInsertRowid);
  }

  return { byId: (id) => byId.get(id), byName: (n) => byName.get(n), byEmail: (e) => byEmail.get(e), createLocal, upsertExternal, contactForEmail, countActiveAdmins, setEmail };
}

/** Rolle aus Gruppenmitgliedschaft ableiten. Keine Gruppen konfiguriert → null (Rolle bleibt). */
export function roleFromGroups(groups, cfg) {
  if (!cfg.adminGroup && !cfg.agentGroup) return null;
  if (cfg.adminGroup && groups.admin) return 'admin';
  if (cfg.agentGroup && groups.agent) return 'agent';
  return 'user';
}
