// Tests: changing name and email address (profile and administration)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-email-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { normalizeEmail } = await import('../src/users.js');

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
const karl = client();
const PW = 'Sehrgeheim123';
const sent = [];
const linkTo = (addr) => { const m = [...sent].reverse().find((x) => x.to === addr && /email\/confirm#/.test(x.text)); return m && /email\/confirm#([A-Za-z0-9_-]+)/.exec(m.text)[1]; };
const wait = () => new Promise((r) => setTimeout(r, 30));

test('Setup', async () => {
  ctx.mailer.enabled = () => true;
  ctx.mailer.send = async (m) => { sent.push(m); return true; };
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: PW, projectKey: 'IT', projectName: 'IT' })).status, 200);
  assert.equal((await admin('POST', '/api/users', { username: 'karl', displayName: 'Karl', email: 'Karl@Firma.local', role: 'user', password: PW })).status, 201);
  assert.equal((await karl('POST', '/api/auth/login', { username: 'karl', password: PW })).status, 200);
  assert.equal(ctx.users.byName('karl').email, 'karl@firma.local', 'addresses are stored in lowercase');
});

test('Local admin changes name and address in the profile – address only with current password', async () => {
  let r = await admin('PATCH', '/api/me', { displayName: 'Anna Admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.displayName, 'Anna Admin');

  r = await admin('PATCH', '/api/me', { email: 'admin@firma.local' });
  assert.equal(r.status, 400, 'without password');
  r = await admin('PATCH', '/api/me', { email: 'admin@firma.local', currentPassword: 'falsch' });
  assert.equal(r.status, 400);
  assert.equal(ctx.users.byName('admin').email, null, 'nothing saved');
  r = await admin('PATCH', '/api/me', { email: 'Admin@Firma.local', currentPassword: PW });
  assert.equal(r.status, 200);
  // Not taken over yet: only after the link sent to the new address was opened (Audit 2026-11)
  assert.equal(r.body.emailPending, 'admin@firma.local');
  assert.equal(ctx.users.byName('admin').email, null, 'still the old (no) address');
  assert.equal((await admin('GET', '/api/me')).body.emailPending, 'admin@firma.local');
  await wait();
  const token = linkTo('admin@firma.local');
  assert.ok(token, 'confirmation link sent to the new address');
  assert.equal((await client()('POST', '/api/auth/email/confirm', { token: 'falsch' })).status, 400);
  r = await client()('POST', '/api/auth/email/confirm', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(ctx.users.byName('admin').email, 'admin@firma.local');
  assert.equal((await client()('POST', '/api/auth/email/confirm', { token })).status, 400, 'link works once');
  assert.equal((await admin('GET', '/api/me')).body.emailPending, undefined);

  // Same address (only different case) needs no password
  assert.equal((await admin('PATCH', '/api/me', { email: 'ADMIN@firma.local', displayName: 'Anna A.' })).status, 200);
  // Clearing works (with password) and needs no link
  assert.equal((await admin('PATCH', '/api/me', { email: '', currentPassword: PW })).body.user.email, '');
  assert.equal((await admin('PATCH', '/api/me', { email: 'admin@firma.local', currentPassword: PW })).status, 200);
  await wait();
  assert.equal((await client()('POST', '/api/auth/email/confirm', { token: linkTo('admin@firma.local') })).status, 200);
  assert.equal(ctx.users.byName('admin').email, 'admin@firma.local');
});

test('A new address is never taken over without the link: mails from it stay with their sender (Audit 2026-11)', async () => {
  const before = sent.length;
  const r = await karl('PATCH', '/api/me', { email: 'chefin@firma.local', currentPassword: PW });
  assert.equal(r.status, 200);
  assert.equal(ctx.users.byName('karl').email, 'karl@firma.local');
  const p = ctx.processor;
  const m = await p.process(await p.parse(Buffer.from(['From: chefin@firma.local', 'Subject: Gehaltsliste', 'Message-ID: <c1@x>', '', 'vertraulich'].join('\r\n'))));
  assert.notEqual(db.prepare('SELECT reporter_id FROM tickets WHERE id=?').get(m.ticketId).reporter_id, ctx.users.byName('karl').id, 'not Karl\'s ticket');
  await wait();
  // the old address is told about it
  assert.ok(sent.slice(before).some((x) => x.to === 'karl@firma.local' && /chefin@firma\.local/.test(x.text)));
  // a newer request replaces the older link
  await karl('PATCH', '/api/me', { email: 'karl.neu@firma.local', currentPassword: PW });
  await wait();
  const old = linkTo('chefin@firma.local');
  assert.equal((await client()('POST', '/api/auth/email/confirm', { token: old })).status, 400);
  assert.equal(ctx.users.byName('karl').email, 'karl@firma.local');
  // without mail sending no self-service change (an admin changes it)
  ctx.mailer.enabled = () => false;
  const off = await karl('PATCH', '/api/me', { email: 'karl.x@firma.local', currentPassword: PW });
  assert.equal(off.status, 400);
  assert.equal(off.body.error.code, 'err.emailChangeNoMail');
  ctx.mailer.enabled = () => true;
});

test('Invalid or foreign addresses are rejected', async () => {
  assert.equal((await admin('PATCH', '/api/me', { email: 'kein-mail', currentPassword: PW })).status, 400);
  assert.equal((await admin('PATCH', '/api/me', { email: 'a@b', currentPassword: PW })).status, 400);
  assert.equal((await admin('PATCH', '/api/me', { email: 'x"@firma.local', currentPassword: PW })).status, 400);
  const r = await admin('PATCH', '/api/me', { email: 'KARL@firma.local', currentPassword: PW });
  assert.equal(r.status, 409, 'belongs to Karl');
  assert.equal(ctx.users.byName('admin').email, 'admin@firma.local');
  assert.equal((await admin('POST', '/api/users', { username: 'karl2', email: 'karl@firma.local', password: PW })).status, 409, 'also when creating');
});

test('Address of an email contact: taken over with the link from the profile (or by an admin), including tickets', async () => {
  const p = ctx.processor;
  const r = p.process(await p.parse(Buffer.from(['From: Karl Privat <karl.privat@example.org>', 'Subject: Laptop', 'Message-ID: <k1@x>', '', 'Hilfe'].join('\r\n'))));
  const contact = ctx.users.byEmail('karl.privat@example.org');
  assert.equal(contact.source, 'email');

  // Self-service: knowing one's own password does not prove the address → nothing merged yet …
  const k = await karl('PATCH', '/api/me', { email: 'karl.privat@example.org', currentPassword: PW });
  assert.equal(k.status, 200);
  assert.equal(ctx.users.byId(contact.id).source, 'email', 'contact untouched');
  const karlId = ctx.users.byName('karl').id;
  assert.notEqual(db.prepare('SELECT reporter_id FROM tickets WHERE id=?').get(r.ticketId).reporter_id, karlId);
  // … only the link to that address proves it: then the contact (with its tickets) is taken over
  await wait();
  assert.equal((await client()('POST', '/api/auth/email/confirm', { token: linkTo('karl.privat@example.org') })).status, 200);
  assert.equal(ctx.users.byId(contact.id), undefined, 'contact deleted');
  assert.equal(db.prepare('SELECT reporter_id FROM tickets WHERE id=?').get(r.ticketId).reporter_id, karlId);
  assert.ok((await karl('GET', '/api/tickets')).body.tickets.some((x) => x.id === r.ticketId), 'Karl sees his ticket');
  // New mails from the address end up with Karl
  const r2 = p.process(await p.parse(Buffer.from(['From: KARL.PRIVAT@example.org', 'Subject: Noch was', 'Message-ID: <k2@x>', '', 'x'].join('\r\n'))));
  assert.equal(db.prepare('SELECT reporter_id FROM tickets WHERE id=?').get(r2.ticketId).reporter_id, karlId, 'case does not matter');
});

test('Administration: name, address and password of local accounts; not AD/SSO accounts and contacts', async () => {
  const karlId = ctx.users.byName('karl').id;
  let r = await admin('PATCH', `/api/users/${karlId}`, { displayName: 'Karl Kunde', email: 'k.kunde@firma.local' });
  assert.equal(r.status, 200);
  assert.equal(ctx.users.byId(karlId).email, 'k.kunde@firma.local');
  assert.equal(ctx.users.byId(karlId).display_name, 'Karl Kunde');
  assert.equal((await admin('PATCH', `/api/users/${karlId}`, { email: 'admin@firma.local' })).status, 409);
  assert.equal((await admin('PATCH', `/api/users/${karlId}`, { email: 'kaputt' })).status, 400);
  assert.equal(ctx.users.byId(karlId).email, 'k.kunde@firma.local', 'nothing changed on error');

  const ad = ctx.users.upsertExternal({ source: 'ldap', username: 'm.muster', displayName: 'Max', email: 'Max.Muster@firma.local', externalId: 'g1', role: 'user' });
  assert.equal((await admin('PATCH', `/api/users/${ad.id}`, { email: 'x@firma.local' })).status, 400);
  assert.equal((await admin('PATCH', `/api/users/${ad.id}`, { displayName: 'X' })).status, 400);
  assert.equal((await admin('PATCH', `/api/users/${ad.id}`, { role: 'admin' })).status, 200, 'role still changeable');
  assert.equal((await admin('PATCH', `/api/users/${ad.id}`, { role: 'user' })).status, 200);
  assert.equal(ctx.users.byEmail('max.muster@firma.local')?.id, ad.id, 'AD address found with different case');
});

test('User with AD account cannot change name/address in the profile', async () => {
  const ad = ctx.users.byName('m.muster');
  const { sessionKey } = await import('../src/auth/session.js');
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,ip,auth_method,mfa) VALUES(?,?,?,?,NULL,'ldap',1)").run(sessionKey('s-ad'), ad.id, Date.now() + 3600e3, Date.now());
  const r = await fetch(`${base}/api/me`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie: 'helfi_sid=s-ad' }, body: JSON.stringify({ email: 'neu@firma.local' }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'err.managedExternally');
  assert.equal(ctx.users.byId(ad.id).email, 'Max.Muster@firma.local', 'unchanged');
});

test('normalizeEmail', () => {
  assert.equal(normalizeEmail('  A@B.de '), 'a@b.de');
  assert.equal(normalizeEmail(''), '');
  assert.throws(() => normalizeEmail('a@b'), /invalidEmail/);
  assert.throws(() => normalizeEmail(`${'x'.repeat(250)}@b.de`), /invalidEmail/);
});
