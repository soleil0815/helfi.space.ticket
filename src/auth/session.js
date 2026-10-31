// Sitzungen (Cookie + Tabelle), Rollenprüfung, Schutz gegen Fehlversuche.
import { randomToken } from '../lib/crypto.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { normalizeUsername } from './ldap.js';

export const COOKIE = 'helfi_sid';

export function createSessions(db) {
  const insert = db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at,ip,auth_method) VALUES(?,?,?,?,?,?)');
  const find = db.prepare(`SELECT s.id sid, s.expires_at, s.auth_method, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`);
  const del = db.prepare('DELETE FROM sessions WHERE id=?');
  const touch = db.prepare('UPDATE sessions SET expires_at=? WHERE id=?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

  const ttl = () => config.sessionHours * 3600 * 1000;

  function cookieOpts() {
    return { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: ttl() };
  }

  return {
    create(res, userId, ip, method) {
      const id = randomToken(32);
      const now = Date.now();
      insert.run(id, userId, now + ttl(), now, ip || null, method);
      db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), userId);
      res.cookie(COOKIE, id, cookieOpts());
      return id;
    },
    destroy(req, res) {
      const id = req.cookies?.[COOKIE];
      if (id) del.run(id);
      res.clearCookie(COOKIE, { path: '/' });
    },
    /** Middleware: setzt req.user, verlängert die Sitzung gleitend. */
    middleware(req, res, next) {
      const id = req.cookies?.[COOKIE];
      if (id) {
        const row = find.get(id);
        if (row && row.expires_at > Date.now() && row.active) {
          req.user = row;
          req.sessionId = id;
          // gleitend verlängern, höchstens einmal pro Minute schreiben
          if (row.expires_at - Date.now() < ttl() - 60000) {
            touch.run(Date.now() + ttl(), id);
            res.cookie(COOKIE, id, cookieOpts());
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

/** Minimaler Cookie-Parser (spart eine Abhängigkeit). */
export function parseCookies(req, _res, next) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignorieren */ }
  }
  req.cookies = out;
  next();
}

const ROLE_RANK = { user: 1, agent: 2, admin: 3 };

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'err.unauthorized'));
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
 * Schutz gegen Raten von Kennwörtern (15-Minuten-Fenster):
 * - je Benutzername (normalisiert: "FIRMA\\x", "x@firma.local" und "x" zählen zusammen) max. 8 Fehlversuche,
 * - je IP-Adresse max. 40 Fehlversuche (gegen das Durchprobieren vieler Namen).
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
