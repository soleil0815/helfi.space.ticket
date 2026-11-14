// Passkeys (WebAuthn): sign in with Face ID, Touch ID, Windows Hello or the device PIN instead of a password.
// A passkey counts as both factors (device + biometrics/PIN, user verification is always required), so it
// replaces password AND the code from the authenticator app.
//
// - Bound to the host name of HELFI_BASE_URL (RP ID) – needs HTTPS (or localhost for development).
// - Local accounts and AD accounts. AD accounts only with a service account: without a password Helfi cannot
//   ask AD as the person, so on every passkey sign-in the service account checks that the account still
//   exists, is enabled and is in the right groups (role and project rights are updated as on a normal sign-in).
// - SSO accounts sign in at their provider; passkeys are not offered there.
// - The first passkey can only be added from where the first 2FA enrollment is allowed (internal network,
//   "allow enrollment from outside") or from a session that has already provided a second factor – otherwise
//   a stolen password would be enough to register one's own passkey from outside.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import net from 'node:net';
import { randomToken } from '../lib/crypto.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { log } from '../lib/log.js';
import { roleFromGroups, projectAccessFromGroups, withProjectGroups } from '../users.js';

export const PASSKEY_COOKIE = 'helfi_pk';
const CHALLENGE_TTL = 5 * 60 * 1000;
const MAX_PER_USER = 20;
const MAX_PENDING = 5000;
export const PROMPT_LATER_DAYS = 14;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** RP ID and origin from HELFI_BASE_URL; null if passkeys cannot work there (no HTTPS, IP address). */
export function relyingParty(baseUrl = config.baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return null; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return null; // WebAuthn does not allow IP addresses as RP ID
  const local = host === 'localhost' || host.endsWith('.localhost');
  if (u.protocol !== 'https:' && !local) return null;
  return { rpID: host, origin: u.origin };
}

