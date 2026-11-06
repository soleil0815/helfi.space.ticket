// Regression tests for the code audit findings (each test fails on the code before the audit)
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

const { openDatabase, verifyKey, WrongKeyError, pruneBackups, backupDatabase, DEFAULT_BACKUP_KEEP } = await import('../src/db.js');
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

test('Setup', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  await admin('POST', '/api/users', { username: 'anna', displayName: 'Anna', email: 'anna@firma.local', role: 'agent', password: 'Sehrgeheim123' });
  await admin('POST', '/api/users', { username: 'karl', displayName: 'Karl', email: 'karl@firma.local', role: 'user', password: 'Sehrgeheim123' });
  assert.equal((await agent('POST', '/api/auth/login', { username: 'anna', password: 'Sehrgeheim123' })).status, 200);
  assert.equal((await user('POST', '/api/auth/login', { username: 'karl', password: 'Sehrgeheim123' })).status, 200);
});

// ---------- Login ----------
test('SSO account with a freely selectable name never takes over an AD account (Audit 1.1)', () => {
  const U = ctx.users;
  // Attacker first logs in via SSO as "m.muster" (name not trusted)
  const evil = U.upsertExternal({ source: 'oidc', username: 'oidc:m.muster', displayName: 'Böse', externalId: 'idp|evil', role: null, trustName: false, trustEmail: false });
  const real = U.upsertExternal({ source: 'ldap', username: 'm.muster', displayName: 'Max', email: 'm.muster@firma.local', externalId: 'guid-m', role: 'admin' });
  assert.notEqual(evil.id, real.id);
  assert.equal(U.byId(evil.id).role, 'user');
  // An earlier "oidc:..." account is never taken over by AD either
  const ad2 = U.upsertExternal({ source: 'ldap', username: 'oidc:m.muster', displayName: 'X', externalId: 'guid-x', role: 'admin' });
  assert.notEqual(ad2.id, evil.id);
});

test('Second-factor throttle is not reset by a correct password (Audit 1.2)', async () => {
  // Anna sets up 2FA (internally)
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
  assert.equal(blocked, true, 'after ~8 wrong codes it stops, no matter how often the password is re-entered');
  ctx.limiter.success(EXTERN, 'mfa~anna');
  ctx.limiter.success(EXTERN, 'anna');
});

test('An enrolled second factor cannot be replaced without the old code (Audit 1.3)', async () => {
  const r = await agent('POST', '/api/me/mfa/setup');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'err.mfaAlreadyEnabled');
});

test('Password change ends other sessions; validate first, then save (Audit 1.4, 2.2)', async () => {
  const other = client();
  await other('POST', '/api/auth/login', { username: 'karl', password: 'Sehrgeheim123' });
  assert.equal((await other('GET', '/api/me')).status, 200);
  // Wrong current password: language must not be saved
  const bad = await user('PATCH', '/api/me', { language: 'en', currentPassword: 'falsch', newPassword: 'NeuesKennwort123' });
  assert.equal(bad.status, 400);
  assert.equal(ctx.users.byName('karl').language, null);
  const ok = await user('PATCH', '/api/me', { currentPassword: 'Sehrgeheim123', newPassword: 'NeuesKennwort123' });
  assert.equal(ok.status, 200);
  assert.equal((await user('GET', '/api/me')).status, 200, 'own session stays');
  assert.equal((await other('GET', '/api/me')).status, 401, 'other session ended');
});

test('LDAP filter: $ patterns in the name do not change the filter (Audit 3.10); DN comparison (1.7)', () => {
  const t = '(&(objectClass=user)(sAMAccountName={{username}}))';
  assert.equal(buildUserFilter(t, "x$'"), "(&(objectClass=user)(sAMAccountName=x$'))");
  assert.equal(buildUserFilter(t, 'a$&b'), '(&(objectClass=user)(sAMAccountName=a$&b))');
  assert.equal(buildUserFilter(t, 'a*)(b'), '(&(objectClass=user)(sAMAccountName=a\\2a\\29\\28b))');
  assert.equal(normalizeDn('CN=Helfi-Admins, OU=Gruppen , DC=firma,DC=local'), normalizeDn('cn=helfi-admins,ou=gruppen,dc=firma,dc=local'));
});

