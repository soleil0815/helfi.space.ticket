// Connection to Active Directory (Windows Server or Samba AD) via LDAPS / StartTLS.
// - fetch and trust the domain controller's certificate ("pinned"),
// - load the domain's certificate authorities automatically from AD,
// - verify sign-in, map groups (including nested ones) to roles.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { Client, FilterParser, EqualityFilter } from 'ldapts';
import { log } from '../lib/log.js';

const IN_CHAIN = '1.2.840.113556.1.4.1941'; // LDAP_MATCHING_RULE_IN_CHAIN (AD + Samba AD)

/** Escapes values for LDAP filters (RFC 4515). */
export function escapeFilter(value) {
  return String(value).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** User filter with escaped name. Replacement via function: otherwise $&, $' etc. in the
 *  username would be interpreted as patterns by String.replace and could alter the filter. */
export function buildUserFilter(template, username) {
  return String(template).replace(/\{\{username\}\}/g, () => escapeFilter(username));
}

/** DN for comparisons: lowercase, no spaces around commas/equals signs */
export function normalizeDn(dn) {
  return String(dn).trim().toLowerCase().replace(/\s*([,=])\s*/g, '$1');
}

/** Escapes a value within a DN (RFC 4514) – for filters with a DN value additionally escapeFilter. */
export function domainFromBaseDn(baseDn) {
  return String(baseDn).split(',').map((p) => p.trim()).filter((p) => /^dc=/i.test(p)).map((p) => p.slice(3)).join('.');
}

/** "FIRMA\\m.muster" or "m.muster@firma.local" → "m.muster" */
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

/** Splits a PEM block with multiple certificates. */
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
    } catch { /* ignore invalid blocks */ }
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
 * Opens a TLS connection (LDAPS directly or via StartTLS) and returns the
 * server's certificate chain – without trusting it. The admin confirms it afterwards.
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

/** TLS options depending on the mode. */
export function tlsOptions(cfg) {
  const opts = { servername: net.isIP(cfg.host) ? undefined : cfg.host, minVersion: 'TLSv1.2' };
  if (cfg.tlsMode === 'insecure') return { ...opts, rejectUnauthorized: false };
  if (cfg.tlsMode === 'pinned') {
    if (!cfg.caPem) throw new Error('Es ist noch kein Zertifikat hinterlegt. Bitte zuerst „Zertifikat abrufen“.');
    // allowPartialTrustChain: the fetched certificate (or an intermediate CA) is enough as trust anchor
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

/** DNS domain for UPN sign-ins: from the base DN, otherwise from the DC's name (dc01.firma.local → firma.local). */
export function dnsDomain(cfg) {
  return domainFromBaseDn(cfg.baseDn) || (net.isIP(cfg.host) ? '' : String(cfg.host).split('.').slice(1).join('.'));
}

async function serviceBind(client, cfg, fallbackUser, fallbackPassword) {
  if (cfg.bindDn) return client.bind(cfg.bindDn, cfg.bindPassword);
  // Without a service account: bind as the signing-in user (UPN)
  if (fallbackUser && fallbackPassword) {
    return client.bind(`${fallbackUser}@${dnsDomain(cfg)}`, fallbackPassword);
  }
  throw new Error('Kein Dienstkonto (Bind-DN) eingetragen.');
}

/** Determine the base DN from AD if none is configured. */
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
  });
  if (!searchEntries.length) { log.warn(`AD group not found: ${value}`); return ''; }
  // Ambiguous (same name in several OUs) → better no role than the wrong one
  if (searchEntries.length > 1) { log.warn(`AD group "${value}" is ambiguous (${searchEntries.length} matches) – please enter the full DN.`); return ''; }
  return searchEntries[0].dn;
}

async function isMember(client, cfg, userDn, memberOf, groupValue) {
  const groupDn = await resolveGroupDn(client, cfg, groupValue);
  if (!groupDn) return false;
  if (!cfg.nestedGroups) {
    const list = (Array.isArray(memberOf) ? memberOf : [memberOf]).filter(Boolean).map(normalizeDn);
    return list.includes(normalizeDn(groupDn));
  }
  const { searchEntries } = await client.search(userDn, {
    scope: 'base',
    filter: `(memberOf:${IN_CHAIN}:=${escapeFilter(groupDn)})`,
    attributes: ['dn'],
  });
  return searchEntries.length > 0;
}

/**
 * Verifies username/password against AD.
 * @returns {Promise<{username, displayName, email, dn, groups:{admin,agent,user}}|null>} null = wrong credentials
 */
