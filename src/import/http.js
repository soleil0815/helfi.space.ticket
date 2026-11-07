// Small HTTP client for importing from other ticket systems.
// Own implementation so that internal certificates (on-prem) and "do not verify" are possible and
// credentials are not sent along on redirects to other hosts (e.g. attachments on a media host).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { log } from '../lib/log.js';
import { normalizeBaseUrl } from '../lib/http.js';

export const MAX_BODY = 512 * 1024 * 1024; // attachments
export const MAX_JSON = 64 * 1024 * 1024; // API responses

/** Error from the source system; status 401/403 aborts the whole import. */
export class SourceError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * Addresses an import must never reach (SSRF protection): loopback, "this host", link-local
 * (cloud metadata services such as 169.254.169.254) and multicast. Ticket systems in the own network
 * (10.x, 172.16–31.x, 192.168.x, fd…) stay reachable. HELFI_IMPORT_ALLOW_LOCAL=1 lifts the block
 * (tests, or a source system on the same host via its loopback address).
 */
export function blockedAddress(ip) {
  const a = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return blockedV4(a);
  if (net.isIPv6(a)) {
    const w = ipv6Words(a);
    const zero = (from, to) => w.slice(from, to).every((x) => x === 0);
    // IPv4 embedded in IPv6 (any notation, e.g. ::ffff:7f00:1 = ::ffff:127.0.0.1): check the IPv4 address.
    // ::ffff:0:0/96 mapped, ::/96 compatible (also :: and ::1), ::ffff:0:0:0/96 translated, 64:ff9b::/96 NAT64
    const embedded = (zero(0, 5) && (w[5] === 0xffff || w[5] === 0))
      || (zero(0, 4) && w[4] === 0xffff && w[5] === 0)
      || (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6));
    if (embedded) return blockedV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
    return (w[0] & 0xffc0) === 0xfe80 || (w[0] >> 8) === 0xff; // link-local fe80::/10, multicast ff00::/8
  }
  return false;
}
function blockedV4(a) {
  const [x, y] = a.split('.').map(Number);
  return x === 127 || x === 0 || (x === 169 && y === 254) || x >= 224;
}
/** Valid IPv6 text → its eight 16-bit words */
function ipv6Words(addr) {
  let s = addr.replace(/%.*$/, ''); // zone id
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [p, q, r, t] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : (tail ? tail.split(':') : []);
  const words = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return words.map((x) => parseInt(x, 16) || 0);
}
const allowLocal = () => process.env.HELFI_IMPORT_ALLOW_LOCAL === '1';

/** Headers that may follow a redirect to another origin (everything else could carry credentials) */
const NEUTRAL_HEADERS = new Set(['accept', 'accept-language', 'content-type']);
const neutralHeaders = (h) => Object.fromEntries(Object.entries(h || {}).filter(([k]) => NEUTRAL_HEADERS.has(k.toLowerCase())));

/** Error text from typical JSON error bodies (several ticket systems) */
function errorText(text) {
  try {
    const j = JSON.parse(text);
    const parts = [...(j.errorMessages || []), ...Object.values(j.errors || {}), j.error_human, j.error, j.Error?.ErrorMessage]
      .filter((x) => typeof x === 'string' && x);
    return parts.join('; ') || text.slice(0, 300);
  } catch { return text.slice(0, 300); }
}

/**
 * @param {object} c
 * @param {string} c.baseUrl
 * @param {() => object} [c.headers] auth headers per request (may change, e.g. after a login)
 * @param {boolean} [c.verifyTls=true]
 * @param {string} [c.caPem]
 * @param {typeof SourceError} [c.ErrorClass]
 */
