// Tests: request participants (permissions, web, email CC, notifications)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-part-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { MAX_PARTICIPANTS } = await import('../src/tickets.js');
const { wireNotifications } = await import('../src/mail/smtp.js');

let server; let base; let db; let ctx;

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const headers = { Accept: 'application/json', 'X-Helfi-Request': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const admin = client();
const anna = client(); // agent
const karl = client(); // reporter
const lena = client(); // colleague, becomes a participant
const otto = client(); // not involved
const ids = {};
let key;

test('Setup', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  for (const [u, role] of [['anna', 'agent'], ['karl', 'user'], ['lena', 'user'], ['otto', 'user']]) {
    const r = await admin('POST', '/api/users', { username: u, displayName: u[0].toUpperCase() + u.slice(1), email: `${u}@firma.local`, role: role === 'agent' ? 'user' : role, password: 'Sehrgeheim123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids[u] = r.body.user.id;
  }
  // legacy all-projects agents: the API no longer gives out role 'agent'
  db.prepare("UPDATE users SET role='agent' WHERE username IN ('anna')").run();
  for (const [c, u] of [[anna, 'anna'], [karl, 'karl'], [lena, 'lena'], [otto, 'otto']]) {
    assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'Sehrgeheim123' })).status, 200);
  }
  const r = await karl('POST', '/api/tickets', { title: 'Drucker druckt nicht', description: 'Seit heute' });
  key = r.body.ticket.key;
  await anna('POST', `/api/tickets/${key}/comments`, { body: 'nur intern', internal: true });
  await anna('POST', `/api/tickets/${key}/comments`, { body: 'Bitte neu starten' });
});

test('Reporter adds a colleague: she sees the ticket without internal notes', async () => {
  assert.equal((await lena('GET', `/api/tickets/${key}`)).status, 404, 'invisible before');
  const r = await karl('POST', `/api/tickets/${key}/participants`, { userId: ids.lena });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.participants.map((p) => p.displayName), ['Lena']);
  assert.equal(r.body.participants[0].email, undefined, 'users do not see other people\'s addresses');

  const tk = (await lena('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.key, key);
  assert.ok(tk.comments.every((c) => !c.internal), 'no internal notes');
  assert.ok(tk.comments.some((c) => c.body === 'Bitte neu starten'));
  assert.equal(tk.canManageParticipants, true);
  assert.equal(tk.participants[0].email, 'lena@firma.local', 'own address visible');

  const list = (await lena('GET', '/api/tickets')).body.tickets.map((x) => x.key);
  assert.ok(list.includes(key));
  assert.deepEqual((await lena('GET', '/api/tickets?participant=me')).body.tickets.map((x) => x.key), [key]);
  assert.deepEqual((await lena('GET', '/api/tickets?reporter=me')).body.tickets, []);
  assert.equal((await otto('GET', `/api/tickets/${key}`)).status, 404);
  assert.ok(!(await otto('GET', '/api/tickets')).body.tickets.some((x) => x.key === key));

  // duplicate and the reporter themselves: no error, no duplicate
  assert.equal((await karl('POST', `/api/tickets/${key}/participants`, { userId: ids.lena })).status, 200);
  assert.equal((await karl('POST', `/api/tickets/${key}/participants`, { userId: ids.karl })).body.participants.length, 1);
  const act = db.prepare("SELECT * FROM activity WHERE action='participantAdded'").all();
  assert.equal(act.length, 1);
});

test('Participants: commenting yes, status/title/assignment no', async () => {
  assert.equal((await lena('POST', `/api/tickets/${key}/comments`, { body: 'Bei mir auch' })).status, 201);
  const r = await lena('PATCH', `/api/tickets/${key}`, { status: 'done', assigneeId: ids.anna });
  assert.equal(r.status, 403);
  assert.equal((await lena('PATCH', `/api/tickets/${key}`, { title: 'Neu' })).status, 403);
  const tk = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.status, 'open');
  assert.equal(tk.title, 'Drucker druckt nicht');
  // a participant cannot write an internal note
  await lena('POST', `/api/tickets/${key}/comments`, { body: 'heimlich', internal: true });
  assert.ok(!(await anna('GET', `/api/tickets/${key}`)).body.ticket.comments.some((c) => c.body === 'heimlich' && c.internal));
});

test('A participant\'s reply reopens a waiting ticket', async () => {
  await anna('PATCH', `/api/tickets/${key}`, { status: 'waiting' });
  await lena('POST', `/api/tickets/${key}/comments`, { body: 'Geht immer noch nicht' });
  assert.equal((await anna('GET', `/api/tickets/${key}`)).body.ticket.status, 'open');
});

