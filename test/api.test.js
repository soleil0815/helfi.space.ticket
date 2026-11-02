// API-Tests mit echtem Server auf einem freien Port und eigener Test-Datenbank.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-api-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'test-setup-code';
process.env.HELFI_LOG_LEVEL = 'error';
process.env.HELFI_COMPOSE_VERSION = '1';

const { openDatabase, DatabaseTooNewError, SCHEMA_VERSION } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');

let server; let base; let db; let ctx;

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  // Tests laufen direkt auf 127.0.0.1 – als internes Netz eintragen (sonst wäre 2FA Pflicht)
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body, { csrf = true, lang } = {}) => {
    const headers = { Accept: 'application/json' };
    if (csrf) headers['X-Helfi-Request'] = '1';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (lang) headers['Accept-Language'] = lang;
    const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null;
    try { json = await r.json(); } catch { /* leer */ }
    return { status: r.status, body: json, headers: r.headers };
  };
}

const admin = client();
const agent = client();
const user1 = client();
const user2 = client();

test('Ersteinrichtung braucht den Einrichtungscode', async () => {
  const anon = client();
  let r = await anon('GET', '/api/bootstrap');
  assert.equal(r.body.setupRequired, true);
  r = await anon('POST', '/api/setup', { token: 'falsch', username: 'admin', password: 'Sehrgeheim123' });
  assert.equal(r.status, 403);
  r = await anon('POST', '/api/setup', { token: 'test-setup-code', username: 'admin', password: 'kurz' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/api/setup', { token: 'test-setup-code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT', language: 'de' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'admin');
  assert.equal(r.body.user.source, 'local');
  r = await anon('POST', '/api/setup', { token: 'test-setup-code', username: 'zweiter', password: 'Sehrgeheim123' });
  assert.equal(r.status, 409, 'nur einmal möglich');
});

test('Schreibende Aufrufe ohne CSRF-Header werden abgelehnt', async () => {
  const r = await admin('POST', '/api/tickets', { title: 'x' }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'err.csrf');
});

test('Fehlermeldungen in der Sprache des Browsers', async () => {
  const anon = client();
  const de = await anon('POST', '/api/auth/login', { username: 'x', password: 'y' }, { lang: 'de-DE' });
  const en = await anon('POST', '/api/auth/login', { username: 'x', password: 'y' }, { lang: 'en-US' });
  assert.match(de.body.error.message, /Kennwort/);
  assert.match(en.body.error.message, /password/);
});

test('Benutzer anlegen und anmelden', async () => {
  for (const [u, role] of [['agent1', 'agent'], ['user1', 'user'], ['user2', 'user']]) {
    const r = await admin('POST', '/api/users', { username: u, displayName: u, email: `${u}@firma.local`, role, password: 'Sehrgeheim123' });
    assert.equal(r.status, 201);
  }
  assert.equal((await agent('POST', '/api/auth/login', { username: 'agent1', password: 'Sehrgeheim123' })).status, 200);
  assert.equal((await user1('POST', '/api/auth/login', { username: 'user1', password: 'Sehrgeheim123' })).status, 200);
  assert.equal((await user2('POST', '/api/auth/login', { username: 'USER2', password: 'Sehrgeheim123' })).status, 200, 'Groß-/Kleinschreibung egal');
});

test('Zu viele Fehlversuche werden gebremst', async () => {
  const anon = client();
  let last;
  for (let i = 0; i < 10; i++) last = await anon('POST', '/api/auth/login', { username: 'agent1', password: 'falsch' });
  assert.equal(last.status, 429);
});

test('Benutzer sehen nur eigene Tickets und keine internen Notizen', async () => {
  const t1 = (await user1('POST', '/api/tickets', { title: 'Mein Drucker', description: 'kaputt', assigneeId: 1 })).body.ticket;
  assert.equal(t1.key, 'IT-1');
  assert.equal(t1.assignee, null, 'Benutzer dürfen nicht zuweisen');
  const t2 = (await user2('POST', '/api/tickets', { title: 'Fremdes Ticket' })).body.ticket;

  assert.equal((await user1('GET', `/api/tickets/${t2.key}`)).status, 404);
  assert.deepEqual((await user1('GET', '/api/tickets')).body.tickets.map((x) => x.key), [t1.key]);
  assert.equal((await agent('GET', '/api/tickets')).body.tickets.length, 2);

  await agent('POST', `/api/tickets/${t1.key}/comments`, { body: 'öffentlich' });
  await agent('POST', `/api/tickets/${t1.key}/comments`, { body: 'GEHEIM', internal: true });
  const seen = (await user1('GET', `/api/tickets/${t1.key}`)).body.ticket;
  assert.deepEqual(seen.comments.map((c) => c.body), ['öffentlich']);
  assert.deepEqual(seen.activity, []);

  // Benutzer kann keine internen Kommentare schreiben
  await user1('POST', `/api/tickets/${t1.key}/comments`, { body: 'von mir', internal: true });
  const all = (await agent('GET', `/api/tickets/${t1.key}`)).body.ticket.comments;
  assert.equal(all.find((c) => c.body === 'von mir').internal, false);
});

test('Benutzer dürfen Status/Zuweisung nicht ändern, Bearbeiter schon', async () => {
  let r = await user1('PATCH', '/api/tickets/IT-1', { status: 'done', priority: 'highest', title: 'Mein Drucker (2. OG)' });
  assert.equal(r.body.ticket.status, 'open');
  assert.equal(r.body.ticket.priority, 'medium');
  assert.equal(r.body.ticket.title, 'Mein Drucker (2. OG)');
  r = await agent('PATCH', '/api/tickets/IT-1', { status: 'waiting', assigneeId: 2 });
  assert.equal(r.body.ticket.status, 'waiting');
  assert.equal(r.body.ticket.assignee.id, 2);
  // Antwort des Melders öffnet wartendes Ticket wieder
  await user1('POST', '/api/tickets/IT-1/comments', { body: 'immer noch kaputt' });
  assert.equal((await agent('GET', '/api/tickets/IT-1')).body.ticket.status, 'open');
  const hist = (await agent('GET', '/api/tickets/IT-1')).body.ticket.activity.map((a) => a.field).filter(Boolean);
  assert.ok(hist.includes('status') && hist.includes('assignee'));
});

test('Nur Admins: Einstellungen, Benutzer; Tickets löscht niemand', async () => {
  assert.equal((await agent('GET', '/api/admin/settings')).status, 403);
  assert.equal((await user1('GET', '/api/users')).status, 403);
  assert.equal((await agent('DELETE', '/api/tickets/IT-2')).status, 405);
  const r = await admin('DELETE', '/api/tickets/IT-2');
  assert.equal(r.status, 405, 'auch Admins nicht');
  assert.equal(r.body.error.code, 'err.ticketDeleteDisabled');
  assert.equal((await admin('GET', '/api/tickets/IT-2')).status, 200);
  assert.equal((await agent('POST', '/api/projects', { key: 'HR', name: 'HR' })).status, 403);
});

test('Geheimnisse verlassen den Server nie im Klartext', async () => {
  await admin('PUT', '/api/admin/settings', { settings: { 'ldap.bindPassword': 'Dienst!Pass', 'smtp.password': 'Mail!Pass' } });
  const r = await admin('GET', '/api/admin/settings');
  assert.equal(r.body.settings['ldap.bindPassword'], '••••••••');
  const raw = db.prepare("SELECT value FROM settings WHERE key='ldap.bindPassword'").get().value;
  assert.ok(raw.startsWith('v1:') && !raw.includes('Dienst'));
  // Platzhalter zurückschicken ändert das Kennwort nicht
  await admin('PUT', '/api/admin/settings', { settings: { 'ldap.bindPassword': '••••••••' } });
  assert.equal(ctx.settings.get('ldap.bindPassword'), 'Dienst!Pass');
  // Unbekannte Schlüssel werden ignoriert
  await admin('PUT', '/api/admin/settings', { settings: { 'evil.key': 1 } });
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key='evil.key'").get(), undefined);
});

test('Der letzte Admin kann nicht entfernt werden', async () => {
  const r = await admin('PATCH', '/api/users/1', { role: 'agent' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.lastAdmin');
  assert.equal((await admin('PATCH', '/api/users/1', { active: false })).status, 400);
});

test('Deaktivierte Benutzer verlieren ihre Sitzung', async () => {
  const id = (await admin('GET', '/api/users?all=1')).body.users.find((u) => u.username === 'user2').id;
  await admin('PATCH', `/api/users/${id}`, { active: false });
  assert.equal((await user2('GET', '/api/me')).status, 401);
});

test('Anhänge: hochladen, nur Berechtigte laden herunter', async () => {
  const fd = new FormData();
  fd.append('files', new Blob(['hallo']), 'notiz äöü.txt');
  const login = client();
  await login('POST', '/api/auth/login', { username: 'user1', password: 'Sehrgeheim123' });
  // Cookie über einen normalen Aufruf holen, dann Upload mit fetch
  const me = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'user1', password: 'Sehrgeheim123' }) });
  const cookie = me.headers.get('set-cookie').split(';')[0];
  const up = await fetch(`${base}/api/tickets/IT-1/attachments`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd });
  assert.equal(up.status, 201);
  const att = (await agent('GET', '/api/tickets/IT-1')).body.ticket.attachments[0];
  assert.equal(att.filename, 'notiz äöü.txt');
  const dl = await fetch(`${base}/api/attachments/${att.id}`, { headers: { cookie } });
  assert.equal(await dl.text(), 'hallo');
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream', 'Text nie inline ausliefern');
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  const anon = await fetch(`${base}/api/attachments/${att.id}`);
  assert.equal(anon.status, 401);
});