export function createSourceHttp({ baseUrl, headers: authHeaders = () => ({}), verifyTls = true, caPem = '', ErrorClass = SourceError }) {
  const base = new URL(normalizeBaseUrl(baseUrl) + '/');
  if (!/^https?:$/.test(base.protocol)) throw new ErrorClass('Nur http:// oder https:// Adressen sind erlaubt.', 400);
  const basePath = base.pathname.replace(/\/$/, ''); // context path, e.g. /jira or /otrs
  const tlsOpts = { rejectUnauthorized: verifyTls !== false, ...(caPem ? { ca: caPem } : {}) };
  const refused = (host, ip) => new ErrorClass(`Die Adresse ${host}${ip && ip !== host ? ` (${ip})` : ''} ist für den Import gesperrt (lokale oder Link-Local-Adresse).`, 400);
  // Checked at connect time on the resolved address – also after redirects and against DNS rebinding
  const guardedLookup = (hostname, options, callback) => dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    const bad = allowLocal() ? null : list.find((x) => blockedAddress(x.address));
    if (bad) return callback(refused(hostname, bad.address));
    return callback(null, address, family);
  });

  function raw(urlStr, { method = 'GET', body, headers = {}, withAuth = true, redirects = 5, timeoutMs = 60000, maxBytes = MAX_BODY } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      if (!/^https?:$/.test(url.protocol)) { reject(new ErrorClass('Nur http:// oder https:// Adressen sind erlaubt.', 400)); return; }
      // Literal IP addresses are not resolved (no lookup call) – check them here
      if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && blockedAddress(url.hostname) && !allowLocal()) { reject(refused(url.hostname)); return; }
      const mod = url.protocol === 'https:' ? https : http;
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = mod.request(url, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Helfi.Space-Import',
          ...(withAuth ? authHeaders() : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
        timeout: timeoutMs,
        lookup: guardedLookup,
        ...(url.protocol === 'https:' ? tlsOpts : {}),
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url);
          // Pass credentials only to the same host: to another origin neither the auth headers nor the
          // caller's own headers (e.g. a login with "Authorization"/"App-Token" and withAuth:false) go along
          const sameOrigin = next.origin === base.origin;
          const nextHeaders = sameOrigin ? headers : neutralHeaders(headers);
          return resolve(raw(next.href, { method: res.statusCode === 303 ? 'GET' : method, body: res.statusCode === 303 ? undefined : body, headers: nextHeaders, withAuth: withAuth && sameOrigin, redirects: redirects - 1, timeoutMs, maxBytes }));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (d) => {
          size += d.length;
          if (size > maxBytes) { req.destroy(new ErrorClass('Antwort zu groß', 413)); return; }
          chunks.push(d);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new ErrorClass(`Zeitüberschreitung bei ${url.host}`, 504)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** JSON request with retry on 429/503 (Retry-After) and brief network failures */
  async function json(path, opts = {}) {
    const url = path.startsWith('http') ? path : `${base.origin}${basePath}${path}`;
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await raw(url, { maxBytes: MAX_JSON, ...opts });
      } catch (e) {
        if (e instanceof ErrorClass && e.status === 400) throw e; // blocked address: no retry
        if (e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN' || e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          throw new ErrorClass(`Zertifikat von ${base.host} wird nicht vertraut (${e.code}). Eigene CA eintragen oder Prüfung abschalten.`, 495);
        }
        // Brief network failure: retry a few times instead of aborting the whole import
        if (attempt < 3 && !(e instanceof ErrorClass && e.status === 413)) { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); continue; }
        throw new ErrorClass(`${base.host} nicht erreichbar: ${e.message}`, 502);
      }
      if ([502, 504].includes(r.status) && attempt < 3) { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); continue; }
      if ((r.status === 429 || r.status === 503) && attempt < 6) {
        const wait = Math.min(60, Number(r.headers['retry-after']) || 2 ** attempt) * 1000;
        log.info(`Source system is throttling (HTTP ${r.status}), waiting ${wait / 1000}s`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      const text = r.body.toString('utf8');
      if (r.status === 401) throw new ErrorClass('Anmeldung beim Quellsystem fehlgeschlagen (Benutzer/Token prüfen).', 401);
      if (r.status === 403) throw new ErrorClass('Keine Berechtigung im Quellsystem für diese Abfrage.', 403);
      if (r.status >= 400) throw new ErrorClass(`Quellsystem antwortet mit HTTP ${r.status}: ${errorText(text)}`, r.status);
      try { return text ? JSON.parse(text) : null; }
      catch { throw new ErrorClass(`Unerwartete Antwort von ${base.host} (kein JSON) – ist die Adresse richtig?`, 502); }
    }
  }

  /** Download a file (follows redirects to other hosts without credentials) */
  async function download(contentUrl, maxBytes) {
    const url = new URL(contentUrl, base);
    const r = await raw(url.href, { headers: { Accept: '*/*' }, withAuth: url.origin === base.origin, maxBytes, timeoutMs: 300000 });
    if (r.status >= 400) throw new ErrorClass(`Anhang nicht ladbar (HTTP ${r.status})`, r.status);
    return r.body;
  }

  return { base, basePath, raw, json, download };
}
