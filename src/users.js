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

export function createUsers(db) {
  const byId = db.prepare('SELECT * FROM users WHERE id=?');
  const byName = db.prepare('SELECT * FROM users WHERE username=?');
  const byEmail = db.prepare("SELECT * FROM users WHERE email=? AND email<>'' ORDER BY (source='email'), id LIMIT 1");

  function countActiveAdmins(exceptId = 0) {
    return db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?").get(exceptId).n;
  }

  function createLocal({ username, displayName, email, role = 'user', password, language = null }) {
    if (!password || password.length < 10) throw new HttpError(400, 'err.passwordWeak');
    if (byName.get(username)) throw new HttpError(409, 'err.usernameTaken');
    const info = db.prepare(
      `INSERT INTO users(username,display_name,email,role,source,password_hash,language) VALUES(?,?,?,?,'local',?,?)`,
    ).run(username, displayName || username, email || null, role, hashPassword(password), language);
    return byId.get(info.lastInsertRowid);
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

  return { byId: (id) => byId.get(id), byName: (n) => byName.get(n), byEmail: (e) => byEmail.get(e), createLocal, upsertExternal, contactForEmail, countActiveAdmins };
}

/** Rolle aus Gruppenmitgliedschaft ableiten. Keine Gruppen konfiguriert → null (Rolle bleibt). */
export function roleFromGroups(groups, cfg) {
  if (!cfg.adminGroup && !cfg.agentGroup) return null;
  if (cfg.adminGroup && groups.admin) return 'admin';
  if (cfg.agentGroup && groups.agent) return 'agent';
  return 'user';
}
