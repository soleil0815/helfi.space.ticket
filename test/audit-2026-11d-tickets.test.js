// Audit 2026-11d: forged agent sender via a Message-ID of a mail to someone else, rejection reason
// with reply mails switched off, duplicate note language, bulk resolve with other changes,
// duplicate chains, re-resolving, import clears duplicate_of, list offset and stable sort
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let ctx; let db; let anna; let bob; let eve;
const sent = [];
const wait = () => new Promise((r) => setTimeout(r, 60));
const eml = (lines) => Buffer.from(lines.join('\r\n'));
async function run(lines) { const p = ctx.processor; return p.process(await p.parse(eml(lines))); }
const mk = async (who, title, extra = {}) => (await who('POST', '/api/tickets', { title, ...extra })).body.ticket;
const resolve = (key, body) => anna('POST', `/api/tickets/${key}/resolve`, body);

before(async () => {
  S = await startServer('audit-d');
  ctx = S.ctx; db = S.db;
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
  anna = await S.user('anna', 'agent');
  bob = await S.user('bob', 'user');
  eve = await S.user('eve', 'user');
  ctx.mailer.enabled = () => true;
  ctx.mailer.send = async (m) => { sent.push(m); return true; };
});
after(() => S.stop());

const outMail = (id, ticketId, recipient, agentOnly = 0) => db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction,agent_only,recipient) VALUES(?,?,'out',?,?)").run(id, ticketId, agentOnly, recipient);

test('Agent sender replying via the Message-ID of a mail to the reporter: internal note, no reopening', async () => {
  const tk = await mk(bob, 'Monitor flackert');
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  outMail('helfi.fwd1@firma.local', tk.id, 'bob@firma.local');
  const r = await run(['From: Anna (IT) <anna@firma.local>', 'To: helpdesk@firma.local', 'Subject: Re: Monitor flackert',
    'In-Reply-To: <helfi.fwd1@firma.local>', 'Message-ID: <forged2@evil.example>', '', 'Bitte hier neu anmelden: https://evil.example/login']);
  assert.equal(r.action, 'comment');
  const last = db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(tk.id);
  assert.equal(last.internal, 1, 'not a public comment in the agent\'s name');
  assert.match(last.body, /sender cannot be verified/);
  assert.equal(ctx.tickets.rawById(tk.id).status, 'done', 'not reopened');
});

test('Agent replying via the Message-ID of a mail sent to that agent stays a public comment', async () => {
  // e.g. the agent is the reporter of their own ticket and got the customer mail
  const tk = await mk(anna, 'Eigenes Ticket der Bearbeiterin');
  outMail('helfi.own1@firma.local', tk.id, 'anna@firma.local');
  const r = await run(['From: Anna (IT) <anna@firma.local>', 'To: helpdesk@firma.local', 'Subject: Re: Eigenes Ticket',
    'In-Reply-To: <helfi.own1@firma.local>', 'Message-ID: <own-reply1@firma.local>', '', 'Nachtrag']);
  assert.equal(r.action, 'comment');
  const last = db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(tk.id);
  assert.equal(last.internal, 0);
});

test('Rejection reason reaches the reporter even with reply mails switched off', async () => {
  ctx.settings.set('notify.reporterOnComment', false);
  try {
    const tk = await mk(bob, 'Bitte neuen Bürostuhl');
    await wait(); sent.length = 0;
    assert.equal((await resolve(tk.key, { resolution: 'rejected', reason: 'Das läuft über die Hausverwaltung.' })).status, 200);
    await wait();
    const m = sent.filter((x) => x.to === 'bob@firma.local');
    assert.equal(m.length, 1, 'exactly one mail with the reason');
    assert.match(m[0].text, /Hausverwaltung/);
    // A normal reply still sends nothing while reply mails are off
    sent.length = 0;
    await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Noch ein Hinweis.' });
    await wait();
    assert.equal(sent.filter((x) => x.to === 'bob@firma.local').length, 0);
  } finally { ctx.settings.set('notify.reporterOnComment', true); }
});

