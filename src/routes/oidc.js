// Routen für SSO (OpenID Connect).
import express from 'express';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { beginLogin, finishLogin } from '../auth/oidc.js';
import { roleFromGroups } from '../users.js';
import { log } from '../lib/log.js';

const PENDING_COOKIE = 'helfi_oidc';
// Offene Anmeldungen im Speicher begrenzen: /auth/oidc/start ist ohne Anmeldung erreichbar
export const MAX_PENDING = 1000;
export const MAX_PENDING_PER_IP = 20;

/** Gilt diese SSO-Anmeldung als zweiter Faktor? never | confirmed (Anbieter meldet MFA) | always */
export function ssoSecondFactor(settings, info) {
  const mode = settings.get('mfa.ssoSecondFactor');
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return !!info.mfa;
}

/**
 * Offene Anmeldung merken: abgelaufene (10 min) entfernen, je Adresse höchstens perIp, insgesamt höchstens max –
 * die ältesten fallen heraus. So kann eine Flut von einer Adresse die Anmeldungen anderer nicht verdrängen.
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
 * AD-Konto zur AD-Kennung aus dem Claim. Ist das AD angebunden (Dienstkonto), wird bei JEDER SSO-Anmeldung
 * im AD nachgesehen – wie bei einer Kennwort-Anmeldung: deaktiviert, nicht (mehr) in der Gruppe oder
 * geänderte Rolle wirken sofort. Ohne Dienstkonto gilt das bekannte AD-Konto.
 * Ergebnis: { user } | { none: true } (nicht im AD) | { denied: 'notInGroup' | 'noAccount' }.
 * Wirft bei einer Störung des AD – dann wird die Anmeldung abgebrochen statt ein getrenntes Konto anzulegen.
 */
export async function adAccountFor(ctx, adId, { allowCreate = true } = {}) {
  const { settings, users } = ctx;
  const known = users.byAdId(adId);
  const ldapCfg = settings.group('ldap');
  const directory = ctx.directory; // zur Laufzeit (in Tests austauschbar)
  if (!directory || !settings.get('ldap.enabled') || !ldapCfg.bindDn) return known ? { user: known } : { none: true };
  const info = adId.guid ? await directory.byGuid(ldapCfg, adId.guid) : await directory.bySid(ldapCfg, adId.sid);
  if (!info) return known ? { denied: 'noAccount' } : { none: true }; // gelöscht oder deaktiviert
  const role = roleFromGroups(info.groups, ldapCfg);
  if (!info.groups.user && role !== 'admin' && role !== 'agent') return { denied: 'notInGroup' };
  const user = users.upsertExternal({ source: 'ldap', username: info.username, displayName: info.displayName, email: info.email, externalId: info.externalId, sid: info.sid, role, allowCreate: !!known || allowCreate });
  return user ? { user } : { denied: 'noAccount' };
}

export function createOidcRoutes(ctx) {
  const { settings, users, mfa } = ctx;
  const r = express.Router();
  const pending = new Map(); // id → { verifier, state, nonce, at } – in Einfügereihenfolge (älteste zuerst)

  r.get('/start', async (req, res) => {
    if (!settings.get('oidc.enabled')) return res.redirect('/login?error=oidcDisabled');
    try {
      const { url, pending: p } = await beginLogin(settings.group('oidc'));
      const id = randomToken(24);
      rememberPending(pending, id, { ...p, ip: req.ip });
      res.cookie(PENDING_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/auth/oidc', maxAge: 10 * 60 * 1000 });
      res.redirect(url);
    } catch (e) {
      log.error('SSO-Start fehlgeschlagen', { error: e.message });
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
      // Zusammenführung über die stabile AD-Kennung (wenn eingestellt): Anmeldung direkt als AD-Konto –
      // auch wenn es schon ein getrenntes SSO-Konto gibt (z. B. von vor der Einstellung)
      let u = null;
      if (info.adId) {
        let ad;
        try { ad = await adAccountFor(ctx, info.adId, { allowCreate: cfg.allowCreate }); }
        catch (e) {
          log.warn('SSO: AD zur Kennung nicht erreichbar – Anmeldung abgebrochen', { error: e.message });
          return res.redirect('/login?error=ldapUnavailable');
        }
        if (ad.denied) {
          log.warn(`SSO-Anmeldung abgewiesen: AD-Konto ${ad.denied === 'notInGroup' ? 'nicht in der Gruppe „Zugelassene Benutzer“' : 'deaktiviert, gelöscht oder nicht freigegeben'}`);
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
      // MFA beim Identitätsanbieter gilt je nach Einstellung als zweiter Faktor – sonst Code wie bei Kennwort
      let r;
      try { r = mfa.afterPrimary(req, res, u, 'oidc', { trustedSecondFactor: ssoSecondFactor(settings, info) }); }
      catch (e) { return res.redirect(`/login?error=${e.code === 'err.mfaEnrollInternal' ? 'mfaEnrollInternal' : 'oidcFailed'}`); }
      res.redirect(r.done ? '/' : `/login?mfa=${r.step}`);
    } catch (e) {
      log.error('SSO-Anmeldung fehlgeschlagen', { error: e.message });
      res.redirect('/login?error=oidcFailed');
    }
  });

  return r;
}
