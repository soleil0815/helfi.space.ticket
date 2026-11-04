// Sessions (cookie + table), role checks, protection against failed attempts.
import { randomToken } from '../lib/crypto.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { normalizeUsername } from './ldap.js';

export const COOKIE = 'helfi_sid';
// Maximum session lifetime from sign-in – after that sign in again, even with constant use
export const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function createSessions(db, { policy } = {}) {
  const insert = db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at,ip,auth_method,mfa) VALUES(?,?,?,?,?,?,?)');
  const find = db.prepare(`SELECT s.id sid, s.expires_at, s.created_at session_created, s.auth_method, s.mfa session_mfa, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`);
  const del = db.prepare('DELETE FROM sessions WHERE id=?');
  const touch = db.prepare('UPDATE sessions SET expires_at=? WHERE id=?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

  const ttl = () => config.sessionHours * 3600 * 1000;

  function cookieOpts() {
    return { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: ttl() };
  }

  return {
    create(res, userId, ip, method, { mfa = false } = {}) {
      const id = randomToken(32);
      const now = Date.now();
      insert.run(id, userId, now + ttl(), now, ip || null, method, mfa ? 1 : 0);
      db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), userId);
      res.cookie(COOKIE, id, cookieOpts());
      return id;
    },
    destroy(req, res) {
      const id = req.cookies?.[COOKIE];
      if (id) del.run(id);
      res.clearCookie(COOKIE, { path: '/' });
    },
    /** Middleware: sets req.user, extends the session (sliding). */
    middleware(req, res, next) {
      const id = req.cookies?.[COOKIE];
      if (id) {
        let row = find.get(id);
        // Older than the maximum lifetime: invalid (deleted below)
        if (row && !(Date.now() - Number(row.session_created) < SESSION_MAX_AGE_MS)) row = { ...row, expires_at: 0 };
        if (row && row.expires_at > Date.now() && row.active && !row.session_mfa && policy?.mfaRequired(req, row)) {
          // Session without second factor (e.g. signed in at the office), but now from outside → sign in again
          req.mfaBlocked = true;
        } else if (row && row.expires_at > Date.now() && row.active) {
          req.user = row;
          req.sessionId = id;
          // sliding extension, write at most once per minute
          // (but never beyond the maximum lifetime from sign-in)
          const until = Math.min(Date.now() + ttl(), Number(row.session_created) + SESSION_MAX_AGE_MS);
          if (until - row.expires_at > 60000) {
            touch.run(until, id);
            res.cookie(COOKIE, id, { ...cookieOpts(), maxAge: until - Date.now() });
          }
        } else if (row) {
          del.run(id);
        }
      }
      next();
    },
    purgeExpired() { purge.run(Date.now()); },
    destroyAllForUser(userId) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); },
  };
}

/** Minimal cookie parser (saves a dependency). */
export function parseCookies(req, _res, next) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  req.cookies = out;
  next();
}

const ROLE_RANK = { user: 1, agent: 2, admin: 3 };

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, req.mfaBlocked ? 'err.mfaRequired' : 'err.unauthorized'));
  next();
}

export function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'err.unauthorized'));
    if ((ROLE_RANK[req.user.role] || 0) < ROLE_RANK[role]) return next(new HttpError(403, 'err.forbidden'));
    next();
  };
}

export const isAgent = (user) => user && (user.role === 'agent' || user.role === 'admin');

/**
 * Protection against password guessing (15-minute window):
 * - per username (normalized: "FIRMA\\x", "x@firma.local" and "x" count together) max. 8 failed attempts,
 * - per IP address max. 40 failed attempts (against trying many names).
 */
export function createLoginLimiter({ max = 8, ipMax = 40, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  const nameKey = (user) => `u|${normalizeUsername(user).toLowerCase()}`;
  const ipKey = (ip) => `i|${ip}`;
  const over = (k, limit) => { const e = hits.get(k); return e && e.until > Date.now() && e.count >= limit; };
  const bump = (k) => {
    const e = hits.get(k);
    if (!e || e.until < Date.now()) hits.set(k, { count: 1, until: Date.now() + windowMs });
    else e.count++;
  };
  return {
    check(ip, user) {
      if (over(nameKey(user), max) || over(ipKey(ip), ipMax)) throw new HttpError(429, 'err.tooManyAttempts');
    },
    fail(ip, user) {
      bump(nameKey(user));
      bump(ipKey(ip));
      if (hits.size > 10000) for (const [k, v] of hits) if (v.until < Date.now()) hits.delete(k);
    },
    success(_ip, user) { hits.delete(nameKey(user)); },
  };
}
