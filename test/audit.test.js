// Regressionstests zu den Funden des Code-Audits (jeder Test scheitert am Stand vor dem Audit)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-audit-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase, verifyKey, WrongKeyError, pruneBackups, backupDatabase, KEEP_VERSION_BACKUPS } = await import('../src/db.js');
const cryptoLib = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { buildUserFilter, normalizeDn } = await import('../src/auth/ldap.js');
const { totpAt, currentStep } = await import('../src/auth/totp.js');

const INTERN = '10.0.10.25';
const EXTERN = '203.0.113.9';
let server; let base; let db; let ctx;

before(async () => {
  cryptoLib.initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client(ip = INTERN) {
  const jar = {};
  const fn = async (method, url, body, { raw = false, headers = {} } = {}) => {
    const h = { 'X-Helfi-Request': '1', 'X-Forwarded-For': ip, ...headers };
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    const r = await fetch(base + url, { method, headers: h, body: raw ? body : (body !== undefined ? JSON.stringify(body) : undefined) });
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const [k, v] = kv.split('=');
      if (/Expires=Thu, 01 Jan 1970/i.test(sc) || v === '') delete jar[k]; else jar[k] = v;
    }
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  fn.jar = jar;
  return fn;
}
const admin = client();
const agent = client();
const user = client();

test('Vorbereitung', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  await admin('POST', '/api/users', { username: 'anna', displayName: 'Anna', email: 'anna@firma.local', role: 'agent', password: 'Sehrgeheim123' });
  await admin('POST', '/api/users', { username: 'karl', displayName: 'Karl', email: 'karl@firma.local', role: 'user', password: 'Sehrgeheim123' });
  assert.equal((await agent('POST', '/api/auth/login', { username: 'anna', password: 'Sehrgeheim123' })).status, 200);
  assert.equal((await user('POST', '/api/auth/login', { username: 'karl', password: 'Sehrgeheim123' })).status, 200);
});

// ---------- Anmeldung ----------
test('SSO-Konto mit frei wählbarem Namen übernimmt nie ein AD-Konto (Audit 1.1)', () => {
  const U = ctx.users;
  // Angreifer meldet sich zuerst per SSO als "m.muster" an (Name nicht vertrauenswürdig)
  const evil = U.upsertExternal({ source: 'oidc', username: 'oidc:m.muster', displayName: 'Böse', externalId: 'idp|evil', role: null, trustName: false, trustEmail: false });
  const real = U.upsertExternal({ source: 'ldap', username: 'm.muster', displayName: 'Max', email: 'm.muster@firma.local', externalId: 'guid-m', role: 'admin' });
  assert.notEqual(evil.id, real.id);
  assert.equal(U.byId(evil.id).role, 'user');
  // Auch ein früheres Konto "oidc:..." wird von AD nie übernommen
  const ad2 = U.upsertExternal({ source: 'ldap', username: 'oidc:m.muster', displayName: 'X', externalId: 'guid-x', role: 'admin' });
  assert.notEqual(ad2.id, evil.id);
});

test('Bremse für den zweiten Faktor wird durch richtiges Kennwort nicht zurückgesetzt (Audit 1.2)', async () => {
  // Anna richtet 2FA ein (intern)
  const s = await agent('POST', '/api/me/mfa/setup');
  await agent('POST', '/api/me/mfa/enable', { code: totpAt(s.body.secret, currentStep()) });
  let blocked = false;
  for (let round = 0; round < 4 && !blocked; round++) {
    const ext = client(EXTERN);
    const r = await ext('POST', '/api/auth/login', { username: 'anna', password: 'Sehrgeheim123' });
    if (r.status === 429) { blocked = true; break; }
    for (let i = 0; i < 5; i++) {
      const v = await ext('POST', '/api/auth/mfa', { code: String(200000 + round * 10 + i) });
      if (v.status === 429) { blocked = true; break; }
    }
  }
  assert.equal(blocked, true, 'nach ~8 falschen Codes ist Schluss, egal wie oft das Kennwort neu eingegeben wird');
  ctx.limiter.success(EXTERN, 'mfa~anna');
  ctx.limiter.success(EXTERN, 'anna');
});

test('Eingerichteter zweiter Faktor lässt sich nicht ohne alten Code ersetzen (Audit 1.3)', async () => {
  const r = await agent('POST', '/api/me/mfa/setup');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'err.mfaAlreadyEnabled');
});

