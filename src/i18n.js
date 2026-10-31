// Serverseitige Texte (Fehlermeldungen und E-Mails) auf Deutsch und Englisch.
// Die Oberfläche hat ihre eigenen Texte in public/js/i18n.js.
export const LANGUAGES = ['de', 'en'];

const T = {
  de: {
    // Fehler
    'err.unauthorized': 'Bitte melde dich an.',
    'err.forbidden': 'Dafür fehlt dir die Berechtigung.',
    'err.notFound': 'Nicht gefunden.',
    'err.badRequest': 'Ungültige Anfrage.',
    'err.csrf': 'Sicherheitsprüfung fehlgeschlagen. Bitte Seite neu laden.',
    'err.invalidLogin': 'Benutzername oder Kennwort falsch.',
    'err.tooManyAttempts': 'Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen.',
    'err.accountDisabled': 'Dieses Konto ist deaktiviert.',
    'err.notInGroup': 'Dein Konto ist für Helfi.Space nicht freigeschaltet (Gruppe fehlt).',
    'err.setupDone': 'Die Ersteinrichtung ist bereits abgeschlossen.',
    'err.setupToken': 'Der Einrichtungscode ist falsch. Er steht im Container-Protokoll (docker compose logs helfi).',
    'err.passwordWeak': 'Das Kennwort muss mindestens 10 Zeichen lang sein.',
    'err.usernameTaken': 'Dieser Benutzername ist bereits vergeben.',
    'err.projectKey': 'Der Projektschlüssel muss aus 2–10 Großbuchstaben/Ziffern bestehen und mit einem Buchstaben beginnen.',
    'err.projectKeyTaken': 'Dieser Projektschlüssel ist bereits vergeben.',
    'err.titleRequired': 'Bitte eine Zusammenfassung eingeben.',
    'err.noProject': 'Es gibt noch kein Projekt. Ein Admin muss zuerst eins anlegen.',
    'err.selfServiceOff': 'Das Anlegen von Tickets ist für dich nicht freigegeben.',
    'err.lastAdmin': 'Der letzte aktive Admin kann nicht entfernt oder herabgestuft werden.',
    'err.ldapDisabled': 'Die AD-Anbindung ist nicht aktiviert.',
    'err.ldapUnavailable': 'Das Active Directory ist gerade nicht erreichbar. Lokale Konten können sich weiterhin anmelden.',
    'err.oidcDisabled': 'SSO ist nicht aktiviert.',
    'err.oidcFailed': 'Die SSO-Anmeldung ist fehlgeschlagen.',
    'err.oidcNoAccount': 'Für dieses Konto gibt es keinen Zugang zu Helfi.Space.',
    'err.mailDisabled': 'Der E-Mail-Versand ist nicht eingerichtet.',
    'err.fileTooLarge': 'Die Datei ist zu groß.',
    'err.internal': 'Interner Fehler. Details stehen im Protokoll.',
    'err.importRunning': 'Es läuft bereits ein Import.',
    // E-Mails
    'mail.created.subject': '[{key}] Ihr Ticket wurde angelegt: {title}',
    'mail.created.body': 'Hallo {name},\n\nvielen Dank für Ihre Nachricht. Wir haben dazu das Ticket {key} angelegt und kümmern uns darum.\n\nWenn Sie auf diese E-Mail antworten, landet Ihre Antwort automatisch im Ticket. Bitte lassen Sie die Ticketnummer [{key}] im Betreff stehen.\n\n{link}\n\nViele Grüße\n{app}',
    'mail.comment.subject': '[{key}] Neue Antwort: {title}',
    'mail.comment.body': 'Hallo {name},\n\n{author} hat auf Ihr Ticket {key} geantwortet:\n\n{body}\n\n---\nAntworten Sie einfach auf diese E-Mail, um zu reagieren.\n{link}\n\n{app}',
    'mail.done.subject': '[{key}] Erledigt: {title}',
    'mail.done.body': 'Hallo {name},\n\nIhr Ticket {key} „{title}“ wurde als erledigt markiert.\n\nFalls noch etwas offen ist, antworten Sie einfach auf diese E-Mail – das Ticket wird dann wieder geöffnet.\n\n{link}\n\n{app}',
    'mail.assigned.subject': '[{key}] Dir zugewiesen: {title}',
    'mail.assigned.body': 'Hallo {name},\n\ndas Ticket {key} „{title}“ wurde dir zugewiesen.\n\n{link}\n\n{app}',
    'mail.test.subject': 'Helfi.Space – Test-E-Mail',
    'mail.test.body': 'Diese Test-E-Mail bestätigt, dass der Versand aus Helfi.Space funktioniert.',
    'mail.greetingFallback': 'zusammen',
  },
  en: {
    'err.unauthorized': 'Please sign in.',
    'err.forbidden': 'You do not have permission to do that.',
    'err.notFound': 'Not found.',
    'err.badRequest': 'Invalid request.',
    'err.csrf': 'Security check failed. Please reload the page.',
    'err.invalidLogin': 'Wrong username or password.',
    'err.tooManyAttempts': 'Too many failed attempts. Please try again in a few minutes.',
    'err.accountDisabled': 'This account is disabled.',
    'err.notInGroup': 'Your account is not enabled for Helfi.Space (missing group membership).',
    'err.setupDone': 'Initial setup has already been completed.',
    'err.setupToken': 'The setup code is wrong. You can find it in the container log (docker compose logs helfi).',
    'err.passwordWeak': 'The password must be at least 10 characters long.',
    'err.usernameTaken': 'This username is already taken.',
    'err.projectKey': 'The project key must be 2–10 uppercase letters/digits and start with a letter.',
    'err.projectKeyTaken': 'This project key is already taken.',
    'err.titleRequired': 'Please enter a summary.',
    'err.noProject': 'There is no project yet. An admin has to create one first.',
    'err.selfServiceOff': 'You are not allowed to create tickets.',
    'err.lastAdmin': 'The last active admin cannot be removed or demoted.',
    'err.ldapDisabled': 'Active Directory integration is not enabled.',
    'err.ldapUnavailable': 'Active Directory is currently unreachable. Local accounts can still sign in.',
    'err.oidcDisabled': 'SSO is not enabled.',
    'err.oidcFailed': 'SSO sign-in failed.',
    'err.oidcNoAccount': 'This account has no access to Helfi.Space.',
    'err.mailDisabled': 'Outgoing mail is not configured.',
    'err.fileTooLarge': 'The file is too large.',
    'err.internal': 'Internal error. See the log for details.',
    'err.importRunning': 'An import is already running.',
    'mail.created.subject': '[{key}] Your ticket has been created: {title}',
    'mail.created.body': 'Hello {name},\n\nthank you for your message. We have created ticket {key} and will take care of it.\n\nIf you reply to this email, your answer is added to the ticket automatically. Please keep the ticket number [{key}] in the subject.\n\n{link}\n\nKind regards\n{app}',
    'mail.comment.subject': '[{key}] New reply: {title}',
    'mail.comment.body': 'Hello {name},\n\n{author} replied to your ticket {key}:\n\n{body}\n\n---\nSimply reply to this email to respond.\n{link}\n\n{app}',
    'mail.done.subject': '[{key}] Resolved: {title}',
    'mail.done.body': 'Hello {name},\n\nyour ticket {key} "{title}" has been marked as resolved.\n\nIf anything is still open, just reply to this email and the ticket will be reopened.\n\n{link}\n\n{app}',
    'mail.assigned.subject': '[{key}] Assigned to you: {title}',
    'mail.assigned.body': 'Hello {name},\n\nticket {key} "{title}" has been assigned to you.\n\n{link}\n\n{app}',
    'mail.test.subject': 'Helfi.Space – test email',
    'mail.test.body': 'This test email confirms that sending mail from Helfi.Space works.',
    'mail.greetingFallback': 'there',
  },
};

export function normalizeLang(value, fallback = 'de') {
  const v = String(value || '').toLowerCase().slice(0, 2);
  return LANGUAGES.includes(v) ? v : fallback;
}

/** Wählt die Sprache aus dem Accept-Language-Header. */
export function langFromHeader(header, fallback = 'de') {
  if (!header) return fallback;
  const parts = String(header).split(',').map((p) => {
    const [tag, q] = p.trim().split(';q=');
    return { tag: tag.toLowerCase().slice(0, 2), q: q ? Number(q) : 1 };
  }).sort((a, b) => b.q - a.q);
  return parts.find((p) => LANGUAGES.includes(p.tag))?.tag || fallback;
}

export function t(lang, key, vars = {}) {
  const dict = T[normalizeLang(lang)] || T.de;
  const s = dict[key] ?? T.de[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

export function hasKey(key) { return key in T.de; }
export const _dicts = T;
