// User management: local accounts, provisioning from AD/SSO, roles.
import { hashPassword } from './lib/crypto.js';
import { HttpError } from './lib/http.js';
import { withProjects } from './auth/access.js';
import { releaseUnassignable } from './assignments.js';

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
    // colour theme: system (follows the device) | light | dark
    theme: ['light', 'dark'].includes(u.theme) ? u.theme : 'system',
    // order of the activity in the ticket: newest | oldest first
    activityOrder: u.activity_order === 'oldest' ? 'oldest' : 'newest',
    lastLogin: u.last_login || null,
    hasPassword: !!u.password_hash,
    mfaEnabled: !!u.totp_enabled,
    selfRegistered: !!u.self_registered,
    approvalPending: !!u.approval_pending,
  };
}

/** Short form for lists (assignment, avatars) – without sign-in details. */
export function userRef(u) {
  if (!u) return null;
  return { id: u.id, displayName: u.display_name, username: u.username, email: u.email || '' };
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Validate and normalize an email address (lowercase). Empty = no address. */
export function normalizeEmail(value) {
  const e = String(value ?? '').trim().toLowerCase();
  if (!e) return '';
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, 'err.invalidEmail');
  return e;
}

export function createUsers(db) {
  const byId = db.prepare('SELECT * FROM users WHERE id=?');
  const byName = db.prepare('SELECT * FROM users WHERE username=?');
  // Case-insensitive: AD returns e.g. "Max.Muster@firma.local", mails arrive in lowercase
  const byEmail = db.prepare("SELECT * FROM users WHERE lower(email)=lower(?) AND email<>'' ORDER BY (source='email'), id LIMIT 1");
  // With the agent's projects (agentOn/agentProjects need them for agents limited to projects)
  const scoped = (u) => withProjects(db, u);

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
      return scoped(byId.get(info.lastInsertRowid));
    })();
  }

  /**
   * Set the email address of an account. Incoming mails are matched by address, therefore:
   * if it belongs to another account → 409; if it belongs to an email contact (created from mails),
   * the contact with its tickets, comments and participations is merged into this account.
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
    return scoped(byId.get(userId));
  }

  /** Merge an email contact into an account and delete the contact. */
  function mergeContact(fromId, intoId) {
    const from = byId.get(fromId);
    if (!from || from.source !== 'email') throw new Error('Nur E-Mail-Kontakte lassen sich übernehmen');
    db.prepare('UPDATE tickets SET reporter_id=? WHERE reporter_id=?').run(intoId, fromId);
    // The account is now the reporter there: no additional participant row for the same person
    db.prepare('DELETE FROM ticket_participants WHERE user_id=? AND ticket_id IN (SELECT id FROM tickets WHERE reporter_id=?)').run(intoId, intoId);
    db.prepare('UPDATE comments SET author_id=? WHERE author_id=?').run(intoId, fromId);
    db.prepare('UPDATE attachments SET uploaded_by=? WHERE uploaded_by=?').run(intoId, fromId);
    db.prepare('UPDATE activity SET user_id=? WHERE user_id=?').run(intoId, fromId);
    // Take over participations, but not on own tickets (the account is already the reporter there)
    db.prepare(`INSERT OR IGNORE INTO ticket_participants(ticket_id,user_id,added_by,created_at)
      SELECT p.ticket_id, ?, p.added_by, p.created_at FROM ticket_participants p JOIN tickets t ON t.id=p.ticket_id
      WHERE p.user_id=? AND (t.reporter_id IS NULL OR t.reporter_id<>?)`).run(intoId, fromId, intoId);
    // Repoint all other references, otherwise deleting would clear them (SET NULL) or delete them too (CASCADE),
    // e.g. open approvals: the request would otherwise stay "pending" forever.
    // Approvals: if the account was already asked in the same round, its row stays (OR IGNORE).
    db.prepare('UPDATE OR IGNORE approvals SET approver_id=? WHERE approver_id=?').run(intoId, fromId);
    // Mentions and votes (CASCADE, one row per person): keep the account's row if it already has one
    db.prepare('UPDATE OR IGNORE comment_mentions SET user_id=? WHERE user_id=?').run(intoId, fromId);
    db.prepare('UPDATE OR IGNORE kb_votes SET user_id=? WHERE user_id=?').run(intoId, fromId);
    for (const [table, col] of [
      ['tickets', 'assignee_id'], ['projects', 'lead_id'], ['ticket_participants', 'added_by'],
      ['canned_responses', 'owner_id'], ['canned_responses', 'created_by'], ['ticket_links', 'created_by'],
      ['config_items', 'owner_id'], ['ticket_ratings', 'assignee_id'],
      ['kb_articles', 'created_by'], ['kb_articles', 'updated_by'], ['kb_images', 'created_by'], ['kb_versions', 'author_id'],
      ['kb_templates', 'created_by'], ['kb_templates', 'updated_by'], ['kb_comments', 'author_id'], ['kb_comments', 'resolved_by'],
      ['kb_feedback', 'user_id'], ['saved_filters', 'owner_id'], ['saved_filters', 'created_by'],
      ['components', 'lead_id'], ['components', 'deputy_id'], ['component_suggestions', 'decided_by'], ['duplicate_suggestions', 'decided_by'],
    ]) db.prepare(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`).run(intoId, fromId);
    // Approver lists as text (service catalog, change approvers in the settings)
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
   * Creates or updates users from AD/SSO.
   * role: desired role from groups; null = do not derive the role from groups.
   * trustName: username comes from a trusted source (AD or SSO with own domain)
   *            and may be merged with an existing AD/SSO account of the same name.
   * trustEmail: email address is verified – email contacts may be merged.
   * allowCreate: false = only sign in existing accounts.
   */
  /** Up to 1.12 the objectGUID could be stored as text (instead of hex): neither 32 hex characters nor a DN */
  const garbledGuid = (id) => !/^[0-9a-f]{32}$/i.test(String(id)) && !String(id).includes('=');

  /**
   * Project groups from AD/SSO (access = projectAccessFromGroups): the group rows of project_agents
   * follow the groups at every sign-in. They give rights in those projects only and never change the role.
   */
  function applyAccess(u, access) {
    if (!access || !u) return;
    db.transaction(() => {
      db.prepare("DELETE FROM project_agents WHERE user_id=? AND source='group'").run(u.id);
      const add = db.prepare("INSERT OR IGNORE INTO project_agents(project_id, user_id, source) SELECT id, ?, 'group' FROM projects WHERE id=?");
      for (const pid of access.projects) add.run(u.id, pid);
    })();
  }

  function upsertExternal({ source, username, displayName, email, externalId, role, access = null, trustName = true, trustEmail = true, allowCreate = true, sid = '' }) {
    // Store objectSid only for AD accounts (stable identifier for merging with SSO)
    const adSid = source === 'ldap' && /^S-1-[\d-]+$/.test(String(sid || '')) ? String(sid) : null;
    // Never store unverified addresses: mails from this address would otherwise be matched to this account
    if (!trustEmail) email = '';
    let u = externalId ? db.prepare('SELECT * FROM users WHERE source=? AND external_id=?').get(source, externalId) : null;

    if (!u) {
      const byUsername = byName.get(username);
      const mergeable = byUsername && trustName && byUsername.source !== 'local'
        // never take over an account of the same source with a different identity – except AD accounts whose
        // stored objectGUID could be mangled up to 1.12 (16 bytes happened to be valid UTF-8 → text instead of hex)
        && !(byUsername.source === source && byUsername.external_id && byUsername.external_id !== externalId
          && !(source === 'ldap' && garbledGuid(byUsername.external_id) && /^[0-9a-f]{32}$/.test(String(externalId || ''))))
        // Never take over accounts in the namespace "oidc:" (untrusted SSO names)
        && !String(byUsername.username).startsWith('oidc:');
      if (mergeable) u = byUsername;
      else if (byUsername) {
        // Name conflict (local account or other identity): separate account with prefix
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
      // Via email only take over plain contacts (created from mails), never other accounts
      const contact = byEmail.get(email);
      if (contact && contact.source === 'email') u = contact;
    }

    if (!u) {
      if (!allowCreate) return null;
      if (byName.get(username)) throw new HttpError(409, 'err.usernameTaken');
      const info = db.prepare(
        'INSERT INTO users(username,display_name,email,role,source,external_id,ad_sid) VALUES(?,?,?,?,?,?,?)',
      ).run(username, displayName || username, email || null, role || 'user', source, externalId || null, adSid);
      applyAccess({ id: info.lastInsertRowid }, access);
      return scoped(byId.get(info.lastInsertRowid));
    }

    const newRole = u.role_locked || !role ? u.role : role;
    // Do not demote the last admin through a group change
    const safeRole = u.role === 'admin' && newRole !== 'admin' && countActiveAdmins(u.id) === 0 ? 'admin' : newRole;
    // Take over the source only if the account was an email contact or already belongs to this source
    const adopt = u.source === 'email' || u.source === source;
    db.prepare(
      `UPDATE users SET display_name=?, email=COALESCE(NULLIF(?,''),email), role=?, source=?, external_id=? WHERE id=?`,
    ).run(displayName || u.display_name, email || '', safeRole,
      adopt ? source : u.source, adopt ? (externalId || u.external_id) : u.external_id, u.id);
    if (adSid && (adopt || u.source === 'ldap')) db.prepare('UPDATE users SET ad_sid=? WHERE id=?').run(adSid, u.id);
    if (adopt && u.source === 'email' && u.username !== username && !byName.get(username)) {
      db.prepare('UPDATE users SET username=? WHERE id=?').run(username, u.id);
    }
    applyAccess(u, access);
    // Lost a project group or the role at this sign-in: taken off the open tickets they may no longer work on
    releaseUnassignable(db, { userId: u.id });
    return scoped(byId.get(u.id));
  }

  /** Sender of an email without an account: create as "email" contact (cannot sign in). */
  function contactForEmail(email, name) {
    const existing = byEmail.get(email);
    if (existing) return existing;
    let username = email.toLowerCase();
    if (byName.get(username)) username = `mail:${username}`;
    const info = db.prepare(
      "INSERT INTO users(username,display_name,email,role,source) VALUES(?,?,?,'user','email')",
    ).run(username, name || email, email);
    return scoped(byId.get(info.lastInsertRowid));
  }

  /** AD account via the AD identifier from an SSO claim ({ sid } or { guid }) */
  function byAdId(adId) {
    if (adId?.sid) return db.prepare("SELECT * FROM users WHERE source='ldap' AND ad_sid=? COLLATE NOCASE").get(adId.sid) || null;
    if (adId?.guid) return db.prepare("SELECT * FROM users WHERE source='ldap' AND lower(external_id)=?").get(adId.guid) || null;
    return null;
  }

  /** Every account (admin list) */
  function all() { return db.prepare('SELECT * FROM users ORDER BY active DESC, display_name').all(); }

  /** Active agents and admins – of these projects (ids), or of every project (null) */
  function agentsOf(projectIds = null) {
    // All projects: admins, legacy agents and everyone who works on a project (role 'user' + project_agents)
    if (projectIds === null) return db.prepare("SELECT * FROM users WHERE active=1 AND (role IN ('agent','admin') OR id IN (SELECT user_id FROM project_agents)) ORDER BY display_name").all();
    return db.prepare(`SELECT * FROM users WHERE active=1 AND (role IN ('admin','agent')
      OR id IN (SELECT user_id FROM project_agents WHERE project_id IN (SELECT value FROM json_each(?)))) ORDER BY display_name`).all(JSON.stringify(projectIds));
  }

  /** Projects per agent (manual and via project group): Map userId → [{ id, key, name, source, group }] */
  function projectsByUser() {
    const byUser = new Map();
    for (const r of db.prepare(`SELECT pa.user_id, pa.source, p.id, p.key, p.name, p.agent_group FROM project_agents pa
      JOIN projects p ON p.id=pa.project_id ORDER BY p.key`).all()) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push({ id: r.id, key: r.key, name: r.name, source: r.source, group: r.source === 'group' ? r.agent_group : undefined });
    }
    return byUser;
  }

  return { all, agentsOf, projectsByUser, rawById: (id) => byId.get(id), byAdId: (adId) => scoped(byAdId(adId)), byId: (id) => scoped(byId.get(id)), byName: (n) => scoped(byName.get(n)), byEmail: (e) => scoped(byEmail.get(e)), createLocal, upsertExternal, contactForEmail, mergeContact, countActiveAdmins, setEmail };
}

/** Settings of a directory (AD or SSO) plus the project groups of active projects: projectGroups [{ id, key, group }] */
export function withProjectGroups(db, cfg) {
  const projectGroups = db.prepare("SELECT id, key, agent_group FROM projects WHERE agent_group<>'' AND archived=0 ORDER BY id").all()
    .map((p) => ({ id: p.id, key: p.key, group: p.agent_group }));
  return { ...cfg, projectGroups };
}

/**
 * Project rights from group membership (groups.projects: ids of the projects whose group the person
 * is in): { projects } – only when project groups are configured, otherwise none.
 */
export function projectAccessFromGroups(groups, cfg) {
  const projects = (cfg.projectGroups || []).length ? [...new Set((groups.projects || []).map(Number))] : [];
  return { projects };
}

/**
 * Derive the role from group membership: admin group → admin, everyone else → user (who works on
 * which project comes from the projects). No admin group configured → null (role stays).
 */
export function roleFromGroups(groups, cfg) {
  if (!cfg.adminGroup) return null;
  return groups.admin ? 'admin' : 'user';
}
