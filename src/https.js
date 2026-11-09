// HTTPS behind the reverse proxy – the same rules as in Catalytix and AssetLotse:
//
// * HELFI_FORCE_HTTPS=auto (default): as soon as the https:// address has been reached once over HTTPS through the
//   trusted proxy, requests the proxy forwards over plain HTTP are redirected to it (remembered in the data folder,
//   https-hosts.txt, so it holds after a restart). A proxy without HTTPS is never redirected into nothing.
//   "1": always, "0": never.
// * HSTS (one year, this host only – no includeSubDomains) only where Helfi.Space had to redirect itself: a proxy
//   that redirects on its own (Nginx Proxy Manager with "Force SSL") usually sends HSTS too – a second header would
//   override its setting (browsers use the first one) and is reported by checkers such as hstspreload.org.
//   HELFI_FORCE_HTTPS=1 always sends HSTS. HELFI_HSTS=off never sends it, HELFI_HSTS=preload always sends it with
//   includeSubDomains; preload.
// * The protocol comes from X-Forwarded-Proto, or else X-Forwarded-Port (80 = HTTP, 443 = HTTPS) – only from a
//   trusted proxy (HELFI_TRUST_PROXY). Direct requests (port 8080 on the LAN, /healthz) are never redirected,
//   addresses that are an IP or "localhost" neither. 301 for GET/HEAD, 308 otherwise (forms keep their data).
//   The target always comes from HELFI_BASE_URL, never from the Host header.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './lib/log.js';

export const HSTS = 'max-age=31536000';
const HSTS_PRELOAD = `${HSTS}; includeSubDomains; preload`;
const MAX_HOSTS = 50;
// a DNS name (not an IP address, not "localhost"): only then is https://<host>/ a sensible target
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** HELFI_FORCE_HTTPS → 'auto' | '1' | '0' (unknown values: 'auto'). */
export function parseForceHttps(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'ja'].includes(v)) return '1';
  if (['0', 'false', 'no', 'off', 'nein'].includes(v)) return '0';
  return 'auto';
}

/**
 * What Helfi.Space has seen through the reverse proxy, per host – file in the data folder (same format as in
 * Catalytix and AssetLotse): a line "<host>" = reached over HTTPS, "<host> redirected" = an HTTP request arrived
 * as well and had to be redirected (the proxy does not redirect itself, so it presumably sends no HSTS either).
 */
export function createHttpsHosts(file) {
  const hosts = new Set();
  const redirected = new Set();
  if (file) try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] && HOSTNAME.test(parts[0])) {
        hosts.add(parts[0]);
        if (parts.slice(1).includes('redirected')) redirected.add(parts[0]);
      }
    }
  } catch { /* not there yet */ }

  const save = (message, host) => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, [...hosts].sort().map((h) => h + (redirected.has(h) ? ' redirected' : '')).join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
      log.info(message.replace('%s', host));
    } catch (e) {
      log.warn(`Could not remember the HTTPS host: ${e.message}`);
    }
  };

  return {
    known: (host) => hosts.has(host),
    wasRedirected: (host) => redirected.has(host),
    learn(host) {
      if (hosts.has(host) || !HOSTNAME.test(host) || hosts.size >= MAX_HOSTS) return;
      hosts.add(host);
      save('HTTPS through the reverse proxy detected for %s – HTTP is now redirected to HTTPS', host);
    },
    markRedirected(host) {
      if (redirected.has(host) || !hosts.has(host)) return;
      redirected.add(host);
      save('The reverse proxy does not redirect %s to HTTPS itself – HSTS is now sent', host);
    },
  };
}

/** Protocol the visitor used according to a trusted proxy: 'http' | 'https', or null (direct / untrusted / unknown). */
export function proxyProtocol(app, req) {
  const trust = app.get('trust proxy fn');
  if (typeof trust !== 'function' || !trust(req.socket.remoteAddress, 0)) return null;
  const proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'http' || proto === 'https' ? proto : null;
  // some proxies only report the port (the protocol header wins)
  const port = String(req.get('x-forwarded-port') || '').split(',')[0].trim();
  return port === '80' ? 'http' : port === '443' ? 'https' : null;
}

/**
 * Middleware for redirect and HSTS, or null when HELFI_BASE_URL is not https:// (then there is no target) or names
 * an IP address / localhost (no certificate there).
 */
export function httpsMiddleware(app, { baseUrl, mode = 'auto', hsts = 'on', hosts = null }) {
  if (!String(baseUrl).startsWith('https://') || mode === '0') return null;
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  if (!HOSTNAME.test(host)) return null;
  const origin = url.origin;
  const basePath = url.pathname.replace(/\/+$/, '');
  const store = hosts || createHttpsHosts(null);
  const active = () => mode === '1' || store.known(host);

  return (req, res, next) => {
    if (req.path === '/healthz') return next();
    const proto = proxyProtocol(app, req);
    if (!proto) return next();                               // direct request: never redirected, no HSTS
    if (proto === 'https') {
      if (mode === 'auto') store.learn(host);
      const send = hsts === 'preload' || (hsts !== 'off' && (mode === '1' || store.wasRedirected(host)));
      if (send && !res.getHeader('Strict-Transport-Security')) {
        res.setHeader('Strict-Transport-Security', hsts === 'preload' ? HSTS_PRELOAD : HSTS);
      }
      return next();
    }
    if (!active()) return next();
    if (mode === 'auto') store.markRedirected(host);
    // originalUrl starts with "/": never "//host" (that would be another site)
    const pathAndQuery = `/${String(req.originalUrl || '/').replace(/^\/+/, '')}`;
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, `${origin}${basePath}${pathAndQuery}`);
  };
}
