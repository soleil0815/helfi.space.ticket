// Software passkey for tests: creates registration and sign-in answers like a phone would
// (attestation "none", P-256/ES256). Only what Helfi.Space checks – no hardware needed.
import crypto from 'node:crypto';

// ---- minimal CBOR encoder (ints, byte strings, text, maps) ----
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
export function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error(`cbor: ${typeof v}`);
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');

/**
 * A passkey on a virtual device.
 * opts: { rpID, origin } – what the device "sees" (wrong values test the server's checks)
 */
export function softPasskey({ rpID = 'localhost', origin = 'http://localhost:8080' } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(32);
  let counter = 0;
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const flags = ({ uv = true, at = false } = {}) => 0x01 | (uv ? 0x04 : 0) | 0x08 | 0x10 | (at ? 0x40 : 0); // UP, UV, BE, BS, AT

  const me = {
    id: b64(credId),
    cose,
    /** Answer to navigator.credentials.create() for the options from the server */
    register(options, { uv = true, originOverride, rpOverride } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: originOverride || origin, crossOrigin: false }));
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter);
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha256(rpOverride || rpID), Buffer.from([flags({ uv, at: true })]), cnt, Buffer.alloc(16), len, credId, cose]);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64(credId), rawId: b64(credId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ['internal', 'hybrid'] },
      };
    },
    /** Answer to navigator.credentials.get() */
    signIn(options, { uv = true, originOverride, rpOverride, keepCounter = false } = {}) {
      if (!keepCounter) counter++;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: originOverride || origin, crossOrigin: false }));
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(rpOverride || rpID), Buffer.from([flags({ uv })]), cnt]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), privateKey);
      return {
        id: b64(credId), rawId: b64(credId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: b64(Buffer.from('x')) },
      };
    },
  };
  return me;
}
