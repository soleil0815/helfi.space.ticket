// Audit 2026-11 (second round), area data: search index, contact merge, components, list filters, markdown
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { mdToHtml, mdToText } from '../src/markdown.js';

let S; let anna; let karl; let lisa;
before(async () => {
  S = await startServer('audit-b-data');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  lisa = await S.user('lisa', 'user');
});
after(() => S.stop());

test('D2 search finds a ticket by the new name of a renamed commenter', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'Nix', description: 'y' })).body.ticket;
  await anna('POST', `/api/tickets/${tk.key}/participants`, { userId: S.ids.lisa });
  await lisa('POST', `/api/tickets/${tk.key}/comments`, { body: 'Kommentar' });
  await anna('GET', '/api/tickets?q=lisa'); // index caught up
  const r = await S.admin('PATCH', `/api/users/${S.ids.lisa}`, { displayName: 'Zwetschgenbaum' });
  assert.equal(r.status, 200);
  const agentHits = (await anna('GET', '/api/tickets?q=Zwetschgenbaum')).body.tickets.map((x) => x.key);
  assert.ok(agentHits.includes(tk.key), 'agent search (people) has the new name');
  const userHits = (await karl('GET', '/api/tickets?q=Zwetschgenbaum')).body.tickets.map((x) => x.key);
  assert.ok(userHits.includes(tk.key), 'user search (people_public) has the new name');
});

test('D3 merging an email contact keeps its mentions, votes and feedback', async () => {
  const contact = S.ctx.users.contactForEmail('neu@firma.local', 'Neu');
  const tk = S.ctx.tickets.create(null, { title: 'Mail' }, { source: 'email', reporterId: contact.id, reporterEmail: 'neu@firma.local' });
  S.ctx.tickets.addComment(S.ctx.users.byId(S.ids.anna), tk.id, { body: `Hallo @[Neu](user:${contact.id})` });
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM comment_mentions WHERE ticket_id=?').get(tk.id).n, 1);
  const art = S.db.prepare("INSERT INTO kb_articles(title, body, visibility) VALUES('A', 'x', 'public')").run().lastInsertRowid;
  S.db.prepare('INSERT INTO kb_votes(article_id, user_id, vote) VALUES(?,?,1)').run(art, contact.id);
  S.db.prepare("INSERT INTO kb_feedback(article_id, user_id, body) VALUES(?,?,'fehlt')").run(art, contact.id);
  const u = await S.admin('POST', '/api/users', { username: 'neu', displayName: 'Neu Konto', email: 'neu@firma.local', role: 'user', password: 'Sehrgeheim123' });
  assert.equal(u.status, 201);
  const id = u.body.user.id;
  assert.equal(S.db.prepare('SELECT reporter_id FROM tickets WHERE id=?').get(tk.id).reporter_id, id);
  assert.deepEqual(S.db.prepare('SELECT user_id FROM comment_mentions WHERE ticket_id=?').all(tk.id).map((x) => x.user_id), [id], 'mention moved to the account');
  assert.equal(S.db.prepare('SELECT user_id FROM kb_votes WHERE article_id=?').get(art)?.user_id, id, 'vote moved');
  assert.equal(S.db.prepare('SELECT user_id FROM kb_feedback WHERE article_id=?').get(art)?.user_id, id, 'feedback author moved');
});

test('D4 after a merge the account is not reporter and participant of the same ticket', () => {
  const contact = S.ctx.users.contactForEmail('dup@firma.local', 'Dup');
  const tk = S.ctx.tickets.create(null, { title: 'Dup' }, { source: 'email', reporterId: contact.id, reporterEmail: 'dup@firma.local' });
  const u = S.ctx.users.createLocal({ username: 'dupacc', displayName: 'Dup Acc', email: '', role: 'user', password: 'Sehrgeheim123' });
  S.ctx.tickets.addParticipant(null, tk.id, { userId: u.id }, { system: true, notify: false });
  S.ctx.users.setEmail(u.id, 'dup@firma.local');
  assert.equal(S.db.prepare('SELECT reporter_id FROM tickets WHERE id=?').get(tk.id).reporter_id, u.id);
  assert.deepEqual(S.db.prepare('SELECT user_id FROM ticket_participants WHERE ticket_id=?').all(tk.id), [], 'no participant row for the reporter');
});

