// Two-factor sign-in flow:
// password (local/AD) or SSO correct → if required for this request, "half" sign-in
// (cookie helfi_mfa, 5 minutes) → code from the app or initial enrollment → full session.
import { randomToken, encrypt, decrypt } from '../lib/crypto.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { log } from '../lib/log.js';
import { generateSecret, verifyTotp, otpauthUri, qrDataUrl, generateRecoveryCodes, useRecoveryCode, currentStep } from './totp.js';

export const PENDING_COOKIE = 'helfi_mfa';
const PENDING_TTL = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function createMfa({ db, settings, sessions, users, policy, limiter }) {
  const pending = new Map(); // id → { userId, method, enroll, secret, attempts, at }
  const setups = new Map(); // userId → { secret, at } (enrollment in the profile)

  const cleanup = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > PENDING_TTL) pending.delete(k);
    for (const [k, v] of setups) if (now - v.at > 10 * 60 * 1000) setups.delete(k);
  };

  const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: PENDING_TTL });

  function secretOf(u) { return u.totp_secret ? decrypt(u.totp_secret) : null; }

  /** Verify and consume a code (TOTP or recovery code) for an enrolled account */
  function checkCode(u, code) {
    const secret = secretOf(u);
    if (!secret) return false;
    const step = verifyTotp(secret, code, { lastStep: u.totp_last_step });
    if (step !== null) {
      db.prepare('UPDATE users SET totp_last_step=? WHERE id=?').run(step, u.id);
      return 'totp';
    }
    let hashes = [];
    try { hashes = JSON.parse(u.recovery_codes || '[]'); } catch { /* empty */ }
    const rest = useRecoveryCode(hashes, code);
    if (rest) {
      db.prepare('UPDATE users SET recovery_codes=? WHERE id=?').run(JSON.stringify(rest), u.id);
      log.info(`Recovery code used by ${u.username} (${rest.length} left)`);
      return 'recovery';
    }
    return false;
  }

  function enable(userId, secret) {
    const { codes, hashes } = generateRecoveryCodes();
    db.prepare('UPDATE users SET totp_secret=?, totp_enabled=1, totp_last_step=?, recovery_codes=? WHERE id=?')
      .run(encrypt(secret), currentStep(), JSON.stringify(hashes), userId);
    log.info(`2FA enrolled for user #${userId}`);
    return codes;
  }

  /** May the account enroll 2FA (for the first time) from here? */
  // Initial enrollment only internally (or if explicitly allowed) – even in mode "never", otherwise someone
  // with a stolen password could register their own factor in advance that applies after switching
  const canEnrollHere = (req) => policy.isInternal(req) || settings.get('mfa.enrollExternal');
  // Separate counter for the second factor – NOT reset by a correct password
  // By user ID: the name would be normalized ("max@firma.local" = "max") and could collide with
  // another account
  const mfaKey = (u) => `mfa~#${u.id}`;

  return {
    /**
     * Call after correct password/SSO. Result:
     *  { done: true }                 → session created
     *  { step: 'code' | 'enroll' }    → second step required (cookie set)
     * Throws err.mfaEnrollInternal if 2FA is required but not enrolled and enrollment from here is not allowed.
     */
    afterPrimary(req, res, u, method, { trustedSecondFactor = false } = {}) {
      cleanup();
      const required = policy.mfaRequired(req, u);
      if (!required || trustedSecondFactor) {
        sessions.create(res, u.id, req.ip, method, { mfa: required || trustedSecondFactor });
        return { done: true };
      }
      if (!u.totp_enabled && !canEnrollHere(req)) throw new HttpError(403, 'err.mfaEnrollInternal');
      const id = randomToken(24);
      pending.set(id, { userId: u.id, method, enroll: !u.totp_enabled, secret: null, attempts: 0, at: Date.now() });
      res.cookie(PENDING_COOKIE, id, cookieOpts());
      return { step: u.totp_enabled ? 'code' : 'enroll' };
    },

    getPending(req) {
      cleanup();
      const id = req.cookies?.[PENDING_COOKIE];
      const p = id && pending.get(id);
      if (!p) throw new HttpError(401, 'err.mfaExpired');
      return { id, p };
    },

    /** Initial enrollment during sign-in: key + QR code */
    async enrollInfo(req) {
      const { p } = this.getPending(req);
      if (!p.enroll) throw new HttpError(400, 'err.badRequest');
      const u = users.byId(p.userId);
      if (!p.secret) p.secret = generateSecret();
      const uri = otpauthUri(p.secret, u.username, settings.get('general.title') || 'Helfi.Space');
      return { secret: p.secret, uri, qr: await qrDataUrl(uri) };
    },

    /** Complete the second step */
    verify(req, res, code) {
      const { id, p } = this.getPending(req);
      const u = users.byId(p.userId);
      if (!u || !u.active) { pending.delete(id); throw new HttpError(403, 'err.accountDisabled'); }
      limiter.check(req.ip, mfaKey(u));
      let recoveryCodes;
      let ok;
      if (p.enroll && u.totp_enabled) {
        // Enrolled in the meantime (other sign-in/profile): never overwrite this factor –
        // sign in again, then the enrolled code is requested
        pending.delete(id); res.clearCookie(PENDING_COOKIE, { path: '/' });
        throw new HttpError(401, 'err.mfaExpired');
      }
      if (p.enroll) {
        const step = p.secret ? verifyTotp(p.secret, code) : null;
        ok = step !== null;
        if (ok) recoveryCodes = enable(u.id, p.secret);
      } else {
        ok = checkCode(u, code);
      }
      if (!ok) {
        p.attempts++;
        limiter.fail(req.ip, mfaKey(u));
        if (p.attempts >= MAX_ATTEMPTS) { pending.delete(id); res.clearCookie(PENDING_COOKIE, { path: '/' }); throw new HttpError(401, 'err.mfaExpired'); }
        throw new HttpError(401, 'err.mfaInvalid');
      }
      pending.delete(id);
      res.clearCookie(PENDING_COOKIE, { path: '/' });
      limiter.success(req.ip, mfaKey(u));
      limiter.success(req.ip, u.username);
      sessions.create(res, u.id, req.ip, p.method, { mfa: true });
      return { user: users.byId(u.id), recoveryCodes, usedRecovery: ok === 'recovery' };
    },

    // ---------- Management in the profile ----------
    status(req, u) {
      let left = 0;
      try { left = JSON.parse(u.recovery_codes || '[]').length; } catch { /* empty */ }
      const net = policy.classify(req);
      return {
        enabled: !!u.totp_enabled, recoveryCodesLeft: left, mode: policy.userMode(u),
        network: { ip: net.ip, internal: net.internal, reason: net.reason },
        required: policy.mfaRequired(req, u),
        canSetup: canEnrollHere(req) || !!u.session_mfa,
        // SSO accounts: does the sign-in at the provider count as a second factor? (always | confirmed | never)
        sso: u.source === 'oidc' ? settings.get('mfa.ssoSecondFactor') : null,
      };
    },

    async startSetup(req, u) {
      // Never replace an enrolled factor without the old code: disable first (requires code)
      if (u.totp_enabled) throw new HttpError(409, 'err.mfaAlreadyEnabled');
      if (!canEnrollHere(req) && !u.session_mfa) throw new HttpError(403, 'err.mfaEnrollInternal');
      const secret = generateSecret();
      setups.set(u.id, { secret, at: Date.now() });
      const uri = otpauthUri(secret, u.username, settings.get('general.title') || 'Helfi.Space');
      return { secret, uri, qr: await qrDataUrl(uri) };
    },

    confirmSetup(req, u, code) {
      cleanup();
      const s = setups.get(u.id);
      if (!s) throw new HttpError(400, 'err.mfaExpired');
      if (users.byId(u.id).totp_enabled) throw new HttpError(409, 'err.mfaAlreadyEnabled');
      limiter.check(req.ip, mfaKey(u));
      if (verifyTotp(s.secret, code) === null) { limiter.fail(req.ip, mfaKey(u)); throw new HttpError(400, 'err.mfaInvalid'); }
      setups.delete(u.id);
      const codes = enable(u.id, s.secret);
      // This session has now provided the second factor; end all other sessions
      if (req.sessionId) {
        db.prepare('UPDATE sessions SET mfa=1 WHERE id=?').run(req.sessionId);
        db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(u.id, req.sessionId);
      }
      return codes;
    },

    disable(req, u, code) {
      limiter.check(req.ip, mfaKey(u));
      if (!checkCode(users.byId(u.id), code)) { limiter.fail(req.ip, mfaKey(u)); throw new HttpError(400, 'err.mfaInvalid'); }
      db.prepare('UPDATE users SET totp_secret=NULL, totp_enabled=0, recovery_codes=NULL WHERE id=?').run(u.id);
      // External sessions without 2FA are invalid afterwards – end all other sessions
      db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(u.id, req.sessionId || '');
      db.prepare('UPDATE sessions SET mfa=0 WHERE id=?').run(req.sessionId || '');
      log.info(`2FA disabled by ${u.username}`);
    },

    newRecoveryCodes(req, u, code) {
      limiter.check(req.ip, mfaKey(u));
      if (!checkCode(users.byId(u.id), code)) { limiter.fail(req.ip, mfaKey(u)); throw new HttpError(400, 'err.mfaInvalid'); }
      const { codes, hashes } = generateRecoveryCodes();
      db.prepare('UPDATE users SET recovery_codes=? WHERE id=?').run(JSON.stringify(hashes), u.id);
      return codes;
    },

    adminReset(userId) {
      db.prepare('UPDATE users SET totp_secret=NULL, totp_enabled=0, totp_last_step=0, recovery_codes=NULL WHERE id=?').run(userId);
      setups.delete(userId);
      for (const [k, v] of pending) if (v.userId === userId) pending.delete(k);
    },
  };
}
