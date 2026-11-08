// Detects whether a request comes from the internal network and whether 2FA is required for it.
import fs from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import { log } from '../lib/log.js';

export const DEFAULT_INTERNAL_NETWORKS = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7';

/** "::ffff:10.0.0.5" → "10.0.0.5" */
export function normalizeIp(ip) {
  const s = String(ip || '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

/** List like "10.0.0.0/8, 192.168.1.10, fd00::/8" → BlockList. Invalid entries are reported. */
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

/** Default gateway of the container (from /proc/net/route), e.g. 172.17.0.1 */
export function readDefaultGateway(routeFile = '/proc/net/route') {
  try {
    for (const line of fs.readFileSync(routeFile, 'utf8').split('\n').slice(1)) {
      const [, dest, gw] = line.trim().split(/\s+/);
      if (dest === '00000000' && gw && gw !== '00000000') {
        const b = Buffer.from(gw, 'hex');
        return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
      }
    }
  } catch { /* not Linux */ }
  return null;
}

export const MFA_LEVELS = ['none', 'admins', 'agents', 'all'];
export const RESOLVE_EVERY_MS = 5 * 60 * 1000;

/** Does the level apply to this role? none / admins / agents (agents + admins) / all */
export function levelApplies(level, role) {
  if (level === 'all') return true;
  if (level === 'agents') return role === 'agent' || role === 'admin';
  if (level === 'admins') return role === 'admin';
  return false;
}

/**
 * Effective requirement external/internal. Older installations only have mfa.mode
 * (off | external | always) – derived from it as long as nothing new has been saved.
 */
export function mfaLevels(settings) {
  const mode = settings.get('mfa.mode');
  const ext = settings.get('mfa.external');
  const int = settings.get('mfa.internal');
  return {
    external: MFA_LEVELS.includes(ext) ? ext : (mode === 'off' ? 'none' : 'all'),
    internal: MFA_LEVELS.includes(int) ? int : (mode === 'always' ? 'all' : 'none'),
  };
}

/** Entries "own internet connection": IP addresses and names (DynDNS), one per line. */
export function parseOwnAddresses(text) {
  const ips = [];
  const names = [];
  const invalid = [];
  for (const raw of String(text || '').split(/[\s,;]+/).filter(Boolean)) {
    const v = raw.trim().toLowerCase();
    if (net.isIP(v)) ips.push(normalizeIp(v));
    else if (/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v)) names.push(v);
    else invalid.push(raw);
  }
  return { ips, names, invalid };
}

export function createNetworkPolicy(settings, { gateway = readDefaultGateway(), resolver = (name) => dns.promises.lookup(name, { all: true }) } = {}) {
  let cacheKey = null;
  let cached = null;
  let warnedProxy = false;
  // Own internet connection: resolved addresses (names are re-resolved regularly)
  let ownKey = null;
  let own = { ips: new Set(), resolved: {}, at: null, errors: {} };

  async function refreshOwn(force = false) {
    const text = settings.get('mfa.ownAddresses');
    if (!force && text === ownKey && own.at && Date.now() - own.at < RESOLVE_EVERY_MS) return own;
    const { ips, names } = parseOwnAddresses(text);
    const next = { ips: new Set(ips), resolved: {}, at: Date.now(), errors: {} };
    for (const n of names) {
      try {
        const res = await resolver(n);
        next.resolved[n] = res.map((r) => normalizeIp(r.address));
        for (const a of next.resolved[n]) next.ips.add(a);
      } catch (e) {
        next.errors[n] = e.code || e.message;
        // On error keep the last known resolution (DNS briefly unreachable)
        if (own.resolved[n]) { next.resolved[n] = own.resolved[n]; for (const a of own.resolved[n]) next.ips.add(a); }
      }
    }
    ownKey = text;
    own = next;
    return own;
  }
  const ownSync = () => {
    // Apply a changed setting immediately for plain IP entries; names follow asynchronously
    const text = settings.get('mfa.ownAddresses');
    if (text !== ownKey) {
      const { ips } = parseOwnAddresses(text);
      own = { ...own, ips: new Set([...ips, ...Object.values(own.resolved).flat()]) };
      refreshOwn(true).catch(() => {});
    } else if (!own.at || Date.now() - own.at >= RESOLVE_EVERY_MS) refreshOwn().catch(() => {});
    return own.ips;
  };

  function networks() {
    const text = settings.get('mfa.internalNetworks');
    if (text !== cacheKey) { cacheKey = text; cached = parseNetworks(text); }
    return cached.list;
  }

  /**
   * Internal = client IP is in the internal networks (or is the server itself).
   * Security rule: if the request has an X-Forwarded-For that Helfi.Space did NOT evaluate because
   * HELFI_TRUST_PROXY is not set, the real origin is unknown →
   * treat as external (otherwise behind a reverse proxy every request would be "internal").
   */
  function isInternal(req) {
    return classify(req).internal;
  }

  /** Returns { ip, internal, reason } – also for the display "How Helfi.Space sees your address". */
  function classify(req) {
    const peer = normalizeIp(req.socket?.remoteAddress);
    const ip = normalizeIp(req.ip);
    if (req.headers['x-forwarded-for'] && ip === peer) {
      if (!warnedProxy) { warnedProxy = true; log.warn('X-Forwarded-For received, but the proxy is not listed in HELFI_TRUST_PROXY – requests are treated as external (2FA).'); }
      return { ip, internal: false, reason: 'untrustedProxy' };
    }
    // A trusted proxy (HELFI_TRUST_PROXY) that forwards a request WITHOUT X-Forwarded-For: the real
    // client is unknown and req.ip is the proxy itself, which may sit in an internal network →
    // treat as external (otherwise every request through such a proxy would skip 2FA).
    // Loopback is exempt: it never counts as internal unless listed explicitly (see below), and
    // without X-Forwarded-For it is the server itself (health check, local tools).
    // Only proxies listed as a single address: with a range (e.g. "uniquelocal" or 10.0.10.0/24) every
    // device in it that connects directly would otherwise count as external.
    if (!req.headers['x-forwarded-for'] && !/^(127\.|::1$)/.test(peer) && listedProxies(req).has(peer)) {
      return { ip, internal: false, reason: 'proxyWithoutClient' };
    }
    // Loopback does NOT automatically count as internal: a reverse proxy on the same host without
    // X-Forwarded-For would otherwise make every external request look internal.
    const type = net.isIPv4(ip) ? 'ipv4' : (net.isIPv6(ip) ? 'ipv6' : null);
    if (!type) return { ip, internal: false, reason: 'unknown' };
    // Docker gateway: with some Docker setups (userland-proxy, rootless, IPv6) ALL requests
    // seem to come from the gateway. It therefore only counts as internal if listed individually.
    if (gateway && ip === gateway && !explicitlyListed(ip)) return { ip, internal: false, reason: 'dockerGateway' };
    // Own internet connection: internal machines call the public address, the router forwards
    // them with its own public IP (hairpin NAT) → counts as internal
    if (ownSync().has(ip)) return { ip, internal: true, reason: 'ownAddress' };
    return { ip, internal: networks().check(ip, type), reason: 'networks' };
  }

  /** Single proxy addresses from HELFI_TRUST_PROXY (express setting 'trust proxy'; ranges and keywords not) */
  function listedProxies(req) {
    const v = req.app?.get?.('trust proxy');
    const list = Array.isArray(v) ? v : String(typeof v === 'string' ? v : '').split(',');
    // "10.0.10.5/32" and "fd00::5/128" are single addresses too
    const single = (x) => {
      const m = /^(.+)\/(\d+)$/.exec(x);
      if (!m) return x;
      const bits = net.isIPv4(m[1]) ? 32 : (net.isIPv6(m[1]) ? 128 : -1);
      return Number(m[2]) === bits ? m[1] : '';
    };
    return new Set(list.map((x) => normalizeIp(single(String(x).trim()))).filter((x) => net.isIP(x)));
  }

  function explicitlyListed(ip) {
    return String(settings.get('mfa.internalNetworks') || '').split(/[\s,;]+/).some((x) => x === ip || x === `${ip}/32`);
  }

  /** Is a second factor required for this request (and this user)? */
  function mfaRequired(req, user) {
    const levels = mfaLevels(settings);
    const level = isInternal(req) ? levels.internal : levels.external;
    return levelApplies(level, user?.role || 'user');
  }

  // re-resolve regularly so a changed DynDNS address applies without restart
  const timer = setInterval(() => refreshOwn().catch(() => {}), RESOLVE_EVERY_MS);
  timer.unref?.();
  refreshOwn().catch(() => {});

  /** Requirement for this user external/internal – for display in profile and banner */
  function userMode(user) {
    const levels = mfaLevels(settings);
    const role = user?.role || 'user';
    const ext = levelApplies(levels.external, role);
    const int = levelApplies(levels.internal, role);
    return ext && int ? 'always' : ext ? 'external' : int ? 'internal' : 'off';
  }

  return {
    isInternal, classify, mfaRequired, userMode, levels: () => mfaLevels(settings), proxyWarning: () => warnedProxy,
    ownAddresses: async () => { const o = await refreshOwn(); return { ips: [...o.ips], resolved: o.resolved, errors: o.errors, at: o.at }; },
    refreshOwn: () => refreshOwn(true),
    stop: () => clearInterval(timer),
  };
}
