// Single Sign-on per OpenID Connect (Authorization Code + PKCE).
// Funktioniert mit Microsoft Entra ID, ADFS (Windows Server), Keycloak, Authentik u. a.
import * as oidc from 'openid-client';
import { config } from '../config.js';
import { normalizeUsername } from './ldap.js';

let cache = { key: '', conf: null, at: 0 };

export const redirectUri = () => `${config.baseUrl}/auth/oidc/callback`;

async function getConfiguration(cfg) {
  const key = `${cfg.issuer}|${cfg.clientId}|${cfg.clientSecret ? 'x' : ''}`;
  if (cache.conf && cache.key === key && Date.now() - cache.at < 3600_000) return cache.conf;
  const issuer = new URL(cfg.issuer);
  const conf = await oidc.discovery(
    issuer,
    cfg.clientId,
    cfg.clientSecret || undefined,
    cfg.clientSecret ? undefined : oidc.None(),
    // http:// nur zulassen, wenn ausdrücklich so eingetragen (z. B. Keycloak im LAN ohne TLS)
    issuer.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
  cache = { key, conf, at: Date.now() };
  return conf;
}

export function resetOidcCache() { cache = { key: '', conf: null, at: 0 }; }

/** Startet die Anmeldung: liefert die URL zum Identitätsanbieter und den zu merkenden Zustand. */
export async function beginLogin(cfg) {
  const conf = await getConfiguration(cfg);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(conf, {
    redirect_uri: redirectUri(),
    scope: cfg.scopes || 'openid profile email',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, pending: { verifier, state, nonce, at: Date.now() } };
}

/** Schließt die Anmeldung ab und liefert die Benutzerdaten aus dem ID-Token. */
export async function finishLogin(cfg, currentUrl, pending) {
  const conf = await getConfiguration(cfg);
  const tokens = await oidc.authorizationCodeGrant(conf, currentUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
  });
  let claims = tokens.claims() || {};
  // Manche Anbieter liefern E-Mail/Gruppen nur über den UserInfo-Endpunkt
  if ((!claims.email || !claims[cfg.groupsClaim]) && tokens.access_token) {
    try {
      const info = await oidc.fetchUserInfo(conf, tokens.access_token, claims.sub);
      claims = { ...info, ...claims };
    } catch { /* optional */ }
  }
  return claimsToUser(claims, cfg);
}

export function claimsToUser(claims, cfg) {
  // Aus welchem Claim stammt der Name? (E-Mail-Adresse braucht eine Bestätigung, s. u.)
  const nameClaim = [cfg.usernameClaim, 'preferred_username', 'upn', 'email'].find((c) => c && claims[c]);
  const rawName = String(nameClaim ? claims[nameClaim] : claims.sub);
  // Nur eine vom Anbieter bestätigte Adresse ist vertrauenswürdig (manche Anbieter lassen die
  // E-Mail-Adresse im Profil frei eintragen)
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  let groups = claims[cfg.groupsClaim] || [];
  if (typeof groups === 'string') groups = groups.split(/[,;]/);
  const set = new Set(groups.map((g) => String(g).trim().toLowerCase()));
  const has = (value) => !!value && value.split(/[,;]/).map((v) => v.trim().toLowerCase()).some((v) => v && set.has(v));

  // Zusammenführen mit AD-Konten nur, wenn der Admin eine Domäne dafür freigegeben hat –
  // sonst könnte z. B. ein Gast "m.muster@fremd.example" das Konto "m.muster" übernehmen.
  const mergeDomain = String(cfg.mergeDomain || '').trim().toLowerCase().replace(/^@/, '');
  // Nicht vertrauenswürdige Namen bekommen immer den Namensraum "oidc:" – so kann ein SSO-Konto
  // nie einen Namen belegen, den später ein AD-Konto braucht (und umgekehrt). Namen ohne "@"
  // gelten nie als vertrauenswürdig (bei manchen Anbietern frei wählbar).
  let username = `oidc:${rawName}`;
  let trustName = false;
  if (mergeDomain) {
    const at = rawName.lastIndexOf('@');
    // Name aus dem E-Mail-Rückfall nur mit bestätigter Adresse übernehmen
    const fromEmail = nameClaim === 'email';
    if (at > 0 && rawName.slice(at + 1).toLowerCase() === mergeDomain && (!fromEmail || emailVerified)) {
      username = normalizeUsername(rawName); trustName = true;
    }
  }

  const email = String(claims.email || (trustName && rawName.includes('@') ? rawName : ''));
  return {
    username,
    displayName: claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || rawName,
    email,
    externalId: `${claims.iss || ''}|${claims.sub}`,
    groups: { admin: has(cfg.adminGroup), agent: has(cfg.agentGroup) },
    trustName,
    // Nur bestätigte Adressen dürfen gespeichert und mit E-Mail-Kontakten (und deren Tickets)
    // zusammengeführt werden – oder die Adresse ist gleich dem vertrauenswürdigen Anmeldenamen
    // der freigegebenen Domäne (z. B. Entra ID: UPN = Mail, ohne email_verified).
    trustEmail: emailVerified || (trustName && !!email && email.toLowerCase() === rawName.toLowerCase()),
  };
}
