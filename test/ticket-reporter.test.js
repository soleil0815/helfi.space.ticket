// Agents enter a ticket for someone else (reporter) – account, AD person or email address – and
// can change the reporter later. Users cannot do either. AD mocked, mails captured.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let lisa;
const sent = [];
const GUID = { erika: 'a1'.repeat(16) };
const AD = [{ username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: GUID.erika, groups: { admin: false, agent: false, user: true } }];
const full = (p) => ({ ...p, dn: `CN=${p.displayName},CN=Users,DC=firma,DC=local` });
const wait = () => new Promise((r) => setTimeout(r, 60));
const mailsTo = (to) => sent.filter((m) => m.to === to);

before(async () => {
  S = await startServer('reporter');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  S.ctx.settings.set('ldap.enabled', true);
  S.ctx.settings.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  S.ctx.settings.set('ldap.userGroup', 'Helfi-Benutzer');
  S.ctx.directory = {
    search: async () => AD.map(({ groups, ...p }) => p),
    byGuid: async (cfg, id) => { const p = AD.find((x) => x.externalId === id); return p ? full(p) : null; },
    byEmail: async (cfg, e) => { const p = AD.find((x) => x.email === e); return p ? full(p) : null; },
  };
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  lisa = await S.user('lisa', 'user');
});
after(() => S.stop());

const history = async (key) => (await S.admin('GET', `/api/tickets/${key}`)).body.ticket.activity;

test('Agent enters a ticket for an existing user: reporter, history, mail, visible to the user', async () => {
  sent.length = 0;
  const r = await anna('POST', '/api/tickets', { title: 'Drucker im 2. OG', description: 'per Telefon gemeldet', reporter: { userId: S.ids.karl } });
  assert.equal(r.status, 201);
  const tk = r.body.ticket;
  assert.equal(tk.reporter.id, S.ids.karl);
  const act = await history(tk.key);
  const created = act.find((a) => a.action === 'createdFor');
  assert.equal(created.user.id, S.ids.anna, 'the agent stays recorded as the one who entered it');
  assert.equal(created.newValue, 'karl');
  await wait();
  const m = mailsTo('karl@firma.local');
  assert.equal(m.length, 1);
  assert.match(m[0].subject, new RegExp(`\\[${tk.key}\\]`));
  assert.match(m[0].text, /\/browse\/IT-/);
  assert.match(m[0].text, /direkt in Helfi\.Space melden|directly in Helfi\.Space/, 'portal hint for accounts');
  assert.ok(!mailsTo('anna@firma.local').some((x) => /angelegt|created/i.test(x.subject)), 'no mail to the agent');
  const list = await karl('GET', '/api/tickets?reporter=me');
  assert.ok(list.body.tickets.some((x) => x.key === tk.key), 'karl sees it under his requests');
});

test('Without notification no mail; "me" as reporter behaves as before', async () => {
  sent.length = 0;
  let r = await anna('POST', '/api/tickets', { title: 'Ohne Mail', reporter: { userId: S.ids.karl }, notifyReporter: false });
  assert.equal(r.status, 201);
  await wait();
  assert.equal(mailsTo('karl@firma.local').length, 0);
  r = await anna('POST', '/api/tickets', { title: 'Für mich', reporter: { userId: S.ids.anna } });
  assert.equal(r.body.ticket.reporter.id, S.ids.anna);
  assert.ok(!(await history(r.body.ticket.key)).some((a) => a.action === 'createdFor'));
});

test('Email address: existing account, AD person by address, otherwise an email contact', async () => {
  let r = await anna('POST', '/api/tickets', { title: 'Per Adresse', reporter: { email: 'Lisa@Firma.local' } });
  assert.equal(r.body.ticket.reporter.id, S.ids.lisa, 'existing account by address');
  r = await anna('POST', '/api/tickets', { title: 'AD per Adresse', reporter: { email: 'e.beispiel@firma.local' } });
  const erika = S.db.prepare("SELECT * FROM users WHERE username='e.beispiel'").get();
  assert.equal(erika.source, 'ldap', 'imported from AD');
  assert.equal(r.body.ticket.reporter.id, erika.id);
  sent.length = 0;
  r = await anna('POST', '/api/tickets', { title: 'Externer', reporter: { email: 'kunde@extern.example', name: 'Kunde Extern' } });
  const contact = S.db.prepare("SELECT * FROM users WHERE email='kunde@extern.example'").get();
  assert.equal(contact.source, 'email');
  assert.equal(contact.display_name, 'Kunde Extern');
  assert.equal(r.body.ticket.reporter.id, contact.id);
  await wait();
  const m = mailsTo('kunde@extern.example');
  assert.equal(m.length, 1);
  assert.doesNotMatch(m[0].text, /direkt in Helfi\.Space melden|directly in Helfi\.Space/, 'no portal hint for email contacts');
  r = await anna('POST', '/api/tickets', { title: 'Kaputt', reporter: { email: 'keine-adresse' } });
  assert.equal(r.status, 400);
});