export async function authenticate(cfg, rawUsername, password) {
  const username = normalizeUsername(rawUsername);
  if (!username || !password) return null; // empty password = anonymous bind, never allow

  const client = await connect(cfg);
  try {
    try {
      await serviceBind(client, cfg, username, password);
    } catch (e) {
      if (!cfg.bindDn) return null; // own bind failed = wrong password
      throw new Error(`Dienstkonto-Anmeldung am AD fehlgeschlagen: ${e.message}`);
    }
    cfg = await ensureBaseDn(client, cfg);
    const filter = buildUserFilter(cfg.userFilter, username);
    const attrs = [cfg.usernameAttr, cfg.displayNameAttr, cfg.emailAttr, 'memberOf', 'objectGUID', 'objectSid'];
    const { searchEntries } = await client.search(cfg.baseDn, { scope: 'sub', filter, attributes: attrs, explicitBufferAttributes: ['objectGUID', 'objectSid'], sizeLimit: 2 });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0];

    // ALWAYS verify the password with the account found (separate connection). Without a service account the first
    // bind via "name@domain" succeeded – that can be the UPN of a DIFFERENT account than the one whose
    // sAMAccountName equals "name". Only the bind to the found DN proves it is this account.
    const userClient = await connect(cfg);
    try { await userClient.bind(entry.dn, password); }
    catch { return null; }
    finally { await userClient.unbind().catch(() => {}); }

    return await entryToUser(client, cfg, entry, username);
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** AD entry → user data with group membership (for sign-in and sender lookup). */
async function entryToUser(client, cfg, entry, fallbackName) {
  const groups = {
    admin: await isMember(client, cfg, entry.dn, entry.memberOf, cfg.adminGroup),
    agent: await isMember(client, cfg, entry.dn, entry.memberOf, cfg.agentGroup),
    user: cfg.userGroup ? await isMember(client, cfg, entry.dn, entry.memberOf, cfg.userGroup) : true,
  };
  const guid = first(entry.objectGUID);
  return {
    username: String(first(entry[cfg.usernameAttr]) || fallbackName),
    displayName: String(first(entry[cfg.displayNameAttr]) || fallbackName),
    email: String(first(entry[cfg.emailAttr]) || ''),
    dn: entry.dn,
    externalId: Buffer.isBuffer(guid) ? guid.toString('hex') : (guid ? String(guid) : entry.dn),
    sid: sidToString(first(entry.objectSid)),
    groups,
  };
}

/** LDAP filter: active user account with this address (primary address, UPN or secondary address). */
export function buildEmailFilter(email) {
  const e = escapeFilter(String(email).trim().toLowerCase());
  return '(&(objectCategory=person)(objectClass=user)'
    + '(!(userAccountControl:1.2.840.113556.1.4.803:=2))' // not disabled accounts
    + `(|(mail=${e})(userPrincipalName=${e})(proxyAddresses=smtp:${e})))`;
}

/**
 * Look up the sender of an email in AD (service account only).
 * Result: user data as with authenticate(), null (not found) or { ambiguous: true }.
 */
export async function findByEmail(cfg, email) {
  if (!cfg.bindDn) throw new Error('Kein Dienstkonto (Bind-DN) eingetragen.');
  const client = await connect(cfg);
  try {
    await serviceBind(client, cfg);
    cfg = await ensureBaseDn(client, cfg);
    const attrs = [cfg.usernameAttr, cfg.displayNameAttr, cfg.emailAttr, 'memberOf', 'objectGUID', 'objectSid'];
    const { searchEntries } = await client.search(cfg.baseDn, { scope: 'sub', filter: buildEmailFilter(email), attributes: attrs, explicitBufferAttributes: ['objectGUID', 'objectSid'], sizeLimit: 2 });
    if (searchEntries.length === 0) return null;
    if (searchEntries.length > 1) return { ambiguous: true };
    return await entryToUser(client, cfg, searchEntries[0], String(email).split('@')[0]);
  } finally {
    await client.unbind().catch(() => {});
  }
}

// ---------- objectSid ----------
/** objectSid (bytes) → "S-1-5-21-…"; otherwise '' */
export function sidToString(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return '';
  const count = buf[1];
  if (buf.length !== 8 + count * 4) return '';
  const auth = buf.readUIntBE(2, 6);
  const subs = [];
  for (let i = 0; i < count; i++) subs.push(buf.readUInt32LE(8 + i * 4));
  return `S-${buf[0]}-${auth}${subs.map((x) => `-${x}`).join('')}`;
}

/** "S-1-5-21-…" → bytes (for LDAP filters); otherwise null */
export function sidToBuffer(sid) {
  const m = /^S-(\d+)-(\d+)((?:-\d+){1,15})$/i.exec(String(sid || '').trim());
  if (!m) return null;
  const subs = m[3].slice(1).split('-').map(Number);
  const auth = Number(m[2]);
  if (Number(m[1]) > 255 || !Number.isSafeInteger(auth) || auth > 0xffffffffffff || subs.some((x) => x > 0xffffffff)) return null;
  const buf = Buffer.alloc(8 + subs.length * 4);
  buf[0] = Number(m[1]); buf[1] = subs.length;
  buf.writeUIntBE(auth, 2, 6);
  subs.forEach((x, i) => buf.writeUInt32LE(x, 8 + i * 4));
  return buf;
}

// ---------- Search people (participants from AD) ----------
const ACTIVE_PERSON = '(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))';
const SEARCH_ATTRS = ['displayName', 'givenName', 'sn', 'cn', 'mail', 'sAMAccountName', 'userPrincipalName'];
const safeAttr = (a) => (/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(String(a || '')) ? a : null);

/** LDAP filter for people search: every word must appear in name, login name or an address. */
export function buildPeopleFilter(cfg, q) {
  const words = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 4);
  if (!words.length) throw new Error('Suchbegriff fehlt');
  const attrs = [...new Set([...SEARCH_ATTRS, safeAttr(cfg.usernameAttr), safeAttr(cfg.displayNameAttr), safeAttr(cfg.emailAttr)].filter(Boolean))];
  const part = (w) => {
    const e = escapeFilter(w);
    return `(|${attrs.map((a) => `(${a}=*${e}*)`).join('')}(proxyAddresses=smtp:*${e}*))`;
  };
  return `(&${ACTIVE_PERSON}${words.map(part).join('')})`;
}