test('E-Mail-Verarbeitung: neues Ticket, Antwort, Kontakt', async () => {
  const p = ctx.processor;
  const mail = async (raw) => p.process(await p.parse(Buffer.from(raw.join('\r\n'))));
  const r1 = await mail(['From: Paula <p@kunde.example>', 'To: hd@firma.local', 'Subject: Hilfe', 'Message-ID: <m1@k>', '', 'Text']);
  assert.equal(r1.action, 'ticket');
  const tk = (await agent('GET', `/api/tickets/${r1.key}`)).body.ticket;
  assert.equal(tk.reporter.email, 'p@kunde.example');
  assert.equal(tk.source, 'email');
  const r2 = await mail(['From: p@kunde.example', 'Subject: AW: [' + r1.key + '] Hilfe', 'Message-ID: <m2@k>', '', 'Danke', '', 'Am 1.1.2026 schrieb X:', '> alt']);
  assert.equal(r2.action, 'comment');
  assert.equal((await agent('GET', `/api/tickets/${r1.key}`)).body.ticket.comments.at(-1).body, 'Danke');
  assert.equal((await mail(['From: p@kunde.example', 'Subject: Hilfe', 'Message-ID: <m1@k>', '', 'x'])).action, 'duplicate');
  assert.equal((await mail(['From: x@kunde.example', 'Subject: Abwesend', 'Auto-Submitted: auto-replied', 'Message-ID: <m3@k>', '', 'x'])).reason, 'automated');
  // Absender ohne Konto kann sich nicht anmelden
  const contact = db.prepare("SELECT * FROM users WHERE email='p@kunde.example'").get();
  assert.equal(contact.source, 'email');
  assert.equal(contact.password_hash, null);
});

