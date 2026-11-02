// Erkennt, ob eine Anfrage aus dem internen Netz kommt, und ob dafür 2FA nötig ist.
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

export const MFA_LEVELS = ['none', 'admins', 'agents', 'all'];
export const RESOLVE_EVERY_MS = 5 * 60 * 1000;

/** Gilt die Stufe für diese Rolle? none / admins / agents (Bearbeiter + Admins) / all */
export function levelApplies(level, role) {
  if (level === 'all') return true;
  if (level === 'agents') return role === 'agent' || role === 'admin';
  if (level === 'admins') return role === 'admin';
  return false;
}

/**
 * Wirksame Pflicht außen/innen. Ältere Installationen haben nur mfa.mode
 * (off | external | always) – daraus wird abgeleitet, solange nichts Neues gespeichert ist.
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

/** Einträge „Eigener Internetanschluss“: IP-Adressen und Namen (DynDNS), eine pro Zeile. */
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
  // Eigener Internetanschluss: aufgelöste Adressen (Namen werden regelmäßig neu aufgelöst)
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
        // Bei einem Fehler die zuletzt bekannte Auflösung behalten (DNS kurz nicht erreichbar)
        if (own.resolved[n]) { next.resolved[n] = own.resolved[n]; for (const a of own.resolved[n]) next.ips.add(a); }
      }
    }
    ownKey = text;
    own = next;
    return own;
  }
  const ownSync = () => {
    // Geänderte Einstellung sofort für reine IP-Einträge übernehmen; Namen folgen asynchron
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
    // Eigener Internetanschluss: interne Rechner rufen die öffentliche Adresse auf, der Router reicht
    // sie mit der eigenen öffentlichen IP weiter (Hairpin-NAT) → gilt als intern
    if (ownSync().has(ip)) return { ip, internal: true, reason: 'ownAddress' };
    return { ip, internal: networks().check(ip, type), reason: 'networks' };
  }

  function explicitlyListed(ip) {
    return String(settings.get('mfa.internalNetworks') || '').split(/[\s,;]+/).some((x) => x === ip || x === `${ip}/32`);
  }

  /** Muss für diese Anfrage (und diesen Benutzer) ein zweiter Faktor vorliegen? */
  function mfaRequired(req, user) {
    const levels = mfaLevels(settings);
    const level = isInternal(req) ? levels.internal : levels.external;
    return levelApplies(level, user?.role || 'user');
  }

  // regelmäßig neu auflösen, damit eine geänderte DynDNS-Adresse ohne Neustart gilt
  const timer = setInterval(() => refreshOwn().catch(() => {}), RESOLVE_EVERY_MS);
  timer.unref?.();
  refreshOwn().catch(() => {});

  /** Pflicht für diesen Benutzer außen/innen – für Anzeige in Profil und Banner */
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
