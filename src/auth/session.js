// Sessions (cookie + table), role checks, protection against failed attempts.
import crypto from 'node:crypto';
import { randomToken } from '../lib/crypto.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { normalizeUsername } from './ldap.js';
import { withProjects as loadProjects } from './access.js';

export const COOKIE = 'helfi_sid';
// Maximum session lifetime from sign-in – after that sign in again, even with constant use
export const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

// Requests that only ask how long the session still runs – they must not count as activity
const STATUS_PATH = '/api/session/status';
// Write the last activity at most this often (the idle check is therefore accurate to a minute)
const TOUCH_EVERY_MS = 60 * 1000;

/** Minutes from a setting: 0/empty = not set; otherwise between 5 minutes and 30 days */
export function idleMinutes(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(43200, Math.max(5, n));
}

/**
 * Automatic sign-out after inactivity: one period for everyone (setting or HELFI_SESSION_HOURS),
 * optionally shorter for admins and for requests from outside the company network – the shortest
 * applicable one counts. Computed per request, so a session that moves from the office to the
 * outside gets the shorter period at once.
 */
export function idlePolicy(settings, policy) {
  const base = () => (idleMinutes(settings?.get('session.idleMinutes')) || Math.round(config.sessionHours * 60)) * 60000;
  return {
    base,
    forRequest(req, user) {
      let ms = base();
      const admin = idleMinutes(settings?.get('session.adminIdleMinutes'));
      if (admin && user?.role === 'admin') ms = Math.min(ms, admin * 60000);
      const ext = idleMinutes(settings?.get('session.externalIdleMinutes'));
      if (ext && policy && !policy.isInternal(req)) ms = Math.min(ms, ext * 60000);
      return ms;
    },
  };
}

/**
 * Key under which a session is stored: SHA-256 of the cookie value. The table (and every backup of
 * it) only holds this hash, so a copy of the database never lets anyone sign in as someone else.
 */
export function sessionKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createSessions(db, { policy, settings } = {}) {
  const insert = db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at,ip,auth_method,mfa,last_seen) VALUES(?,?,?,?,?,?,?,?)');
  const find = db.prepare(`SELECT s.id sid, s.expires_at, s.created_at session_created, s.auth_method, s.mfa session_mfa, s.last_seen session_seen, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`);
  const del = db.prepare('DELETE FROM sessions WHERE id=?');
  const touch = db.prepare('UPDATE sessions SET expires_at=?, last_seen=? WHERE id=?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

  const idle = idlePolicy(settings, policy);
  // Kept in the table until then (cleanup); the actual idle check uses last_seen per request
  const ttl = () => idle.base();
  // "Sign out when the browser closes": cookie without expiry (the browser drops it at the end)
  const browserSession = () => !!settings?.get('session.browserSession');

  function cookieOpts(maxAge = ttl()) {
    const o = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' };
    return browserSession() ? o : { ...o, maxAge };
  }

  /** Time left for this request's session (idle period and maximum lifetime) */
  function remaining(req, row, now = Date.now()) {
    const seen = Number(row.session_seen) || Number(row.session_created);
    const idleMs = idle.forRequest(req, row);
    const left = Math.min(seen + idleMs, Number(row.session_created) + SESSION_MAX_AGE_MS) - now;
    return { idleMs, remainingMs: Math.max(0, left) };
  }

  return {
    create(res, userId, ip, method, { mfa = false } = {}) {
      const token = randomToken(32);
      const now = Date.now();
      insert.run(sessionKey(token), userId, now + ttl(), now, ip || null, method, mfa ? 1 : 0, now);
      db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), userId);
      res.cookie(COOKIE, token, cookieOpts());
      return token;
    },
    /** For the client: idle period, time left, warn before (only for a signed-in request) */
    info(req) {
      if (!req.user) return null;
      return { ...remaining(req, req.user), warnMs: 2 * 60 * 1000, browserSession: browserSession() };
    },
    destroy(req, res) {
      const token = req.cookies?.[COOKIE];
      if (token) del.run(sessionKey(token));
      res.clearCookie(COOKIE, { path: '/' });
    },
    /** Middleware: sets req.user, extends the session (sliding). */
    middleware(req, res, next) {
      const token = req.cookies?.[COOKIE];
      if (token) {
        const id = sessionKey(token); // req.sessionId is this stored key, never the cookie value
        let row = find.get(id);
        // Older than the maximum lifetime or idle for too long: invalid (deleted below)
        if (row && !(Date.now() - Number(row.session_created) < SESSION_MAX_AGE_MS)) row = { ...row, expires_at: 0 };
        if (row && row.expires_at > 0 && remaining(req, row).remainingMs <= 0) row = { ...row, expires_at: 0 };
        if (row && row.expires_at > Date.now() && row.active && !row.session_mfa && policy?.mfaRequired(req, row)) {
          // Session without second factor (e.g. signed in at the office), but now from outside → sign in again
          req.mfaBlocked = true;
        } else if (row && row.expires_at > Date.now() && row.active) {
          req.user = loadProjects(db, row);
          req.sessionId = id;
          // Activity: remember it at most once per minute (never beyond the maximum lifetime).
          // Asking for the remaining time is not activity.
          const now = Date.now();
          const seen = Number(row.session_seen) || 0;
          if (!String(req.originalUrl || req.url || '').startsWith(STATUS_PATH) && now - seen > TOUCH_EVERY_MS) {
            const until = Math.min(now + ttl(), Number(row.session_created) + SESSION_MAX_AGE_MS);
            touch.run(until, now, id);
            row.session_seen = now;
            res.cookie(COOKIE, token, cookieOpts(until - now));
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

export { isAgent, agentProjects, agentOn, projectScopeSql, withProjects } from './access.js';

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