test('Konten aus SSO übernehmen nie fremde AD-/lokale Konten (Regression)', async () => {
  const U = ctx.users;
  const ad = U.upsertExternal({ source: 'ldap', username: 'bob', displayName: 'Bob', email: 'bob@firma.local', externalId: 'guid-bob', role: 'admin' });
  assert.equal(ad.role, 'admin');
  // SSO-Gast mit gleichem Namen, aber ohne Vertrauen in den Namen
  const guest = U.upsertExternal({ source: 'oidc', username: 'bob', displayName: 'Gast', email: 'bob@firma.local', externalId: 'idp|evil', role: null, trustName: false, trustEmail: false });
  assert.notEqual(guest.id, ad.id);
  assert.equal(guest.username, 'oidc:bob');
  assert.equal(guest.role, 'user');
  assert.equal(U.byId(ad.id).source, 'ldap', 'AD-Konto unverändert');
  assert.equal(U.byId(ad.id).external_id, 'guid-bob');
  // Vertrauenswürdige Domäne: dasselbe Konto, Herkunft bleibt AD
  const same = U.upsertExternal({ source: 'oidc', username: 'bob', displayName: 'Bob', email: '', externalId: 'idp|bob', role: null, trustName: true });
  assert.equal(same.id, ad.id);
  assert.equal(U.byId(ad.id).source, 'ldap');
  // Zweite SSO-Identität mit gleichem Namen → nicht zusammenführen
  const other = U.upsertExternal({ source: 'oidc', username: 'carl', displayName: 'C1', externalId: 'idp|c1', role: null, trustName: true });
  const other2 = U.upsertExternal({ source: 'oidc', username: 'carl', displayName: 'C2', externalId: 'idp|c2', role: null, trustName: true });
  assert.notEqual(other.id, other2.id);
  // Lokales Konto (Notfall-Admin) wird nie übernommen
  const loc = U.upsertExternal({ source: 'ldap', username: 'admin', displayName: 'AD-Admin', externalId: 'guid-x', role: 'user' });
  assert.equal(loc.username, 'ldap:admin');
  assert.equal(U.byName('admin').source, 'local');
  // E-Mail-Kontakt nur mit bestätigter Adresse übernehmen
  U.contactForEmail('paula@kunde.example', 'Paula');
  const unverified = U.upsertExternal({ source: 'oidc', username: 'x@evil', email: 'paula@kunde.example', externalId: 'idp|x', trustName: false, trustEmail: false });
  assert.equal(U.byEmail('paula@kunde.example').source, 'email');
  assert.equal(unverified.email, null, 'unbestätigte Adresse wird nicht gespeichert');
  // allowCreate=false
  assert.equal(U.upsertExternal({ source: 'oidc', username: 'neu', externalId: 'idp|neu', allowCreate: false }), null);
});

