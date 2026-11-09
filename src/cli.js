#!/usr/bin/env node
/**
 * Emergency access from the Docker host – for when no admin can sign in any more
 * (password and second factor lost, no other admin, "forgot password" off or no mail).
 *
 *   docker compose exec helfi helfi-admin list
 *   docker compose exec helfi helfi-admin reset <name> [--generate] [--keep-2fa]
 *   docker compose exec helfi helfi-admin create <name> [--email a@firma.local] [--name "Vor Nachname"] [--generate]
 *
 * Only reachable with a shell on the Docker host (who has that can read the data folder anyway) –
 * never over the network. Every use is recorded (shown under Administration → System) and all admins
 * with an email address are informed. Works on local accounts only: AD/SSO accounts are managed there.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { paths } from './config.js';
import { SCHEMA_VERSION } from './db.js';
import { hashPassword, initMasterKey } from './lib/crypto.js';
import { createSettings } from './settings.js';
import { createMailer } from './mail/smtp.js';
import { t, normalizeLang } from './i18n.js';
import { addEmergencyLog } from './emergency.js';

const MIN_PASSWORD = 10;
const USERNAME = /^[A-Za-z0-9._@-]{2,64}$/;

const TEXT = {
  de: {
    usage: [
      'Notfallzugang für Helfi.Space (nur lokale Konten):',
      '',
      '  helfi-admin list                       lokale Admin-Konten anzeigen',
      '  helfi-admin reset <name>               neues Kennwort setzen, 2FA abschalten, Sitzungen beenden',
      '      --generate                         zufälliges Kennwort erzeugen statt fragen',
      '      --keep-2fa                         Zwei-Faktor-Anmeldung behalten',
      '      --password-stdin                   Kennwort aus der Standardeingabe lesen',
      '  helfi-admin create <name>              neuen lokalen Admin anlegen',
      '      --email <adresse>  --name "<Anzeigename>"  --generate  --password-stdin',
      '',
      'Aufruf auf dem Docker-Host:  docker compose exec helfi helfi-admin reset admin',
    ].join('\n'),
    noDb: 'Keine Datenbank gefunden ({file}). Läuft der Befehl im Helfi-Container?',
    schema: 'Datenbank (Schema {db}) und Programm (Schema {app}) passen nicht zusammen. Bitte erst den Container neu starten (Aktualisierung abschließen) und dann erneut versuchen.',
    listHead: 'Lokale Admin-Konten:',
    listNone: 'Keine lokalen Admin-Konten. Mit „helfi-admin create <name>“ einen anlegen.',
    listRow: '  {username}  ({name})  {state}  2FA: {mfa}  letzte Anmeldung: {last}',
    active: 'aktiv', inactive: 'deaktiviert', on: 'an', off: 'aus', never: 'nie',
    others: 'Dazu {n} Admin(s) aus AD/SSO.',
    noUser: 'Kein Konto „{name}“. Vorhandene lokale Admins: helfi-admin list',
    notLocal: '„{name}“ ist ein Konto aus {source} – Kennwort und Rolle werden dort verwaltet. Für einen lokalen Zugang: helfi-admin create <neuer-name>',
    notAdmin: '„{name}“ ist kein Admin (Rolle: {role}). Für einen Admin-Zugang: helfi-admin create <neuer-name>',
    badName: 'Ungültiger Name – erlaubt sind Buchstaben, Ziffern und . _ @ - (2 bis 64 Zeichen).',
    taken: 'Den Namen „{name}“ gibt es schon.',
    badEmail: 'Ungültige E-Mail-Adresse.',
    emailTaken: 'Die E-Mail-Adresse gehört schon zu einem anderen Konto.',
    ask1: 'Neues Kennwort (mindestens {n} Zeichen): ',
    ask2: 'Kennwort wiederholen: ',
    mismatch: 'Die Kennwörter stimmen nicht überein.',
    weak: 'Das Kennwort ist zu kurz (mindestens {n} Zeichen).',
    noTty: 'Keine Eingabe möglich (ohne -it gestartet?). Mit --generate ein zufälliges Kennwort erzeugen oder mit --password-stdin übergeben.',
    generated: 'Neues Kennwort für {name} (wird nur jetzt angezeigt):\n\n    {pw}\n\nBitte nach der Anmeldung unter Profil → Kennwort ändern.',
    resetDone: 'Fertig: „{name}“ hat ein neues Kennwort{mfa}, alle Sitzungen sind beendet. Anmelden unter {url}/login?local=1',
    mfaOff: ', die Zwei-Faktor-Anmeldung ist abgeschaltet (nach der Anmeldung neu einrichten)',
    createDone: 'Fertig: lokaler Admin „{name}“ angelegt. Anmelden unter {url}/login?local=1',
    lockHint: 'Hinweis: Eine Sperre nach zu vielen Fehlversuchen endet nach 15 Minuten oder sofort mit „docker compose restart helfi“.',
    mailed: 'Benachrichtigt: {n} Admin(s) per E-Mail.',
    noMail: 'Keine E-Mail verschickt (Postausgang nicht eingerichtet oder keine Admin-Adresse).',
    unknown: 'Unbekannter Befehl „{cmd}“.',
  },
  en: {
    usage: [
      'Emergency access for Helfi.Space (local accounts only):',
      '',
      '  helfi-admin list                       show local admin accounts',
      '  helfi-admin reset <name>               set a new password, switch off 2FA, end sessions',
      '      --generate                         generate a random password instead of asking',
      '      --keep-2fa                         keep two-factor sign-in',
      '      --password-stdin                   read the password from standard input',
      '  helfi-admin create <name>              create a new local admin',
      '      --email <address>  --name "<display name>"  --generate  --password-stdin',
      '',
      'Run on the Docker host:  docker compose exec helfi helfi-admin reset admin',
    ].join('\n'),
    noDb: 'No database found ({file}). Is the command running in the Helfi container?',
    schema: 'Database (schema {db}) and program (schema {app}) do not match. Restart the container first (finish the update), then try again.',
    listHead: 'Local admin accounts:',
    listNone: 'No local admin accounts. Create one with "helfi-admin create <name>".',
    listRow: '  {username}  ({name})  {state}  2FA: {mfa}  last sign-in: {last}',
    active: 'active', inactive: 'deactivated', on: 'on', off: 'off', never: 'never',
    others: 'Plus {n} admin(s) from AD/SSO.',
    noUser: 'No account "{name}". Existing local admins: helfi-admin list',
    notLocal: '"{name}" is an account from {source} – password and role are managed there. For local access: helfi-admin create <new-name>',
    notAdmin: '"{name}" is not an admin (role: {role}). For admin access: helfi-admin create <new-name>',
    badName: 'Invalid name – letters, digits and . _ @ - are allowed (2 to 64 characters).',
    taken: 'The name "{name}" already exists.',
    badEmail: 'Invalid email address.',
    emailTaken: 'The email address already belongs to another account.',
    ask1: 'New password (at least {n} characters): ',
    ask2: 'Repeat password: ',
    mismatch: 'The passwords do not match.',
    weak: 'The password is too short (at least {n} characters).',
    noTty: 'No input possible (started without -it?). Use --generate for a random password or pass it with --password-stdin.',
    generated: 'New password for {name} (shown only now):\n\n    {pw}\n\nPlease change it after signing in under Profile → Password.',
    resetDone: 'Done: "{name}" has a new password{mfa}, all sessions are ended. Sign in at {url}/login?local=1',
    mfaOff: ', two-factor sign-in is switched off (set it up again after signing in)',
    createDone: 'Done: local admin "{name}" created. Sign in at {url}/login?local=1',
    lockHint: 'Note: a lock after too many failed attempts ends after 15 minutes, or right away with "docker compose restart helfi".',
    mailed: 'Informed: {n} admin(s) by email.',
    noMail: 'No email sent (outgoing mail not set up or no admin address).',
    unknown: 'Unknown command "{cmd}".',
  },
};

class CliError extends Error {}

function fmt(s, vars = {}) { return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`)); }

function parseArgs(argv) {
  const out = { _: [], flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email' || a === '--name') out.opts[a.slice(2)] = argv[++i] ?? '';
    else if (a.startsWith('--')) out.flags.add(a.slice(2));
    else out._.push(a);
  }
  return out;
}

/** Random password: 20 characters without look-alikes (0/O, 1/l/I). */
export function generatePassword(len = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
  const bytes = crypto.randomBytes(len * 2);
  let pw = '';
  for (let i = 0; i < bytes.length && pw.length < len; i++) if (bytes[i] < 256 - (256 % chars.length)) pw += chars[bytes[i] % chars.length];
  return pw;
}