test('D5 deleting a component writes a history entry on its tickets', async () => {
  const p = S.ctx.tickets.projects.get('IT');
  const c = (await S.admin('POST', `/api/projects/${p.id}/components`, { name: 'VPN', keywords: 'vpn' })).body.component;
  const tk = (await karl('POST', '/api/tickets', { title: 'VPN geht nicht' })).body.ticket;
  assert.equal((await anna('GET', `/api/tickets/${tk.key}`)).body.ticket.component?.name, 'VPN');
  assert.equal((await S.admin('DELETE', `/api/components/${c.id}`)).status, 200);
  const t = (await anna('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.equal(t.component, null);
  const h = t.activity.filter((a) => a.field === 'component' && a.action === 'changed');
  assert.equal(h.length, 1, 'one history entry');
  assert.equal(h[0].oldValue, 'VPN');
  assert.equal(h[0].newValue, null);
  const adminId = S.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  assert.equal(S.db.prepare("SELECT user_id FROM activity WHERE ticket_id=? AND field='component' AND action='changed'").get(tk.id).user_id, adminId);
});

test('D6 users cannot filter their list by component', async () => {
  const p = S.ctx.tickets.projects.get('IT');
  const c = (await S.admin('POST', `/api/projects/${p.id}/components`, { name: 'Geheim', keywords: 'drucker' })).body.component;
  const tk1 = (await karl('POST', '/api/tickets', { title: 'drucker kaputt' })).body.ticket;
  const tk2 = (await karl('POST', '/api/tickets', { title: 'maus kaputt' })).body.ticket;
  const mine = (await karl('GET', `/api/tickets?component=${c.id}`)).body.tickets.map((x) => x.key);
  assert.ok(mine.includes(tk1.key) && mine.includes(tk2.key), 'filter ignored: both tickets listed');
  const none = (await karl('GET', '/api/tickets?component=none')).body.tickets.map((x) => x.key);
  assert.ok(none.includes(tk1.key), 'filter "none" ignored too');
  const agent = (await anna('GET', `/api/tickets?component=${c.id}`)).body.tickets.map((x) => x.key);
  assert.ok(agent.includes(tk1.key) && !agent.includes(tk2.key), 'agents keep the filter');
});

test('D7 own tickets in an archived project stay in the user list; agents keep hiding them', async () => {
  const p = (await S.admin('POST', '/api/projects', { key: 'ARC', name: 'Arc' })).body.project;
  const tk = (await karl('POST', '/api/tickets', { title: 'In Arc', projectId: p.id })).body.ticket;
  await anna('POST', `/api/tickets/${tk.key}/participants`, { userId: S.ids.lisa });
  await S.admin('PATCH', `/api/projects/${p.id}`, { archived: true });
  assert.ok((await karl('GET', '/api/tickets?reporter=me')).body.tickets.some((x) => x.key === tk.key), 'reporter sees it');
  assert.ok((await karl('GET', '/api/tickets')).body.tickets.some((x) => x.key === tk.key), 'reporter sees it without filter');
  assert.ok((await lisa('GET', '/api/tickets?participant=me')).body.tickets.some((x) => x.key === tk.key), 'participant sees it');
  assert.ok(!(await anna('GET', '/api/tickets')).body.tickets.some((x) => x.key === tk.key), 'agent list unchanged');
  assert.ok((await anna('GET', '/api/tickets?project=ARC')).body.tickets.some((x) => x.key === tk.key), 'agent with explicit project');
});

test('D8 markdown: inline code inside link text and literal placeholders', () => {
  const html = mdToHtml('[`a<b`](https://example.com)');
  assert.ok(!/[\u0001\u0002]/.test(html), 'no raw placeholder');
  assert.match(html, /<a href="https:\/\/example.com">.*<code[^>]*>a&lt;b<\/code>.*<\/a>/);
  const text = mdToText('[`code`](https://example.com)');
  assert.ok(!/[\u0001\u0002]/.test(text));
  assert.match(text, /code \(https:\/\/example.com\)/);
  const lit = mdToHtml('`<geheim>` dann \u00010\u0002');
  assert.equal((lit.match(/&lt;geheim&gt;/g) || []).length, 1, 'literal marker does not repeat an earlier part');
  assert.ok(!/[\u0001\u0002]/.test(lit));
  const litText = mdToText('`x` \u00010\u0002');
  assert.equal((litText.match(/x/g) || []).length, 1);
});
