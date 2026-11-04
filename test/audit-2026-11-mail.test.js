// Tests for audit 2026-11, email: ReDoS, bounce detection, CC takeover, replies to
// agent mails, skipped mails in the mailbox, font-size, attachment notice, contact person, CC limit
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startServer } from './helpers/server.js';

// Load modules only after startServer (data folder comes from the environment)
let quoteStart; let sanitizeMailHtml; let stripQuotedReply; let deliveryReport; let createImapPoller; let MAX_CC_PARTICIPANTS;
let S; let ctx; let db;
const outbox = [];
const wait = () => new Promise((r) => setTimeout(r, 60));
const eml = (lines) => Buffer.from(lines.join('\r\n'));
async function run(lines, opts = {}) {
  const p = ctx.processor;
  return p.process(await p.parse(Array.isArray(lines) ? eml(lines) : lines), opts);
}
const publicComments = (ticketId) => ctx.tickets.comments({ id: -1, role: 'user' }, ticketId);

before(async () => {
  S = await startServer('audit-mail');
  ctx = S.ctx; db = S.db;
  ({ quoteStart, sanitizeMailHtml } = await import('../src/mail/html.js'));
  ({ stripQuotedReply, deliveryReport } = await import('../src/mail/parse.js'));
  ({ createImapPoller, MAX_CC_PARTICIPANTS } = await import('../src/mail/imap.js'));
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
  await S.user('anna', 'agent');
});
after(() => S.stop());

// ---------- 1. ReDoS ----------
test('Quote detection: 200 KB of malicious HTML/text in under 1 s', async () => {
  const html = '<p>x</p>' + '<div '.repeat(40000);
  let t = Date.now();
  assert.equal(quoteStart(html), -1);
  sanitizeMailHtml(html, { collapseQuote: true });
  assert.ok(Date.now() - t < 1000, `HTML took ${Date.now() - t} ms`);
  for (const h of ['<p>x</p>' + '<div class="'.repeat(20000), '<p>x</p>' + '<blockquote '.repeat(20000)]) {
    t = Date.now(); quoteStart(h);
    assert.ok(Date.now() - t < 1000, `HTML took ${Date.now() - t} ms`);
  }
  const text = 'Am ' + 'wrote:x '.repeat(20000);
  t = Date.now();
  stripQuotedReply(text);
  stripQuotedReply(('Am ' + 'wrote:x '.repeat(120) + '\n').repeat(160));
  assert.ok(Date.now() - t < 1000, `text took ${Date.now() - t} ms`);
  // Whole reply mail with such HTML
  const first = await run(['From: fremd@extern.example', 'To: helpdesk@firma.local', 'Subject: Hallo', 'Message-ID: <redos1@extern.example>', '', 'Text']);
  t = Date.now();
  const r = await run(['From: fremd@extern.example', 'To: helpdesk@firma.local', `Subject: Re: [${first.key}] Hallo`, 'Message-ID: <redos2@extern.example>',
    'Content-Type: text/html; charset=utf-8', '', html]);
  assert.equal(r.action, 'comment');
  assert.ok(Date.now() - t < 3000, `processing took ${Date.now() - t} ms`);
});

test('Quote detection stays correct', () => {
  assert.ok(quoteStart('<p>Danke</p><div style="border:none;border-top:solid #E1E1E1 1.0pt" id="divRplyFwdMsg">Von: x</div>') > 0);
  assert.ok(quoteStart('<p>Danke</p><div dir="ltr" class="gmail_quote">Am Mo. schrieb x:</div>') > 0);
  assert.ok(quoteStart('<p>Danke</p><blockquote type="cite">alt</blockquote>') > 0);
  assert.equal(quoteStart('<p>Danke</p><div class="normal">kein Zitat</div>'), -1);
  assert.equal(stripQuotedReply('Danke!\n\nAm 01.01.2026 um 10:00 schrieb Max <max@firma.local>:\n> alt'), 'Danke!');
  assert.equal(stripQuotedReply('Thanks\nOn Mon, Jan 1, 2026 at 10:00 AM Max <max@firma.local> wrote:\n> old'), 'Thanks');
  assert.equal(stripQuotedReply('Danke\nAm Mo., 1. Jan. 2026 um 10:00 Uhr schrieb Max\n<max@firma.local>:\n> alt'), 'Danke');
  assert.equal(stripQuotedReply('Am Montag geht es wieder.\nGruß'), 'Am Montag geht es wieder.\nGruß', 'no colon at the end');
});

