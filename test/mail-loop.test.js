// Tests: protection against mail loops (non-delivery reports, suppression list, sender rules)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-loop-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { deliveryReport } = await import('../src/mail/parse.js');
const { parseRules, matchRule } = await import('../src/mail/rules.js');

let server; let base; let db; let ctx;
before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' }) });
  assert.equal(r.status, 200);
  ctx.tickets.projects.create({ key: 'MON', name: 'Überwachung' });
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
});
after(async () => { await new Promise((r) => setTimeout(r, 100)); server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const eml = (lines) => Buffer.from(lines.join('\r\n'));
const exchangeNdr = (outId, to = 'monitor@firma.local', msgId = 'ndr1@firma.local') => eml([
  'From: Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@firma.local>',
  'To: <helpdesk@firma.local>', 'Subject: Unzustellbar: [IT-1] Festplatte voll', `Message-ID: <${msgId}>`,
  `In-Reply-To: <${outId}>`, 'Content-Type: multipart/report; report-type=delivery-status; boundary="B1"', 'X-MS-Exchange-Message-Is-Ndr:', '',
  '--B1', 'Content-Type: text/plain', '', `Die Nachricht konnte nicht zugestellt werden an ${to}.`, '',
  '--B1', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns;mail.firma.local', '', `Final-Recipient: rfc822;${to}`, 'Action: failed', '',
  '--B1', 'Content-Type: text/rfc822-headers', '', `Message-ID: <${outId}>`, `To: ${to}`, '', '--B1--']);
const postfixNdr = (outId, to) => eml([
  'Return-Path: <>', 'From: MAILER-DAEMON@mail.firma.local (Mail Delivery System)', 'To: helpdesk@firma.local',
  'Subject: Undelivered Mail Returned to Sender', 'Message-ID: <ndr2@mail.firma.local>', `X-Failed-Recipients: ${to}`,
  'Content-Type: multipart/report; report-type=delivery-status; boundary="B2"', '',
  '--B2', 'Content-Type: text/plain', '', 'could not be delivered', '',
  '--B2', 'Content-Type: message/rfc822', '', `Message-ID: <${outId}>`, `To: ${to}`, 'Subject: x', '', 'Text', '--B2--']);

async function run(buf, opts = {}) {
  const p = ctx.processor;
  return p.process(await p.parse(buf), opts);
}

test('Detect reports: Exchange, Postfix, read receipt; not a normal mail', async () => {
  const p = ctx.processor;
  const ex = deliveryReport(...await (async () => { const x = await p.parse(exchangeNdr('helfi.1.1.ab@firma.local')); return [x, x.raw]; })());
  assert.equal(ex.kind, 'bounce');
  assert.deepEqual(ex.failed, ['monitor@firma.local']);
  assert.ok(ex.refs.includes('helfi.1.1.ab@firma.local'));
  const pf = await p.parse(postfixNdr('helfi.2.2.cd@firma.local', 'drucker@firma.local'));
  assert.deepEqual(deliveryReport(pf, pf.raw).failed, ['drucker@firma.local']);
  const mdn = await p.parse(eml(['From: chef@firma.local', 'Subject: Gelesen: x', 'Content-Type: multipart/report; report-type=disposition-notification; boundary="M"', '', '--M', 'Content-Type: text/plain', '', 'gelesen', '--M--']));
  assert.equal(deliveryReport(mdn, mdn.raw).kind, 'receipt');
  const normal = await p.parse(eml(['From: max@firma.local', 'Subject: Drucker', '', 'geht nicht']));
  assert.equal(deliveryReport(normal, normal.raw), null);
  // "Unzustellbar" in the subject alone does not make a report
  const subj = await p.parse(eml(['From: max@firma.local', 'Subject: Unzustellbar: Paket kam nicht an', '', 'Hilfe']));
  assert.equal(deliveryReport(subj, subj.raw), null);
});

test('Report for one of our own mails: internal note, no reopening, address blocked, no reply', async () => {
  const first = await run(eml(['From: Monitor <monitor@firma.local>', 'To: helpdesk@firma.local', 'Subject: Festplatte voll', 'Message-ID: <alarm1@mon>', '', 'C: 98 %']));
  assert.equal(first.action, 'ticket');
  ctx.tickets.update({ id: 1, role: 'admin' }, first.ticketId, { status: 'waiting' });
  const outId = `helfi.${first.ticketId}.1730500000000.abcdef@firma.local`;
  db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction,recipient) VALUES(?,?,'out',?)").run(outId, first.ticketId, 'monitor@firma.local');

  const before = db.prepare('SELECT COUNT(*) n FROM tickets').get().n;
  const r = await run(exchangeNdr(outId));
  assert.equal(r.action, 'bounce');
  assert.equal(r.ticketId, first.ticketId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tickets').get().n, before, 'no new ticket');
  const notes = db.prepare('SELECT * FROM comments WHERE ticket_id=?').all(first.ticketId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].internal, 1, 'internal only');
  assert.match(notes[0].body, /monitor@firma\.local/);
  assert.equal(ctx.tickets.rawById(first.ticketId).status, 'waiting', 'is not reopened');
  assert.equal(ctx.suppressions.isBlocked('Monitor@firma.local'), true);
  assert.equal(ctx.mailer.blocked('monitor@firma.local'), 'gesperrt (unzustellbar)');
  assert.equal((await run(exchangeNdr(outId))).action, 'duplicate');
});

test('Report without our own Message-ID (forged/foreign): no note in any ticket, address not blocked', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM comments').get().n;
  const r = await run(postfixNdr('helfi.1.99.ff@firma.local', 'drucker@firma.local'));
  assert.equal(r.action, 'bounce');
  assert.equal(r.ticketId, null, 'made-up Helfi ID is not trusted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM comments').get().n, before);
  // A forged report must not block mail to arbitrary addresses
  assert.equal(ctx.suppressions.isBlocked('drucker@firma.local'), false);
  // Postfix report about one of our real outgoing mails: address is blocked
  const tk = db.prepare('SELECT id FROM tickets ORDER BY id LIMIT 1').get();
  const outId = `helfi.${tk.id}.1730500000001.fedcba@firma.local`;
  db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction,recipient) VALUES(?,?,'out',?)").run(outId, tk.id, 'drucker@firma.local');
  const r2 = await run(postfixNdr(outId, 'drucker@firma.local').toString().replace('ndr2@mail.firma.local', 'ndr3@mail.firma.local'));
  assert.equal(r2.ticketId, tk.id);
  assert.equal(ctx.suppressions.isBlocked('drucker@firma.local'), true);
});

