// Audit 2026-11e (Michael's decisions on the open points of 2026-11d): session ids stored only as
// hash, AI backfill with open tickets by default and a lower per-run cap, reply mails do not reopen
// rejected/duplicate tickets
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from './helpers/server.js';

let S; let ctx; let db; let anna; let bob;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const eml = (lines) => Buffer.from(lines.join('\r\n'));
async function run(lines) { const p = ctx.processor; return p.process(await p.parse(eml(lines))); }

before(async () => {
  S = await startServer('audit-e');
  ctx = S.ctx; db = S.db;
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
  anna = await S.user('anna', 'agent');
  bob = await S.user('bob', 'user');
});
after(() => S.stop());

test('sessions table stores only the SHA-256 of the cookie value', async () => {
  const token = decodeURIComponent(bob.cookie().split('=')[1]);
  assert.ok(token.length > 20);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(token).n, 0, 'the cookie value itself is not stored');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(sha(token)).n, 1, 'stored as its hash');
  const { sessionKey } = await import('../src/auth/session.js');
  assert.equal(sessionKey(token), sha(token));
  // A value read from the table (e.g. from a backup) does not sign anyone in
  const r = await fetch(`${S.base}/api/me`, { headers: { cookie: `helfi_sid=${sha(token)}` } });
  assert.equal(r.status, 401);
  assert.equal((await bob('GET', '/api/me')).status, 200, 'the real cookie still works');
});

test('migration 40 converts existing plaintext session ids, so nobody has to sign in again', async () => {
  const { openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-sess-'));
  try {
    const file = path.join(dir, 'helfi.sqlite');
    let d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    const uid = d.prepare("INSERT INTO users(username, display_name, role, source) VALUES('max','Max','user','local')").run().lastInsertRowid;
    d.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,auth_method,last_seen) VALUES('plain-token-0001',?,?,?,'local',?)").run(uid, Date.now() + 3600e3, Date.now(), Date.now());
    d.prepare("UPDATE meta SET value='39' WHERE key='schema_version'").run();
    d.close();
    d = await openDatabase(file, { appVersion: '1.0.0', backupDir: path.join(dir, 'b') });
    assert.deepEqual(d.prepare('SELECT id FROM sessions').all().map((x) => x.id), [sha('plain-token-0001')]);
    d.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backfill: open tickets only by default, at most 1000 per run, text volume in the preview', async () => {
  const { BACKFILL_MAX_AI } = await import('../src/ai-classify.js');
  assert.equal(BACKFILL_MAX_AI, 1000);
  const p = (await S.admin('GET', '/api/projects')).body.projects[0];
  await S.admin('POST', `/api/projects/${p.id}/components`, { name: 'Netzwerk', keywords: 'wlan' });
  const a = (await bob('POST', '/api/tickets', { title: 'Offen ohne Komponente', description: 'x'.repeat(50) })).body.ticket;
  const b = (await bob('POST', '/api/tickets', { title: 'Erledigt ohne Komponente' })).body.ticket;
  db.prepare("UPDATE tickets SET status='done', resolution='done' WHERE id=?").run(b.id);
  const ids = (q) => S.admin('GET', `/api/admin/components/backfill?project=${p.id}${q}`).then((r) => r.body);
  const open = await ids('');
  const all = await ids('&includeDone=1');
  assert.equal(all.total - open.total, 1, 'the done ticket counts only with includeDone=1');
  assert.ok(open.total >= 1 && a.id);
  // AI on: the preview tells how much text goes out
  await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': 'http://127.0.0.1:9/v1', 'ai.model': 'test-model', 'ai.classify': true } });
  const withAi = await ids('');
  assert.ok(withAi.ai >= 1);
  assert.ok(withAi.aiChars >= 'Offen ohne Komponente'.length + 50, 'characters of ticket text');
  assert.equal(withAi.aiTokens, Math.ceil(withAi.aiChars / 4));
  assert.equal(withAi.remote, false, 'local address is not an AI on the internet');
  await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': false } });
});

for (const resolution of ['rejected', 'duplicate']) {
  test(`reply mail to a ticket closed as ${resolution}: internal note, stays closed`, async () => {
    const orig = (await bob('POST', '/api/tickets', { title: 'Original Drucker' })).body.ticket;
    const tk = (await bob('POST', '/api/tickets', { title: `Drucker ${resolution}` })).body.ticket;
    const body = resolution === 'duplicate' ? { resolution, duplicateOf: orig.key } : { resolution, reason: 'Machen wir nicht.' };
    assert.equal((await anna('POST', `/api/tickets/${tk.key}/resolve`, body)).status, 200);
    const out = db.prepare("SELECT message_id FROM mail_messages WHERE ticket_id=? AND direction='out' ORDER BY rowid DESC").get(tk.id);
    const ref = out ? [`In-Reply-To: <${out.message_id}>`] : [];
    const r = await run(['From: Bob <bob@firma.local>', 'To: helpdesk@firma.local', `Subject: Re: [${tk.key}] Drucker`, ...ref,
      `Message-ID: <reply-${resolution}@firma.local>`, '', 'Danke!']);
    assert.equal(r.action, 'comment');
    const row = ctx.tickets.rawById(tk.id);
    assert.equal(row.status, 'done', 'not reopened');
    assert.equal(row.resolution, resolution, 'resolution kept');
    const last = db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(tk.id);
    assert.equal(last.internal, 1);
    assert.match(last.body, /stays closed/);
  });
}

test('reply mail to a normally done ticket still reopens it (unchanged)', async () => {
  const tk = (await bob('POST', '/api/tickets', { title: 'Monitor' })).body.ticket;
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  await run(['From: Bob <bob@firma.local>', 'To: helpdesk@firma.local', `Subject: Re: [${tk.key}] Monitor`, 'Message-ID: <reply-done@firma.local>', '', 'Geht wieder nicht.']);
  assert.notEqual(ctx.tickets.rawById(tk.id).status, 'done');
});