// ---------- 2. Bounce only from headers / delivery-status ----------
test('Normal mail with NDR lines in the body: ticket, no block', async () => {
  const r = await run(['From: kunde@extern.example', 'To: helpdesk@firma.local', 'Subject: Meine Mail kam zurück', 'Message-ID: <ndrtext1@extern.example>', '',
    'Hallo, siehe unten:', 'X-Failed-Recipients: chef@firma.local', 'X-MS-Exchange-Message-Is-Ndr:', 'Final-Recipient: rfc822; anna@firma.local', 'Bitte helfen!']);
  assert.equal(r.action, 'ticket');
  assert.equal(ctx.suppressions.isBlocked('chef@firma.local'), false);
  assert.equal(ctx.suppressions.isBlocked('anna@firma.local'), false);
});

test('Bounce: Final-Recipient only from the message/delivery-status part', async () => {
  const p = ctx.processor;
  const x = await p.parse(eml([
    'From: MAILER-DAEMON@mail.firma.local', 'To: helpdesk@firma.local', 'Subject: Undelivered', 'Message-ID: <ndr9@mail.firma.local>',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B9"', '',
    '--B9', 'Content-Type: text/plain', '', 'Text des Angreifers:', 'Final-Recipient: rfc822; chef@firma.local', 'X-Failed-Recipients: chef2@firma.local', '',
    '--B9', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns;mail.firma.local', '', 'Final-Recipient: rfc822;drucker@firma.local', 'Action: failed', '',
    '--B9--']));
  const rep = deliveryReport(x, x.raw);
  assert.equal(rep.kind, 'bounce');
  assert.deepEqual(rep.failed, ['drucker@firma.local']);
});

// ---------- 3. CC only for a new ticket or matching via our own Message-ID ----------
test('Matching via subject: CC does not become a participant; via Message-ID it does', async () => {
  const first = await run(['From: Chefin <chefin@firma.local>', 'To: helpdesk@firma.local', 'Subject: Gehaltsliste', 'Message-ID: <cc-a1@firma.local>', '', 'vertraulich']);
  const r = await run(['From: Chefin <chefin@firma.local>', 'To: helpdesk@firma.local', 'Cc: spion@evil.example', `Subject: Re: [${first.key}]`, 'Message-ID: <cc-a2@evil.example>', '', 'ok']);
  assert.equal(r.action, 'comment');
  assert.deepEqual(ctx.tickets.participants(first.ticketId).map((x) => x.email), []);
  assert.ok(!ctx.tickets.customerRecipients(first.ticketId).some((x) => x.email === 'spion@evil.example'));

  const outId = `helfi.${first.ticketId}.1730500000000.0123456789abcdef0123456789abcdef@firma.local`;
  db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction) VALUES(?,?,'out')").run(outId, first.ticketId);
  const r2 = await run(['From: Chefin <chefin@firma.local>', 'To: helpdesk@firma.local', 'Cc: kollegin@firma.local', 'Subject: Re: Gehaltsliste',
    'Message-ID: <cc-a3@firma.local>', `In-Reply-To: <${outId}>`, '', 'Kollegin bitte mit aufnehmen']);
  assert.equal(r2.action, 'comment');
  assert.deepEqual(ctx.tickets.participants(first.ticketId).map((x) => x.email), ['kollegin@firma.local']);
});

