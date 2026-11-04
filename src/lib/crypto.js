// Password hashes (scrypt) and encryption of stored secrets (AES-256-GCM).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths } from '../config.js';

let masterKey = null;

/** Loads the key from HELFI_SECRET or /data/secret.key (created on first start). */
export function initMasterKey() {
  const env = process.env.HELFI_SECRET;
  if (env) {
    // Do not silently ignore values that are too short (otherwise the key changes unnoticed)
    if (env.length < 16) throw new Error('HELFI_SECRET ist zu kurz (mindestens 16 Zeichen) – bitte ändern oder leer lassen.');
    masterKey = crypto.createHash('sha256').update(env).digest();
    return;
  }
  if (!fs.existsSync(paths.secretKey)) {
    fs.writeFileSync(paths.secretKey, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  masterKey = Buffer.from(fs.readFileSync(paths.secretKey, 'utf8').trim(), 'base64');
  if (masterKey.length !== 32) throw new Error(`Schlüsseldatei ${paths.secretKey} ist beschädigt.`);
}

export function setMasterKeyForTests(buf) { masterKey = buf; }

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decrypt(blob) {
  if (!blob) return '';
  if (!blob.startsWith('v1:')) throw new Error('Unbekanntes Geheimnis-Format');
  const raw = Buffer.from(blob.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, n, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
  return crypto.timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