test('Kennwortwechsel beendet andere Sitzungen; erst prüfen, dann speichern (Audit 1.4, 2.2)', async () => {
  const other = client();
  await other('POST', '/api/auth/login', { username: 'karl', password: 'Sehrgeheim123' });
  assert.equal((await other('GET', '/api/me')).status, 200);
  // Falsches aktuelles Kennwort: Sprache darf nicht gespeichert werden
  const bad = await user('PATCH', '/api/me', { language: 'en', currentPassword: 'falsch', newPassword: 'NeuesKennwort123' });
  assert.equal(bad.status, 400);
  assert.equal(ctx.users.byName('karl').language, null);
  const ok = await user('PATCH', '/api/me', { currentPassword: 'Sehrgeheim123', newPassword: 'NeuesKennwort123' });
  assert.equal(ok.status, 200);
  assert.equal((await user('GET', '/api/me')).status, 200, 'eigene Sitzung bleibt');
  assert.equal((await other('GET', '/api/me')).status, 401, 'andere Sitzung beendet');
});

test('LDAP-Filter: $-Muster im Namen verändern den Filter nicht (Audit 3.10); DN-Vergleich (1.7)', () => {
  const t = '(&(objectClass=user)(sAMAccountName={{username}}))';
  assert.equal(buildUserFilter(t, "x$'"), "(&(objectClass=user)(sAMAccountName=x$'))");
  assert.equal(buildUserFilter(t, 'a$&b'), '(&(objectClass=user)(sAMAccountName=a$&b))');
  assert.equal(buildUserFilter(t, 'a*)(b'), '(&(objectClass=user)(sAMAccountName=a\\2a\\29\\28b))');
  assert.equal(normalizeDn('CN=Helfi-Admins, OU=Gruppen , DC=firma,DC=local'), normalizeDn('cn=helfi-admins,ou=gruppen,dc=firma,dc=local'));
});

// ---------- Web/API ----------
test('Benutzer ändern: bei Fehler wird nichts gespeichert (Audit 2.1)', async () => {
  const karl = ctx.users.byName('karl');
  const r = await admin('PATCH', `/api/users/${karl.id}`, { role: 'admin', password: 'kurz' });
  assert.equal(r.status, 400);
  assert.equal(ctx.users.byId(karl.id).role, 'user', 'Rolle unverändert');
});

test('Ungültige Eingaben ergeben 400 statt 500 (Audit 2.3–2.9)', async () => {
  // fehlender Body
  const anon = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'X-Helfi-Request': '1' } });
  assert.equal(anon.status, 401);
  // limit
  assert.equal((await agent('GET', '/api/tickets?limit=1.5')).status, 200);
  assert.equal((await agent('GET', '/api/tickets?limit=-Infinity')).status, 200);
  // Objekte statt Text
  assert.equal((await agent('POST', '/api/tickets', { title: { toString: 1 } })).status, 400);
  const u = await admin('POST', '/api/users', { username: 'x1', email: {}, password: 'Sehrgeheim123' });
  assert.equal(u.status, 201);
  assert.notEqual(u.body.user.email, '[object Object]');
  // Projektleitung, die es nicht gibt
  assert.equal((await admin('POST', '/api/projects', { key: 'ZZ', name: 'Z', leadId: 99999 })).status, 400);
  // Bearbeiter / Datum
  const t = (await agent('POST', '/api/tickets', { title: 'Prüf' })).body.ticket;
  assert.equal((await agent('PATCH', `/api/tickets/${t.key}`, { assigneeId: 'abc' })).status, 400);
  assert.equal((await agent('PATCH', `/api/tickets/${t.key}`, { dueDate: '<b>xx</b>' })).status, 400);
  assert.equal((await agent('PATCH', `/api/tickets/${t.key}`, { dueDate: '2026-12-24' })).body.ticket.dueDate, '2026-12-24');
  // Upload mit falschem Feldnamen
  const fd = new FormData();
  fd.append('falsch', new Blob(['x']), 'a.txt');
  assert.equal((await agent('POST', `/api/tickets/${t.key}/attachments`, fd, { raw: true })).status, 400);
});

test('Benutzer sehen die E-Mail des Bearbeiters nicht (Audit 2.11); CSP form-action (2.12)', async () => {
  const t = (await user('POST', '/api/tickets', { title: 'Meins' })).body.ticket;
  const anna = ctx.users.byName('anna');
  await agent('PATCH', `/api/tickets/${t.key}`, { assigneeId: anna.id });
  const seen = (await user('GET', `/api/tickets/${t.key}`)).body.ticket;
  assert.equal(seen.assignee.displayName, 'Anna');
  assert.equal(seen.assignee.email, undefined);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /form-action 'self'(;|$)/);
});