test('AD person by objectGUID is created on first use', async () => {
  S.db.prepare("DELETE FROM users WHERE username='e.beispiel' AND NOT EXISTS (SELECT 1 FROM tickets WHERE reporter_id=users.id)").run();
  const r = await anna('POST', '/api/tickets', { title: 'Aus dem AD', reporter: { adId: GUID.erika } });
  assert.equal(r.status, 201);
  assert.equal(r.body.ticket.reporter.displayName, 'Erika Beispiel');
  assert.equal((await anna('POST', '/api/tickets', { title: 'x', reporter: { adId: 'nicht-hex' } })).status, 400);
  S.ctx.settings.set('ldap.enabled', false);
  try {
    assert.equal((await anna('POST', '/api/tickets', { title: 'x', reporter: { adId: GUID.erika } })).status, 403, 'AD off');
  } finally { S.ctx.settings.set('ldap.enabled', true); }
});

test('Users cannot set a reporter; disabled or unknown people are refused', async () => {
  const before = S.db.prepare('SELECT COUNT(*) n FROM tickets').get().n;
  assert.equal((await karl('POST', '/api/tickets', { title: 'Fremd', reporter: { userId: S.ids.lisa } })).status, 403);
  assert.equal((await anna('POST', '/api/tickets', { title: 'Unbekannt', reporter: { userId: 99999 } })).status, 400);
  S.db.prepare('UPDATE users SET active=0 WHERE id=?').run(S.ids.lisa);
  try {
    assert.equal((await anna('POST', '/api/tickets', { title: 'Deaktiviert', reporter: { userId: S.ids.lisa } })).status, 400);
  } finally { S.db.prepare('UPDATE users SET active=1 WHERE id=?').run(S.ids.lisa); }
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM tickets').get().n, before, 'nothing created');
});

test('Change the reporter later: history, mail, old reporter keeps access as participant', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'Eigentlich für Lisa' })).body.ticket;
  assert.equal((await karl('PUT', `/api/tickets/${tk.key}/reporter`, { reporter: { userId: S.ids.lisa } })).status, 403, 'users may not');
  sent.length = 0;
  const r = await anna('PUT', `/api/tickets/${tk.key}/reporter`, { reporter: { userId: S.ids.lisa } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.reporter.id, S.ids.lisa);
  const act = await history(tk.key);
  const ch = act.find((a) => a.action === 'changed' && a.field === 'reporter');
  assert.equal(ch.oldValue, 'karl');
  assert.equal(ch.newValue, 'lisa');
  const parts = (await S.admin('GET', `/api/tickets/${tk.key}`)).body.ticket.participants;
  assert.ok(parts.some((p) => p.id === S.ids.karl), 'karl stays as participant');
  assert.equal((await karl('GET', `/api/tickets/${tk.key}`)).status, 200);
  assert.equal((await lisa('GET', `/api/tickets/${tk.key}`)).status, 200);
  await wait();
  assert.equal(mailsTo('lisa@firma.local').length, 1);
  // back to karl without mail: karl is no longer a participant twice
  sent.length = 0;
  await anna('PUT', `/api/tickets/${tk.key}/reporter`, { reporter: { userId: S.ids.karl }, notify: false });
  const after2 = (await S.admin('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.equal(after2.reporter.id, S.ids.karl);
  assert.ok(!after2.participants.some((p) => p.id === S.ids.karl));
  await wait();
  assert.equal(mailsTo('karl@firma.local').length, 0);
  // same reporter again: no change, no entry
  const n = (await history(tk.key)).length;
  await anna('PUT', `/api/tickets/${tk.key}/reporter`, { reporter: { userId: S.ids.karl } });
  assert.equal((await history(tk.key)).length, n);
});

test('Email tickets: an agent can turn the sender contact into the real account', async () => {
  const contact = S.db.prepare("SELECT * FROM users WHERE email='kunde@extern.example'").get();
  const tk = (await anna('POST', '/api/tickets', { title: 'Mail von extern', reporter: { userId: contact.id }, notifyReporter: false })).body.ticket;
  const r = await anna('PUT', `/api/tickets/${tk.key}/reporter`, { reporter: { userId: S.ids.lisa }, notify: false });
  assert.equal(r.body.ticket.reporter.id, S.ids.lisa);
  const parts = (await S.admin('GET', `/api/tickets/${tk.key}`)).body.ticket.participants;
  assert.ok(!parts.some((p) => p.id === contact.id), 'email contacts are not kept as participants');
});
