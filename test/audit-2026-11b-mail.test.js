// Tests for audit 2026-11b, email: replies via Message-ID from people no longer involved,
// forged delivery reports, "resolved" event (survey) for quiet resolving, AD lookups for CC
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startServer } from './helpers/server.js';

let S; let ctx; let db; let anna;
const outbox = [];
const wait = () => new Promise((r) => setTimeout(r, 80));
const eml = (lines) => Buffer.from(lines.join('\r\n'));
async function run(lines, opts = {}) { const p = ctx.processor; return p.process(await p.parse(eml(lines)), opts); }
const publicComments = (ticketId) => ctx.tickets.comments({ id: -1, role: 'user' }, ticketId);
const emails = (ticketId) => ctx.tickets.participants(ticketId).map((p) => p.email);

before(async () => {
  S = await startServer('audit-b-mail');
  ctx = S.ctx; db = S.db;
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
  ctx.settings.set('imap.ccParticipants', true);
  anna = await S.user('anna', 'agent');
  await S.user('bob', 'user');
  nodemailer.createTransport = () => ({ sendMail: async (m) => { outbox.push(m); return {}; }, verify: async () => true });
  ctx.settings.set('smtp.enabled', true);
  ctx.settings.set('smtp.host', 'smtp.firma.local');
  ctx.settings.set('smtp.from', 'helpdesk@firma.local');
  ctx.settings.set('notify.reporterOnCreate', true);
  ctx.settings.set('notify.reporterOnComment', true);
  ctx.settings.set('notify.participantAdded', true);
});
after(() => S.stop());

test('Former reporter replying to an old mail: internal note only, no CC participants, no reopening', async () => {
  const first = await run(['From: alice@extern.example', 'To: helpdesk@firma.local', 'Subject: Problem', 'Message-ID: <b1a@extern.example>', '', 'text']);
  await wait();
  const confirm = outbox.find((m) => m.to === 'alice@extern.example');
  assert.ok(confirm, 'confirmation sent');
  const r = await anna('PUT', `/api/tickets/${first.key}/reporter`, { reporter: { userId: S.ids.bob }, notify: false });
  assert.equal(r.status, 200);
  await anna('PATCH', `/api/tickets/${first.key}`, { status: 'done' });
  const before = publicComments(first.ticketId).length;
  const r2 = await run(['From: alice@extern.example', 'To: helpdesk@firma.local', 'Cc: outsider@extern2.example', 'Subject: Re: Problem',
    'Message-ID: <b1b@extern.example>', `In-Reply-To: ${confirm.messageId}`, '', 'still here']);
  assert.equal(r2.action, 'comment');
  assert.equal(r2.ticketId, first.ticketId);
  assert.ok(!emails(first.ticketId).includes('outsider@extern2.example'), 'CC recipient not added');
  assert.equal(publicComments(first.ticketId).length, before, 'not a public comment');
  const last = db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(first.ticketId);
  assert.equal(last.internal, 1);
  assert.match(last.body, /still here/);
  assert.match(last.body, /not \(or no longer\) involved/, "agents see why it is only a note");
  assert.equal(ctx.tickets.rawById(first.ticketId).status, 'done', 'not reopened');
  outbox.length = 0;
  await anna('POST', `/api/tickets/${first.key}/comments`, { body: 'Confidential reply' });
  await wait();
  assert.ok(!outbox.some((m) => m.to === 'outsider@extern2.example' || m.to === 'alice@extern.example'), 'no reply to former reporter/outsider');
});

