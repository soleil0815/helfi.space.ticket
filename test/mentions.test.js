// Tests: @-mentions in comments (permissions, filter, unseen marker, mails)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mention-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { wireNotifications } = await import('../src/mail/smtp.js');
const { normalizeMentions, mentionsAsText } = await import('../src/mentions.js');

let server; let base; let db; let ctx;
const sent = [];
const mentioned = [];
before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  wireNotifications({ tickets: ctx.tickets, mailer: { enabled: () => true, send: async (m) => { sent.push(m); } }, settings: ctx.settings, users: ctx.users });
  ctx.tickets.events.on('mentioned', (p) => mentioned.push(p));
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => setTimeout(r, 100)); server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

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
const anna = client();
const bert = client();
const karl = client();
const ids = {};
let key;
const tick = () => new Promise((r) => setTimeout(r, 40));
const tok = (name, id) => `@[${name}](user:${id})`;
const rows = (sql, ...a) => db.prepare(sql).all(...a);

test('Setup', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  for (const [u, role, name] of [['anna', 'agent', 'Anna Agentin'], ['bert', 'agent', 'Bert Berater'], ['karl', 'user', 'Karl Kunde'], ['otto', 'user', 'Otto Fremd']]) {
    ids[u] = (await admin('POST', '/api/users', { username: u, displayName: name, email: `${u}@firma.local`, role, password: 'Sehrgeheim123' })).body.user.id;
  }
  for (const [c, u] of [[anna, 'anna'], [bert, 'bert'], [karl, 'karl']]) assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'Sehrgeheim123' })).status, 200);
  key = (await karl('POST', '/api/tickets', { title: 'Drucker streikt' })).body.ticket.key;
});

test('Unit: tokens become plain names, unknown people stay plain text', () => {
  assert.equal(mentionsAsText(`Hallo ${tok('Bert', 7)}, bitte prüfen`), 'Hallo @Bert, bitte prüfen');
  const users = { 7: { id: 7, display_name: 'Bert Berater' }, 8: { id: 8, display_name: 'Otto' } };
  const r = normalizeMentions(`${tok('Falscher Name', 7)} ${tok('Otto', 8)} ${tok('X', 99)} ${tok('Bert', 7)}`, { getUser: (id) => users[id] || null, allowed: (u) => u.id === 7 });
  assert.equal(r.text, `${tok('Bert Berater', 7)} @Otto @X ${tok('Bert Berater', 7)}`, 'current name; not allowed → text');
  assert.deepEqual(r.ids, [7], 'no duplicates');
  // Linear on hostile input (no ReDoS)
  const evil = `@[${'a'.repeat(50000)}`.repeat(4) + '](user:';
  const t0 = Date.now();
  mentionsAsText(evil);
  normalizeMentions(evil, { getUser: () => null, allowed: () => false });
  assert.ok(Date.now() - t0 < 500);
});

test('Candidates: agents only; internal note → only agents; reply → plus the ticket\'s people, nobody else', async () => {
  const pub = (await anna('GET', `/api/tickets/${key}/mention-candidates?q=`)).body.people;
  const names = pub.map((p) => p.displayName);
  assert.ok(names.includes('Karl Kunde') && names.includes('Bert Berater'), names.join());
  assert.ok(!names.includes('Otto Fremd'), 'no one who cannot see the ticket');
  assert.equal(pub[0].displayName, 'Karl Kunde', 'reporter first');
  const internal = (await anna('GET', `/api/tickets/${key}/mention-candidates?q=&internal=1`)).body.people.map((p) => p.displayName);
  assert.ok(!internal.includes('Karl Kunde') && internal.includes('Bert Berater'));
  const q = (await anna('GET', `/api/tickets/${key}/mention-candidates?q=ber`)).body.people.map((p) => p.displayName);
  assert.deepEqual(q, ['Bert Berater']);
  // LIKE wildcards are plain text
  assert.equal((await anna('GET', `/api/tickets/${key}/mention-candidates?q=%25`)).body.people.length, 0);
  assert.equal((await karl('GET', `/api/tickets/${key}/mention-candidates?q=`)).status, 403);
});