test('Blocked recipients: list and unblock (admins only)', async () => {
  let cookie = '';
  const call = async (method, url) => {
    const r = await fetch(base + url, { method, headers: { 'X-Helfi-Request': '1', cookie } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  assert.equal((await call('GET', '/api/admin/mail/suppressions')).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'admin', password: 'Sehrgeheim123' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const list = (await call('GET', '/api/admin/mail/suppressions')).body.suppressions.map((x) => x.address).sort();
  assert.deepEqual(list, ['drucker@firma.local', 'monitor@firma.local']);
  const after = (await call('DELETE', '/api/admin/mail/suppressions/DRUCKER%40firma.local')).body.suppressions.map((x) => x.address);
  assert.deepEqual(after, ['monitor@firma.local']);
  assert.equal(ctx.mailer.blocked('drucker@firma.local'), null);
  // expired blocks no longer apply
  db.prepare("UPDATE mail_suppressions SET until='2000-01-01T00:00:00.000Z'").run();
  assert.equal(ctx.suppressions.isBlocked('monitor@firma.local'), false);
  ctx.suppressions.purgeExpired();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mail_suppressions').get().n, 0);
});

test('Rules: patterns, case, invalid entries', () => {
  const rules = parseRules(JSON.stringify([
    { pattern: 'Monitor@Firma.local', action: 'noreply', project: 'mon' },
    { pattern: '*@zabbix.firma.local', action: 'ignore' },
    { pattern: '***' }, { pattern: '' }, null, { pattern: 'drucker@firma.local', action: 'unsinn' },
  ]));
  assert.equal(rules.length, 3);
  assert.equal(matchRule(rules, 'monitor@firma.local').project, 'MON');
  assert.equal(matchRule(rules, 'alarm@zabbix.firma.local').action, 'ignore');
  assert.equal(matchRule(rules, 'alarm@zabbix.firma.local.evil.example'), null, 'pattern applies to the whole address');
  assert.equal(matchRule(rules, 'drucker@firma.local').action, 'noreply', 'unknown action → never reply');
  assert.equal(matchRule(rules, 'max@firma.local'), null);
  assert.deepEqual(parseRules('kaputt'), []);
  assert.equal(matchRule(parseRules(JSON.stringify([{ pattern: 'a.b@x.de' }])), 'aXb@x.de'), null, 'dot is not a wildcard');
});

test('Rule "never reply": ticket in the chosen project, no mail to the sender', async () => {
  ctx.settings.set('imap.senderRules', JSON.stringify([{ pattern: 'backup@firma.local', action: 'noreply', project: 'MON' }, { pattern: '*@spam.example', action: 'ignore' }]));
  const r = await run(eml(['From: backup@firma.local', 'To: helpdesk@firma.local', 'Subject: Sicherung fehlgeschlagen', 'Message-ID: <bk1@x>', '', 'Fehler']));
  assert.equal(r.action, 'ticket');
  assert.match(r.key, /^MON-/);
  assert.equal(ctx.mailer.blocked('Backup@firma.local'), 'Regel');
  const ig = await run(eml(['From: werbung@spam.example', 'Subject: Angebot', 'Message-ID: <sp1@x>', '', 'x']));
  assert.equal(ig.reason, 'rule');
  // Rule with unknown project → default project instead of error
  ctx.settings.set('imap.senderRules', JSON.stringify([{ pattern: 'backup@firma.local', action: 'noreply', project: 'GIBTSNICHT' }]));
  const r2 = await run(eml(['From: backup@firma.local', 'Subject: Nochmal', 'Message-ID: <bk2@x>', '', 'x']));
  assert.match(r2.key, /^IT-/);
});

test('Automatically generated mails (Proxmox, monitoring): only with rule "never reply"', async () => {
  const pve = (id, from = 'pve@pve.firma.local', extra = 'Auto-Submitted: auto-generated') => eml([`From: ${from}`, 'To: helpdesk@firma.local', 'Subject: Testnachricht', `Message-ID: <${id}@x>`, extra, '', 'Dies ist ein Test']);
  ctx.settings.set('imap.senderRules', '[]');
  let r = await run(pve('pv1'));
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'automated');
  assert.equal(r.from, 'pve@pve.firma.local');
  ctx.settings.set('imap.senderRules', JSON.stringify([{ pattern: '*@pve.firma.local', action: 'noreply' }, { pattern: 'noreply@firma.local', action: 'noreply' }]));
  r = await run(pve('pv2'));
  assert.equal(r.action, 'ticket', 'accepted with rule');
  assert.equal(ctx.mailer.blocked('pve@pve.firma.local'), 'Regel', 'and never replied to');
  // noreply senders and Precedence: bulk likewise
  assert.equal((await run(pve('pv3', 'noreply@firma.local', 'Precedence: bulk'))).action, 'ticket');
  // still discarded without a matching rule
  assert.equal((await run(pve('pv4', 'alarm@nas.firma.local'))).reason, 'automated');
  // always discard our own address, even if a rule matches
  ctx.settings.set('imap.senderRules', JSON.stringify([{ pattern: '*@firma.local', action: 'noreply' }]));
  const own = ctx.settings.get('smtp.from') || 'helpdesk@firma.local';
  ctx.settings.set('smtp.from', own);
  assert.equal((await run(pve('pv5', own))).reason, 'own');
  ctx.settings.set('imap.senderRules', '[]');
});

test('Receipt confirmation is not sent to blocked addresses (mailer checks before sending)', async () => {
  const { createMailer } = await import('../src/mail/smtp.js');
  const { createSuppressions } = await import('../src/mail/rules.js');
  const sup = createSuppressions(db);
  sup.add('weg@firma.local', 'test');
  const settings = { get: (k) => (k === 'imap.senderRules' ? '[]' : ctx.settings.get(k)), group: () => ({ enabled: true, host: '127.0.0.1', port: 1, security: 'none', from: 'helpdesk@firma.local', verifyTls: true }) };
  const m = createMailer(db, settings, { suppressions: sup });
  assert.equal(await m.send({ to: 'weg@firma.local', subject: 'x', text: 'y' }), false, 'rejected without a connection attempt');
});
