// Routes for SSO (OpenID Connect).
import express from 'express';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { beginLogin, finishLogin } from '../auth/oidc.js';
import { roleFromGroups } from '../users.js';
import { log } from '../lib/log.js';

const PENDING_COOKIE = 'helfi_oidc';
// Limit pending sign-ins in memory: /auth/oidc/start is reachable without signing in
export const MAX_PENDING = 1000;
export const MAX_PENDING_PER_IP = 20;

/** Does this SSO sign-in count as a second factor? never | confirmed (provider reports MFA) | always */
export function ssoSecondFactor(settings, info) {
  const mode = settings.get('mfa.ssoSecondFactor');
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return !!info.mfa;
}

/**
 * Remember a pending sign-in: remove expired ones (10 min), at most perIp per address, at most max in total –
 * the oldest drop out. This way a flood from one address cannot push out other people's sign-ins.
 */
export function rememberPending(pending, id, p, { max = MAX_PENDING, perIp = MAX_PENDING_PER_IP, now = Date.now() } = {}) {
  for (const [k, v] of pending) if (now - v.at > 10 * 60 * 1000) pending.delete(k);
  if (p.ip) {
    const mine = [...pending].filter(([, v]) => v.ip === p.ip);
    for (let i = 0; i <= mine.length - perIp; i++) pending.delete(mine[i][0]);
  }
  while (pending.size >= max) pending.delete(pending.keys().next().value);
  pending.set(id, p);
}

/**
 * AD account for the AD identifier from the claim. If AD is connected (service account), AD is checked on EVERY
 * SSO sign-in – as with a password sign-in: disabled, no longer in the group or a changed role take effect
 * immediately. Without a service account the known AD account is used.
 * Result: { user } | { none: true } (not in AD) | { denied: 'notInGroup' | 'noAccount' }.
 * Throws if AD fails – then the sign-in is aborted instead of creating a separate account.
 */
export async function adAccountFor(ctx, adId, { allowCreate = true } = {}) {
  const { settings, users } = ctx;
  const known = users.byAdId(adId);
  const ldapCfg = settings.group('ldap');
  const directory = ctx.directory; // at runtime (replaceable in tests)
  if (!directory || !settings.get('ldap.enabled') || !ldapCfg.bindDn) return known ? { user: known } : { none: true };
  const info = adId.guid ? await directory.byGuid(ldapCfg, adId.guid) : await directory.bySid(ldapCfg, adId.sid);
  if (!info) return known ? { denied: 'noAccount' } : { none: true }; // deleted or disabled
  const role = roleFromGroups(info.groups, ldapCfg);
  if (!info.groups.user && role !== 'admin' && role !== 'agent') return { denied: 'notInGroup' };
  const user = users.upsertExternal({ source: 'ldap', username: info.username, displayName: info.displayName, email: info.email, externalId: info.externalId, sid: info.sid, role, allowCreate: !!known || allowCreate });
  return user ? { user } : { denied: 'noAccount' };
}

export function createOidcRoutes(ctx) {
  const { settings, users, mfa } = ctx;
  const r = express.Router();
  const pending = new Map(); // id → { verifier, state, nonce, at } – in insertion order (oldest first)

  r.get('/start', async (req, res) => {
    if (!settings.get('oidc.enabled')) return res.redirect('/login?error=oidcDisabled');
    try {
      const { url, pending: p } = await beginLogin(settings.group('oidc'));
      const id = randomToken(24);
      rememberPending(pending, id, { ...p, ip: req.ip });
      res.cookie(PENDING_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/auth/oidc', maxAge: 10 * 60 * 1000 });
      res.redirect(url);
    } catch (e) {
      log.error('SSO start failed', { error: e.message });
      res.redirect('/login?error=oidcFailed');
    }
  });

  r.get('/callback', async (req, res) => {
    const id = req.cookies?.[PENDING_COOKIE];
    const p = id && pending.get(id);
    res.clearCookie(PENDING_COOKIE, { path: '/auth/oidc' });
    if (!p) return res.redirect('/login?error=oidcFailed');
    pending.delete(id);
    try {
      const cfg = settings.group('oidc');
      const currentUrl = new URL(req.originalUrl, config.baseUrl);
      const info = await finishLogin(cfg, currentUrl, p);
      // Merge via the stable AD identifier (if configured): sign in directly as the AD account –
      // even if a separate SSO account already exists (e.g. from before the setting)
      let u = null;
      if (info.adId) {
        let ad;
        try { ad = await adAccountFor(ctx, info.adId, { allowCreate: cfg.allowCreate }); }
        catch (e) {
          log.warn('SSO: AD not reachable for identifier – sign-in aborted', { error: e.message });
          return res.redirect('/login?error=ldapUnavailable');
        }
        if (ad.denied) {
          log.warn(`SSO sign-in rejected: AD account ${ad.denied === 'notInGroup' ? 'not in the "allowed users" group' : 'disabled, deleted or not permitted'}`);
          return res.redirect(`/login?error=${ad.denied === 'notInGroup' ? 'notInGroup' : 'oidcNoAccount'}`);
        }
        if (ad.user) u = ad.user;
      }
      if (!u) {
        const role = roleFromGroups(info.groups, cfg);
        u = users.upsertExternal({ source: 'oidc', ...info, role, allowCreate: cfg.allowCreate });
      }
      if (!u) return res.redirect('/login?error=oidcNoAccount');
      if (!u.active) return res.redirect('/login?error=accountDisabled');
      // MFA at the identity provider counts as a second factor depending on the setting – otherwise a code as with password
      let r;
      try { r = mfa.afterPrimary(req, res, u, 'oidc', { trustedSecondFactor: ssoSecondFactor(settings, info) }); }
      catch (e) { return res.redirect(`/login?error=${e.code === 'err.mfaEnrollInternal' ? 'mfaEnrollInternal' : 'oidcFailed'}`); }
      res.redirect(r.done ? '/' : `/login?mfa=${r.step}`);
    } catch (e) {
      log.error('SSO sign-in failed', { error: e.message });
      res.redirect('/login?error=oidcFailed');
    }
  });

  return r;
}