export function createPasskeys(ctx) {
  const { db, settings, sessions, users, policy, limiter } = ctx;
  const regChallenges = new Map(); // userId → { challenge, at }
  const loginChallenges = new Map(); // id (cookie) → { challenge, at }

  // Full (e.g. a flood of requests): drop the oldest entries instead of all, so sign-ins in progress go on
  const keep = (m) => { while (m.size >= MAX_PENDING) m.delete(m.keys().next().value); };
  const cleanup = () => {
    const now = Date.now();
    for (const m of [regChallenges, loginChallenges]) for (const [k, v] of m) if (now - v.at > CHALLENGE_TTL) m.delete(k);
  };
  const cookieOpts = () => ({ httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/api/auth/passkey', maxAge: CHALLENGE_TTL });

  const rp = () => relyingParty(config.baseUrl);
  const enabled = () => !!settings.get('passkeys.enabled');
  const available = () => enabled() && !!rp();
  const adReady = () => !!(settings.get('ldap.enabled') && settings.get('ldap.bindDn'));

  /** Why this account cannot use passkeys (null = it can) */
  function blockedReason(u) {
    if (!enabled()) return 'off';
    if (!rp()) return 'noHttps';
    if (u.source === 'local') return null;
    if (u.source === 'ldap') return adReady() ? null : 'adNoServiceAccount';
    return 'sso';
  }

  const canAddHere = (req, u) => policy.isInternal(req) || !!settings.get('mfa.enrollExternal') || !!u.session_mfa;

  const rows = (userId) => db.prepare('SELECT * FROM user_passkeys WHERE user_id=? ORDER BY created_at').all(userId);
  const view = (p) => ({
    id: p.id, name: p.name, createdAt: p.created_at, lastUsedAt: p.last_used_at,
    synced: !!p.backed_up, // in iCloud Keychain / Google Password Manager (available on the person's other devices)
  });

  /** Look the AD account up again with the service account and update role/rights (as on a password sign-in). */
  async function refreshFromAd(u) {
    const cfg = withProjectGroups(db, settings.group('ldap'));
    let info;
    try {
      if (/^[0-9a-f]{32}$/i.test(String(u.external_id || ''))) info = await ctx.directory.byGuid(cfg, u.external_id);
      else if (u.ad_sid) info = await ctx.directory.bySid(cfg, u.ad_sid);
      else info = null;
    } catch (e) {
      log.error('Passkey sign-in: AD lookup failed', { error: e.message });
      throw new HttpError(503, 'err.ldapUnavailable');
    }
    if (!info) {
      log.warn(`Passkey sign-in rejected: AD account of ${u.username} no longer exists or is disabled`);
      throw new HttpError(401, 'err.passkeyInvalid');
    }
    const role = roleFromGroups(info.groups, cfg);
    if (!info.groups.user && role !== 'admin' && role !== 'agent' && !info.groups.projects?.length) {
      log.warn(`Passkey sign-in rejected: ${info.username} is not in the "allowed users" group`);
      throw new HttpError(403, 'err.notInGroup');
    }
    const fresh = users.upsertExternal({ source: 'ldap', username: info.username, displayName: info.displayName, email: info.email, externalId: info.externalId, sid: info.sid, role, access: projectAccessFromGroups(info.groups, cfg) });
    if (fresh.id !== u.id) {
      // Another account matched (should not happen) – never sign in as someone else
      log.warn(`Passkey sign-in rejected: AD lookup for ${u.username} returned another account`);
      throw new HttpError(401, 'err.passkeyInvalid');
    }
    return fresh;
  }

  return {
    available,

    /** For the profile: state and own passkeys */
    status(req, u) {
      const reason = blockedReason(u);
      const canAdd = !reason && canAddHere(req, u);
      const passkeys = rows(u.id).map(view);
      const until = db.prepare('SELECT passkey_prompt_until v FROM users WHERE id=?').get(u.id)?.v;
      return {
        available: !reason, reason, canAdd, passkeys,
        // Hint on the start page: only where adding works right away, for people without any passkey
        prompt: canAdd && !passkeys.length && !!settings.get('passkeys.prompt') && until !== -1 && !(until > Date.now()),
      };
    },

    /** Hint on the start page: "later" (14 days) or "never ask again" */
    snoozePrompt(u, action) {
      if (action !== 'later' && action !== 'never') throw new HttpError(400, 'err.badRequest', 'action');
      const v = action === 'never' ? -1 : Date.now() + PROMPT_LATER_DAYS * 24 * 3600 * 1000;
      db.prepare('UPDATE users SET passkey_prompt_until=? WHERE id=?').run(v, u.id);
    },

    async registrationOptions(req, u) {
      cleanup();
      const reason = blockedReason(u);
      if (reason) throw new HttpError(400, `err.passkey.${reason}`);
      if (!canAddHere(req, u)) throw new HttpError(403, 'err.passkeyAddInternal');
      const existing = rows(u.id);
      if (existing.length >= MAX_PER_USER) throw new HttpError(400, 'err.passkeyLimit');
      const { rpID } = rp();
      const options = await generateRegistrationOptions({
        rpName: String(settings.get('general.title') || 'Helfi.Space').slice(0, 64),
        rpID,
        userName: u.username,
        userDisplayName: u.display_name || u.username,
        // Stable, opaque handle per account (no name, no number – the device stores it)
        userID: new TextEncoder().encode(`helfi-${u.id}`),
        attestationType: 'none',
        excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: JSON.parse(p.transports || '[]') })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        preferredAuthenticatorType: 'localDevice',
      });
      regChallenges.delete(u.id);
      keep(regChallenges);
      regChallenges.set(u.id, { challenge: options.challenge, at: Date.now() });
      return options;
    },

    async register(req, u, response, rawName) {
      cleanup();
      const pending = regChallenges.get(u.id);
      regChallenges.delete(u.id);
      if (!pending) throw new HttpError(400, 'err.passkeyExpired');
      const reason = blockedReason(u);
      if (reason) throw new HttpError(400, `err.passkey.${reason}`);
      if (!canAddHere(req, u)) throw new HttpError(403, 'err.passkeyAddInternal');
      const { rpID, origin } = rp();
      let v;
      try {
        v = await verifyRegistrationResponse({ response, expectedChallenge: pending.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      } catch (e) {
        log.warn(`Passkey registration of ${u.username} failed: ${e.message}`);
        throw new HttpError(400, 'err.passkeyFailed');
      }
      if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'err.passkeyFailed');
      const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
      if (db.prepare('SELECT 1 FROM user_passkeys WHERE credential_id=?').get(credential.id)) throw new HttpError(409, 'err.passkeyExists');
      if (rows(u.id).length >= MAX_PER_USER) throw new HttpError(400, 'err.passkeyLimit');
      const name = String(rawName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'Passkey';
      const now = Date.now();
      const info = db.prepare(`INSERT INTO user_passkeys(user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(u.id, credential.id, Buffer.from(credential.publicKey), credential.counter || 0,
        JSON.stringify((credential.transports || []).slice(0, 8)), credentialDeviceType || '', credentialBackedUp ? 1 : 0, name, now);
      log.info(`Passkey "${name}" added by ${u.username}`);
      return view(db.prepare('SELECT * FROM user_passkeys WHERE id=?').get(info.lastInsertRowid));
    },

    rename(u, id, rawName) {
      const name = String(rawName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
      if (!name) throw new HttpError(400, 'err.badRequest', 'name');
      const r = db.prepare('UPDATE user_passkeys SET name=? WHERE id=? AND user_id=?').run(name, id, u.id);
      if (!r.changes) throw new HttpError(404, 'err.notFound');
    },

    remove(u, id) {
      const r = db.prepare('DELETE FROM user_passkeys WHERE id=? AND user_id=?').run(id, u.id);
      if (!r.changes) throw new HttpError(404, 'err.notFound');
      log.info(`Passkey #${id} removed by ${u.username}`);
    },

    /** Administration: remove all passkeys of a person (lost phone, leaving) */
    adminRemoveAll(userId) {
      return db.prepare('DELETE FROM user_passkeys WHERE user_id=?').run(userId).changes;
    },
    count: (userId) => db.prepare('SELECT COUNT(*) n FROM user_passkeys WHERE user_id=?').get(userId).n,

    // ---------- Sign-in ----------
    async loginOptions(req, res) {
      cleanup();
      if (!available()) throw new HttpError(404, 'err.passkey.off');
      const { rpID } = rp();
      // No allowCredentials: the device offers the passkeys it has for this site (no name needed)
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
      keep(loginChallenges);
      const id = randomToken(24);
      loginChallenges.set(id, { challenge: options.challenge, at: Date.now() });
      res.cookie(PASSKEY_COOKIE, id, cookieOpts());
      return options;
    },

    async login(req, res, response) {
      cleanup();
      if (!available()) throw new HttpError(404, 'err.passkey.off');
      const id = req.cookies?.[PASSKEY_COOKIE];
      const pending = id && loginChallenges.get(id);
      // One-time challenge: used up by every attempt
      if (id) loginChallenges.delete(id);
      res.clearCookie(PASSKEY_COOKIE, { path: '/api/auth/passkey' });
      if (!pending) throw new HttpError(401, 'err.passkeyExpired');
      const credId = typeof response?.id === 'string' ? response.id.slice(0, 1024) : '';
      const key = `passkey~${credId.slice(0, 64)}`;
      limiter.check(req.ip, key);
      const row = credId && db.prepare('SELECT * FROM user_passkeys WHERE credential_id=?').get(credId);
      if (!row) { limiter.fail(req.ip, key); throw new HttpError(401, 'err.passkeyInvalid'); }
      const { rpID, origin } = rp();
      let v;
      try {
        v = await verifyAuthenticationResponse({
          response, expectedChallenge: pending.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
          credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports || '[]') },
        });
      } catch (e) {
        log.warn(`Passkey sign-in failed (passkey #${row.id}): ${e.message}`);
        limiter.fail(req.ip, key);
        throw new HttpError(401, 'err.passkeyInvalid');
      }
      if (!v.verified) { limiter.fail(req.ip, key); throw new HttpError(401, 'err.passkeyInvalid'); }

      let u = users.rawById(row.user_id);
      if (!u) throw new HttpError(401, 'err.passkeyInvalid');
      const reason = blockedReason(u);
      if (reason) throw new HttpError(403, `err.passkey.${reason}`);
      if (u.source === 'ldap') u = await refreshFromAd(u);
      if (!u.active) { limiter.fail(req.ip, key); throw new HttpError(401, 'err.passkeyInvalid'); }

      db.prepare('UPDATE user_passkeys SET counter=?, last_used_at=?, backed_up=? WHERE id=?')
        .run(v.authenticationInfo.newCounter || 0, Date.now(), v.authenticationInfo.credentialBackedUp ? 1 : 0, row.id);
      limiter.success(req.ip, key);
      // Device + Face ID/Touch ID/PIN = two factors: the session counts as signed in with 2FA
      sessions.create(res, u.id, req.ip, 'passkey', { mfa: true });
      log.info(`Signed in with passkey: ${u.username} ("${row.name}")`);
      return users.byId(u.id);
    },
  };
}