test('Removed participant replying to an old mail: internal note, CC not added', async () => {
  const tk = (await anna('POST', '/api/tickets', { title: 'Secret', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  await anna('POST', `/api/tickets/${tk.key}/participants`, { email: 'ex@extern.example' });
  await wait();
  const added = outbox.find((m) => m.to === 'ex@extern.example');
  assert.ok(added);
  const pid = ctx.tickets.participants(tk.id).find((p) => p.email === 'ex@extern.example').id;
  assert.equal((await anna('DELETE', `/api/tickets/${tk.key}/participants/${pid}`)).status, 200);
  const r = await run(['From: ex@extern.example', 'To: helpdesk@firma.local', 'Cc: ex-private@extern2.example', 'Subject: Re: x',
    'Message-ID: <b2@extern.example>', `In-Reply-To: ${added.messageId}`, '', 'hi']);
  assert.equal(r.action, 'comment');
  assert.deepEqual(emails(tk.id), [], 'nobody re-added');
  assert.equal(publicComments(tk.id).length, 0);
});

test('Current participant replying via Message-ID: public comment and CC participants (unchanged)', async () => {
  const tk = (await anna('POST', '/api/tickets', { title: 'Shared', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  await anna('POST', `/api/tickets/${tk.key}/participants`, { email: 'carl@extern.example' });
  await wait();
  const added = outbox.find((m) => m.to === 'carl@extern.example');
  const r = await run(['From: carl@extern.example', 'To: helpdesk@firma.local', 'Cc: dora@extern.example', 'Subject: Re: x',
    'Message-ID: <b3@extern.example>', `In-Reply-To: ${added.messageId}`, '', 'hello']);
  assert.equal(r.action, 'comment');
  assert.ok(emails(tk.id).includes('dora@extern.example'));
  assert.equal(publicComments(tk.id).length, 1);
});

test('CC recipients of a reply from a non-participant are not looked up in AD', async () => {
  const tk = (await anna('POST', '/api/tickets', { title: 'Lookup', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  await anna('POST', `/api/tickets/${tk.key}/participants`, { email: 'gone@extern.example' });
  await wait();
  const added = outbox.find((m) => m.to === 'gone@extern.example');
  const pid = ctx.tickets.participants(tk.id).find((p) => p.email === 'gone@extern.example').id;
  await anna('DELETE', `/api/tickets/${tk.key}/participants/${pid}`);
  const p = ctx.processor;
  const parsed = await p.parse(eml(['From: gone@extern.example', 'To: helpdesk@firma.local', 'Cc: lookup-me@firma.local', 'Subject: Re: x',
    'Message-ID: <b4@extern.example>', `In-Reply-To: ${added.messageId}`, '', 'hi']));
  // Enable AD lookup with a fake directory and count the queries
  ctx.settings.set('imap.adLookup', true);
  ctx.settings.set('ldap.enabled', true);
  ctx.settings.set('ldap.bindDn', 'CN=svc,DC=firma,DC=local');
  try {
    const { createMailProcessor } = await import('../src/mail/imap.js');
    let calls = 0;
    const proc = createMailProcessor({ db, settings: ctx.settings, tickets: ctx.tickets, users: ctx.users, adLookup: async () => { calls++; return null; } });
    const found = await proc.lookupParticipants(parsed);
    assert.equal(found.size, 0);
    assert.equal(calls, 0, 'no AD lookup for CC that is discarded anyway');
    // New mail (new ticket): CC is looked up as before
    const fresh = await p.parse(eml(['From: new@extern.example', 'To: helpdesk@firma.local', 'Cc: lookup-me@firma.local', 'Subject: New', 'Message-ID: <b4b@extern.example>', '', 'x']));
    await proc.lookupParticipants(fresh);
    assert.equal(calls, 1);
    // [KEY] in the subject from a non-participant becomes a new ticket: CC is looked up
    const viaSubject = await p.parse(eml(['From: stranger@extern.example', 'To: helpdesk@firma.local', 'Cc: lookup-two@firma.local', `Subject: [${tk.key}] x`, 'Message-ID: <b4c@extern.example>', '', 'x']));
    await proc.lookupParticipants(viaSubject);
    assert.equal(calls, 2);
    // ... but from the reporter (comment, CC is never added via the subject): no lookup
    const fromReporter = await p.parse(eml(['From: bob@firma.local', 'To: helpdesk@firma.local', 'Cc: lookup-three@firma.local', `Subject: [${tk.key}] x`, 'Message-ID: <b4d@extern.example>', '', 'x']));
    await proc.lookupParticipants(fromReporter);
    assert.equal(calls, 2);
  } finally {
    ctx.settings.set('imap.adLookup', false);
    ctx.settings.set('ldap.enabled', false);
  }
});

const dsn = (msgId, failed, ref) => [
  'From: MAILER-DAEMON@mail.extern.example', 'To: helpdesk@firma.local', 'Subject: Undelivered Mail', `Message-ID: <${msgId}>`,
  ...(ref ? [`In-Reply-To: <${ref}>`] : []),
  'Content-Type: multipart/report; report-type=delivery-status; boundary="B"', '',
  '--B', 'Content-Type: text/plain', '', 'x', '',
  '--B', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns;x', '', `Final-Recipient: rfc822;${failed}`, 'Action: failed', '', '--B--'];

test('Forged delivery report without our Message-ID does not block the address', async () => {
  const r = await run(dsn('b5@evil.example', 'bob@firma.local'));
  assert.equal(r.action, 'bounce');
  assert.equal(ctx.suppressions.isBlocked('bob@firma.local'), false);
  outbox.length = 0;
  assert.equal(await ctx.mailer.send({ to: 'bob@firma.local', subject: 'Registration', text: 'x', customer: true }), true);
  // Report about one of our own mails still blocks
  const tk = (await anna('POST', '/api/tickets', { title: 'Bounce', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  const outId = `helfi.${tk.id}.1.abcdef@firma.local`;
  db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction,recipient) VALUES(?,?,'out',?)").run(outId, tk.id, 'bob@firma.local');
  const r2 = await run(dsn('b5b@mail.extern.example', 'bob@firma.local', outId));
  assert.equal(r2.ticketId, tk.id);
  assert.equal(ctx.suppressions.isBlocked('bob@firma.local'), true);
  ctx.suppressions.remove('bob@firma.local');
});

test('Delivery report with a real Message-ID only blocks the address that mail went to', async () => {
  // Anyone who once got a mail from us (e.g. a receipt) knows such a Message-ID
  const tk = (await anna('POST', '/api/tickets', { title: 'Bounce2', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  const outId = `helfi.${tk.id}.2.abcdef@firma.local`;
  db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction,recipient) VALUES(?,?,'out',?)").run(outId, tk.id, 'attacker@extern.example');
  const r = await run(dsn('b5c@mail.extern.example', 'ceo@firma.local', outId));
  assert.equal(r.action, 'bounce');
  assert.equal(ctx.suppressions.isBlocked('ceo@firma.local'), false, 'address the mail did not go to stays deliverable');
  // The mailer records the recipient of each ticket mail
  outbox.length = 0;
  await ctx.mailer.send({ to: 'Bob@Firma.local', subject: 'x', text: 'x', ticketId: tk.id, customer: true });
  const row = db.prepare("SELECT recipient FROM mail_messages WHERE ticket_id=? AND direction='out' ORDER BY rowid DESC LIMIT 1").get(tk.id);
  assert.equal(row.recipient, 'bob@firma.local');
});

test('Bulk reply + done still starts the survey and sends the reporter the rating link', async () => {
  ctx.settings.set('survey.enabled', true);
  ctx.settings.set('notify.reporterOnDone', true);
  const tk = (await anna('POST', '/api/tickets', { title: 'Bulk', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  await anna('POST', `/api/tickets/${tk.key}/participants`, { email: 'eve@extern.example' });
  await wait(); outbox.length = 0;
  const b = await anna('POST', '/api/tickets/bulk', { keys: [tk.key], comment: 'Done', changes: { status: 'done' } });
  assert.equal(b.status, 200);
  await wait();
  assert.ok(db.prepare('SELECT 1 FROM ticket_ratings WHERE ticket_id=?').get(tk.id), 'rating row created');
  const toBob = outbox.filter((m) => m.to === 'bob@firma.local');
  assert.ok(toBob.some((m) => /\/rate\//.test(m.text)), 'reporter gets the rating link');
  const toEve = outbox.filter((m) => m.to === 'eve@extern.example');
  assert.equal(toEve.length, 1, 'participant only gets the reply, no second "resolved" mail');
  // Survey off: no extra mail at all
  ctx.settings.set('survey.enabled', false);
  const tk2 = (await anna('POST', '/api/tickets', { title: 'Bulk2', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  await wait(); outbox.length = 0;
  await anna('POST', '/api/tickets/bulk', { keys: [tk2.key], comment: 'Done', changes: { status: 'done' } });
  await wait();
  assert.equal(outbox.filter((m) => m.to === 'bob@firma.local').length, 1, 'only the reply');
});
