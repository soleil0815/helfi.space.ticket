// Routen für SSO (OpenID Connect).
import express from 'express';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { beginLogin, finishLogin } from '../auth/oidc.js';
import { roleFromGroups } from '../users.js';
import { log } from '../lib/log.js';

const PENDING_COOKIE = 'helfi_oidc';

export function createOidcRoutes({ settings, users, sessions }) {
  const r = express.Router();
  const pending = new Map(); // id → { verifier, state, nonce, at }

  const cleanup = () => { for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k); };

  r.get('/start', async (req, res) => {
    if (!settings.get('oidc.enabled')) return res.redirect('/login?error=oidcDisabled');
    try {
      cleanup();
      const { url, pending: p } = await beginLogin(settings.group('oidc'));
      const id = randomToken(24);
      pending.set(id, p);
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
      const role = roleFromGroups(info.groups, cfg);
      const u = users.upsertExternal({ source: 'oidc', ...info, role, allowCreate: cfg.allowCreate });
      if (!u) return res.redirect('/login?error=oidcNoAccount');
      if (!u.active) return res.redirect('/login?error=accountDisabled');
      sessions.create(res, u.id, req.ip, 'oidc');
      res.redirect('/');
    } catch (e) {
      log.error('SSO-Anmeldung fehlgeschlagen', { error: e.message });
      res.redirect('/login?error=oidcFailed');
    }
  });

  return r;
}