// ---------- 4. Reply to an agent-only mail ----------
test('Reply to agent mail (assignment): internal note, no reopening', async () => {
  const realCreate = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async (m) => { outbox.push(m); return {}; }, verify: async () => true });
  try {
    ctx.settings.set('smtp.enabled', true);
    ctx.settings.set('smtp.host', 'smtp.firma.local');
    ctx.settings.set('smtp.from', 'helpdesk@firma.local');
    const first = await run(['From: kunde@extern.example', 'To: helpdesk@firma.local', 'Subject: Problem', 'Message-ID: <ag1@extern.example>', '', 'Text']);
    await wait();
    const confirm = outbox.find((m) => m.to === 'kunde@extern.example');
    assert.ok(confirm && !/\.agent@/.test(confirm.messageId), 'mail to customer without marker');
    assert.equal(db.prepare('SELECT agent_only FROM mail_messages WHERE message_id=?').get(confirm.messageId.replace(/[<>]/g, '')).agent_only, 0);
    outbox.length = 0;
    ctx.tickets.update({ id: 1, role: 'admin' }, first.ticketId, { assigneeId: S.ids.anna, status: 'waiting' });
    await wait();
    const assigned = outbox.find((m) => m.to === 'anna@firma.local');
    assert.ok(assigned, 'assignment mail');
    // The marker is stored in the database, not in the Message-ID (third parties see that too, e.g. when forwarded)
    assert.doesNotMatch(assigned.messageId, /\.agent@/);
    assert.equal(db.prepare('SELECT agent_only FROM mail_messages WHERE message_id=?').get(assigned.messageId.replace(/[<>]/g, '')).agent_only, 1);

    const r = await run(['From: anna@firma.local', 'To: helpdesk@firma.local', 'Cc: fremd2@extern.example', `Subject: Re: [${first.key}] zugewiesen`,
      'Message-ID: <ag2@firma.local>', `In-Reply-To: ${assigned.messageId}`, '', 'Intern: Kunde nervt, Ticket liegen lassen']);
    assert.equal(r.action, 'comment');
    const c = db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(first.ticketId);
    assert.equal(c.internal, 1, 'internal only');
    assert.equal(c.author_id, null, 'no permissions of the account');
    assert.equal(publicComments(first.ticketId).length, 0, 'users see nothing');
    assert.equal(ctx.tickets.rawById(first.ticketId).status, 'waiting', 'not reopened');
    assert.deepEqual(ctx.tickets.participants(first.ticketId), [], 'no CC from an internal reply');

    // The customer's reply to their confirmation stays public and reopens
    const r2 = await run(['From: kunde@extern.example', 'To: helpdesk@firma.local', 'Subject: Re: Problem', 'Message-ID: <ag3@extern.example>',
      `In-Reply-To: ${confirm.messageId}`, '', 'Geht immer noch nicht']);
    assert.equal(r2.action, 'comment');
    assert.equal(publicComments(first.ticketId).length, 1);
    assert.equal(ctx.tickets.rawById(first.ticketId).status, 'open');
    // Bounce detection also finds Message-IDs with a marker
    const x = await ctx.processor.parse(eml(['Return-Path: <>', 'From: MAILER-DAEMON@mail.firma.local', 'Subject: Undelivered', `X-Failed-Recipients: anna@firma.local`,
      'Message-ID: <ag4@mail.firma.local>', '', `Message-ID: ${assigned.messageId}`]));
    assert.ok(deliveryReport(x, x.raw).refs.includes(assigned.messageId.replace(/[<>]/g, '')));
  } finally {
    nodemailer.createTransport = realCreate;
    ctx.settings.set('smtp.enabled', false);
  }
});

// ---------- 5. Skipped mails stay in the inbox ----------
test('Mailbox: only move processed mails to the folder; skipped ones/bounces stay read in the inbox', async () => {
  const mails = {
    1: eml(['From: neu@extern.example', 'To: helpdesk@firma.local', 'Subject: Neue Anfrage', 'Message-ID: <imap1@extern.example>', '', 'Hilfe']),
    2: eml(['From: liste@extern.example', 'To: helpdesk@firma.local', 'Precedence: list', 'Subject: Echte Anfrage über Verteiler', 'Message-ID: <imap2@extern.example>', '', 'Hilfe']),
    3: eml(['Return-Path: <>', 'From: MAILER-DAEMON@mail.firma.local', 'To: helpdesk@firma.local', 'Subject: Undelivered', 'X-Failed-Recipients: x9@extern.example',
      'Message-ID: <imap3@mail.firma.local>', '', 'kam nicht an']),
    4: eml(['From: chef@firma.local', 'Subject: Gelesen: x', 'Message-ID: <imap4@firma.local>', 'Content-Type: multipart/report; report-type=disposition-notification; boundary="M"', '',
      '--M', 'Content-Type: text/plain', '', 'gelesen', '--M--']),
  };
  const moved = []; const seenFlags = [];
  class FakeImap {
    on() {}
    async connect() {}
    async mailboxCreate() {}
    async getMailboxLock() { return { release() {} }; }
    async search(q) { return q.seen === false ? [1, 2, 3, 4] : []; }
    async fetchOne(uid, what) { return what.size ? { size: 100 } : { source: mails[uid] }; }
    async messageFlagsAdd(uid, flags) { if (flags.includes('\\Seen')) seenFlags.push(Number(uid)); }
    async messageMove(uid) { moved.push(Number(uid)); }
    async messageDelete() {}
    async logout() {}
    close() {}
  }
  ctx.settings.set('imap.enabled', true);
  ctx.settings.set('imap.host', '127.0.0.1');
  ctx.settings.set('imap.port', 1);
  ctx.settings.set('imap.security', 'none');
  ctx.settings.set('imap.processedFolder', 'Verarbeitet');
  try {
    const poller = createImapPoller({ settings: ctx.settings, processor: ctx.processor, ImapClient: FakeImap });
    const res = await poller.pollOnce();
    assert.equal(res.tickets, 1);
    assert.deepEqual(moved, [1, 4], 'only ticket and read receipt moved');
    assert.deepEqual(seenFlags.sort(), [1, 2, 3, 4], 'all marked as read (no reprocessing)');
  } finally {
    ctx.settings.set('imap.enabled', false);
    ctx.settings.set('imap.processedFolder', '');
  }
});