// ---------- E-Mail ----------
const mail = async (raw) => ctx.processor.process(await ctx.processor.parse(Buffer.from(raw.join('\r\n'))));

test('Antwort über eingehende Message-ID landet nicht im fremden Ticket (Audit 3.1)', async () => {
  const first = await mail(['From: paula@kunde.example', 'Subject: Hilfe', 'Message-ID: <orig-1@kunde.example>', '', 'Text']);
  const r = await mail(['From: mallory@boese.example', 'Subject: Re: Hilfe', 'In-Reply-To: <orig-1@kunde.example>', 'Message-ID: <m-1@boese.example>', '', 'Ich auch']);
  assert.equal(r.action, 'ticket');
  assert.notEqual(r.ticketId, first.ticketId);
});

test('Gefälschter Bearbeiter-Absender bekommt keine Bearbeiter-Rechte (Audit 3.2)', async () => {
  const t = (await user('POST', '/api/tickets', { title: 'Karls Ticket' })).body.ticket;
  const spoof = await mail(['From: anna@firma.local', `Subject: Re: [${t.key}] Karls Ticket`, 'Message-ID: <spoof-1@x>', '', 'Bitte Passwort schicken']);
  assert.equal(spoof.action, 'ticket', 'nicht im Ticket von Karl');
  // Über eine echte ausgehende Message-ID darf geantwortet werden – aber ohne das Bearbeiter-Konto
  db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction) VALUES('helfi.out.1@firma.local',?,'out')").run(t.id);
  const viaRef = await mail(['From: anna@firma.local', 'Subject: Re: x', 'In-Reply-To: <helfi.out.1@firma.local>', 'Message-ID: <spoof-2@x>', '', 'Antwort']);
  assert.equal(viaRef.action, 'comment');
  const c = (await agent('GET', `/api/tickets/${t.key}`)).body.ticket.comments.at(-1);
  assert.equal(c.author.id, null, 'nicht unter Annas Konto');
  assert.equal(c.author.email, 'anna@firma.local');
});

test('Zu große Anhänge werden im Ticket vermerkt (Audit 3.8)', async () => {
  ctx.settings.set('imap.maxAttachmentMb', 1);
  const big = Buffer.alloc(1.5 * 1024 * 1024, 65).toString('base64').replace(/.{76}/g, '$&\r\n');
  const r = await mail(['From: paula@kunde.example', 'Subject: Mit Anhang', 'Message-ID: <big-1@k>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/plain', '', 'Siehe Anhang', '--b', 'Content-Type: application/pdf; name="gross.pdf"', 'Content-Disposition: attachment; filename="gross.pdf"', 'Content-Transfer-Encoding: base64', '', big, '--b--', '']);
  const tk = (await agent('GET', `/api/tickets/${r.key}`)).body.ticket;
  assert.equal(tk.attachments.length, 0);
  assert.match(tk.description, /Anhang nicht übernommen.*gross\.pdf/);
  ctx.settings.set('imap.maxAttachmentMb', 20);
});

test('Ausgehende Message-IDs sind nicht erratbar (Audit 3.1)', () => {
  const src = fs.readFileSync(new URL('../src/mail/smtp.js', import.meta.url), 'utf8');
  assert.match(src, /crypto\.randomBytes\(16\)/);
  assert.doesNotMatch(src, /Math\.random/);
});

test('Eingangsbestätigungen: Stundengrenze gegen Missbrauch (Audit 3.3)', async () => {
  const { EventEmitter } = await import('node:events');
  const { wireNotifications, MAX_CONFIRMATIONS_PER_HOUR } = await import('../src/mail/smtp.js');
  let sent = 0;
  const events = new EventEmitter();
  wireNotifications({
    tickets: { events, rawById: () => ({}) },
    mailer: { enabled: () => true, send: async () => { sent++; } },
    settings: { get: (k) => (k === 'general.defaultLanguage' ? 'de' : true) },
    users: { byId: () => null },
  });
  for (let i = 0; i < MAX_CONFIRMATIONS_PER_HOUR + 15; i++) {
    events.emit('created', { ticket: { id: i, key: `IT-${i}`, title: 'x', source: 'email', reporter: { email: `opfer${i}@x.example`, displayName: 'x' } } });
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent, MAX_CONFIRMATIONS_PER_HOUR);
});

