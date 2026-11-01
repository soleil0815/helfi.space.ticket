// Tests: Anfrage-Teilnehmer (Rechte, Web, E-Mail-CC, Benachrichtigungen)
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
const anna = client(); // Bearbeiterin
const karl = client(); // Melder
const lena = client(); // Kollegin, wird Teilnehmerin
const otto = client(); // unbeteiligt
const ids = {};
let key;

test('Vorbereitung', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  for (const [u, role] of [['anna', 'agent'], ['karl', 'user'], ['lena', 'user'], ['otto', 'user']]) {
    const r = await admin('POST', '/api/users', { username: u, displayName: u[0].toUpperCase() + u.slice(1), email: `${u}@firma.local`, role, password: 'Sehrgeheim123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids[u] = r.body.user.id;
  }
  for (const [c, u] of [[anna, 'anna'], [karl, 'karl'], [lena, 'lena'], [otto, 'otto']]) {
    assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'Sehrgeheim123' })).status, 200);
  }
  const r = await karl('POST', '/api/tickets', { title: 'Drucker druckt nicht', description: 'Seit heute' });
  key = r.body.ticket.key;
  await anna('POST', `/api/tickets/${key}/comments`, { body: 'nur intern', internal: true });
  await anna('POST', `/api/tickets/${key}/comments`, { body: 'Bitte neu starten' });
});

test('Melder fügt Kollegin hinzu: sie sieht das Ticket ohne interne Notizen', async () => {
  assert.equal((await lena('GET', `/api/tickets/${key}`)).status, 404, 'vorher unsichtbar');
  const r = await karl('POST', `/api/tickets/${key}/participants`, { userId: ids.lena });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.participants.map((p) => p.displayName), ['Lena']);
  assert.equal(r.body.participants[0].email, undefined, 'Benutzer sehen keine fremden Adressen');

  const tk = (await lena('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.key, key);
  assert.ok(tk.comments.every((c) => !c.internal), 'keine internen Notizen');
  assert.ok(tk.comments.some((c) => c.body === 'Bitte neu starten'));
  assert.equal(tk.canManageParticipants, true);
  assert.equal(tk.participants[0].email, 'lena@firma.local', 'eigene Adresse sichtbar');

  const list = (await lena('GET', '/api/tickets')).body.tickets.map((x) => x.key);
  assert.ok(list.includes(key));
  assert.deepEqual((await lena('GET', '/api/tickets?participant=me')).body.tickets.map((x) => x.key), [key]);
  assert.deepEqual((await lena('GET', '/api/tickets?reporter=me')).body.tickets, []);
  assert.equal((await otto('GET', `/api/tickets/${key}`)).status, 404);
  assert.ok(!(await otto('GET', '/api/tickets')).body.tickets.some((x) => x.key === key));

  // doppelt und Melder selbst: kein Fehler, keine Dopplung
  assert.equal((await karl('POST', `/api/tickets/${key}/participants`, { userId: ids.lena })).status, 200);
  assert.equal((await karl('POST', `/api/tickets/${key}/participants`, { userId: ids.karl })).body.participants.length, 1);
  const act = db.prepare("SELECT * FROM activity WHERE action='participantAdded'").all();
  assert.equal(act.length, 1);
});

test('Teilnehmer: kommentieren ja, Status/Titel/Zuweisung nein', async () => {
  assert.equal((await lena('POST', `/api/tickets/${key}/comments`, { body: 'Bei mir auch' })).status, 201);
  const r = await lena('PATCH', `/api/tickets/${key}`, { status: 'done', assigneeId: ids.anna });
  assert.equal(r.status, 403);
  assert.equal((await lena('PATCH', `/api/tickets/${key}`, { title: 'Neu' })).status, 403);
  const tk = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.status, 'open');
  assert.equal(tk.title, 'Drucker druckt nicht');
  // interne Notiz kann ein Teilnehmer nicht schreiben
  await lena('POST', `/api/tickets/${key}/comments`, { body: 'heimlich', internal: true });
  assert.ok(!(await anna('GET', `/api/tickets/${key}`)).body.ticket.comments.some((c) => c.body === 'heimlich' && c.internal));
});