// ---------- 6. font-size ----------
test('font-size: pattern applies to the whole value', () => {
  assert.doesNotMatch(sanitizeMailHtml('<p style="font-size:largeXXX">a</p>').html, /font-size/);
  assert.doesNotMatch(sanitizeMailHtml('<p style="font-size:mediumfoo(x)">a</p>').html, /font-size/);
  assert.match(sanitizeMailHtml('<p style="font-size:x-large">a</p>').html, /font-size:x-large/);
  assert.match(sanitizeMailHtml('<p style="font-size:medium">a</p>').html, /font-size:medium/);
  assert.match(sanitizeMailHtml('<p style="font-size:12pt">a</p>').html, /font-size:12pt/);
});

// ---------- 7. Notice about attachments not imported with long text ----------
test('Notice about attachments not imported is kept with long text', async () => {
  const parts = [];
  for (let i = 0; i < 31; i++) parts.push('--A7', 'Content-Type: text/plain', `Content-Disposition: attachment; filename="datei${i}.txt"`, '', `Inhalt ${i}`);
  const long = 'x'.repeat(120000);
  const r = await run(['From: lang@extern.example', 'To: helpdesk@firma.local', 'Subject: Langer Text', 'Message-ID: <long1@extern.example>',
    'Content-Type: multipart/mixed; boundary="A7"', '', '--A7', 'Content-Type: text/plain', '', long, ...parts, '--A7--']);
  assert.equal(r.action, 'ticket');
  const d = ctx.tickets.rawById(r.ticketId).description;
  assert.ok(d.length <= 100000);
  assert.match(d, /attachment not imported: datei30\.txt \(0 MB\)\]$/);
  const r2 = await run(['From: lang@extern.example', 'To: helpdesk@firma.local', `Subject: Re: [${r.key}] Langer Text`, 'Message-ID: <long2@extern.example>',
    'Content-Type: multipart/mixed; boundary="A7"', '', '--A7', 'Content-Type: text/plain', '', long, ...parts, '--A7--']);
  assert.equal(r2.action, 'comment');
  const c = db.prepare('SELECT body FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(r.ticketId).body;
  assert.match(c, /attachment not imported: datei30\.txt \(0 MB\)\]$/);
});

// ---------- 9. Agents do not count towards the CC participant limit ----------
test('CC limit: agents do not count', async () => {
  const agents = [];
  for (let i = 0; i < MAX_CC_PARTICIPANTS; i++) {
    const res = await S.admin('POST', '/api/users', { username: `ag${i}`, displayName: `ag${i}`, email: `ag${i}@firma.local`, role: 'agent', password: 'Sehrgeheim123' });
    assert.ok(res.status < 300, `account ag${i}: ${res.status}`);
    agents.push(`ag${i}@firma.local`);
  }
  const r = await run(['From: viele@extern.example', `To: helpdesk@firma.local, ${agents.join(', ')}`, 'Cc: k1@extern.example, k2@extern.example',
    'Subject: Viele Empfänger', 'Message-ID: <many1@extern.example>', '', 'x']);
  assert.equal(r.action, 'ticket');
  assert.deepEqual(ctx.tickets.participants(r.ticketId).map((x) => x.email).sort(), ['k1@extern.example', 'k2@extern.example']);
});
