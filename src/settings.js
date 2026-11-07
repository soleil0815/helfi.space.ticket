// Settings in the database. Defaults live here in the code
// so that docker-compose.yml stays stable.
import { encrypt, decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';
import { HttpError } from './lib/http.js';

export const DEFAULTS = {
  // General
  'general.title': 'Helfi.Space',
  'general.defaultProject': '',
  'general.allowSelfService': true, // users (role "user") may create tickets
  'general.defaultLanguage': 'de', // de | en – for emails to senders without an account

  // Sign-in page (text without HTML; **bold**, links and mail addresses are recognized)
  'login.title': '',
  // Service level (SLA): targets in business minutes per priority
  // Satisfaction survey: rating links in the "Resolved" mail to the reporter
  'survey.enabled': false,
  'survey.days': 14, // how long the link is valid
  'sla.enabled': false,
  'sla.hours': '{"days":[1,2,3,4,5],"start":"08:00","end":"17:00"}',
  'sla.holidays': '', // one line per holiday: YYYY-MM-DD name
  'sla.targets': '{"highest":{"response":30,"resolve":240},"high":{"response":120,"resolve":960},"medium":{"response":480,"resolve":2400},"low":{"response":960,"resolve":4800}}',
  'sla.pauseWaiting': true, // "Waiting" pauses the resolution clock
  'sla.warnPercent': 80,

  // Change management
  'change.approvers': '', // user IDs of the approvers (CAB), comma-separated
  'change.approvalMode': 'any', // any = one approval is enough, all = everyone must approve
  'change.standardTemplates': '[]', // JSON: [{ title, risk, services, implementationPlan, backoutPlan, testPlan }]

  // Branding
  'brand.color': '', // primary color #RRGGBB (empty = default blue)
  'brand.header': 'light', // light | color (header in the primary color)
  'brand.showTitle': true, // show title next to the logo
  'brand.logo': '', // "png:<hash>" | "svg:<hash>" – changeable only via /api/admin/brand/logo
  'login.textDe': '',
  'login.textEn': '',
  'login.userLabelDe': '',
  'login.userLabelEn': '',

  // Automatic sign-out after inactivity (minutes; 0 = not set). Everyone: 0 = HELFI_SESSION_HOURS.
  // Admins and requests from outside the company network can get a shorter period (the shortest counts).
  'session.idleMinutes': 0,
  'session.adminIdleMinutes': 60,
  'session.externalIdleMinutes': 0,
  'session.browserSession': false, // sign out when the browser is closed (cookie without expiry)

  // AI assistance for agents (OpenAI-compatible endpoint, e.g. Ollama): summary, reply suggestion, rewrite
  'ai.enabled': false,
  'ai.baseUrl': '', // e.g. http://ollama:11434/v1
  'ai.model': '',
  'ai.apiKey': '', // secret (optional; bound to ai.baseUrl)
  'ai.reasoning': 'low', // off | low | medium | high (reasoning models such as gpt-oss)
  'ai.includeInternal': false, // also send internal notes to the model
  'ai.maxChars': 12000, // ticket text sent at most (newest comments first)
  'ai.timeout': 90, // seconds
  // Which AI functions are offered (AI as a whole stays optional via ai.enabled)
  'ai.summary': true,
  'ai.reply': true,
  'ai.rewrite': true,
  'ai.classify': false, // component detection for new tickets that no rule matched
  'ai.classifyMode': 'suggest', // suggest (agent accepts) | auto (set directly, marked "by AI")
  'ai.kb': true, // help writing knowledge articles
  'ai.duplicates': false, // hint "possible duplicate of …" for new tickets

  // Self-registration (local accounts with role "user", confirmed by mail) and "forgot password"
  'register.enabled': false,
  'register.domains': '', // allowed mail domains (one per line, subdomains included); empty = all
  'register.approval': false, // new accounts stay inactive until an admin approves them
  'register.passwordReset': 'users', // off | users (local accounts with role "user") | all (also agents/admins)

  // Two-factor sign-in (TOTP)
  'mfa.mode': 'external', // off | external (required only from outside) | always
  'mfa.internalNetworks': '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7',
  'mfa.enrollExternal': false, // allow initial enrollment from outside (otherwise only in the internal network)
  'mfa.external': '', // required from outside: all | agents | admins | none (empty = derived from mfa.mode)
  'mfa.internal': '', // required in the internal network: none | admins | agents | all (empty = derived from mfa.mode)
  'mfa.ownAddresses': '', // own internet connection: public IPs/DynDNS names, treated as internal
  'mfa.trustSso': true, // deprecated (up to 1.12): replaced by mfa.ssoSecondFactor, migration 24 carries over the value
  // Does an SSO sign-in count as a second factor? never | confirmed (only if the provider reports MFA: amr/acr) | always
  'mfa.ssoSecondFactor': 'confirmed',
  'general.defaultLanguage': 'de', // de | en – for emails to senders without an account

  // Active Directory / LDAP
  'ldap.enabled': false,
  'ldap.host': '',
  'ldap.port': 636,
  'ldap.security': 'ldaps', // ldaps | starttls | none
  'ldap.tlsMode': 'pinned', // pinned (fetched certificate) | system | insecure
  'ldap.verifyHostname': true,
  'ldap.caPem': '',
  'ldap.caInfo': '',
  'ldap.baseDn': '',
  'ldap.bindDn': '',
  'ldap.bindPassword': '', // secret
  'ldap.userFilter': '(&(objectCategory=person)(objectClass=user)(sAMAccountName={{username}}))',
  'ldap.usernameAttr': 'sAMAccountName',
  'ldap.displayNameAttr': 'displayName',
  'ldap.emailAttr': 'mail',
  'ldap.nestedGroups': true,
  'ldap.adminGroup': '',
  'ldap.agentGroup': '',
  'ldap.userGroup': '', // empty = all users may sign in
  'ldap.timeoutMs': 8000,
  'ldap.peopleSearch': true, // search AD when adding participants (agents only, needs service account)

  // SSO (OpenID Connect – e.g. Microsoft Entra ID, ADFS, Keycloak, Authentik)
  'oidc.enabled': false,
  'oidc.issuer': '',
  'oidc.clientId': '',
  'oidc.clientSecret': '', // secret
  'oidc.scopes': 'openid profile email',
  'oidc.buttonLabel': 'Mit Firmenkonto anmelden',
  'oidc.usernameClaim': 'preferred_username',
  'oidc.mergeDomain': '', // e.g. firma.local: "m.muster@firma.local" = AD account "m.muster"; empty = never merge
  'oidc.groupsClaim': 'groups',
  'oidc.adminGroup': '',
  'oidc.agentGroup': '',
  'oidc.autoRedirect': false,
  'oidc.allowCreate': true,
  'oidc.mfaAcr': '', // acr values that count as MFA (comma-separated), in addition to amr
  'oidc.adIdClaim': '', // claim with the AD identifier (objectSid or objectGUID), e.g. onprem_sid – then merge only via that

  // Email fetching (IMAP)
  // Backup
  'backup.keep': 10, // keep this many backups per kind (1–100)

  'imap.enabled': false,
  'imap.host': '',
  'imap.port': 993,
  'imap.security': 'tls', // tls | starttls | none
  'imap.verifyTls': true,
  'imap.user': '',
  'imap.password': '', // secret
  'imap.folder': 'INBOX',
  'imap.processedFolder': '', // empty = only mark as read
  'imap.processedKeepDays': 0, // delete processed mails in the folder after X days; 0 = never, otherwise at least 7
  'imap.senderRules': '[]', // JSON: [{ pattern, action: noreply|ignore, project }] – see src/mail/rules.js
  'imap.ccParticipants': true, // To/CC recipients of new mails become request participants
  'imap.adLookup': true, // look up unknown senders in AD (only with active AD sign-in and service account)
  'imap.intervalSec': 60,
  'imap.keywordSince': '', // internal: since when processed mails get their own keyword
  'imap.project': '',
  'imap.maxAttachmentMb': 20,

  // Sending email (SMTP)
  'smtp.enabled': false,
  'smtp.host': '',
  'smtp.port': 587,
  'smtp.security': 'starttls', // tls | starttls | none
  'smtp.verifyTls': true,
  'smtp.user': '',
  'smtp.password': '', // secret
  'smtp.from': '',
  'smtp.fromName': 'Helfi.Space',
  'notify.reporterOnCreate': true,
  'notify.reporterOnComment': true,
  'notify.reporterOnDone': true,
  'notify.assignee': true,
  'notify.participantAdded': true, // mail to people added as participants on the web
  'notify.mention': true, // mail to people @-mentioned in a comment
};

export const SECRET_KEYS = new Set(['ldap.bindPassword', 'oidc.clientSecret', 'imap.password', 'smtp.password', 'ai.apiKey']);

const SECRET_PLACEHOLDER = '••••••••';

// Fields a stored secret is bound to
const SECRET_BOUND = {
  ldap: ['host', 'port', 'security', 'bindDn'],
  imap: ['host', 'port', 'security', 'user'],
  smtp: ['host', 'port', 'security', 'user'],
  oidc: ['issuer', 'clientId'],
  ai: ['baseUrl'],
};

// Weaker certificate validation also binds the secret (otherwise it could be captured via
// redirection/man-in-the-middle). Only switching to weaker validation counts –
// making it stricter does not need a new password.
const TLS_RANK = { insecure: 0, system: 1, pinned: 2 };
const SECRET_WEAKER = {
  // pinned → system/insecure and system → insecure are weaker; so is a different stored
  // certificate (that could slip in a custom CA) – then re-enter the password.
  ldap: {
    tlsMode: (o, n) => TLS_RANK[n ?? 'pinned'] < TLS_RANK[o ?? 'pinned'],
    verifyHostname: (o, n) => !!o && !n,
    caPem: (o, n) => String(o ?? '').trim() !== '' && String(o ?? '').trim() !== String(n ?? '').trim(),
  },
  imap: { verifyTls: (o, n) => !!o && !n },
  smtp: { verifyTls: (o, n) => !!o && !n },
};

/** Does a field change that the stored secret of a section is bound to? */
function secretBindingChanged(prefix, stored, next) {
  if ((SECRET_BOUND[prefix] || []).some((f) => String(next[f] ?? '') !== String(stored[f] ?? ''))) return true;
  return Object.entries(SECRET_WEAKER[prefix] || {}).some(([f, weaker]) => weaker(stored[f], next[f]));
}

export function createSettings(db) {
  const getStmt = db.prepare('SELECT value, secret FROM settings WHERE key=?');
  const setStmt = db.prepare(
    'INSERT INTO settings(key,value,secret) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, secret=excluded.secret',
  );

  function coerce(key, raw) {
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') return raw === true || raw === 'true' || raw === 1 || raw === '1';
    if (typeof def === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : def; }
    return raw === null || raw === undefined ? '' : String(raw);
  }

  function get(key) {
    if (!(key in DEFAULTS)) throw new Error(`Unbekannte Einstellung ${key}`);
    const row = getStmt.get(key);
    if (!row) return DEFAULTS[key];
    let value;
    if (row.secret) {
      try { value = decrypt(row.value); }
      catch {
        // Wrong key (HELFI_SECRET/secret.key changed): do not crash, let the password be re-entered
        log.warn(`Stored secret "${key}" cannot be decrypted (key changed?) – please enter it again.`);
        return '';
      }
    } else value = JSON.parse(row.value);
    return coerce(key, value);
  }

  function set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unbekannte Einstellung ${key}`);
    if (SECRET_KEYS.has(key)) {
      if (value === SECRET_PLACEHOLDER || value === undefined) return; // unchanged
      setStmt.run(key, encrypt(String(value ?? '')), 1);
    } else {
      setStmt.run(key, JSON.stringify(coerce(key, value)), 0);
    }
  }

  /** All settings of a section, e.g. group('ldap') → { host, port, ... } */
  function group(prefix) {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key.startsWith(prefix + '.')) out[key.slice(prefix.length + 1)] = get(key);
    }
    return out;
  }

  /** For the UI: secrets only as placeholders. */
  function publicView() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (SECRET_KEYS.has(key)) out[key] = get(key) ? SECRET_PLACEHOLDER : '';
      else out[key] = get(key);
    }
    return out;
  }

  function setMany(obj) {
    // If server/account is changed (or validation weakened), the stored secret no longer
    // applies: it must be re-entered in the same save – otherwise it would be sent to the
    // new (possibly foreign) server on the next connection.
    for (const prefix of Object.keys(SECRET_BOUND)) {
      const keys = Object.keys(obj).filter((k) => k.startsWith(prefix + '.') && k in DEFAULTS);
      if (!keys.length) continue;
      const stored = group(prefix);
      const next = { ...stored };
      for (const k of keys) if (!SECRET_KEYS.has(k)) next[k.slice(prefix.length + 1)] = coerce(k, obj[k]);
      if (!secretBindingChanged(prefix, stored, next)) continue;
      for (const k of SECRET_KEYS) {
        if (!k.startsWith(prefix + '.')) continue;
        const typed = obj[k] !== undefined && obj[k] !== SECRET_PLACEHOLDER;
        if (stored[k.slice(prefix.length + 1)] && !typed) throw new HttpError(400, 'err.secretRebind', k);
      }
    }
    db.transaction(() => {
      for (const [k, v] of Object.entries(obj)) if (k in DEFAULTS) set(k, v);
    })();
  }

  /**
   * Merge stored values + (not yet saved) form values for connection tests.
   * Placeholder = stored secret. If a different server/user is entered, the
   * stored secret is NOT sent (otherwise it could be captured via one's own server).
   */
  function mergedGroup(prefix, form = {}) {
    const stored = group(prefix);
    const cfg = { ...stored };
    const typedSecret = new Set();
    for (const [k, v] of Object.entries(form || {})) {
      if (!k.startsWith(prefix + '.') || !(k in DEFAULTS)) continue;
      const short = k.slice(prefix.length + 1);
      if (SECRET_KEYS.has(k)) {
        if (v === SECRET_PLACEHOLDER || v === undefined) continue;
        typedSecret.add(short);
      }
      cfg[short] = coerce(k, v);
    }
    if (secretBindingChanged(prefix, stored, cfg)) {
      for (const k of SECRET_KEYS) {
        const short = k.slice(prefix.length + 1);
        if (k.startsWith(prefix + '.') && !typedSecret.has(short)) cfg[short] = '';
      }
    }
    return cfg;
  }

  return { get, set, group, publicView, setMany, mergedGroup, SECRET_PLACEHOLDER };
}
