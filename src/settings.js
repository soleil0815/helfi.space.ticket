// Einstellungen in der Datenbank. Vorgaben stehen hier im Programm,
// damit die docker-compose.yml stabil bleibt.
import { encrypt, decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';
import { HttpError } from './lib/http.js';

export const DEFAULTS = {
  // Allgemein
  'general.title': 'Helfi.Space',
  'general.defaultProject': '',
  'general.allowSelfService': true, // Benutzer (Rolle "user") dürfen Tickets anlegen
  'general.defaultLanguage': 'de', // de | en – für E-Mails an Absender ohne Konto

  // Anmeldeseite (Text ohne HTML; **fett**, Links und Mailadressen werden erkannt)
  'login.title': '',
  // Service Level (SLA): Ziele in Geschäftsminuten je Priorität
  // Zufriedenheitsumfrage: Bewertungslinks in der „Erledigt“-Mail an den Melder
  'survey.enabled': false,
  'survey.days': 14, // so lange gilt der Link
  'sla.enabled': false,
  'sla.hours': '{"days":[1,2,3,4,5],"start":"08:00","end":"17:00"}',
  'sla.holidays': '', // eine Zeile je Feiertag: JJJJ-MM-TT Name
  'sla.targets': '{"highest":{"response":30,"resolve":240},"high":{"response":120,"resolve":960},"medium":{"response":480,"resolve":2400},"low":{"response":960,"resolve":4800}}',
  'sla.pauseWaiting': true, // „Wartet“ hält die Lösungsuhr an
  'sla.warnPercent': 80,

  // Change-Management
  'change.approvers': '', // Benutzer-IDs der Genehmiger (CAB), durch Komma getrennt
  'change.approvalMode': 'any', // any = eine Zustimmung genügt, all = alle müssen zustimmen
  'change.standardTemplates': '[]', // JSON: [{ title, risk, services, implementationPlan, backoutPlan, testPlan }]

  // Erscheinungsbild
  'brand.color': '', // Hauptfarbe #RRGGBB (leer = Standardblau)
  'brand.header': 'light', // light | color (Kopfzeile in der Hauptfarbe)
  'brand.showTitle': true, // Titel neben dem Logo anzeigen
  'brand.logo': '', // "png:<hash>" | "svg:<hash>" – nur über /api/admin/brand/logo änderbar
  'login.textDe': '',
  'login.textEn': '',
  'login.userLabelDe': '',
  'login.userLabelEn': '',

  // Zwei-Faktor-Anmeldung (TOTP)
  'mfa.mode': 'external', // off | external (nur von außerhalb Pflicht) | always
  'mfa.internalNetworks': '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7',
  'mfa.enrollExternal': false, // Ersteinrichtung von außen erlauben (sonst nur im internen Netz)
  'mfa.external': '', // Pflicht von außen: all | agents | admins | none (leer = aus mfa.mode abgeleitet)
  'mfa.internal': '', // Pflicht im internen Netz: none | admins | agents | all (leer = aus mfa.mode abgeleitet)
  'mfa.ownAddresses': '', // eigener Internetanschluss: öffentliche IPs/DynDNS-Namen, gelten als intern
  'mfa.trustSso': true, // SSO-Anmeldungen gelten als zweiter Faktor (MFA beim Identitätsanbieter)
  'general.defaultLanguage': 'de', // de | en – für E-Mails an Absender ohne Konto

  // Active Directory / LDAP
  'ldap.enabled': false,
  'ldap.host': '',
  'ldap.port': 636,
  'ldap.security': 'ldaps', // ldaps | starttls | none
  'ldap.tlsMode': 'pinned', // pinned (abgerufenes Zertifikat) | system | insecure
  'ldap.verifyHostname': true,
  'ldap.caPem': '',
  'ldap.caInfo': '',
  'ldap.baseDn': '',
  'ldap.bindDn': '',
  'ldap.bindPassword': '', // geheim
  'ldap.userFilter': '(&(objectCategory=person)(objectClass=user)(sAMAccountName={{username}}))',
  'ldap.usernameAttr': 'sAMAccountName',
  'ldap.displayNameAttr': 'displayName',
  'ldap.emailAttr': 'mail',
  'ldap.nestedGroups': true,
  'ldap.adminGroup': '',
  'ldap.agentGroup': '',
  'ldap.userGroup': '', // leer = alle Benutzer dürfen sich anmelden
  'ldap.timeoutMs': 8000,
  'ldap.peopleSearch': true, // Teilnehmer beim Hinzufügen im AD suchen (nur Bearbeiter, braucht Dienstkonto)

  // SSO (OpenID Connect – z. B. Microsoft Entra ID, ADFS, Keycloak, Authentik)
  'oidc.enabled': false,
  'oidc.issuer': '',
  'oidc.clientId': '',
  'oidc.clientSecret': '', // geheim
  'oidc.scopes': 'openid profile email',
  'oidc.buttonLabel': 'Mit Firmenkonto anmelden',
  'oidc.usernameClaim': 'preferred_username',
  'oidc.mergeDomain': '', // z. B. firma.local: "m.muster@firma.local" = AD-Konto "m.muster"; leer = nie zusammenführen
  'oidc.groupsClaim': 'groups',
  'oidc.adminGroup': '',
  'oidc.agentGroup': '',
  'oidc.autoRedirect': false,
  'oidc.allowCreate': true,

  // E-Mail-Abruf (IMAP)
  // Sicherung
  'backup.keep': 10, // je Art so viele Sicherungen aufbewahren (1–100)

  'imap.enabled': false,
  'imap.host': '',
  'imap.port': 993,
  'imap.security': 'tls', // tls | starttls | none
  'imap.verifyTls': true,
  'imap.user': '',
  'imap.password': '', // geheim
  'imap.folder': 'INBOX',
  'imap.processedFolder': '', // leer = nur als gelesen markieren
  'imap.processedKeepDays': 0, // verarbeitete Mails im Ordner nach X Tagen löschen; 0 = nie, sonst mind. 7
  'imap.senderRules': '[]', // JSON: [{ pattern, action: noreply|ignore, project }] – siehe src/mail/rules.js
  'imap.ccParticipants': true, // An/CC-Empfänger neuer Mails werden Anfrage-Teilnehmer
  'imap.adLookup': true, // unbekannte Absender im AD suchen (nur mit aktiver AD-Anmeldung und Dienstkonto)
  'imap.intervalSec': 60,
  'imap.project': '',
  'imap.maxAttachmentMb': 20,

  // E-Mail-Versand (SMTP)
  'smtp.enabled': false,
  'smtp.host': '',
  'smtp.port': 587,
  'smtp.security': 'starttls', // tls | starttls | none
  'smtp.verifyTls': true,
  'smtp.user': '',
  'smtp.password': '', // geheim
  'smtp.from': '',
  'smtp.fromName': 'Helfi.Space',
  'notify.reporterOnCreate': true,
  'notify.reporterOnComment': true,
  'notify.reporterOnDone': true,
  'notify.assignee': true,
  'notify.participantAdded': true, // Mail an Personen, die im Web als Teilnehmer hinzugefügt werden
};

export const SECRET_KEYS = new Set(['ldap.bindPassword', 'oidc.clientSecret', 'imap.password', 'smtp.password']);

const SECRET_PLACEHOLDER = '••••••••';

// Felder, an die ein gespeichertes Geheimnis gebunden ist
const SECRET_BOUND = {
  ldap: ['host', 'port', 'security', 'bindDn'],
  imap: ['host', 'port', 'security', 'user'],
  smtp: ['host', 'port', 'security', 'user'],
  oidc: ['issuer', 'clientId'],
};

// Schwächere Zertifikatsprüfung bindet das Geheimnis ebenfalls (sonst ließe es sich per
// Umleitung/Zwischenstelle abgreifen). Nur der Wechsel zur schwächeren Prüfung zählt –
// Strenger stellen braucht kein neues Kennwort.
const TLS_RANK = { insecure: 0, system: 1, pinned: 2 };
const SECRET_WEAKER = {
  // pinned → system/insecure und system → insecure sind schwächer; ein anderes hinterlegtes
  // Zertifikat ebenso (damit ließe sich eine eigene CA unterschieben) – dann Kennwort neu eingeben.
  ldap: {
    tlsMode: (o, n) => TLS_RANK[n ?? 'pinned'] < TLS_RANK[o ?? 'pinned'],
    verifyHostname: (o, n) => !!o && !n,
    caPem: (o, n) => String(o ?? '').trim() !== '' && String(o ?? '').trim() !== String(n ?? '').trim(),
  },
  imap: { verifyTls: (o, n) => !!o && !n },
  smtp: { verifyTls: (o, n) => !!o && !n },
};

/** Ändert sich ein Feld, an das das gespeicherte Geheimnis eines Bereichs gebunden ist? */
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
        // Falscher Schlüssel (HELFI_SECRET/secret.key geändert): nicht abstürzen, Kennwort neu eingeben lassen
        log.warn(`Gespeichertes Geheimnis „${key}“ lässt sich nicht entschlüsseln (Schlüssel geändert?) – bitte neu eingeben.`);
        return '';
      }
    } else value = JSON.parse(row.value);
    return coerce(key, value);
  }

  function set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unbekannte Einstellung ${key}`);
    if (SECRET_KEYS.has(key)) {
      if (value === SECRET_PLACEHOLDER || value === undefined) return; // unverändert
      setStmt.run(key, encrypt(String(value ?? '')), 1);
    } else {
      setStmt.run(key, JSON.stringify(coerce(key, value)), 0);
    }
  }

  /** Alle Einstellungen eines Bereichs, z. B. group('ldap') → { host, port, ... } */
  function group(prefix) {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key.startsWith(prefix + '.')) out[key.slice(prefix.length + 1)] = get(key);
    }
    return out;
  }

  /** Für die Oberfläche: Geheimnisse nur als Platzhalter. */
  function publicView() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (SECRET_KEYS.has(key)) out[key] = get(key) ? SECRET_PLACEHOLDER : '';
      else out[key] = get(key);
    }
    return out;
  }

  function setMany(obj) {
    // Wird Server/Konto geändert (oder die Prüfung abgeschwächt), gilt das gespeicherte Geheimnis
    // nicht mehr: es muss im selben Speichervorgang neu eingegeben werden – sonst würde es beim
    // nächsten Verbindungsaufbau an den neuen (womöglich fremden) Server geschickt.
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
   * Gespeicherte Werte + (noch nicht gespeicherte) Formularwerte für Verbindungstests zusammenführen.
   * Platzhalter = gespeichertes Geheimnis. Wird ein anderer Server/Benutzer eingetragen, wird das
   * gespeicherte Geheimnis NICHT mitgeschickt (sonst ließe es sich über einen eigenen Server abgreifen).
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
