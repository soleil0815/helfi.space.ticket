// Self-registration (local accounts with role "user") and "forgot password".
//
// Both work with one-time links sent by mail. Only the SHA-256 of a token is stored. A pending
// registration has no user row: the account is created (or an existing email contact is turned
// into it) only after the link was opened – this proves the address, so the tickets of the
// contact may move over. Answers never reveal whether an address is known.
import crypto from 'node:crypto';
import { HttpError, str } from '../lib/http.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { normalizeEmail } from '../users.js';
import { withProjects } from './access.js';
import { t, normalizeLang } from '../i18n.js';
import { log } from '../lib/log.js';

export const REGISTER_TTL_MS = 24 * 3600 * 1000;
export const RESET_TTL_MS = 3600 * 1000;
export const RESET_MODES = ['off', 'users', 'all'];
const MIN_PASSWORD = 10;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Allowed domains from the setting (one per line, also comma/space separated), lowercase. */
export function parseDomains(value) {
  return String(value || '').split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '').replace(/^\*\./, ''))
    .filter(Boolean);
}

/** Does the address belong to one of the domains (subdomains included)? No domains = all allowed. */
export function domainAllowed(email, domains) {
  if (!domains.length) return true;
  const host = String(email).split('@')[1] || '';
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Counter per key in a sliding window (in memory; resets on restart, which is fine for this). */
export function createRateLimit({ limit, windowMs }) {
  const hits = new Map();
  return {
    take(key, now = Date.now()) {
      const list = (hits.get(key) || []).filter((ts) => ts > now - windowMs);
      if (list.length >= limit) { hits.set(key, list); return false; }
      list.push(now);
      hits.set(key, list);
      if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((ts) => ts > now - windowMs)) hits.delete(k);
      return true;
    },
  };
}