test('Reply: allowed people are mentioned, a forged mention of a stranger stays text', async () => {
  sent.length = 0;
  const body = `${tok('Bert', ids.bert)} und ${tok('Karl Kunde', ids.karl)}, schaut mal. ${tok('Otto Fremd', ids.otto)} ${tok('Anna', ids.anna)}`;
  const c = (await anna('POST', `/api/tickets/${key}/comments`, { body })).body.comment;
  assert.equal(c.body, `${tok('Bert Berater', ids.bert)} und ${tok('Karl Kunde', ids.karl)}, schaut mal. @Otto Fremd ${tok('Anna Agentin', ids.anna)}`);
  const m = rows('SELECT user_id, seen_at FROM comment_mentions WHERE comment_id=? ORDER BY user_id', c.id);
  assert.deepEqual(m.map((x) => x.user_id).sort(), [ids.anna, ids.bert, ids.karl].sort());
  assert.ok(m.find((x) => x.user_id === ids.anna).seen_at, 'own mention counts as seen');
  await tick();
  assert.deepEqual(mentioned.at(-1).userIds.sort(), [ids.bert, ids.karl].sort(), 'no event for oneself');
  // Mails: Bert gets a mention mail (agent mail); Karl only his normal reply mail; Anna nothing
  const toBert = sent.filter((x) => x.to === 'bert@firma.local');
  assert.equal(toBert.length, 1);
  assert.match(toBert[0].subject, /Anna Agentin/);
  assert.match(toBert[0].text, /@Bert Berater und @Karl Kunde/);
  assert.doesNotMatch(toBert[0].text, /user:/);
  assert.equal(toBert[0].customer, false);
  const toKarl = sent.filter((x) => x.to === 'karl@firma.local');
  assert.equal(toKarl.length, 1, 'no second mail to the reporter');
  assert.doesNotMatch(toKarl[0].text, /user:\d/, 'reply mail shows plain names');
  assert.ok(!sent.some((x) => x.to === 'anna@firma.local' || x.to === 'otto@firma.local'));
});

test('Internal note: customers cannot be mentioned; agents get a mail saying it is a note', async () => {
  sent.length = 0;
  const c = (await anna('POST', `/api/tickets/${key}/comments`, { body: `${tok('Karl', ids.karl)} intern an ${tok('Bert', ids.bert)}`, internal: true })).body.comment;
  assert.equal(c.body, `@Karl intern an ${tok('Bert Berater', ids.bert)}`);
  assert.deepEqual(rows('SELECT user_id FROM comment_mentions WHERE comment_id=?', c.id).map((x) => x.user_id), [ids.bert]);
  await tick();
  assert.deepEqual(sent.map((x) => x.to), ['bert@firma.local']);
  assert.match(sent[0].text, /internen Notiz/);
});

test('Only agents mention: customer text and mail comments stay plain', async () => {
  const c = (await karl('POST', `/api/tickets/${key}/comments`, { body: `Danke ${tok('Anna', ids.anna)}` })).body.comment;
  assert.equal(c.body, 'Danke @Anna');
  const viaMail = ctx.tickets.addComment(null, key, { body: `Re: ${tok('Bert', ids.bert)}` }, { source: 'email', authorEmail: 'karl@firma.local', skipPermission: true });
  assert.equal(viaMail.body, 'Re: @Bert');
  const asAgentMail = ctx.tickets.addComment(ctx.users.byId(ids.anna), key, { body: `${tok('Bert', ids.bert)}` }, { source: 'email' });
  assert.equal(asAgentMail.body, '@Bert', 'mail senders can be forged');
});

test('"Mentions me": filter, unseen marker and count until the ticket is opened', async () => {
  const list = (await bert('GET', '/api/tickets?mentioned=me')).body.tickets;
  assert.deepEqual(list.map((x) => x.key), [key]);
  assert.equal(list[0].mentionUnseen, true);
  assert.equal((await bert('GET', '/api/queues')).body.counts.mentions, 1);
  assert.equal((await anna('GET', '/api/tickets?mentioned=me')).body.tickets.length, 1, 'own mention still lists the ticket');
  assert.equal((await anna('GET', '/api/queues')).body.counts.mentions, 0);
  const tk = (await bert('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.comments.filter((c) => c.mentionsMe).length, 2);
  assert.equal((await bert('GET', '/api/queues')).body.counts.mentions, 0);
  assert.equal((await bert('GET', '/api/tickets?mentioned=me')).body.tickets[0].mentionUnseen, undefined);
  // The customer sees the reply with the mention, never the internal note
  const kt = (await karl('GET', `/api/tickets/${key}`)).body.ticket;
  assert.ok(kt.comments.some((c) => c.body.includes(tok('Karl Kunde', ids.karl)) && c.mentionsMe));
  assert.ok(!kt.comments.some((c) => c.internal));
});

test('Mails can be switched off; inactive people are not mentioned', async () => {
  ctx.settings.set('notify.mention', false);
  sent.length = 0;
  await anna('POST', `/api/tickets/${key}/comments`, { body: `${tok('Bert', ids.bert)} kurz`, internal: true });
  await tick();
  assert.equal(sent.length, 0);
  ctx.settings.set('notify.mention', true);
  await admin('PATCH', `/api/users/${ids.bert}`, { active: false });
  const c = (await anna('POST', `/api/tickets/${key}/comments`, { body: `${tok('Bert', ids.bert)} weg?`, internal: true })).body.comment;
  assert.equal(c.body, '@Bert weg?');
});