// ---------- Web/API ----------
test('Editing a user: nothing is saved on error (Audit 2.1)', async () => {
  const karl = ctx.users.byName('karl');
  const r = await admin('PATCH', `/api/users/${karl.id}`, { role: 'admin', password: 'kurz' });
  assert.equal(r.status, 400);
  assert.equal(ctx.users.byId(karl.id).role, 'user', 'role unchanged');
});

test('Invalid input yields 400 instead of 500 (Audit 2.3–2.9)', async () => {
  // missing body
  const anon = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'X-Helfi-Request': '1' } });
  assert.equal(anon.status, 401);
  // limit
  assert.equal((await agent('GET', '/api/tickets?limit=1.5')).status, 200);
  assert.equal((await agent('GET', '/api/tickets?limit=-Infinity')).status, 200);
  // objects instead of text
  assert.equal((await agent('POST', '/api/tickets', { title: { toString: 1 } })).status, 400);
  const u = await admin('POST', '/api/users', { username: 'x1', email: {}, password: 'Sehrgeheim123' });
  assert.equal(u.status, 201);
  assert.notEqual(u.body.user.email, '[object Object]');
  // project lead that does not exist
  assert.equal((await admin('POST', '/api/projects', { key: 'ZZ', name: 'Z', leadId: 99999 })).status, 400);
  // assignee / date
  const t = (await agent('POST', '/api/tickets', { title: 'Prüf' })).body.ticket;
  assert.equal((await agent('PATCH', `/api/tickets/${t.key}`, { assigneeId: 'abc' })).status, 400);
  assert.equal((await agent('PATCH', `/api/tickets/${t.key}`, { dueDate: '<b>xx</b>' })).status, 400);
  assert.equal((await agent('PATCH', `/api/tickets/${t.key}`, { dueDate: '2026-12-24' })).body.ticket.dueDate, '2026-12-24');
  // upload with wrong field name
  const fd = new FormData();
  fd.append('falsch', new Blob(['x']), 'a.txt');
  assert.equal((await agent('POST', `/api/tickets/${t.key}/attachments`, fd, { raw: true })).status, 400);
});

test('Users do not see the agent\'s email (Audit 2.11); CSP form-action (2.12)', async () => {
  const t = (await user('POST', '/api/tickets', { title: 'Meins' })).body.ticket;
  const anna = ctx.users.byName('anna');
  await agent('PATCH', `/api/tickets/${t.key}`, { assigneeId: anna.id });
  const seen = (await user('GET', `/api/tickets/${t.key}`)).body.ticket;
  assert.equal(seen.assignee.displayName, 'Anna');
  assert.equal(seen.assignee.email, undefined);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /form-action 'self'(;|$)/);
});

// ---------- Email ----------
const mail = async (raw) => ctx.processor.process(await ctx.processor.parse(Buffer.from(raw.join('\r\n'))));

test('Reply via incoming Message-ID does not end up in someone else\'s ticket (Audit 3.1)', async () => {
  const first = await mail(['From: paula@kunde.example', 'Subject: Hilfe', 'Message-ID: <orig-1@kunde.example>', '', 'Text']);
  const r = await mail(['From: mallory@boese.example', 'Subject: Re: Hilfe', 'In-Reply-To: <orig-1@kunde.example>', 'Message-ID: <m-1@boese.example>', '', 'Ich auch']);
  assert.equal(r.action, 'ticket');
  assert.notEqual(r.ticketId, first.ticketId);
});