test('Users may not add arbitrary addresses or email contacts, agents may', async () => {
  assert.equal((await karl('POST', `/api/tickets/${key}/participants`, { email: 'fremd@kunde.example' })).status, 403);
  assert.equal((await otto('POST', `/api/tickets/${key}/participants`, { userId: ids.otto })).status, 404, 'uninvolved people do not see the ticket');
  const r = await anna('POST', `/api/tickets/${key}/participants`, { email: 'Extern@Kunde.example' });
  assert.equal(r.status, 201);
  const ext = r.body.participants.find((p) => p.email === 'extern@kunde.example');
  assert.ok(ext && ext.contact, 'created as email contact');
  assert.equal((await karl('POST', `/api/tickets/${key}/participants`, { userId: ext.id })).status, 403, 'contacts only by agents');
  assert.equal((await anna('POST', `/api/tickets/${key}/participants`, { email: 'kein-mail' })).status, 400);
  assert.equal((await anna('POST', `/api/tickets/${key}/participants`, {})).status, 400);
  // a user may not add a contact from another ticket
  const t2 = (await karl('POST', '/api/tickets', { title: 'Zweites' })).body.ticket.key;
  assert.equal((await karl('POST', `/api/tickets/${t2}/participants`, { userId: ext.id })).status, 403);
});

test('People search: users only find real accounts, without addresses', async () => {
  assert.deepEqual((await karl('GET', '/api/people?q=l')).body.people, [], 'at least 2 characters');
  const p = (await karl('GET', '/api/people?q=le')).body.people;
  assert.deepEqual(p.map((x) => x.displayName), ['Lena']);
  assert.equal(p[0].email, undefined);
  assert.deepEqual((await karl('GET', '/api/people?q=extern')).body.people, [], 'not email contacts');
  const a = (await anna('GET', '/api/people?q=extern')).body.people;
  assert.equal(a[0].email, 'extern@kunde.example', 'agents also find contacts');
  assert.deepEqual((await karl('GET', '/api/people?q=%25%25')).body.people, [], 'wildcards are escaped');
});

test('Removing: reporter, agents or the person themselves – nobody else', async () => {
  const tk = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  const ext = tk.participants.find((p) => p.contact);
  assert.equal((await lena('DELETE', `/api/tickets/${key}/participants/${ext.id}`)).status, 403);
  assert.equal((await karl('DELETE', `/api/tickets/${key}/participants/${ext.id}`)).status, 200);
  assert.equal((await lena('DELETE', `/api/tickets/${key}/participants/${ids.lena}`)).status, 200);
  assert.equal((await lena('GET', `/api/tickets/${key}`)).status, 404, 'invisible afterwards');
  assert.equal((await anna('DELETE', `/api/tickets/${key}/participants/${ids.lena}`)).status, 404);
});

test(`At most ${MAX_PARTICIPANTS} participants`, async () => {
  const t3 = (await anna('POST', '/api/tickets', { title: 'Viele' })).body.ticket.key;
  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    assert.equal((await anna('POST', `/api/tickets/${t3}/participants`, { email: `p${i}@kunde.example` })).status, 201);
  }
  assert.equal((await anna('POST', `/api/tickets/${t3}/participants`, { email: 'zuviel@kunde.example' })).status, 400);
});

// ---------- Email ----------
async function mail(lines) {
  const p = ctx.processor;
  const parsed = await p.parse(Buffer.from(lines.join('\r\n')));
  return p.process(parsed, {});
}

test('Email: To/CC become participants (except our own address and agents), they may reply by mail', async () => {
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
  const r = await mail(['From: Paula <paula@kunde.example>', 'To: helpdesk@firma.local, Chef <chef@kunde.example>',
    'Cc: anna@firma.local, kollege@kunde.example, Helpdesk@firma.local, paula@kunde.example', 'Subject: Server weg', 'Message-ID: <cc1@k>', '', 'Hilfe']);
  assert.equal(r.action, 'ticket');
  const names = ctx.tickets.participants(r.ticketId).map((p) => p.email).sort();
  assert.deepEqual(names, ['chef@kunde.example', 'kollege@kunde.example']);

  // Participant replies with ticket number in the subject → comment instead of new ticket
  const tk = ctx.tickets.rawById(r.ticketId);
  const r2 = await mail(['From: kollege@kunde.example', `Subject: AW: [IT-${tk.number}] Server weg`, 'Message-ID: <cc2@k>', '', 'Bei mir auch']);
  assert.equal(r2.action, 'comment');
  assert.equal(r2.ticketId, r.ticketId);
  // Uninvolved person with the same number → separate ticket
  const r3 = await mail(['From: fremd@kunde.example', `Subject: AW: [IT-${tk.number}] Server weg`, 'Message-ID: <cc3@k>', '', 'x']);
  assert.equal(r3.action, 'ticket');
});

