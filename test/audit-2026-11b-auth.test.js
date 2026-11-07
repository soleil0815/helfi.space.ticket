// Audit 2026-11b (auth): profile address change, login-name privacy, self-registration checks
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S;
before(async () => { S = await startServer('audit11b-auth'); });
after(async () => { await S.stop(); });

const PW = 'Sehrgeheim123';
const mail = (lines) => S.ctx.processor.parse(Buffer.from(lines.join('\r\n'))).then((m) => S.ctx.processor.process(m));

/** Capture outgoing mails; returns the list */
function captureMail() {
  const sent = [];
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  return sent;
}
const tokenFor = (sent, to) => sent.filter((m) => m.to === to).pop()?.text.match(/#([A-Za-z0-9_-]{20,})/)?.[1];
const settle = () => new Promise((r) => setTimeout(r, 30));

test('F2b: display names that are just mail addresses are shortened for users (comments, participants, reporter)', async () => {
  const bob = await S.user('bob2', 'user');
  const t = (await bob('POST', '/api/tickets', { title: 'name check' })).body.ticket;
  // Email contact without a name (display name = address) as participant, mail reply without a name
  await (await S.user('agnes2', 'agent'))('POST', `/api/tickets/${t.key}/participants`, { email: 'carl.private@extern.example' });
  const carl = S.ctx.users.byEmail('carl.private@extern.example');
  S.ctx.tickets.addComment(carl, t.key, { body: 'from carl' }, { source: 'email', authorEmail: 'carl.private@extern.example', authorName: 'carl.private@extern.example', skipPermission: true });
  S.ctx.tickets.addComment(null, t.key, { body: 'no name' }, { source: 'email', authorEmail: 'nn@extern.example', authorName: 'nn@extern.example', skipPermission: true });
  const view = (await bob('GET', `/api/tickets/${t.key}`)).body.ticket;
  const json = JSON.stringify({ c: view.comments.map((c) => c.author), p: view.participants });
  assert.ok(!json.includes('extern.example'), `no address domain for users: ${json}`);
  assert.ok(json.includes('carl.private@…'), 'shortened form shown');
  const agentView = (await (await S.user('agnes3', 'agent'))('GET', `/api/tickets/${t.key}`)).body.ticket;
  assert.ok(JSON.stringify(agentView.comments.map((c) => c.author)).includes('carl.private@extern.example'), 'agents see the address');
});

test('F1: profile address change refuses an email contact address instead of merging it', async () => {
  const r = await mail(['From: CEO <ceo@partner.example>', 'Subject: Confidential', 'Message-ID: <f1@x>', '', 'secret']);
  const contact = S.ctx.users.byEmail('ceo@partner.example');
  assert.equal(contact.source, 'email');
  const mallory = await S.user('mallory', 'user');
  const k = await mallory('PATCH', '/api/me', { email: 'CEO@partner.example', currentPassword: PW });
  assert.equal(k.status, 409);
  assert.equal(k.body.error.code, 'err.emailKnownContact');
  assert.match(k.body.error.message, /administrator/i);
  assert.ok(S.ctx.users.byId(contact.id), 'contact still exists');
  assert.equal(S.ctx.users.byName('mallory').email, 'mallory@firma.local', 'address unchanged');
  assert.equal((await mallory('GET', `/api/tickets/${r.ticketId}`)).status, 404, 'ticket stays invisible');
  // Admin linking still merges the contact
  const a = await S.admin('PATCH', `/api/users/${S.ids.mallory}`, { email: 'ceo@partner.example' });
  assert.equal(a.status, 200);
  assert.equal(S.ctx.users.byId(contact.id), undefined, 'admin change merged the contact');
  assert.equal((await mallory('GET', `/api/tickets/${r.ticketId}`)).status, 200);
});

test('F2: users see neither login names nor addresses of others in people search and comment authors', async () => {
  S.db.prepare("INSERT INTO users(username,display_name,email,role,source,password_hash,active,self_registered) VALUES('anna.privat@mail.example','Anna Privat','anna.privat@mail.example','user','local','x',1,1)").run();
  const annaId = S.db.prepare("SELECT id FROM users WHERE username='anna.privat@mail.example'").get().id;
  const bob = await S.user('bob', 'user');
  const p = await bob('GET', '/api/people?q=Anna');
  const anna = p.body.people.find((x) => x.id === annaId);
  assert.ok(anna, 'still found by name');
  assert.equal(anna.displayName, 'Anna Privat');
  assert.equal(anna.username, undefined);
  assert.equal(anna.email, undefined);
  // The private address (= login name) is no search key for users
  assert.ok(!(await bob('GET', '/api/people?q=anna.privat@mail')).body.people.some((x) => x.id === annaId));
  // Agents still see the login name
  const agent = await S.user('agnes', 'agent');
  assert.equal((await agent('GET', '/api/people?q=Anna')).body.people.find((x) => x.id === annaId).username, 'anna.privat@mail.example');

  const t = await bob('POST', '/api/tickets', { title: 'x' });
  const key = t.body.ticket.key;
  await bob('POST', `/api/tickets/${key}/participants`, { userId: annaId });
  S.ctx.tickets.addComment(S.ctx.users.byId(annaId), key, { body: 'hi' });
  S.ctx.tickets.addComment(null, key, { body: 'via mail' }, { source: 'email', authorEmail: 'unknown@mail.example', authorName: null, skipPermission: true });
  await bob('POST', `/api/tickets/${key}/comments`, { body: 'mine' });
  const carl = await S.user('carl', 'user');
  await bob('POST', `/api/tickets/${key}/participants`, { userId: S.ids.carl });
  const authors = (await carl('GET', `/api/tickets/${key}`)).body.ticket.comments.map((c) => c.author);
  const a = authors.find((x) => x.id === annaId);
  assert.equal(a.displayName, 'Anna Privat');
  assert.equal(a.username, undefined);
  const anon = authors.find((x) => x.id === null);
  assert.equal(anon.email, undefined);
  assert.ok(!JSON.stringify(authors).includes('@'), 'no address or mail login name anywhere');
  // The author sees their own login name; agents see everything
  assert.equal((await bob('GET', `/api/tickets/${key}`)).body.ticket.comments.find((c) => c.author.id === S.ids.bob).author.username, 'bob');
  const agentView = (await agent('GET', `/api/tickets/${key}`)).body.ticket.comments.map((c) => c.author);
  assert.equal(agentView.find((x) => x.id === annaId).username, 'anna.privat@mail.example');
  assert.equal(agentView.find((x) => x.id === null).email, 'unknown@mail.example');
});

test('F4: an admin-disabled email contact cannot reactivate itself via self-registration', async () => {
  const sent = captureMail();
  S.ctx.settings.set('register.enabled', true);
  S.ctx.settings.set('register.domains', '');
  await mail(['From: Spam <spam@bad.example>', 'Subject: s1', 'Message-ID: <f4@x>', '', 'x']);
  const c = S.ctx.users.byEmail('spam@bad.example');
  assert.equal((await S.admin('PATCH', `/api/users/${c.id}`, { active: false })).status, 200);
  const anon = S.client();
  const r = await anon('POST', '/api/auth/register', { displayName: 'Spam', email: 'spam@bad.example', password: PW });
  assert.equal(r.status, 200, 'neutral answer');
  assert.deepEqual(r.body, { ok: true });
  await settle();
  assert.equal(tokenFor(sent, 'spam@bad.example'), undefined, 'no confirmation link sent');
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM account_tokens WHERE kind='register' AND email='spam@bad.example'").get().n, 0);
  // A link issued before the contact was disabled no longer works either
  await mail(['From: Other <other@bad.example>', 'Subject: s2', 'Message-ID: <f4b@x>', '', 'x']);
  await anon('POST', '/api/auth/register', { displayName: 'Other', email: 'other@bad.example', password: PW });
  await settle();
  const tok = tokenFor(sent, 'other@bad.example');
  assert.ok(tok);
  const o = S.ctx.users.byEmail('other@bad.example');
  await S.admin('PATCH', `/api/users/${o.id}`, { active: false });
  assert.equal((await anon('POST', '/api/auth/register/confirm', { token: tok })).status, 400);
  const row = S.db.prepare('SELECT active, source FROM users WHERE id=?').get(o.id);
  assert.deepEqual({ ...row }, { active: 0, source: 'email' });
  assert.equal(S.db.prepare('SELECT active FROM users WHERE id=?').get(c.id).active, 0);
});

test('F5: confirmation links stop working when registration is switched off or the domain is removed', async () => {
  const sent = captureMail();
  S.ctx.settings.set('register.enabled', true);
  S.ctx.settings.set('register.domains', 'partner.example');
  const anon = S.client();
  for (const who of ['eve', 'fay']) {
    assert.equal((await anon('POST', '/api/auth/register', { displayName: who, email: `${who}@partner.example`, password: PW })).status, 200);
  }
  await settle();
  const eve = tokenFor(sent, 'eve@partner.example');
  const fay = tokenFor(sent, 'fay@partner.example');
  S.ctx.settings.set('register.enabled', false);
  assert.equal((await anon('POST', '/api/auth/register/confirm', { token: eve })).status, 400, 'registration off');
  S.ctx.settings.set('register.enabled', true);
  S.ctx.settings.set('register.domains', 'firma.local');
  assert.equal((await anon('POST', '/api/auth/register/confirm', { token: fay })).status, 400, 'domain removed');
  assert.equal(S.ctx.users.byName('eve@partner.example'), undefined);
  assert.equal(S.ctx.users.byName('fay@partner.example'), undefined);
  assert.equal((await S.client()('POST', '/api/auth/login', { username: 'eve@partner.example', password: PW })).status, 401);
});