test('Forged agent sender does not get agent permissions (Audit 3.2)', async () => {
  const t = (await user('POST', '/api/tickets', { title: 'Karls Ticket' })).body.ticket;
  const spoof = await mail(['From: anna@firma.local', `Subject: Re: [${t.key}] Karls Ticket`, 'Message-ID: <spoof-1@x>', '', 'Bitte Passwort schicken']);
  assert.equal(spoof.action, 'ticket', 'not in Karl\'s ticket');
  // Replying via a real outgoing Message-ID is allowed – but without the agent account
  db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction) VALUES('helfi.out.1@firma.local',?,'out')").run(t.id);
  const viaRef = await mail(['From: anna@firma.local', 'Subject: Re: x', 'In-Reply-To: <helfi.out.1@firma.local>', 'Message-ID: <spoof-2@x>', '', 'Antwort']);
  assert.equal(viaRef.action, 'comment');
  const c = (await agent('GET', `/api/tickets/${t.key}`)).body.ticket.comments.at(-1);
  assert.equal(c.author.id, null, 'not under Anna\'s account');
  assert.equal(c.author.email, 'anna@firma.local');
});

test('Oversized attachments are noted in the ticket (Audit 3.8)', async () => {
  ctx.settings.set('imap.maxAttachmentMb', 1);
  const big = Buffer.alloc(1.5 * 1024 * 1024, 65).toString('base64').replace(/.{76}/g, '$&\r\n');
  const r = await mail(['From: paula@kunde.example', 'Subject: Mit Anhang', 'Message-ID: <big-1@k>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/plain', '', 'Siehe Anhang', '--b', 'Content-Type: application/pdf; name="gross.pdf"', 'Content-Disposition: attachment; filename="gross.pdf"', 'Content-Transfer-Encoding: base64', '', big, '--b--', '']);
  const tk = (await agent('GET', `/api/tickets/${r.key}`)).body.ticket;
  assert.equal(tk.attachments.length, 0);
  assert.match(tk.description, /Anhang nicht übernommen.*gross\.pdf/);
  ctx.settings.set('imap.maxAttachmentMb', 20);
});

test('Outgoing Message-IDs cannot be guessed (Audit 3.1)', () => {
  const src = fs.readFileSync(new URL('../src/mail/smtp.js', import.meta.url), 'utf8');
  assert.match(src, /crypto\.randomBytes\(16\)/);
  assert.doesNotMatch(src, /Math\.random/);
});

