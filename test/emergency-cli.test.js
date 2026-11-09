// Emergency access from the Docker host: helfi-admin list | reset | create (src/cli.js, docker/helfi-admin.sh)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startServer } from './helpers/server.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = await startServer('emergency-cli');
const { main, generatePassword } = await import('../src/cli.js');
const { paths } = await import('../src/config.js');
after(() => S.stop());

/** Runs the command with captured output; input = what arrives on stdin (not a terminal). */
async function run(args, { input = '', dbFile = paths.db } = {}) {
  let out = ''; let err = '';
  const sink = (fn) => new Writable({ write(c, _e, cb) { fn(String(c)); cb(); } });
  const stdin = Readable.from(input ? [input] : []);
  const code = await main(args, { stdin, stdout: sink((s) => { out += s; }), stderr: sink((s) => { err += s; }) }, { dbFile, baseUrl: 'https://helfi.firma.local' });
  return { code, out, err };
}
const login = (username, password) => fetch(`${S.base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username, password }),
});
const userRow = (name) => S.db.prepare('SELECT * FROM users WHERE username=?').get(name);

test('help and list', async () => {
  let r = await run(['help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /helfi-admin reset <name>/);
  r = await run(['list']);
  assert.equal(r.code, 0);
  assert.match(r.out, /admin\s+\(admin\)\s+aktiv\s+2FA: aus/);
});

test('reset: new password from stdin, 2FA off, sessions ended, recorded and shown to admins', async () => {
  const before = await S.admin('GET', '/api/me');
  assert.equal(before.status, 200);
  S.db.prepare("UPDATE users SET totp_enabled=1, totp_secret='x', recovery_codes='[]' WHERE username='admin'").run();
  const r = await run(['reset', 'admin', '--password-stdin'], { input: 'Notfall-Kennwort-2026\n' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /neues Kennwort, die Zwei-Faktor-Anmeldung ist abgeschaltet/);
  assert.match(r.out, /https:\/\/helfi\.firma\.local\/login\?local=1/);
  assert.match(r.out, /Keine E-Mail verschickt/);
  assert.doesNotMatch(r.out, /Notfall-Kennwort-2026/, 'a chosen password is never printed');
  const u = userRow('admin');
  assert.equal(u.totp_enabled, 0);
  assert.equal(u.totp_secret, null);
  assert.equal(u.recovery_codes, null);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(u.id).n, 0);
  assert.equal((await S.admin('GET', '/api/me')).status, 401, 'old session ended');
  assert.equal((await login('admin', 'Sehrgeheim123')).status, 401, 'old password no longer valid');
  assert.equal((await login('admin', 'Notfall-Kennwort-2026')).status, 200);
  await S.admin.login('admin', 'Notfall-Kennwort-2026');
  const sys = await S.admin('GET', '/api/admin/system');
  assert.equal(sys.body.emergency[0].action, 'reset');
  assert.equal(sys.body.emergency[0].username, 'admin');
  assert.equal(sys.body.emergency[0].mfaReset, true);
});

test('reset --generate --keep-2fa: random password printed once, 2FA stays', async () => {
  S.db.prepare("UPDATE users SET totp_enabled=1, totp_secret='y' WHERE username='admin'").run();
  const r = await run(['reset', 'admin', '--generate', '--keep-2fa']);
  assert.equal(r.code, 0, r.err);
  const pw = r.out.match(/^ {4}(\S{20})$/m)?.[1];
  assert.ok(pw, r.out);
  assert.equal(userRow('admin').totp_enabled, 1);
  assert.doesNotMatch(r.out, /abgeschaltet/);
  S.db.prepare("UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE username='admin'").run();
  assert.equal((await login('admin', pw)).status, 200);
  // set back for the other tests
  assert.equal((await run(['reset', 'admin', '--password-stdin'], { input: 'Sehrgeheim123\n' })).code, 0);
  await S.admin.login('admin');
});

test('reset refuses: unknown name, AD account, non-admin, short password, no terminal', async () => {
  let r = await run(['reset', 'gibtsnicht', '--generate']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Kein Konto/);
  S.db.prepare("INSERT INTO users(username,display_name,role,source) VALUES('ad.admin','AD Admin','admin','ldap')").run();
  r = await run(['reset', 'ad.admin', '--generate']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Active Directory/);
  await S.user('agent1', 'agent');
  r = await run(['reset', 'agent1', '--generate']);
  assert.equal(r.code, 1);
  assert.match(r.err, /kein Admin/);
  r = await run(['reset', 'admin', '--password-stdin'], { input: 'kurz\n' });
  assert.equal(r.code, 1);
  assert.match(r.err, /zu kurz/);
  r = await run(['reset', 'admin']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--generate/);
  assert.equal((await login('admin', 'Sehrgeheim123')).status, 200, 'nothing changed');
  // list counts AD admins separately
  assert.match((await run(['list'])).out, /1 Admin\(s\) aus AD\/SSO/);
});

test('create: new local admin who can sign in; refuses taken or invalid names and taken addresses', async () => {
  let r = await run(['create', 'notfall', '--name', 'Notfall Admin', '--email', 'notfall@firma.local', '--password-stdin'], { input: 'Notfall-Kennwort-2026\n' });
  assert.equal(r.code, 0, r.err);
  const u = userRow('notfall');
  assert.equal(u.role, 'admin');
  assert.equal(u.source, 'local');
  assert.equal(u.display_name, 'Notfall Admin');
  assert.equal(u.email, 'notfall@firma.local');
  assert.equal((await login('notfall', 'Notfall-Kennwort-2026')).status, 200);
  r = await run(['create', 'Notfall', '--generate']);
  assert.match(r.err, /gibt es schon/);
  r = await run(['create', 'a b', '--generate']);
  assert.match(r.err, /Ungültiger Name/);
  r = await run(['create', 'zweiter', '--email', 'NOTFALL@firma.local', '--generate']);
  assert.match(r.err, /gehört schon/);
  r = await run(['create', 'dritter', '--email', 'kaputt', '--generate']);
  assert.match(r.err, /Ungültige E-Mail/);
  const sys = await S.admin('GET', '/api/admin/system');
  assert.equal(sys.body.emergency[0].action, 'create');
  assert.equal(sys.body.emergency[0].username, 'notfall');
});

test('No database or a database of another version: clear message, nothing changed', async () => {
  let r = await run(['list'], { dbFile: path.join(os.tmpdir(), 'helfi-gibt-es-nicht.sqlite') });
  assert.equal(r.code, 1);
  assert.match(r.err, /Keine Datenbank/);
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-cli-')), 'helfi.sqlite');
  await S.db.backup(copy);
  const d = new Database(copy);
  d.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run();
  d.close();
  r = await run(['reset', 'admin', '--generate'], { dbFile: copy });
  assert.equal(r.code, 1);
  assert.match(r.err, /passen nicht zusammen/);
  r = await run(['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Unbekannter Befehl/);
});

test('Generated passwords: 20 characters, no look-alikes, different every time', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword();
    assert.equal(pw.length, 20);
    assert.match(pw, /^[A-HJ-NP-Za-km-z2-9_-]+$/);
    seen.add(pw);
  }
  assert.equal(seen.size, 200);
});

test('helfi-admin wrapper: as root it switches to PUID/PGID (never root), otherwise runs directly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-wrap-'));
  const log = path.join(dir, 'su-exec.log');
  fs.writeFileSync(path.join(dir, 'su-exec'), `#!/bin/sh\necho "$1" > "${log}"\nshift\nexec "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HELFI_APP_DIR: root, HELFI_DATA_DIR: path.dirname(paths.db) };
  const sh = (extra) => spawnSync('sh', [path.join(root, 'docker/helfi-admin.sh'), 'help'], { env: { ...env, ...extra }, encoding: 'utf8' });
  let r = sh({ PUID: '1026', PGID: '100' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /helfi-admin list/);
  if (process.getuid?.() === 0) {
    assert.equal(fs.readFileSync(log, 'utf8').trim(), '1026:100');
    r = sh({ PUID: '0', PGID: '100' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /root/);
    r = sh({ PUID: 'abc', PGID: '100' });
    assert.equal(r.status, 1);
  }
});