test('Per E-Mail: Fremde können nicht über die Ticketnummer in Tickets schreiben (Regression)', async () => {
  const p = ctx.processor;
  const mail = async (raw) => p.process(await p.parse(Buffer.from(raw.join('\r\n'))));
  const first = await mail(['From: anna@kunde.example', 'Subject: Mein Problem', 'Message-ID: <r1@k>', '', 'Text']);
  const r = await mail(['From: mallory@boese.example', `Subject: AW: [${first.key}] Mein Problem`, 'Message-ID: <r2@k>', '', 'Bitte Passwort an mich']);
  assert.equal(r.action, 'ticket', 'Fremder bekommt ein eigenes Ticket');
  assert.notEqual(r.key, first.key);
  assert.equal((await agent('GET', `/api/tickets/${first.key}`)).body.ticket.comments.length, 0);
  // Antwort über unsere (nicht erratbare) Message-ID ist erlaubt
  db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction) VALUES('helfi.x.1@firma.local',?,'out')").run(first.ticketId);
  const viaRef = await mail(['From: kollege@kunde.example', 'Subject: AW: irgendwas', 'In-Reply-To: <helfi.x.1@firma.local>', 'Message-ID: <r3@k>', '', 'Ich auch']);
  assert.equal(viaRef.action, 'comment');
  // Schleifenschutz: viele neue Tickets vom selben Absender
  const { MAX_NEW_TICKETS_PER_HOUR } = await import('../src/mail/imap.js');
  let last;
  for (let i = 0; i <= MAX_NEW_TICKETS_PER_HOUR; i++) last = await mail(['From: loop@bot.example', `Subject: Ticket ${i}`, `Message-ID: <loop${i}@k>`, '', 'x']);
  assert.equal(last.reason, 'rate');
});

test('Benutzer sehen die Zahl interner Kommentare nicht (Regression)', async () => {
  const mine = (await user1('GET', '/api/tickets')).body.tickets.find((x) => x.key === 'IT-1');
  const all = (await agent('GET', '/api/tickets')).body.tickets.find((x) => x.key === 'IT-1');
  assert.ok(all.commentCount > mine.commentCount);
  assert.equal((await user1('GET', '/api/tickets/IT-1')).body.ticket.commentCount, mine.commentCount);
  const patched = (await user1('PATCH', '/api/tickets/IT-1', { title: 'Mein Drucker (2. OG)!' })).body.ticket;
  assert.equal(patched.commentCount, mine.commentCount);
});

test('Zuweisen nur an Bearbeiter, kein Umnummerieren beim gleichen Projekt, archivierte Projekte (Regression)', async () => {
  const userId = (await admin('GET', '/api/users?all=1')).body.users.find((u) => u.username === 'user1').id;
  assert.equal((await agent('PATCH', '/api/tickets/IT-1', { assigneeId: userId })).status, 400);
  const before = (await agent('GET', '/api/tickets/IT-1')).body.ticket.number;
  const r = await agent('PATCH', '/api/tickets/IT-1', { projectId: 'IT' });
  assert.equal(r.body.ticket.number, before);
  const hr = (await admin('POST', '/api/projects', { key: 'HR', name: 'Personal' })).body.project;
  await admin('PATCH', `/api/projects/${hr.id}`, { archived: true });
  const t = (await user1('POST', '/api/tickets', { title: 'x', projectId: hr.id })).body.ticket;
  assert.equal(t.projectKey, 'IT', 'nicht im archivierten Projekt');
});

