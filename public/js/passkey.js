// Passkeys in the browser (desktop and phone app): WebAuthn calls and conversion between the JSON from
// the server (base64url) and the binary form the browser API wants. No library needed.
import { api } from './api.js';
import { state } from './state.js';

const fromB64 = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};
const toB64 = (buf) => {
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Can this browser do passkeys at all? */
export const passkeySupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials?.get;

/**
 * Passkeys usable on this page? The browser only offers them under the address they belong to
 * (rpId from the bootstrap) – opened via another name or an IP address, the button would only fail.
 */
export function passkeysHere(rpId) {
  if (!rpId || !passkeySupported()) return false;
  const host = location.hostname;
  return host === rpId || host.endsWith(`.${rpId}`);
}

/** Suggesting passkeys in the user name field (iPhone, Android, current desktop browsers) */
export async function conditionalSupported() {
  try { return passkeySupported() && !!(await window.PublicKeyCredential.isConditionalMediationAvailable?.()); }
  catch { return false; }
}

function credentialJson(cred) {
  const r = cred.response;
  const out = {
    id: cred.id, rawId: toB64(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: { clientDataJSON: toB64(r.clientDataJSON) },
  };
  if (r.attestationObject) {
    out.response.attestationObject = toB64(r.attestationObject);
    out.response.transports = r.getTransports?.() || [];
  } else {
    out.response.authenticatorData = toB64(r.authenticatorData);
    out.response.signature = toB64(r.signature);
    out.response.userHandle = toB64(r.userHandle);
  }
  return out;
}

/**
 * Sign in with a passkey. conditional: wait for the person to pick a passkey in the user name field
 * (runs until chosen or aborted via signal). Result: { user }.
 */
export async function passkeySignIn({ conditional = false, signal } = {}) {
  const o = await api.passkeyOptions();
  const publicKey = { ...o, challenge: fromB64(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })) };
  const cred = await navigator.credentials.get({ publicKey, signal, ...(conditional ? { mediation: 'conditional' } : {}) });
  if (!cred) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
  return api.passkeyLogin(credentialJson(cred));
}

/** Add a passkey to the own account (Face ID/Touch ID/PIN prompt of the device). Result: { passkey }. */
export async function passkeyAdd(name) {
  const o = await api.passkeyRegOptions();
  const publicKey = {
    ...o,
    challenge: fromB64(o.challenge),
    user: { ...o.user, id: fromB64(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  if (!cred) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
  const r = await api.passkeyAdd(credentialJson(cred), name);
  if (state.boot?.mfa) state.boot.mfa.passkey = true; // no more "set up 2FA" banner
  return r;
}

/** The person closed the system dialog or it timed out – no error message needed */
export const passkeyCancelled = (ex) => ex?.name === 'NotAllowedError' || ex?.name === 'AbortError';

/** A sensible default name for a new passkey (the person can change it) */
export function defaultPasskeyName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Passkey';
}