test('Email: CC takeover can be disabled; automated mails add nobody', async () => {
  ctx.settings.set('imap.ccParticipants', false);
  const r = await mail(['From: max@kunde.example', 'To: helpdesk@firma.local', 'Cc: x1@kunde.example', 'Subject: Ohne CC', 'Message-ID: <cc4@k>', '', 'x']);
  assert.deepEqual(ctx.tickets.participants(r.ticketId), []);
  ctx.settings.set('imap.ccParticipants', true);
  const r2 = await mail(['From: robot@kunde.example', 'To: helpdesk@firma.local', 'Cc: x2@kunde.example', 'Auto-Submitted: auto-replied', 'Subject: Abwesend', 'Message-ID: <cc5@k>', '', 'x']);
  assert.equal(r2.reason, 'automated');
  assert.equal(ctx.users.byEmail('x2@kunde.example'), undefined);
});

// ---------- Notifications ----------
test('Notifications go individually to reporter and participants, never to the actor', async () => {
  const sent = [];
  const events = new EventEmitter();
  const recipients = [{ id: 5, email: 'melder@x.de', displayName: 'Melder' }, { id: 6, email: 'teil@x.de', displayName: 'Teil' }, { id: null, email: 'kontakt@x.de', displayName: 'K' }];
  const tickets = { events, rawById: () => ({ id: 1 }), customerRecipients: () => recipients };
  const settings = { get: (k) => (k === 'general.defaultLanguage' ? 'de' : (k === 'general.title' ? 'Helfi.Space' : true)) };
  const users = { byId: () => ({ language: 'de' }) };
  wireNotifications({ tickets, mailer: { enabled: () => true, send: async (m) => { sent.push(m); } }, settings, users });
  const ticket = { id: 1, key: 'IT-1', title: 'X' };

  events.emit('commented', { ticket, comment: { body: 'Antwort', source: 'web' }, user: { id: 2, role: 'agent', display_name: 'Anna' }, internal: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.map((m) => m.to), ['melder@x.de', 'teil@x.de', 'kontakt@x.de']);

  sent.length = 0;
  events.emit('commented', { ticket, comment: { body: 'auch', source: 'web' }, user: { id: 6, role: 'user', display_name: 'Teil' }, internal: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.map((m) => m.to), ['melder@x.de', 'kontakt@x.de'], 'a participant\'s comment goes to the others');

  sent.length = 0;
  events.emit('commented', { ticket, comment: { body: 'intern', source: 'web' }, user: { id: 2, role: 'agent', display_name: 'Anna' }, internal: true });
  events.emit('commented', { ticket, comment: { body: 'mail', source: 'email' }, user: { id: 6, role: 'user', display_name: 'Teil' }, internal: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 0, 'never internal notes or comments from emails');

  events.emit('resolved', { ticket, user: { id: 2 } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 3);

  sent.length = 0;
  events.emit('participantAdded', { ticket, participant: { id: 7, email: 'neu@x.de', display_name: 'Neu' }, user: { id: 5, display_name: 'Melder' } });
  events.emit('participantAdded', { ticket, participant: { id: 5, email: 'melder@x.de', display_name: 'Selbst' }, user: { id: 5, display_name: 'Melder' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.map((m) => m.to), ['neu@x.de']);
  assert.match(sent[0].text, /Melder hat Sie als Teilnehmer/);
});

test('Recipient list: reporter and active participants, without duplicates', async () => {
  const t4 = (await karl('POST', '/api/tickets', { title: 'Liste' })).body.ticket.key;
  await karl('POST', `/api/tickets/${t4}/participants`, { userId: ids.lena });
  await anna('POST', `/api/tickets/${t4}/participants`, { userId: ids.otto });
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(ids.otto);
  const id = ctx.tickets.load(null, t4).id;
  assert.deepEqual(ctx.tickets.customerRecipients(id).map((r) => r.email), ['karl@firma.local', 'lena@firma.local']);
  db.prepare('UPDATE users SET active=1 WHERE id=?').run(ids.otto);
});