/**
 * Filter "active user with this objectGUID" (hex from externalId).
 * As a filter object with bytes: in a filter string ldapts would send \\aa… as UTF-8.
 */
export function guidFilter(hex) {
  if (!/^[0-9a-f]{32}$/i.test(String(hex || ''))) return null;
  return binaryFilter('objectGUID', Buffer.from(String(hex), 'hex'));
}

/** Filter "active user with this objectSid" (text form S-1-5-…) */
export function sidFilter(sid) {
  const b = sidToBuffer(sid);
  return b ? binaryFilter('objectSid', b) : null;
}

function binaryFilter(attribute, value) {
  const f = FilterParser.parseString(`(&${ACTIVE_PERSON})`);
  f.filters.push(new EqualityFilter({ attribute, value }));
  return f;
}

const guidHex = (v) => { const g = first(v); return Buffer.isBuffer(g) ? g.toString('hex') : ''; };

/**
 * Search active AD users (service account only). Returns at most `limit` matches,
 * sorted by display name: { username, displayName, email, externalId }.
 */
export async function searchPeople(cfg, q, { limit = 10 } = {}) {
  if (!cfg.bindDn) throw new Error('Kein Dienstkonto (Bind-DN) eingetragen.');
  const filter = buildPeopleFilter(cfg, q);
  const client = await connect(cfg);
  try {
    await serviceBind(client, cfg);
    cfg = await ensureBaseDn(client, cfg);
    const attrs = [cfg.usernameAttr, cfg.displayNameAttr, cfg.emailAttr, 'objectGUID'];
    const entries = [];
    // Only the first page: do not read the whole directory for very general searches
    for await (const page of client.searchPaginated(cfg.baseDn, {
      scope: 'sub', filter, attributes: attrs, explicitBufferAttributes: ['objectGUID'], paged: { pageSize: Math.max(limit * 3, 20) },
    })) { entries.push(...page.searchEntries); break; }
    return entries
      .map((e) => {
        const username = String(first(e[cfg.usernameAttr]) || '');
        return {
          username,
          displayName: String(first(e[cfg.displayNameAttr]) || username),
          email: String(first(e[cfg.emailAttr]) || ''),
          externalId: guidHex(e.objectGUID),
        };
      })
      .filter((p) => p.username && p.externalId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'))
      .slice(0, limit);
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** Get an AD user by objectGUID, with groups (as on sign-in). null = not there (anymore) or disabled. */
export async function findByGuid(cfg, hex) {
  return findOne(cfg, guidFilter(hex));
}

/** Get an AD user by objectSid (S-1-5-…), with groups. null = not there (anymore) or disabled. */
export async function findBySid(cfg, sid) {
  return findOne(cfg, sidFilter(sid));
}

async function findOne(cfg, filter) {
  if (!cfg.bindDn) throw new Error('Kein Dienstkonto (Bind-DN) eingetragen.');
  if (!filter) return null;
  const client = await connect(cfg);
  try {
    await serviceBind(client, cfg);
    cfg = await ensureBaseDn(client, cfg);
    const attrs = [cfg.usernameAttr, cfg.displayNameAttr, cfg.emailAttr, 'memberOf', 'objectGUID', 'objectSid'];
    const { searchEntries } = await client.search(cfg.baseDn, {
      scope: 'sub', filter, attributes: attrs, explicitBufferAttributes: ['objectGUID', 'objectSid'], sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0];
    return await entryToUser(client, cfg, entry, String(first(entry[cfg.usernameAttr]) || ''));
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** Reads RootDSE (base DN, configuration partition, server name). */
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

/** Gets the domain's certificate authorities (AD CS) from the configuration partition. */
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
        try { out.push(describeCert(v)); } catch { /* not a valid certificate */ }
      }
    }
    return out;
  } catch (e) {
    log.debug('No AD certificate authorities found', { error: e.message });
    return [];
  }
}

/** Connection test for the settings page. */
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