/** Reads a line without echo from the terminal. */
function askHidden(io, prompt) {
  return new Promise((resolve, reject) => {
    const input = io.stdin;
    io.stdout.write(prompt);
    let buf = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (err) => { input.setRawMode(wasRaw); input.pause(); input.removeListener('data', onData); io.stdout.write('\n'); err ? reject(err) : resolve(buf); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new CliError('abgebrochen / cancelled'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
      return undefined;
    };
    input.on('data', onData);
  });
}

async function readStdinLine(io) {
  let data = '';
  for await (const chunk of io.stdin) { data += chunk; if (data.includes('\n')) break; }
  return data.split(/\r?\n/)[0];
}

async function obtainPassword(io, L, flags) {
  if (flags.has('generate')) return { password: generatePassword(), generated: true };
  let pw;
  if (flags.has('password-stdin')) pw = await readStdinLine(io);
  else {
    if (!io.stdin.isTTY || typeof io.stdin.setRawMode !== 'function') throw new CliError(L.noTty);
    pw = await askHidden(io, fmt(L.ask1, { n: MIN_PASSWORD }));
    if (pw.length >= MIN_PASSWORD) {
      const again = await askHidden(io, L.ask2);
      if (again !== pw) throw new CliError(L.mismatch);
    }
  }
  if (!pw || pw.length < MIN_PASSWORD) throw new CliError(fmt(L.weak, { n: MIN_PASSWORD }));
  return { password: pw, generated: false };
}

function openDb(file) {
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Informs all active admins with an email address (best effort; needs the key for the SMTP password). */
async function informAdmins(db, { action, username }) {
  try {
    if (!process.env.HELFI_SECRET && !fs.existsSync(paths.secretKey)) return 0;
    initMasterKey();
    const settings = createSettings(db);
    const mailer = createMailer(db, settings);
    const app = settings.get('general.title') || 'Helfi.Space';
    const admins = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1 AND email IS NOT NULL AND email<>''").all();
    let sent = 0;
    for (const a of admins) {
      const lang = normalizeLang(a.language, settings.get('general.defaultLanguage'));
      const vars = { app, name: username, action: t(lang, `mail.emergency.${action}`), at: new Date().toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE') };
      // eslint-disable-next-line no-await-in-loop
      if (await mailer.send({ to: a.email, subject: t(lang, 'mail.emergency.subject', vars), text: t(lang, 'mail.emergency.body', vars) })) sent++;
    }
    return sent;
  } catch { return 0; }
}

/**
 * Runs the command. io: { stdin, stdout, stderr }; returns the exit code (0 = ok).
 * dbFile only for tests.
 */
export async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, { dbFile = paths.db, baseUrl = process.env.HELFI_BASE_URL || '' } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'help';
  let db = null;
  let L = TEXT.de;
  const say = (s) => io.stdout.write(`${s}\n`);
  try {
    db = openDb(dbFile);
    if (db) {
      try {
        const lang = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='general.defaultLanguage'").get()?.value || '"de"');
        L = TEXT[normalizeLang(lang)] || TEXT.de;
      } catch { /* default German */ }
    }
    if (cmd === 'help' || args.flags.has('help')) { say(L.usage); return 0; }
    if (!db) throw new CliError(fmt(L.noDb, { file: dbFile }));
    const schema = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0);
    if (schema !== SCHEMA_VERSION) throw new CliError(fmt(L.schema, { db: schema, app: SCHEMA_VERSION }));
    const url = (baseUrl || '').replace(/\/+$/, '') || 'https://<helfi>';
    const byName = (n) => db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(n);

    if (cmd === 'list') {
      const rows = db.prepare("SELECT * FROM users WHERE role='admin' AND source='local' ORDER BY username").all();
      if (!rows.length) say(L.listNone);
      else {
        say(L.listHead);
        for (const u of rows) {
          say(fmt(L.listRow, {
            username: u.username, name: u.display_name, state: u.active ? L.active : L.inactive,
            mfa: u.totp_enabled ? L.on : L.off, last: u.last_login ? u.last_login.slice(0, 16).replace('T', ' ') : L.never,
          }));
        }
      }
      const other = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND source<>'local' AND active=1").get().n;
      if (other) say(fmt(L.others, { n: other }));
      return 0;
    }

    if (cmd === 'reset') {
      const name = args._[1];
      if (!name) { say(L.usage); return 2; }
      const u = byName(name);
      if (!u) throw new CliError(fmt(L.noUser, { name }));
      if (u.source !== 'local') throw new CliError(fmt(L.notLocal, { name: u.username, source: u.source === 'ldap' ? 'Active Directory' : u.source.toUpperCase() }));
      if (u.role !== 'admin') throw new CliError(fmt(L.notAdmin, { name: u.username, role: u.role }));
      const { password, generated } = await obtainPassword(io, L, args.flags);
      const keep2fa = args.flags.has('keep-2fa');
      db.transaction(() => {
        db.prepare('UPDATE users SET password_hash=?, active=1, approval_pending=0 WHERE id=?').run(hashPassword(password), u.id);
        if (!keep2fa) db.prepare('UPDATE users SET totp_secret=NULL, totp_enabled=0, totp_last_step=0, recovery_codes=NULL WHERE id=?').run(u.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
        addEmergencyLog(db, { at: new Date().toISOString(), action: 'reset', username: u.username, mfaReset: !keep2fa });
      })();
      if (generated) say(`\n${fmt(L.generated, { name: u.username, pw: password })}\n`);
      say(fmt(L.resetDone, { name: u.username, mfa: keep2fa ? '' : L.mfaOff, url }));
      say(L.lockHint);
      const sent = await informAdmins(db, { action: 'reset', username: u.username });
      say(sent ? fmt(L.mailed, { n: sent }) : L.noMail);
      return 0;
    }

    if (cmd === 'create') {
      const name = args._[1];
      if (!name) { say(L.usage); return 2; }
      if (!USERNAME.test(name)) throw new CliError(L.badName);
      if (byName(name)) throw new CliError(fmt(L.taken, { name }));
      const email = String(args.opts.email || '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CliError(L.badEmail);
      if (email && db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(email)) throw new CliError(L.emailTaken);
      const { password, generated } = await obtainPassword(io, L, args.flags);
      db.transaction(() => {
        db.prepare("INSERT INTO users(username,display_name,email,role,source,password_hash) VALUES(?,?,?,'admin','local',?)")
          .run(name, String(args.opts.name || '').trim().slice(0, 120) || name, email || null, hashPassword(password));
        addEmergencyLog(db, { at: new Date().toISOString(), action: 'create', username: name });
      })();
      if (generated) say(`\n${fmt(L.generated, { name, pw: password })}\n`);
      say(fmt(L.createDone, { name, url }));
      const sent = await informAdmins(db, { action: 'create', username: name });
      say(sent ? fmt(L.mailed, { n: sent }) : L.noMail);
      return 0;
    }

    throw new CliError(`${fmt(L.unknown, { cmd })}\n\n${L.usage}`);
  } catch (e) {
    io.stderr.write(`${e instanceof CliError ? e.message : `Fehler / Error: ${e.message}`}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

// Started directly (helfi-admin / node src/cli.js)
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