test('Verbindungstests schicken gespeicherte Kennwörter nicht an neue Server (Regression)', async () => {
  await admin('PUT', '/api/admin/settings', { settings: { 'smtp.host': 'mail.firma.local', 'smtp.user': 'helpdesk', 'smtp.password': 'Mail!Pass' } });
  assert.equal(ctx.settings.mergedGroup('smtp', { 'smtp.password': '••••••••' }).password, 'Mail!Pass', 'gleicher Server: gespeichertes Kennwort');
  assert.equal(ctx.settings.mergedGroup('smtp', { 'smtp.host': 'angreifer.example', 'smtp.password': '••••••••' }).password, '', 'anderer Server: kein Kennwort');
  assert.equal(ctx.settings.mergedGroup('smtp', { 'smtp.user': 'jemand', 'smtp.password': '••••••••' }).password, '');
  assert.equal(ctx.settings.mergedGroup('smtp', { 'smtp.host': 'neu.example', 'smtp.password': 'neu-getippt' }).password, 'neu-getippt');
  assert.equal(ctx.settings.mergedGroup('ldap', { 'ldap.host': 'x.example' }).bindPassword, '');
});

test('Upload über Dateisystemgrenzen (EXDEV) funktioniert (Regression)', async () => {
  const original = fs.renameSync;
  fs.renameSync = () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; };
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'admin', password: 'Sehrgeheim123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const fd = new FormData();
    fd.append('files', new Blob(['exdev-inhalt']), 'x.txt');
    const up = await fetch(`${base}/api/tickets/IT-1/attachments`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd });
    assert.equal(up.status, 201);
    const id = (await up.json()).ids[0];
    assert.equal(await (await fetch(`${base}/api/attachments/${id}`, { headers: { cookie } })).text(), 'exdev-inhalt');
    assert.deepEqual(fs.readdirSync(path.join(paths.attachments, '.tmp')), [], 'keine Reste');
  } finally {
    fs.renameSync = original;
  }
});

test('Datenbank: Sicherung vor Versionswechsel, neuere Datenbank wird abgelehnt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-db-'));
  const file = path.join(dir, 'h.sqlite');
  const backups = path.join(dir, 'backups');
  let d = await openDatabase(file, { appVersion: '1.0.0', backupDir: backups });
  d.close();
  assert.equal(fs.existsSync(backups) ? fs.readdirSync(backups).length : 0, 0, 'neue Datenbank: keine Sicherung nötig');
  d = await openDatabase(file, { appVersion: '1.0.0', backupDir: backups });
  d.close();
  assert.equal(fs.existsSync(backups) ? fs.readdirSync(backups).length : 0, 0, 'gleiche Version: keine Sicherung');
  d = await openDatabase(file, { appVersion: '1.1.0', backupDir: backups });
  d.close();
  assert.match(fs.readdirSync(backups)[0], /^helfi-vor-1\.1\.0-.*\.sqlite$/);
  // Datenbank einer "Zukunftsversion"
  d = await openDatabase(file, { appVersion: '1.1.0', backupDir: backups });
  d.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION + 1));
  d.close();
  await assert.rejects(openDatabase(file, { appVersion: '1.0.0', backupDir: backups }), (e) => e instanceof DatabaseTooNewError && /helfi-vor-1\.1\.0/.test(e.message));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Hinweis bei veralteter docker-compose.yml', async () => {
  const cfg = (await import('../src/config.js')).config;
  const old = cfg.composeVersion;
  cfg.composeVersion = 0;
  let w = (await admin('GET', '/api/bootstrap')).body.warnings.map((x) => x.code);
  assert.ok(w.includes('composeUnknown'));
  cfg.composeVersion = 1;
  w = (await admin('GET', '/api/bootstrap')).body.warnings.map((x) => x.code);
  assert.ok(!w.includes('composeUnknown') && !w.includes('composeOutdated'));
  cfg.composeVersion = old;
  // Nicht-Admins sehen keine Systemwarnungen
  assert.deepEqual((await agent('GET', '/api/bootstrap')).body.warnings, []);
});

test('Sicherheitskopfzeilen und SPA-Auslieferung', async () => {
  const r = await fetch(`${base}/browse/IT-1`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal((await fetch(`${base}/api/gibtsnicht`)).status, 401);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