test('Receipt confirmations: hourly limit against abuse (Audit 3.3)', async () => {
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

// ---------- Data ----------
test('Backup also before a pending migration with the same version (Audit 4.1)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mig-'));
  const file = path.join(dir, 'h.sqlite');
  let d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
  d.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run();
  d.exec('DROP TABLE kb_feedback; DROP TABLE kb_votes; DROP TABLE comment_mentions; ALTER TABLE sessions DROP COLUMN last_seen; DROP TABLE ai_summaries; DROP TABLE account_tokens; ALTER TABLE users DROP COLUMN approval_pending; ALTER TABLE users DROP COLUMN self_registered; DROP INDEX idx_users_ad_sid; ALTER TABLE users DROP COLUMN ad_sid; DROP TRIGGER users_news_seen; ALTER TABLE users DROP COLUMN news_seen; ALTER TABLE mail_messages DROP COLUMN agent_only; DROP TABLE ticket_fts; CREATE VIRTUAL TABLE ticket_fts USING fts5(title, public_text, internal_text, people, tokenize=\'trigram\'); DELETE FROM settings WHERE key=\'mfa.ssoSecondFactor\'; DROP TRIGGER projects_no_delete_with_tickets; DROP TRIGGER tickets_no_delete; DROP TRIGGER search_t_ins; DROP TRIGGER search_t_upd; DROP TRIGGER search_t_del; DROP TRIGGER search_c_ins; DROP TRIGGER search_c_upd; DROP TRIGGER search_c_del; DROP TRIGGER search_a_ins; DROP TRIGGER search_a_upd; DROP TRIGGER search_a_del; DROP TRIGGER search_u_upd; DROP TABLE ticket_fts; DROP TABLE search_dirty; DROP TABLE kb_comments; DROP INDEX idx_kb_articles_parent; ALTER TABLE kb_articles DROP COLUMN parent_id; DROP TABLE kb_templates; DROP TABLE kb_versions; DROP TABLE kb_images; DROP TABLE ticket_ratings; DROP TABLE ticket_cis; DROP TABLE config_items; DROP TABLE catalog_items; DROP TABLE kb_articles; DROP TABLE approvals; DROP TABLE ticket_fields; DROP TABLE sla_events; ALTER TABLE tickets DROP COLUMN major; ALTER TABLE tickets DROP COLUMN urgency; ALTER TABLE tickets DROP COLUMN impact; DROP TABLE ticket_links; DROP TABLE mail_html; ALTER TABLE attachments DROP COLUMN inline; ALTER TABLE attachments DROP COLUMN draft; DROP TABLE mail_suppressions; DROP TABLE canned_responses; DROP TABLE ticket_participants; ALTER TABLE users DROP COLUMN recovery_codes; ALTER TABLE users DROP COLUMN totp_last_step; ALTER TABLE users DROP COLUMN totp_enabled; ALTER TABLE users DROP COLUMN totp_secret; ALTER TABLE sessions DROP COLUMN mfa;');
  d.close();
  d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
  d.close();
  const files = fs.readdirSync(path.join(dir, 'b'));
  assert.equal(files.length, 1, 'backup before migration 3');
  assert.equal(fs.statSync(path.join(dir, 'b', files[0])).mode & 0o777, 0o600, 'readable only by the owner (Audit 4.6)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Cleanup: keep the newest per kind, at least one (Audit 4.4, 4.8)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-prune-'));
  const old = Date.now() / 1000 - 30 * 86400;
  const mk = (name, i) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); fs.utimesSync(f, old + i, old + i); };
  for (let i = 0; i < 3; i++) mk(`helfi-taeglich-2026-01-0${i + 1}.sqlite`, i);
  for (let i = 0; i < DEFAULT_BACKUP_KEEP + 3; i++) mk(`helfi-vor-1.${i}.0-x.sqlite`, i);
  mk('helfi-manuell-x.sqlite', 0);
  mk('fremd.sqlite', 0);
  pruneBackups(undefined, dir); // not set → default
  let left = fs.readdirSync(dir);
  assert.equal(left.filter((f) => f.includes('taeglich')).length, 3);
  assert.equal(left.filter((f) => f.includes('-vor-')).length, DEFAULT_BACKUP_KEEP);
  assert.ok(!left.includes('helfi-vor-1.0.0-x.sqlite'), 'oldest version backup gone');
  pruneBackups(1, dir);
  left = fs.readdirSync(dir);
  assert.deepEqual(left.filter((f) => f.includes('taeglich')), ['helfi-taeglich-2026-01-03.sqlite'], 'the newest daily backup stays');
  assert.deepEqual(left.filter((f) => f.includes('-vor-')), [`helfi-vor-1.${DEFAULT_BACKUP_KEEP + 2}.0-x.sqlite`]);
  assert.ok(left.includes('helfi-manuell-x.sqlite'));
  assert.ok(left.includes('fremd.sqlite'), 'foreign files stay untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Wrong key: clear message instead of crash loop (Audit 4.3)', async () => {
  // Stored secret with a different key → setting returns empty, no crash
  ctx.settings.set('smtp.password', 'Mail!Pass');
  verifyKey(db); // Create the check value with the right key (server.js does this at startup)
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
  // A too short HELFI_SECRET is not silently ignored
  process.env.HELFI_SECRET = 'kurz';
  try { assert.throws(() => cryptoLib.initMasterKey(), /zu kurz/); }
  finally { delete process.env.HELFI_SECRET; cryptoLib.setMasterKeyForTests(original); }
});

test('Loopback without proxy setting does not automatically count as internal (Audit 1.6)', () => {
  const r = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  assert.equal(ctx.policy.isInternal(r), false);
});

test('Backups: backupDatabase writes 0600', async () => {
  const f = await backupDatabase(db, 'test', fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-b-')));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});