test('Antwort eines Teilnehmers öffnet ein wartendes Ticket wieder', async () => {
  await anna('PATCH', `/api/tickets/${key}`, { status: 'waiting' });
  await lena('POST', `/api/tickets/${key}/comments`, { body: 'Geht immer noch nicht' });
  assert.equal((await anna('GET', `/api/tickets/${key}`)).body.ticket.status, 'open');
});

test('Benutzer dürfen keine freien Adressen oder E-Mail-Kontakte hinzufügen, Bearbeiter schon', async () => {
  assert.equal((await karl('POST', `/api/tickets/${key}/participants`, { email: 'fremd@kunde.example' })).status, 403);
  assert.equal((await otto('POST', `/api/tickets/${key}/participants`, { userId: ids.otto })).status, 404, 'Unbeteiligte sehen das Ticket nicht');
  const r = await anna('POST', `/api/tickets/${key}/participants`, { email: 'Extern@Kunde.example' });
  assert.equal(r.status, 201);
  const ext = r.body.participants.find((p) => p.email === 'extern@kunde.example');
  assert.ok(ext && ext.contact, 'als E-Mail-Kontakt angelegt');
  assert.equal((await karl('POST', `/api/tickets/${key}/participants`, { userId: ext.id })).status, 403, 'Kontakte nur durch Bearbeiter');
  assert.equal((await anna('POST', `/api/tickets/${key}/participants`, { email: 'kein-mail' })).status, 400);
  assert.equal((await anna('POST', `/api/tickets/${key}/participants`, {})).status, 400);
  // Kontakt aus einem anderen Ticket darf ein Benutzer nicht hinzufügen
  const t2 = (await karl('POST', '/api/tickets', { title: 'Zweites' })).body.ticket.key;
  assert.equal((await karl('POST', `/api/tickets/${t2}/participants`, { userId: ext.id })).status, 403);
});

test('Personensuche: Benutzer finden nur echte Konten, ohne Adressen', async () => {
  assert.deepEqual((await karl('GET', '/api/people?q=l')).body.people, [], 'mindestens 2 Zeichen');
  const p = (await karl('GET', '/api/people?q=le')).body.people;
  assert.deepEqual(p.map((x) => x.displayName), ['Lena']);
  assert.equal(p[0].email, undefined);
  assert.deepEqual((await karl('GET', '/api/people?q=extern')).body.people, [], 'E-Mail-Kontakte nicht');
  const a = (await anna('GET', '/api/people?q=extern')).body.people;
  assert.equal(a[0].email, 'extern@kunde.example', 'Bearbeiter finden auch Kontakte');
  assert.deepEqual((await karl('GET', '/api/people?q=%25%25')).body.people, [], 'Platzhalter werden maskiert');
});

test('Entfernen: Melder, Bearbeiter oder die Person selbst – sonst niemand', async () => {
  const tk = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  const ext = tk.participants.find((p) => p.contact);
  assert.equal((await lena('DELETE', `/api/tickets/${key}/participants/${ext.id}`)).status, 403);
  assert.equal((await karl('DELETE', `/api/tickets/${key}/participants/${ext.id}`)).status, 200);
  assert.equal((await lena('DELETE', `/api/tickets/${key}/participants/${ids.lena}`)).status, 200);
  assert.equal((await lena('GET', `/api/tickets/${key}`)).status, 404, 'danach unsichtbar');
  assert.equal((await anna('DELETE', `/api/tickets/${key}/participants/${ids.lena}`)).status, 404);
});

test(`Höchstens ${MAX_PARTICIPANTS} Teilnehmer`, async () => {
  const t3 = (await anna('POST', '/api/tickets', { title: 'Viele' })).body.ticket.key;
  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    assert.equal((await anna('POST', `/api/tickets/${t3}/participants`, { email: `p${i}@kunde.example` })).status, 201);
  }
  assert.equal((await anna('POST', `/api/tickets/${t3}/participants`, { email: 'zuviel@kunde.example' })).status, 400);
});