export function createSelfService({ db, settings, users, sessions, mailer, baseUrl }) {
  const perIp = createRateLimit({ limit: 20, windowMs: 3600 * 1000 });
  const perAddress = createRateLimit({ limit: 3, windowMs: 3600 * 1000 });
  const overall = createRateLimit({ limit: 200, windowMs: 3600 * 1000 });

  const appName = () => settings.get('general.title') || 'Helfi.Space';
  const loginUrl = () => `${baseUrl}/login`;

  function limit(ip, email) {
    // Count the address only if the IP is still allowed (otherwise one IP could block any address)
    if (!perIp.take(`ip|${ip}`) || !overall.take('all')) throw new HttpError(429, 'err.tooManyRequests');
    if (email && !perAddress.take(`mail|${email}`)) throw new HttpError(429, 'err.tooManyRequests');
  }

  function purgeExpired(now = Date.now()) {
    return db.prepare('DELETE FROM account_tokens WHERE expires_at < ?').run(now).changes;
  }

  function newToken(fields) {
    const token = randomToken(32);
    const now = Date.now();
    db.prepare(`INSERT INTO account_tokens(kind, token_hash, email, user_id, display_name, password_hash, language, created_at, expires_at)
      VALUES (@kind, @hash, @email, @userId, @displayName, @passwordHash, @language, @now, @expires)`).run({
      userId: null, displayName: null, passwordHash: null, language: null, ...fields, hash: sha256(token), now, expires: now + fields.ttl,
    });
    return token;
  }

  function findToken(kind, token, now = Date.now()) {
    const tk = str(token, 200).trim();
    if (!tk) return null;
    return db.prepare('SELECT * FROM account_tokens WHERE kind=? AND token_hash=? AND expires_at >= ?').get(kind, sha256(tk), now) || null;
  }

  /** Mail in the background: the answer must not wait for it (timing would reveal which mail was sent). */
  function sendLater(to, lang, key, vars) {
    Promise.resolve()
      .then(() => mailer.send({ to, subject: t(lang, `mail.${key}.subject`, vars), text: t(lang, `mail.${key}.body`, vars), customer: true }))
      .catch((e) => log.warn('Account mail failed', { kind: key, error: e.message }));
  }

  // ---------- Status for the sign-in page ----------
  function resetMode() {
    const m = settings.get('register.passwordReset');
    return RESET_MODES.includes(m) ? m : 'users';
  }
  const registrationOpen = () => !!settings.get('register.enabled') && mailer.enabled();

  /** Accounts that may reset their password themselves */
  // "users" = effective role user: no admins, no agents, no users who work on a project (they act as agents)
  const resetRoleSql = () => (resetMode() === 'all' ? '' : " AND role='user' AND id NOT IN (SELECT user_id FROM project_agents)");
  function resetAvailable() {
    if (resetMode() === 'off' || !mailer.enabled()) return false;
    if (settings.get('register.enabled')) return true;
    // Only show the link if there is anyone it could help (not for pure AD/SSO installations)
    return !!db.prepare(`SELECT 1 FROM users WHERE source='local' AND active=1 AND password_hash IS NOT NULL AND email<>''${resetRoleSql()} LIMIT 1`).get();
  }

  function status() {
    return { register: registrationOpen(), passwordReset: resetAvailable(), domains: settings.get('register.enabled') ? parseDomains(settings.get('register.domains')) : [] };
  }

  // ---------- Registration ----------
  function register(req) {
    if (!registrationOpen()) throw new HttpError(404, 'err.registrationClosed');
    const lang = normalizeLang(req.body.language, settings.get('general.defaultLanguage'));
    // Field that people do not see (bots fill it in): pretend success
    if (str(req.body.website, 200).trim()) { log.info('Registration ignored (bot field filled in)'); return { ok: true }; }
    const displayName = str(req.body.displayName, 120).trim();
    if (!displayName) throw new HttpError(400, 'err.badRequest', 'displayName');
    const email = normalizeEmail(str(req.body.email, 254));
    if (!email) throw new HttpError(400, 'err.invalidEmail');
    const password = str(req.body.password, 1024);
    if (password.length < MIN_PASSWORD) throw new HttpError(400, 'err.passwordWeak');
    if (!domainAllowed(email, parseDomains(settings.get('register.domains')))) throw new HttpError(400, 'err.registerDomain');
    limit(req.ip, email);
    purgeExpired();

    // Hash in every case: same effort whether the address is known or not
    const passwordHash = hashPassword(password);
    const vars = { name: displayName, app: appName(), login: loginUrl() };
    if (accountBlocking(email)) {
      // Do not reveal it on the page – the owner of the address learns it by mail
      sendLater(email, lang, 'registerExists', vars);
      return { ok: true };
    }
    db.prepare("DELETE FROM account_tokens WHERE kind='register' AND email=?").run(email);
    const token = newToken({ kind: 'register', email, displayName, passwordHash, language: lang, ttl: REGISTER_TTL_MS });
    sendLater(email, lang, 'register', { ...vars, link: `${baseUrl}/register/confirm#${token}`, hours: REGISTER_TTL_MS / 3600000 });
    log.info('Registration started, confirmation link sent');
    return { ok: true };
  }

  /**
   * An account (not just an email contact) already uses this address or this user name,
   * or an admin disabled the email contact of this address (it must not reactivate itself).
   */
  function accountBlocking(email) {
    const byMail = db.prepare("SELECT 1 FROM users WHERE lower(email)=? AND (source<>'email' OR active=0) LIMIT 1").get(email);
    const byName = db.prepare("SELECT 1 FROM users WHERE username=? AND NOT (source='email' AND lower(email)=?) LIMIT 1").get(email, email);
    return !!(byMail || byName);
  }

  function confirmRegistration(token) {
    const row = findToken('register', token);
    if (!row) throw new HttpError(400, 'err.linkInvalid');
    // Registration switched off or domain no longer allowed since the link was sent: the link no longer applies
    if (!registrationOpen() || !domainAllowed(row.email.toLowerCase(), parseDomains(settings.get('register.domains')))) {
      db.prepare('DELETE FROM account_tokens WHERE id=?').run(row.id);
      throw new HttpError(400, 'err.linkInvalid');
    }
    const approval = !!settings.get('register.approval');
    const user = db.transaction(() => {
      db.prepare('DELETE FROM account_tokens WHERE id=?').run(row.id);
      const email = row.email.toLowerCase();
      if (accountBlocking(email)) throw new HttpError(400, 'err.linkInvalid');
      const contacts = db.prepare("SELECT * FROM users WHERE lower(email)=? AND source='email' ORDER BY id").all(email);
      let id;
      if (contacts.length) {
        // Turn the email contact into the account: tickets, comments and participations stay with it
        id = contacts[0].id;
        db.prepare(`UPDATE users SET username=?, display_name=?, email=?, source='local', password_hash=?, language=?, role='user',
          active=?, approval_pending=?, self_registered=1 WHERE id=?`).run(email, row.display_name, email, row.password_hash, row.language, approval ? 0 : 1, approval ? 1 : 0, id);
        // Further contacts with the same address (older data) are merged into it
        for (const c of contacts.slice(1)) users.mergeContact(c.id, id);
      } else {
        id = db.prepare(`INSERT INTO users(username, display_name, email, role, source, password_hash, language, active, approval_pending, self_registered)
          VALUES (?, ?, ?, 'user', 'local', ?, ?, ?, ?, 1)`).run(email, row.display_name, email, row.password_hash, row.language, approval ? 0 : 1, approval ? 1 : 0).lastInsertRowid;
      }
      db.prepare("DELETE FROM account_tokens WHERE kind='register' AND email=?").run(email);
      return users.byId(id);
    })();
    log.info(`Self-registration confirmed: account "${user.username}" (${approval ? 'waiting for approval' : 'active'})`);
    if (approval) notifyAdmins(user);
    return { ok: true, pending: approval };
  }

  function notifyAdmins(user) {
    const admins = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1 AND email<>''").all();
    for (const a of admins) {
      const lang = normalizeLang(a.language, settings.get('general.defaultLanguage'));
      sendLater(a.email, lang, 'registerApproval', { name: user.display_name, email: user.email, app: appName(), link: `${baseUrl}/admin/users` });
    }
  }

  // ---------- Forgot password ----------
  function eligibleForReset(u) {
    if (!u || u.source !== 'local' || !u.active || !u.password_hash || !u.email) return false;
    // Effective role (a user with projects is an agent) – the same in requestReset and resetPassword
    return resetMode() === 'all' || withProjects(db, u).role === 'user';
  }

  function requestReset(req) {
    if (!resetAvailable()) throw new HttpError(404, 'err.notFound');
    const email = normalizeEmail(str(req.body.email, 254));
    if (!email) throw new HttpError(400, 'err.invalidEmail');
    limit(req.ip, email);
    purgeExpired();
    const u = db.prepare("SELECT * FROM users WHERE lower(email)=? AND source='local' ORDER BY id LIMIT 1").get(email);
    if (!eligibleForReset(u)) return { ok: true };
    db.prepare("DELETE FROM account_tokens WHERE kind='reset' AND user_id=?").run(u.id);
    const token = newToken({ kind: 'reset', email, userId: u.id, ttl: RESET_TTL_MS });
    const lang = normalizeLang(u.language, settings.get('general.defaultLanguage'));
    sendLater(email, lang, 'reset', { name: u.display_name, app: appName(), link: `${baseUrl}/reset#${token}`, minutes: RESET_TTL_MS / 60000, username: u.username });
    log.info(`Password reset requested for "${u.username}"`);
    return { ok: true };
  }

  function resetPassword(req) {
    const password = str(req.body.password, 1024);
    const row = findToken('reset', req.body.token);
    if (!row) throw new HttpError(400, 'err.linkInvalid');
    if (password.length < MIN_PASSWORD) throw new HttpError(400, 'err.passwordWeak');
    const u = users.byId(row.user_id);
    // Address changed or account disabled in the meantime: the link no longer applies
    if (!eligibleForReset(u) || String(u.email).toLowerCase() !== row.email.toLowerCase()) {
      db.prepare('DELETE FROM account_tokens WHERE id=?').run(row.id);
      throw new HttpError(400, 'err.linkInvalid');
    }
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), u.id);
      db.prepare("DELETE FROM account_tokens WHERE kind='reset' AND user_id=?").run(u.id);
    })();
    // Sign out everywhere: whoever knew the old password is out now
    sessions.destroyAllForUser(u.id);
    const lang = normalizeLang(u.language, settings.get('general.defaultLanguage'));
    sendLater(u.email, lang, 'passwordChanged', { name: u.display_name, app: appName(), login: loginUrl() });
    log.info(`Password reset completed for "${u.username}"`);
    return { ok: true };
  }

  /** An admin approved a self-registered account: tell the person they can sign in now */
  function notifyApproved(u) {
    if (!u?.email) return;
    const lang = normalizeLang(u.language, settings.get('general.defaultLanguage'));
    sendLater(u.email, lang, 'registerApproved', { name: u.display_name, app: appName(), login: loginUrl(), username: u.username });
  }

  return { status, register, confirmRegistration, requestReset, resetPassword, purgeExpired, eligibleForReset, notifyApproved };
}
