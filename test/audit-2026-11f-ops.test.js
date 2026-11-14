// Audit 2026-11f, operations: helfi-admin reset/list (src/cli.js) and the HTTPS auto-learn (src/https.js).
// update.sh --cleanup (-sN image files) is covered in test/update.test.js, Permissions-Policy/CORP/COOP in
// test/csp-strict.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import express from 'express';
import { startServer } from './helpers/server.js';

const S = await startServer('audit-2026-11f-ops');
const { main } = await import('../src/cli.js');
const { paths } = await import('../src/config.js');
const { applyTrustProxy } = await import('../src/app.js');
const { httpsMiddleware, createHttpsHosts } = await import('../src/https.js');
after(() => S.stop());

async function cli(args, input = '') {
  let out = ''; let err = '';
  const sink = (fn) => new Writable({ write(c, _e, cb) { fn(String(c)); cb(); } });
  const code = await main(args, { stdin: Readable.from(input ? [input] : []), stdout: sink((s) => { out += s; }), stderr: sink((s) => { err += s; }) },
    { dbFile: paths.db, baseUrl: 'https://helfi.firma.local' });
  return { code, out, err };
}

// --- 1: helfi-admin reset must invalidate pending "forgot password" links ---------------------

test('helfi-admin reset deletes pending password-reset links of that admin (Audit 11f)', async () => {
  S.db.prepare("INSERT INTO users(username,display_name,email,role,source,password_hash,active) VALUES('notadmin','Not','notadmin@firma.local','admin','local','x',0)").run();
  const uid = S.db.prepare("SELECT id FROM users WHERE username='notadmin'").get().id;
  const other = S.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const ins = S.db.prepare("INSERT INTO account_tokens(kind,token_hash,email,user_id,created_at,expires_at) VALUES('reset',?,?,?,?,?)");
  ins.run('h-reset-1', 'notadmin@firma.local', uid, Date.now(), Date.now() + 3600e3);
  ins.run('h-reset-other', 'admin@firma.local', other, Date.now(), Date.now() + 3600e3);
  const r = await cli(['reset', 'notadmin', '--password-stdin'], 'Notfall-Kennwort-2026\n');
  assert.equal(r.code, 0, r.err);
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM account_tokens WHERE kind='reset' AND user_id=?").get(uid).n, 0, 'old link is gone');
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM account_tokens WHERE token_hash='h-reset-other'").get().n, 1, 'other users untouched');
});

// --- 4: helfi-admin list must not pass terminal control sequences through ------------------------

test('helfi-admin list strips control characters from display names (Audit 11f)', async () => {
  S.db.prepare("INSERT INTO users(username,display_name,role,source,password_hash) VALUES('escadmin',?,'admin','local','x')")
    .run('Evil\x1b]0;pwned\x07\x1b[2J\u009bName\r\n');
  const r = await cli(['list']);
  assert.equal(r.code, 0, r.err);
  const line = r.out.split('\n').find((l) => l.includes('escadmin'));
  assert.ok(line, r.out);
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(line));
  assert.match(line, /\(Evil\]0;pwned\[2JName\)/);
});

// --- 2: HTTPS is only learned from requests for the HELFI_BASE_URL host ----------------------------

async function serve(file) {
  const app = express();
  applyTrustProxy(app, 'loopback');
  app.use(httpsMiddleware(app, { baseUrl: 'https://helfi.firma.local', mode: 'auto', hsts: 'on', hosts: createHttpsHosts(file) }));
  app.all('/{*rest}', (_req, res) => res.send('ok'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  // node:http (not fetch): the Host header must be set freely, like a reverse proxy forwards it
  const call = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/x', headers }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  return { call, close: () => server.close() };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-https-11f-')), 'https-hosts.txt');

test('HTTPS for another host (IP, default vhost) does not switch the base host to HTTPS (Audit 11f)', async () => {
  const file = tmpFile();
  const s = await serve(file);
  try {
    assert.equal(await s.call({ Host: '10.0.10.5', 'X-Forwarded-Proto': 'https' }), 200);
    assert.equal(await s.call({ Host: 'other.firma.local', 'X-Forwarded-Proto': 'https' }), 200);
    assert.equal(fs.existsSync(file), false, 'nothing learned');
    assert.equal(await s.call({ Host: 'helfi.firma.local', 'X-Forwarded-Proto': 'http' }), 200, 'never redirected into nothing');
    // Control: an HTTPS request for the real name is learned
    await s.call({ Host: 'Helfi.Firma.Local', 'X-Forwarded-Proto': 'https' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'helfi.firma.local\n');
    // HTTP for another host is still redirected (redirect logic unchanged) but does not mark the base host
    assert.equal(await s.call({ Host: '10.0.10.5', 'X-Forwarded-Proto': 'http' }), 301);
    assert.equal(fs.readFileSync(file, 'utf8'), 'helfi.firma.local\n', 'no "redirected" from another host');
    assert.equal(await s.call({ Host: 'helfi.firma.local', 'X-Forwarded-Proto': 'http' }), 301);
    assert.equal(fs.readFileSync(file, 'utf8'), 'helfi.firma.local redirected\n');
  } finally { s.close(); }
});

test('A multi-valued X-Forwarded-Proto is never learned from (Audit 11f)', async () => {
  const file = tmpFile();
  const s = await serve(file);
  try {
    // appending proxy: the client chose the leftmost value
    assert.equal(await s.call({ Host: 'helfi.firma.local', 'X-Forwarded-Proto': 'https, http' }), 200);
    assert.equal(await s.call({ Host: 'helfi.firma.local', 'X-Forwarded-Port': '443,80' }), 200);
    assert.equal(fs.existsSync(file), false, 'nothing learned');
    assert.equal(await s.call({ Host: 'helfi.firma.local', 'X-Forwarded-Proto': 'http' }), 200);
  } finally { s.close(); }
});