// ---------- E-Mail ----------
async function mail(lines) {
  const p = ctx.processor;
  const parsed = await p.parse(Buffer.from(lines.join('\r\n')));
  return p.process(parsed, {});
}

test('E-Mail: An/CC werden Teilnehmer (ohne eigene Adresse und Bearbeiter), sie dürfen per Mail antworten', async () => {
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
  const r = await mail(['From: Paula <paula@kunde.example>', 'To: helpdesk@firma.local, Chef <chef@kunde.example>',
    'Cc: anna@firma.local, kollege@kunde.example, Helpdesk@firma.local, paula@kunde.example', 'Subject: Server weg', 'Message-ID: <cc1@k>', '', 'Hilfe']);
  assert.equal(r.action, 'ticket');
  const names = ctx.tickets.participants(r.ticketId).map((p) => p.email).sort();
  assert.deepEqual(names, ['chef@kunde.example', 'kollege@kunde.example']);

  // Teilnehmer antwortet mit Ticketnummer im Betreff → Kommentar statt neues Ticket
  const tk = ctx.tickets.rawById(r.ticketId);
  const r2 = await mail(['From: kollege@kunde.example', `Subject: AW: [IT-${tk.number}] Server weg`, 'Message-ID: <cc2@k>', '', 'Bei mir auch']);
  assert.equal(r2.action, 'comment');
  assert.equal(r2.ticketId, r.ticketId);
  // Unbeteiligter mit derselben Nummer → eigenes Ticket
  const r3 = await mail(['From: fremd@kunde.example', `Subject: AW: [IT-${tk.number}] Server weg`, 'Message-ID: <cc3@k>', '', 'x']);
  assert.equal(r3.action, 'ticket');
});

test('E-Mail: CC-Übernahme abschaltbar; automatische Mails fügen niemanden hinzu', async () => {
  ctx.settings.set('imap.ccParticipants', false);
  const r = await mail(['From: max@kunde.example', 'To: helpdesk@firma.local', 'Cc: x1@kunde.example', 'Subject: Ohne CC', 'Message-ID: <cc4@k>', '', 'x']);
  assert.deepEqual(ctx.tickets.participants(r.ticketId), []);
  ctx.settings.set('imap.ccParticipants', true);
  const r2 = await mail(['From: robot@kunde.example', 'To: helpdesk@firma.local', 'Cc: x2@kunde.example', 'Auto-Submitted: auto-replied', 'Subject: Abwesend', 'Message-ID: <cc5@k>', '', 'x']);
  assert.equal(r2.reason, 'automated');
  assert.equal(ctx.users.byEmail('x2@kunde.example'), undefined);
});

// ---------- Benachrichtigungen ----------
test('Benachrichtigungen gehen einzeln an Melder und Teilnehmer, nie an den Auslöser', async () => {
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
  assert.deepEqual(sent.map((m) => m.to), ['melder@x.de', 'kontakt@x.de'], 'Kommentar eines Teilnehmers geht an die anderen');

  sent.length = 0;
  events.emit('commented', { ticket, comment: { body: 'intern', source: 'web' }, user: { id: 2, role: 'agent', display_name: 'Anna' }, internal: true });
  events.emit('commented', { ticket, comment: { body: 'mail', source: 'email' }, user: { id: 6, role: 'user', display_name: 'Teil' }, internal: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 0, 'nie interne Notizen oder Kommentare aus E-Mails');

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

test('Empfängerliste: Melder und aktive Teilnehmer, ohne Doppelte', async () => {
  const t4 = (await karl('POST', '/api/tickets', { title: 'Liste' })).body.ticket.key;
  await karl('POST', `/api/tickets/${t4}/participants`, { userId: ids.lena });
  await anna('POST', `/api/tickets/${t4}/participants`, { userId: ids.otto });
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(ids.otto);
  const id = ctx.tickets.load(null, t4).id;
  assert.deepEqual(ctx.tickets.customerRecipients(id).map((r) => r.email), ['karl@firma.local', 'lena@firma.local']);
  db.prepare('UPDATE users SET active=1 WHERE id=?').run(ids.otto);
});
