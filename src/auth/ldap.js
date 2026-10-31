// Anbindung an Active Directory (Windows Server oder Samba AD) per LDAPS / StartTLS.
// - Zertifikat des Domänencontrollers abrufen und vertrauen ("pinned"),
// - Zertifizierungsstellen der Domäne automatisch aus dem AD nachladen,
// - Anmeldung prüfen, Gruppen (auch verschachtelt) auf Rollen abbilden.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { Client } from 'ldapts';
import { log } from '../lib/log.js';

const IN_CHAIN = '1.2.840.113556.1.4.1941'; // LDAP_MATCHING_RULE_IN_CHAIN (AD + Samba AD)

/** Maskiert Werte für LDAP-Filter (RFC 4515). */
export function escapeFilter(value) {
  return String(value).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** Maskiert einen Wert innerhalb eines DN (RFC 4514) – für Filter mit DN-Wert zusätzlich escapeFilter. */
export function domainFromBaseDn(baseDn) {
  return String(baseDn).split(',').map((p) => p.trim()).filter((p) => /^dc=/i.test(p)).map((p) => p.slice(3)).join('.');
}

/** "FIRMA\\m.muster" oder "m.muster@firma.local" → "m.muster" */
export function normalizeUsername(input) {
  let u = String(input || '').trim();
  if (u.includes('\\')) u = u.split('\\').pop();
  if (u.includes('@')) u = u.split('@')[0];
  return u;
}

function derToPem(der) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

export function describeCert(pemOrDer) {
  const x = new crypto.X509Certificate(pemOrDer);
  return {
    subject: x.subject.replace(/\n/g, ', '),
    issuer: x.issuer.replace(/\n/g, ', '),
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: new Date(x.validTo).toISOString(),
    fingerprint256: x.fingerprint256,
    isCA: x.ca,
    subjectAltName: x.subjectAltName || '',
    pem: x.toString(),
  };
}

/** Teilt einen PEM-Block mit mehreren Zertifikaten auf. */
export function splitPem(pem) {
  return String(pem || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

export function mergePem(existing, additional) {
  const seen = new Set();
  const out = [];
  for (const p of [...splitPem(existing), ...splitPem(additional)]) {
    try {
      const fp = new crypto.X509Certificate(p).fingerprint256;
      if (!seen.has(fp)) { seen.add(fp); out.push(p.trim()); }
    } catch { /* ungültige Blöcke ignorieren */ }
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

function startTlsRequest() {
  const oid = Buffer.from('1.3.6.1.4.1.1466.20037', 'ascii');
  const name = Buffer.concat([Buffer.from([0x80, oid.length]), oid]);
  const ext = Buffer.concat([Buffer.from([0x77, name.length]), name]);
  const msgId = Buffer.from([0x02, 0x01, 0x01]);
  const body = Buffer.concat([msgId, ext]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Baut eine TLS-Verbindung auf (LDAPS direkt oder per StartTLS) und liefert die
 * Zertifikatskette des Servers – ohne ihr zu vertrauen. Der Admin bestätigt sie danach.
 */
export function fetchCertificateChain({ host, port, security = 'ldaps', timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error(`Zeitüberschreitung bei ${host}:${port}`)), timeoutMs);

    const onSecure = (sock) => {
      const chain = [];
      const seen = new Set();
      let c = sock.getPeerCertificate(true);
      while (c && c.raw && !seen.has(c.fingerprint256)) {
        seen.add(c.fingerprint256);
        chain.push(describeCert(c.raw));
        if (!c.issuerCertificate || c.issuerCertificate === c) break;
        c = c.issuerCertificate;
      }
      sock.end();
      if (!chain.length) return finish(new Error('Der Server hat kein Zertifikat geliefert.'));
      finish(null, { chain, pem: chain.map((x) => x.pem).join('') , protocol: sock.getProtocol() });
    };

    const tlsOpts = { host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false };

    if (security === 'ldaps') {
      const s = tls.connect({ ...tlsOpts, port }, () => onSecure(s));
      s.on('error', finish);
      return;
    }
    if (security === 'starttls') {
      const raw = net.connect({ host, port }, () => raw.write(startTlsRequest()));
      raw.on('error', finish);
      raw.once('data', (buf) => {
        // ExtendedResponse: resultCode ENUMERATED 0 = success
        const i = buf.indexOf(Buffer.from([0x0a, 0x01]));
        if (i < 0 || buf[i + 2] !== 0) { raw.destroy(); return finish(new Error('Der Server unterstützt kein StartTLS.')); }
        const s = tls.connect({ ...tlsOpts, socket: raw }, () => onSecure(s));
        s.on('error', finish);
      });
      return;
    }
    finish(new Error('Ohne Verschlüsselung gibt es kein Zertifikat.'));
  });
}

/** TLS-Optionen je nach Modus. */
export function tlsOptions(cfg) {
  const opts = { servername: net.isIP(cfg.host) ? undefined : cfg.host, minVersion: 'TLSv1.2' };
  if (cfg.tlsMode === 'insecure') return { ...opts, rejectUnauthorized: false };
  if (cfg.tlsMode === 'pinned') {
    if (!cfg.caPem) throw new Error('Es ist noch kein Zertifikat hinterlegt. Bitte zuerst „Zertifikat abrufen“.');
    // allowPartialTrustChain: das abgerufene Zertifikat (oder eine Zwischen-CA) genügt als Vertrauensanker
    Object.assign(opts, { ca: splitPem(cfg.caPem), allowPartialTrustChain: true, rejectUnauthorized: true });
  } else {
    opts.rejectUnauthorized = true;
  }
  if (!cfg.verifyHostname) opts.checkServerIdentity = () => undefined;
  return opts;
}

function url(cfg) {
  const scheme = cfg.security === 'ldaps' ? 'ldaps' : 'ldap';
  const host = net.isIPv6(cfg.host) ? `[${cfg.host}]` : cfg.host;
  return `${scheme}://${host}:${cfg.port}`;
}

export async function connect(cfg) {
  const useTls = cfg.security === 'ldaps' || cfg.security === 'starttls';
  const tlsOpts = useTls ? tlsOptions(cfg) : undefined;
  const client = new Client({
    url: url(cfg),
    timeout: cfg.timeoutMs,
    connectTimeout: cfg.timeoutMs,
    tlsOptions: cfg.security === 'ldaps' ? tlsOpts : undefined,
    strictDN: false,
  });
  if (cfg.security === 'starttls') await client.startTLS(tlsOpts);
  return client;
}

function first(v) { return Array.isArray(v) ? v[0] : v; }

/** DNS-Domäne für UPN-Anmeldungen: aus dem Base-DN, sonst aus dem Namen des DCs (dc01.firma.local → firma.local). */
export function dnsDomain(cfg) {
  return domainFromBaseDn(cfg.baseDn) || (net.isIP(cfg.host) ? '' : String(cfg.host).split('.').slice(1).join('.'));
}

async function serviceBind(client, cfg, fallbackUser, fallbackPassword) {
  if (cfg.bindDn) return client.bind(cfg.bindDn, cfg.bindPassword);
  // Ohne Dienstkonto: mit dem anmeldenden Benutzer selbst binden (UPN)
  if (fallbackUser && fallbackPassword) {
    return client.bind(`${fallbackUser}@${dnsDomain(cfg)}`, fallbackPassword);
  }
  throw new Error('Kein Dienstkonto (Bind-DN) eingetragen.');
}

/** Base-DN aus dem AD ermitteln, wenn keiner eingetragen ist. */
async function ensureBaseDn(client, cfg) {
  if (cfg.baseDn) return cfg;
  const dse = await readRootDse(client);
  if (!dse.defaultNamingContext) throw new Error('Base-DN fehlt und konnte nicht ermittelt werden.');
  return { ...cfg, baseDn: dse.defaultNamingContext };
}

async function resolveGroupDn(client, cfg, value) {
  if (!value) return '';
  if (value.includes('=')) return value;
  const { searchEntries } = await client.search(cfg.baseDn, {
    scope: 'sub',
    filter: `(&(objectClass=group)(|(cn=${escapeFilter(value)})(sAMAccountName=${escapeFilter(value)})))`,
    attributes: ['dn'],
    sizeLimit: 2,
  });
  if (!searchEntries.length) { log.warn(`AD-Gruppe nicht gefunden: ${value}`); return ''; }
  return searchEntries[0].dn;
}

async function isMember(client, cfg, userDn, memberOf, groupValue) {
  const groupDn = await resolveGroupDn(client, cfg, groupValue);
  if (!groupDn) return false;
  if (!cfg.nestedGroups) {
    const list = (Array.isArray(memberOf) ? memberOf : [memberOf]).filter(Boolean).map((g) => g.toLowerCase());
    return list.includes(groupDn.toLowerCase());
  }
  const { searchEntries } = await client.search(userDn, {
    scope: 'base',
    filter: `(memberOf:${IN_CHAIN}:=${escapeFilter(groupDn)})`,
    attributes: ['dn'],
  });
  return searchEntries.length > 0;
}

/**
 * Prüft Benutzername/Kennwort gegen das AD.
 * @returns {Promise<{username, displayName, email, dn, groups:{admin,agent,user}}|null>} null = falsche Anmeldedaten
 */
export async function authenticate(cfg, rawUsername, password) {
  const username = normalizeUsername(rawUsername);
  if (!username || !password) return null; // leeres Kennwort = anonymer Bind, niemals zulassen

  const client = await connect(cfg);
  try {
    try {
      await serviceBind(client, cfg, username, password);
    } catch (e) {
      if (!cfg.bindDn) return null; // eigener Bind fehlgeschlagen = falsches Kennwort
      throw new Error(`Dienstkonto-Anmeldung am AD fehlgeschlagen: ${e.message}`);
    }
    cfg = await ensureBaseDn(client, cfg);
    const filter = cfg.userFilter.replace(/\{\{username\}\}/g, escapeFilter(username));
    const attrs = [cfg.usernameAttr, cfg.displayNameAttr, cfg.emailAttr, 'memberOf', 'objectGUID'];
    const { searchEntries } = await client.search(cfg.baseDn, { scope: 'sub', filter, attributes: attrs, sizeLimit: 2 });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0];

    // Kennwort prüfen (eigene Verbindung, damit die Dienstkonto-Sitzung erhalten bleibt)
    if (cfg.bindDn) {
      const userClient = await connect(cfg);
      try { await userClient.bind(entry.dn, password); }
      catch { return null; }
      finally { await userClient.unbind().catch(() => {}); }
    }

    const groups = {
      admin: await isMember(client, cfg, entry.dn, entry.memberOf, cfg.adminGroup),
      agent: await isMember(client, cfg, entry.dn, entry.memberOf, cfg.agentGroup),
      user: cfg.userGroup ? await isMember(client, cfg, entry.dn, entry.memberOf, cfg.userGroup) : true,
    };
    const guid = first(entry.objectGUID);
    return {
      username: String(first(entry[cfg.usernameAttr]) || username),
      displayName: String(first(entry[cfg.displayNameAttr]) || username),
      email: String(first(entry[cfg.emailAttr]) || ''),
      dn: entry.dn,
      externalId: Buffer.isBuffer(guid) ? guid.toString('hex') : (guid ? String(guid) : entry.dn),
      groups,
    };
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** Liest RootDSE (Base-DN, Konfigurationspartition, Servername). */
export async function readRootDse(client) {
  const { searchEntries } = await client.search('', {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: ['defaultNamingContext', 'configurationNamingContext', 'dnsHostName', 'serverName'],
  });
  const e = searchEntries[0] || {};
  return {
    defaultNamingContext: first(e.defaultNamingContext) || '',
    configurationNamingContext: first(e.configurationNamingContext) || '',
    dnsHostName: first(e.dnsHostName) || '',
  };
}

/** Holt die Zertifizierungsstellen der Domäne (AD CS) aus der Konfigurationspartition. */
export async function fetchDomainCAs(client, configNc) {
  if (!configNc) return [];
  const base = `CN=Public Key Services,CN=Services,${configNc}`;
  try {
    const { searchEntries } = await client.search(base, {
      scope: 'sub',
      filter: '(|(objectClass=certificationAuthority)(cn=NTAuthCertificates))',
      attributes: ['cACertificate'],
      explicitBufferAttributes: ['cACertificate'],
    });
    const out = [];
    for (const e of searchEntries) {
      const vals = Array.isArray(e.cACertificate) ? e.cACertificate : [e.cACertificate];
      for (const v of vals) {
        if (!v || !v.length) continue;
        try { out.push(describeCert(v)); } catch { /* kein gültiges Zertifikat */ }
      }
    }
    return out;
  } catch (e) {
    log.debug('Keine AD-Zertifizierungsstellen gefunden', { error: e.message });
    return [];
  }
}

/** Verbindungstest für die Einstellungsseite. */
export async function testConnection(cfg, { username, password } = {}) {
  const result = { ok: false, steps: [] };
  let client;
  try {
    client = await connect(cfg);
    result.steps.push({ ok: true, key: 'connect' });
    await serviceBind(client, cfg, username && normalizeUsername(username), password);
    result.steps.push({ ok: true, key: 'bind' });
    const dse = await readRootDse(client);
    result.rootDse = dse;
    if (!cfg.baseDn) cfg.baseDn = dse.defaultNamingContext;
    const cas = await fetchDomainCAs(client, dse.configurationNamingContext);
    result.domainCAs = cas.map(({ pem, ...rest }) => rest);
    result.domainCaPem = cas.map((c) => c.pem).join('');
    const { searchEntries } = await client.search(cfg.baseDn, {
      scope: 'sub', filter: '(&(objectCategory=person)(objectClass=user))', attributes: ['dn'], sizeLimit: 5,
    }).catch((e) => (e.name === 'SizeLimitExceededError' ? { searchEntries: [1, 2, 3, 4, 5] } : Promise.reject(e)));
    result.steps.push({ ok: true, key: 'search', count: searchEntries.length });
    for (const [role, value] of [['admin', cfg.adminGroup], ['agent', cfg.agentGroup], ['user', cfg.userGroup]]) {
      if (!value) continue;
      const dn = await resolveGroupDn(client, cfg, value);
      result.steps.push({ ok: !!dn, key: 'group', role, value, dn });
    }
    if (username && password) {
      const u = await authenticate(cfg, username, password);
      result.steps.push({ ok: !!u, key: 'user', user: u ? { username: u.username, displayName: u.displayName, email: u.email, groups: u.groups } : null });
    }
    result.ok = result.steps.every((s) => s.ok);
  } catch (e) {
    result.steps.push({ ok: false, key: 'error', message: e.message });
  } finally {
    if (client) await client.unbind().catch(() => {});
  }
  return result;
}
