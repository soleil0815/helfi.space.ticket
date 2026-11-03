// Zwei-Faktor-Anmeldung per TOTP (RFC 6238) – funktioniert mit jeder Authenticator-App
// (Microsoft/Google Authenticator, Aegis, 2FAS, 1Password, Bitwarden …).
import crypto from 'node:crypto';
import QRCode from 'qrcode';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PERIOD = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Ungültiges Base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** Code für einen Zeitschritt */
export function totpAt(secret, step) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = hmac[hmac.length - 1] & 15;
  const num = (hmac.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS;
  return String(num).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / PERIOD);

/**
 * Prüft einen Code (±1 Zeitschritt Toleranz für abweichende Uhren).
 * Liefert den benutzten Zeitschritt oder null. Codes mit Schritt ≤ lastStep werden
 * abgelehnt (kein zweites Verwenden desselben Codes).
 */
export function verifyTotp(secret, code, { lastStep = 0, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue;
    const expected = totpAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

export function otpauthUri(secret, account, issuer = 'Helfi.Space') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

/** QR-Code als data:-URL (SVG) – die Oberfläche zeigt ihn als Bild an */
export async function qrDataUrl(text) {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ---------- Wiederherstellungscodes ----------
const normCode = (c) => String(c).toLowerCase().replace(/[^a-z0-9]/g, '');
// Früheres Format (bis 1.12): SHA-256 ohne Salz – wird weiter angenommen, neue Codes nur noch mit scrypt
const legacyHash = (c) => crypto.createHash('sha256').update(normCode(c)).digest('hex');
// scrypt mit eigenem Salz je Code. Kleineres N als bei Kennwörtern: bis zu 10 Codes werden je Versuch geprüft,
// die Codes selbst sind zufällig (~40 Bit) – offline durchprobieren bleibt trotzdem aussichtslos.
const RC = { N: 4096, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const RC_LEN = 8;

function hashCode(c) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normCode(c), salt, 32, RC);
  return `r1$${RC.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function matches(stored, code) {
  const s = String(stored || '');
  if (s.startsWith('r1$')) {
    const [, n, salt, hash] = s.split('$');
    const expected = Buffer.from(hash || '', 'base64');
    const N = Number(n);
    if (!expected.length || !Number.isInteger(N) || N < 1024 || N > 1 << 16) return false;
    const actual = crypto.scryptSync(normCode(code), Buffer.from(salt || '', 'base64'), expected.length, { ...RC, N });
    return crypto.timingSafeEqual(expected, actual);
  }
  if (/^[0-9a-f]{64}$/.test(s)) return crypto.timingSafeEqual(Buffer.from(s), Buffer.from(legacyHash(code)));
  return false;
}

export function generateRecoveryCodes(n = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (const b of crypto.randomBytes(8)) s += chars[b % chars.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return { codes, hashes: codes.map(hashCode) };
}

/** Prüft einen Wiederherstellungscode; liefert die verbleibenden Hashes oder null */
export function useRecoveryCode(hashes, code) {
  // Nur Eingaben in Code-Form prüfen (spart scrypt bei TOTP-Codes und Unsinn)
  if (normCode(code).length !== RC_LEN) return null;
  const list = Array.isArray(hashes) ? hashes : [];
  const idx = list.findIndex((x) => matches(x, code));
  if (idx < 0) return null;
  return [...list.slice(0, idx), ...list.slice(idx + 1)];
}