test('Duplicate standard note is written in the reporter\'s language', async () => {
  db.prepare("UPDATE users SET language='en' WHERE id=?").run(S.ids.eve);
  const orig = await mk(bob, 'VPN bricht ab');
  const dup = await mk(eve, 'VPN disconnects');
  assert.equal((await resolve(dup.key, { resolution: 'duplicate', duplicateOf: orig.key })).status, 200);
  const last = db.prepare('SELECT body FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(dup.id);
  assert.match(last.body, /already being handled in ticket/);
});

test('Bulk resolve combined with other changes is refused instead of skipping them', async () => {
  const orig = await mk(bob, 'Drucker 3. OG');
  const dup = await mk(bob, 'Drucker druckt nicht');
  const r = await anna('POST', '/api/tickets/bulk', { keys: [dup.key], resolve: { resolution: 'duplicate', duplicateOf: orig.key }, changes: { priority: 'highest' } });
  assert.equal(r.status, 400);
  const row = ctx.tickets.rawById(dup.id);
  assert.equal(row.status, 'open', 'nothing applied');
});

test('Duplicate chains: no cycle over three tickets, a closed duplicate leads to the real original', async () => {
  const a = await mk(bob, 'Kette A'); const b = await mk(bob, 'Kette B'); const c = await mk(bob, 'Kette C');
  assert.equal((await resolve(a.key, { resolution: 'duplicate', duplicateOf: b.key })).status, 200);
  assert.equal((await resolve(b.key, { resolution: 'duplicate', duplicateOf: c.key })).status, 200);
  const r = await resolve(c.key, { resolution: 'duplicate', duplicateOf: a.key });
  assert.equal(r.status, 400, 'C → A → B → C would be a cycle');
  // D closed as duplicate of A (itself a duplicate of B, B of C) ends up at C
  const d = await mk(bob, 'Kette D');
  const rd = await resolve(d.key, { resolution: 'duplicate', duplicateOf: a.key });
  assert.equal(rd.status, 200);
  assert.equal(rd.body.ticket.duplicateOf, c.key);
});

test('Re-resolving a done ticket removes the link to the previous original and touches updated_at', async () => {
  const o1 = await mk(bob, 'Original 1'); const o2 = await mk(bob, 'Original 2');
  const t = await mk(bob, 'Mehrfach geschlossen');
  await resolve(t.key, { resolution: 'duplicate', duplicateOf: o1.key });
  db.prepare("UPDATE tickets SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(t.id);
  await resolve(t.key, { resolution: 'duplicate', duplicateOf: o2.key });
  const links = () => db.prepare("SELECT to_id FROM ticket_links WHERE kind='duplicates' AND from_id=?").all(t.id).map((x) => x.to_id);
  assert.deepEqual(links(), [o2.id]);
  assert.notEqual(ctx.tickets.rawById(t.id).updated_at, '2020-01-01T00:00:00.000Z');
  await resolve(t.key, { resolution: 'rejected', reason: 'Doch nicht zuständig.' });
  assert.deepEqual(links(), []);
  assert.equal(ctx.tickets.rawById(t.id).duplicate_of, null);
});

test('Import clears duplicate_of when the source no longer has the ticket as a duplicate', async () => {
  const orig = await mk(bob, 'Import-Original');
  let updated = '2026-01-01T00:00:00Z';
  const adapter = {
    sourceId: 'fake:dup', host: 'x', kind: 'fake', keyPrefix: 'F',
    count: async () => 1,
    async *tickets() { yield { extId: '1', extKey: '#1', title: 'Importiert', statusName: 'Open', created: '2026-01-01T00:00:00Z', updated }; },
  };
  ctx.importer.start(adapter, { projects: [{ key: 'a', targetKey: 'FDU' }] }, 1);
  await ctx.importer.wait();
  const row = db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key='FDU'").get();
  // Closed locally as a duplicate; the source reopens it later
  db.prepare("UPDATE tickets SET status='done', resolution='duplicate', duplicate_of=? WHERE id=?").run(orig.id, row.id);
  updated = new Date(Date.now() + 60000).toISOString();
  ctx.importer.start(adapter, { projects: [{ key: 'a', targetKey: 'FDU' }] }, 1);
  await ctx.importer.wait();
  const after = db.prepare('SELECT status, resolution, duplicate_of FROM tickets WHERE id=?').get(row.id);
  assert.equal(after.status, 'open');
  assert.equal(after.duplicate_of, null);
});

test('Ticket list: a huge offset gives an empty page instead of an error; sort order is unique', async () => {
  const r = await anna('GET', '/api/tickets?offset=1000000000000000000000000');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tickets, []);
  // Equal timestamps: pages never repeat or skip a ticket
  db.prepare("UPDATE tickets SET updated_at='2026-05-05T05:05:05.000Z'").run();
  const all = (await anna('GET', '/api/tickets?limit=2000')).body.tickets.map((x) => x.id);
  const paged = [];
  for (let off = 0; off < all.length; off += 3) paged.push(...(await anna('GET', `/api/tickets?limit=3&offset=${off}`)).body.tickets.map((x) => x.id));
  assert.deepEqual(paged, all);
  assert.deepEqual([...all].sort((x, y) => y - x), all, 'ties ordered by id, newest first');
});

test('Import that closes a local duplicate as rejected also removes the duplicates link', async () => {
  const orig = await mk(bob, 'Import-Original 2');
  let item = { extId: '1', extKey: '#1', title: 'Importiert 2', statusName: 'Open', created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
  const adapter = { sourceId: 'fake:dup2', host: 'x', kind: 'fake', keyPrefix: 'G', count: async () => 1, async *tickets() { yield item; } };
  ctx.importer.start(adapter, { projects: [{ key: 'a', targetKey: 'FDV' }] }, 1);
  await ctx.importer.wait();
  const row = db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key='FDV'").get();
  // Closed locally as a duplicate (with its link); the source later closes it as rejected
  const key = db.prepare("SELECT p.key || '-' || t.number k FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(row.id).k;
  assert.equal((await anna('POST', `/api/tickets/${key}/resolve`, { resolution: 'duplicate', duplicateOf: orig.key, body: 'Siehe Original' })).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM ticket_links WHERE kind='duplicates' AND from_id=?").get(row.id), 'link exists before');
  item = { ...item, statusName: 'Abgelehnt', statusCategory: 'done', updated: new Date(Date.now() + 60000).toISOString() };
  ctx.importer.start(adapter, { projects: [{ key: 'a', targetKey: 'FDV' }] }, 1);
  await ctx.importer.wait();
  const after = db.prepare('SELECT resolution, duplicate_of FROM tickets WHERE id=?').get(row.id);
  assert.equal(after.resolution, 'rejected');
  assert.equal(after.duplicate_of, null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ticket_links WHERE kind='duplicates' AND from_id=?").get(row.id).n, 0, 'no stale duplicates link');
});
