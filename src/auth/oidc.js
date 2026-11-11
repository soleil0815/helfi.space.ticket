// Single sign-on via OpenID Connect (Authorization Code + PKCE).
// Works with Microsoft Entra ID, ADFS (Windows Server), Keycloak, Authentik and others.
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
    // allow http:// only if explicitly configured that way (e.g. Keycloak in the LAN without TLS)
    issuer.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
  cache = { key, conf, at: Date.now() };
  return conf;
}

export function resetOidcCache() { cache = { key: '', conf: null, at: 0 }; }

/** Starts the sign-in: returns the URL to the identity provider and the state to remember. */
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

/** Completes the sign-in and returns the user data from the ID token. */
export async function finishLogin(cfg, currentUrl, pending) {
  const conf = await getConfiguration(cfg);
  const tokens = await oidc.authorizationCodeGrant(conf, currentUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
  });
  let claims = tokens.claims() || {};
  // Some providers return email/groups only via the UserInfo endpoint
  if ((!claims.email || !claims[cfg.groupsClaim]) && tokens.access_token) {
    try {
      const info = await oidc.fetchUserInfo(conf, tokens.access_token, claims.sub);
      claims = { ...info, ...claims };
    } catch { /* optional */ }
  }
  return claimsToUser(claims, cfg);
}

// amr values (RFC 8176) that prove a sign-in with multiple factors or a strong factor
const MFA_AMR = new Set(['mfa', 'mca', 'otp', 'hwk', 'sc', 'fido', 'face', 'fpt', 'iris', 'retina', 'vbm']);

/** Did the identity provider confirm MFA? (amr, or acr from the configured list) */
export function mfaConfirmed(claims, cfg = {}) {
  const amr = Array.isArray(claims.amr) ? claims.amr : (claims.amr ? [claims.amr] : []);
  if (amr.some((v) => MFA_AMR.has(String(v).toLowerCase()))) return true;
  const acrs = String(cfg.mfaAcr || '').split(/[,;\s]+/).map((v) => v.trim()).filter(Boolean);
  return !!claims.acr && acrs.includes(String(claims.acr));
}

/**
 * AD identifier from a claim → { sid } or { guid } (objectGUID as hex in byte order, as with AD sign-in).
 * Recognized: SID "S-1-5-21-…", GUID with hyphens (text form, e.g. Keycloak), 32 hex characters (bytes),
 * Base64 of the 16 bytes (e.g. onPremisesImmutableId in Entra ID). Otherwise null.
 */
export function parseAdId(value) {
  const v = String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();
  if (!v) return null;
  if (/^S-1-\d+(-\d+){1,15}$/i.test(v)) return { sid: v.toUpperCase() };
  const dashed = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i.exec(v);
  if (dashed) {
    // Text form: the first three groups are reversed in the bytes (little-endian)
    const rev = (x) => x.match(/../g).reverse().join('');
    return { guid: (rev(dashed[1]) + rev(dashed[2]) + rev(dashed[3]) + dashed[4] + dashed[5]).toLowerCase() };
  }
  if (/^[0-9a-f]{32}$/i.test(v)) return { guid: v.toLowerCase() };
  if (/^[A-Za-z0-9+/]{22}==$/.test(v)) {
    const b = Buffer.from(v, 'base64');
    if (b.length === 16) return { guid: b.toString('hex') };
  }
  return null;
}

export function claimsToUser(claims, cfg) {
  // Which claim does the name come from? (an email address needs verification, see below)
  const nameClaim = [cfg.usernameClaim, 'preferred_username', 'upn', 'email'].find((c) => c && claims[c]);
  const rawName = String(nameClaim ? claims[nameClaim] : claims.sub);
  // Only an address verified by the provider is trustworthy (some providers let users
  // enter any email address in their profile)
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  let groups = claims[cfg.groupsClaim] || [];
  if (typeof groups === 'string') groups = groups.split(/[,;]/);
  const set = new Set(groups.map((g) => String(g).trim().toLowerCase()));
  const has = (value) => !!value && value.split(/[,;]/).map((v) => v.trim().toLowerCase()).some((v) => v && set.has(v));

  // Merge with AD accounts only if the admin has allowed a domain for it –
  // otherwise e.g. a guest "m.muster@fremd.example" could take over the account "m.muster".
  const mergeDomain = String(cfg.mergeDomain || '').trim().toLowerCase().replace(/^@/, '');
  // With a configured claim for the AD identifier, merging happens ONLY via that claim (see routes/oidc.js),
  // never via the name – some providers let users choose it freely.
  const adIdClaim = String(cfg.adIdClaim || '').trim();
  const adId = adIdClaim ? parseAdId(claims[adIdClaim]) : null;
  // Untrusted names always get the namespace "oidc:" – so an SSO account can
  // never take a name that an AD account needs later (and vice versa). Names without "@"
  // are never trusted (freely choosable with some providers).
  let username = `oidc:${rawName}`;
  let trustName = false;
  if (mergeDomain && !adIdClaim) {
    const at = rawName.lastIndexOf('@');
    // Use the name from the email fallback only with a verified address
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
    groups: { admin: has(cfg.adminGroup), agent: has(cfg.agentGroup), projects: (cfg.projectGroups || []).filter((pg) => has(pg.group)).map((pg) => pg.id) },
    trustName,
    // Only verified addresses may be stored and merged with email contacts (and their tickets)
    // – or the address equals the trusted login name
    // of the allowed domain (e.g. Entra ID: UPN = mail, without email_verified).
    trustEmail: emailVerified || (trustName && !!email && email.toLowerCase() === rawName.toLowerCase()),
    adId,
    mfa: mfaConfirmed(claims, cfg),
  };
}
