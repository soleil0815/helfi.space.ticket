// Erkennt, ob eine Anfrage aus dem internen Netz kommt, und ob dafür 2FA nötig ist.
import fs from 'node:fs';
import net from 'node:net';
import { log } from '../lib/log.js';

export const DEFAULT_INTERNAL_NETWORKS = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7';

/** "::ffff:10.0.0.5" → "10.0.0.5" */
export function normalizeIp(ip) {
  const s = String(ip || '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

/** Liste wie "10.0.0.0/8, 192.168.1.10, fd00::/8" → BlockList. Ungültige Einträge werden gemeldet. */
export function parseNetworks(text) {
  const list = new net.BlockList();
  const invalid = [];
  for (const raw of String(text || '').split(/[\s,;]+/).filter(Boolean)) {
    const [addr, prefix] = raw.split('/');
    const type = net.isIPv4(addr) ? 'ipv4' : (net.isIPv6(addr) ? 'ipv6' : null);
    if (!type) { invalid.push(raw); continue; }
    if (prefix === undefined) { list.addAddress(addr, type); continue; }
    const p = Number(prefix);
    if (!Number.isInteger(p) || p < 0 || p > (type === 'ipv4' ? 32 : 128)) { invalid.push(raw); continue; }
    list.addSubnet(addr, p, type);
  }
  return { list, invalid };
}

/** Standard-Gateway des Containers (aus /proc/net/route), z. B. 172.17.0.1 */
export function readDefaultGateway(routeFile = '/proc/net/route') {
  try {
    for (const line of fs.readFileSync(routeFile, 'utf8').split('\n').slice(1)) {
      const [, dest, gw] = line.trim().split(/\s+/);
      if (dest === '00000000' && gw && gw !== '00000000') {
        const b = Buffer.from(gw, 'hex');
        return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
      }
    }
  } catch { /* nicht Linux */ }
  return null;
}

export function createNetworkPolicy(settings, { gateway = readDefaultGateway() } = {}) {
  let cacheKey = null;
  let cached = null;
  let warnedProxy = false;

  function networks() {
    const text = settings.get('mfa.internalNetworks');
    if (text !== cacheKey) { cacheKey = text; cached = parseNetworks(text); }
    return cached.list;
  }

  /**
   * Intern = Client-IP liegt in den internen Netzen (oder ist der Server selbst).
   * Sicherheitsregel: Steht ein X-Forwarded-For im Request, den Helfi.Space wegen fehlender
   * HELFI_TRUST_PROXY-Einstellung NICHT ausgewertet hat, ist die echte Herkunft unbekannt →
   * als extern behandeln (sonst wäre hinter einem Reverse-Proxy jeder Zugriff "intern").
   */
  function isInternal(req) {
    return classify(req).internal;
  }

  /** Liefert { ip, internal, reason } – auch für die Anzeige „So erkennt Helfi.Space deine Adresse“. */
  function classify(req) {
    const peer = normalizeIp(req.socket?.remoteAddress);
    const ip = normalizeIp(req.ip);
    if (req.headers['x-forwarded-for'] && ip === peer) {
      if (!warnedProxy) { warnedProxy = true; log.warn('X-Forwarded-For erhalten, aber der Proxy ist nicht in HELFI_TRUST_PROXY eingetragen – Zugriffe gelten als extern (2FA).'); }
      return { ip, internal: false, reason: 'untrustedProxy' };
    }
    // Loopback zählt NICHT automatisch als intern: Ein Reverse-Proxy auf demselben Rechner ohne
    // X-Forwarded-For ließe sonst jeden Zugriff von außen als intern erscheinen.
    const type = net.isIPv4(ip) ? 'ipv4' : (net.isIPv6(ip) ? 'ipv6' : null);
    if (!type) return { ip, internal: false, reason: 'unknown' };
    // Docker-Gateway: Bei manchen Docker-Setups (userland-proxy, rootless, IPv6) kommen ALLE
    // Zugriffe scheinbar vom Gateway. Er zählt deshalb nur als intern, wenn er einzeln eingetragen ist.
    if (gateway && ip === gateway && !explicitlyListed(ip)) return { ip, internal: false, reason: 'dockerGateway' };
    return { ip, internal: networks().check(ip, type), reason: 'networks' };
  }

  function explicitlyListed(ip) {
    return String(settings.get('mfa.internalNetworks') || '').split(/[\s,;]+/).some((x) => x === ip || x === `${ip}/32`);
  }

  /** Muss für diese Anfrage ein zweiter Faktor vorliegen? */
  function mfaRequired(req) {
    const mode = settings.get('mfa.mode');
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    return !isInternal(req);
  }

  return { isInternal, classify, mfaRequired, proxyWarning: () => warnedProxy };
}