// ---------- Daten ----------
test('Sicherung auch vor ausstehender Migration bei gleicher Version (Audit 4.1)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mig-'));
  const file = path.join(dir, 'h.sqlite');
  let d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
  d.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run();
  d.exec('DROP TABLE kb_images; DROP TABLE ticket_ratings; DROP TABLE ticket_cis; DROP TABLE config_items; DROP TABLE catalog_items; DROP TABLE kb_articles; DROP TABLE approvals; DROP TABLE ticket_fields; DROP TABLE sla_events; ALTER TABLE tickets DROP COLUMN major; ALTER TABLE tickets DROP COLUMN urgency; ALTER TABLE tickets DROP COLUMN impact; DROP TABLE ticket_links; DROP TABLE mail_html; ALTER TABLE attachments DROP COLUMN inline; ALTER TABLE attachments DROP COLUMN draft; DROP TABLE mail_suppressions; DROP TABLE canned_responses; DROP TABLE ticket_participants; ALTER TABLE users DROP COLUMN recovery_codes; ALTER TABLE users DROP COLUMN totp_last_step; ALTER TABLE users DROP COLUMN totp_enabled; ALTER TABLE users DROP COLUMN totp_secret; ALTER TABLE sessions DROP COLUMN mfa;');
  d.close();
  d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
  d.close();
  const files = fs.readdirSync(path.join(dir, 'b'));
  assert.equal(files.length, 1, 'Sicherung vor Migration 3');
  assert.equal(fs.statSync(path.join(dir, 'b', files[0])).mode & 0o777, 0o600, 'nur für den Besitzer lesbar (Audit 4.6)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Aufräumen: Aufbewahrung 0 löscht nicht alles, Versions-Sicherungen begrenzt (Audit 4.4, 4.8)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-prune-'));
  const old = Date.now() / 1000 - 30 * 86400;
  for (let i = 0; i < 3; i++) { const f = path.join(dir, `helfi-taeglich-2026-01-0${i + 1}.sqlite`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, old + i, old + i); }
  for (let i = 0; i < KEEP_VERSION_BACKUPS + 3; i++) { const f = path.join(dir, `helfi-vor-1.${i}.0-x.sqlite`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, old + i, old + i); }
  fs.writeFileSync(path.join(dir, 'helfi-manuell-x.sqlite'), 'x');
  pruneBackups(0, dir);
  const left = fs.readdirSync(dir);
  assert.deepEqual(left.filter((f) => f.includes('taeglich')), ['helfi-taeglich-2026-01-03.sqlite'], 'die neueste Tagessicherung bleibt');
  assert.equal(left.filter((f) => f.includes('-vor-')).length, KEEP_VERSION_BACKUPS);
  assert.ok(left.includes('helfi-manuell-x.sqlite'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Falscher Schlüssel: klare Meldung statt Absturz-Schleife (Audit 4.3)', async () => {
  // Gespeichertes Geheimnis mit anderem Schlüssel → Einstellung liefert leer, kein Absturz
  ctx.settings.set('smtp.password', 'Mail!Pass');
  verifyKey(db); // Prüfwert mit dem richtigen Schlüssel anlegen (macht server.js beim Start)
  const original = Buffer.from(fs.readFileSync(paths.secretKey, 'utf8').trim(), 'base64');
  cryptoLib.setMasterKeyForTests(crypto.randomBytes(32));
  try {
    assert.equal(ctx.settings.get('smtp.password'), '');
    assert.doesNotThrow(() => ctx.settings.publicView());
    assert.throws(() => verifyKey(db), WrongKeyError);
  } finally {
    cryptoLib.setMasterKeyForTests(original);
  }
  assert.doesNotThrow(() => verifyKey(db));
  // Zu kurzer HELFI_SECRET wird nicht stillschweigend übergangen
  process.env.HELFI_SECRET = 'kurz';
  try { assert.throws(() => cryptoLib.initMasterKey(), /zu kurz/); }
  finally { delete process.env.HELFI_SECRET; cryptoLib.setMasterKeyForTests(original); }
});

test('Loopback ohne Proxy-Angabe gilt nicht automatisch als intern (Audit 1.6)', () => {
  const r = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  assert.equal(ctx.policy.isInternal(r), false);
});

test('Backups: backupDatabase schreibt 0600', async () => {
  const f = await backupDatabase(db, 'test', fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-b-')));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});
