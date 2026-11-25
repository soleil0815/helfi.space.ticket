// A public reply of an agent puts the ticket on "Waiting" (for the customer); the customer's answer
// reopens it. Internal notes, the agent's own tickets, "don't wait" and outage messages change nothing.
// Migration 52 does the same once for tickets answered before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let erika;
before(async () => {
  S = await startServer('reply-waits');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  erika = await S.user('erika', 'user');
});
after(() => S.stop());

const mk = async (who, title) => (await who('POST', '/api/tickets', { title })).body.ticket.key;
const status = async (key) => (await anna('GET', `/api/tickets/${key}`)).body.ticket.status;
const reply = (who, key, body, extra = {}) => who('POST', `/api/tickets/${key}/comments`, { body, ...extra });

test('Reply to the customer → "Waiting", the customer answers → "Open"; counted in the queue', async () => {
  const before = (await anna('GET', '/api/queues')).body.counts;
  const key = await mk(karl, 'Drucker druckt nicht');
  assert.equal((await reply(anna, key, 'Ist er eingeschaltet?')).status, 201);
  assert.equal(await status(key), 'waiting');
  const tk = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  assert.ok(tk.activity.some((a) => a.field === 'status' && a.oldValue === 'open' && a.newValue === 'waiting'), 'history entry');
  const counts = (await anna('GET', '/api/queues')).body.counts;
  assert.equal((counts.waiting || 0) - (before.waiting || 0), 1, '"Waiting for customer" counts it');
  await reply(karl, key, 'Ja, ist er.');
  assert.equal(await status(key), 'open');
});

test('In progress → "Waiting"; already waiting or done stays', async () => {
  const key = await mk(karl, 'VPN');
  await anna('PATCH', `/api/tickets/${key}`, { status: 'in_progress' });
  await reply(anna, key, 'Bitte neu verbinden.');
  assert.equal(await status(key), 'waiting');
  await reply(anna, key, 'Noch ein Hinweis.');
  assert.equal(await status(key), 'waiting');
  await anna('PATCH', `/api/tickets/${key}`, { status: 'done' });
  await reply(anna, key, 'Nachtrag nach dem Erledigen.');
  assert.equal(await status(key), 'done');
});

test('Internal note, unticked "wait" and the agent\'s own ticket change nothing', async () => {
  const a = await mk(karl, 'A');
  await reply(anna, a, 'nur intern', { internal: true });
  assert.equal(await status(a), 'open');
  await reply(anna, a, 'Ich melde mich morgen.', { waitForCustomer: false });
  assert.equal(await status(a), 'open');
  const own = await mk(anna, 'Eigenes Ticket');
  await reply(anna, own, 'Notiz an mich');
  assert.equal(await status(own), 'open', 'the agent is the customer here');
  // A user cannot use the switch to move anything
  const b = await mk(karl, 'B');
  await reply(karl, b, 'Noch was', { waitForCustomer: true });
  assert.equal(await status(b), 'open');
});

test('Outage message to all affected: IT is working on it, nobody waits for the customer', async () => {
  const major = await mk(anna, 'Netzwerk gestört');
  const k1 = await mk(erika, 'Kein Internet');
  await anna('PATCH', `/api/tickets/${major}`, { major: true, type: 'incident' });
  await anna('POST', `/api/tickets/${major}/links`, { kind: 'causes', target: k1 });
  const r = await anna('POST', `/api/tickets/${major}/broadcast`, { body: 'Wir arbeiten daran.' });
  assert.equal(r.status, 200);
  assert.equal(await status(k1), 'open');
});

test('Migration 52: tickets answered before wait for the customer', async () => {
  const { MIGRATIONS } = await import('../src/db.js');
  const m = MIGRATIONS.find((x) => x.id === 52);
  assert.ok(m, 'migration 52 exists');
  const db = S.db;
  const idOf = (key) => db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(key).id;
  // Old state: replies were saved without changing the status
  const answered = await mk(karl, 'beantwortet');
  const askedBack = await mk(karl, 'Kunde hat zurückgeschrieben');
  const noteOnly = await mk(karl, 'nur interne Notiz');
  const deletedReply = await mk(karl, 'Antwort gelöscht');
  const own = await mk(anna, 'eigenes');
  const closed = await mk(karl, 'erledigt');
  for (const k of [answered, askedBack, deletedReply, own, closed]) await reply(anna, k, 'Antwort', { waitForCustomer: false });
  await reply(karl, askedBack, 'Danke, aber …');
  await reply(anna, noteOnly, 'intern', { internal: true });
  db.prepare("UPDATE comments SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), body='' WHERE ticket_id=? AND internal=0").run(idOf(deletedReply));
  await anna('PATCH', `/api/tickets/${closed}`, { status: 'done' });
  db.prepare("UPDATE tickets SET status='in_progress' WHERE id=?").run(idOf(answered));

  db.exec(m.sql);
  assert.equal(await status(answered), 'waiting');
  const hist = (await anna('GET', `/api/tickets/${answered}`)).body.ticket.activity.filter((a) => a.field === 'status' && a.newValue === 'waiting');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].oldValue, 'in_progress');
  for (const k of [askedBack, noteOnly, deletedReply, own]) assert.equal(await status(k), 'open', k);
  assert.equal(await status(closed), 'done');
  // Running it again changes nothing more
  db.exec(m.sql);
  assert.equal((await anna('GET', `/api/tickets/${answered}`)).body.ticket.activity.filter((a) => a.field === 'status' && a.newValue === 'waiting').length, 1);
});
