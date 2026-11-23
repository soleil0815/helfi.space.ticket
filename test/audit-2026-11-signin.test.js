// Audit 2026-11 (sign-in): an account with a second factor never gets another one with the password
// alone (not even in the company network), removing a passkey ends the other sessions, the step-up with
// the code, AD attempts are counted before asking AD, SSO via the AD identifier without service account
// takes role and projects from the token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { softPasskey } from './helpers/webauthn.js';
import { totpAt, currentStep } from '../src/auth/totp.js';

let S;
/** Client with a cookie jar (passkey challenge cookie and session cookie side by side) */
function jar() {
  const cookies = new Map();
  const call = async (method, url, body) => {
    const r = await fetch(S.base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim();
      if (!v || attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a))) cookies.delete(k); else cookies.set(k, v);
    }
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  call.login = async (username, password = 'Sehrgeheim123') => {
    const r = await call('POST', '/api/auth/login', { username, password });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return call;
  };
  return call;
}
const code = (secret, offset = 0) => totpAt(secret, currentStep() + offset);
async function enableTotp(c) {
  const s = await c('POST', '/api/me/mfa/setup');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const e = await c('POST', '/api/me/mfa/enable', { code: code(s.body.secret) });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  return s.body.secret;
}
async function addPasskey(c, pk) {
  const o = await c('POST', '/api/me/passkeys/options');
  if (o.status !== 200) return o;
  return c('POST', '/api/me/passkeys', { response: pk.register(o.body), name: 'Laptop' });
}

before(async () => {
  S = await startServer('audit-signin');
  for (const u of ['tina', 'paul', 'rita']) await S.user(u, 'user');
});
after(() => S?.stop());

test('TOTP account: a password-only session in the company network cannot add a passkey – only after the code', async () => {
  const setup = await jar().login('tina');
  const secret = await enableTotp(setup);
  // the internal network does not ask for the code at sign-in: password-only session
  const pwOnly = await jar().login('tina');
  let st = (await pwOnly('GET', '/api/me/passkeys')).body;
  assert.equal(st.canAdd, false);
  assert.equal(st.confirmWith, 'code');
  const r = await addPasskey(pwOnly, softPasskey());
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'err.passkeyAddSecondFactor');
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM user_passkeys WHERE user_id=?').get(S.ids.tina).n, 0);
  // step-up with a wrong code fails, with the current code the session may add one
  assert.equal((await pwOnly('POST', '/api/me/mfa/confirm', { code: '000000' })).status, 400);
  assert.equal((await pwOnly('POST', '/api/me/mfa/confirm', { code: code(secret, 1) })).status, 200);
  st = (await pwOnly('GET', '/api/me/passkeys')).body;
  assert.equal(st.canAdd, true);
  assert.equal((await addPasskey(pwOnly, softPasskey())).status, 200);
});

test('Passkey account: a password-only session cannot add another passkey nor set up TOTP; a passkey sign-in can', async () => {
  const first = await jar().login('paul');
  const pk = softPasskey();
  assert.equal((await addPasskey(first, pk)).status, 200, 'first factor of an account without any: allowed internally');
  const pwOnly = await jar().login('paul');
  const st = (await pwOnly('GET', '/api/me/passkeys')).body;
  assert.equal(st.confirmWith, 'passkey');
  assert.equal((await addPasskey(pwOnly, softPasskey())).status, 403);
  const mfa = (await pwOnly('GET', '/api/me/mfa')).body;
  assert.equal(mfa.canSetup, false);
  assert.equal(mfa.setupNeedsPasskey, true);
  const s = await pwOnly('POST', '/api/me/mfa/setup');
  assert.equal(s.status, 403);
  assert.equal(s.body.error.code, 'err.mfaSetupSecondFactor');
  // signed in with the passkey: both work
  const c = jar();
  const o = await c('POST', '/api/auth/passkey/options');
  assert.equal((await c('POST', '/api/auth/passkey/login', { response: pk.signIn(o.body) })).status, 200);
  assert.equal((await addPasskey(c, softPasskey())).status, 200);
  assert.equal((await c('POST', '/api/me/mfa/setup')).status, 200);
});

test('Removing a passkey signs out all other sessions of the account', async () => {
  const owner = await jar().login('rita');
  const pk = softPasskey();
  const added = (await addPasskey(owner, pk)).body.passkey;
  // someone else signed in with that passkey (lost/stolen device)
  const thief = jar();
  const o = await thief('POST', '/api/auth/passkey/options');
  assert.equal((await thief('POST', '/api/auth/passkey/login', { response: pk.signIn(o.body) })).status, 200);
  assert.equal((await thief('GET', '/api/me')).status, 200);
  // the owner confirms with the code step or a passkey; here: signs in with a second passkey of theirs
  S.db.prepare('UPDATE sessions SET mfa=1 WHERE user_id=? AND auth_method<>?').run(S.ids.rita, 'passkey');
  assert.equal((await owner('DELETE', `/api/me/passkeys/${added.id}`)).status, 200);
  assert.equal((await thief('GET', '/api/me')).status, 401, 'the other session ended');
  assert.equal((await owner('GET', '/api/me')).status, 200, 'the own session stays');
});

test('AD attempts count before AD answers: parallel attempts cannot run past the limit; a right password gives it back', async () => {
  const { createLoginLimiter } = await import('../src/auth/session.js');
  const l = createLoginLimiter({ max: 3, ipMax: 10 });
  // three requests start at once (each waits for AD): the fourth is refused before asking AD
  const a = [l.begin('10.0.10.5', 'karl'), l.begin('10.0.10.5', 'karl'), l.begin('10.0.10.5', 'karl')];
  assert.throws(() => l.begin('10.0.10.5', 'karl'), /tooManyAttempts/);
  // a right password (or AD not reachable) releases its attempt – once
  a[0].release(); a[0].release();
  assert.doesNotThrow(() => l.begin('10.0.10.5', 'karl'));
  assert.throws(() => l.begin('10.0.10.5', 'karl'), /tooManyAttempts/);
  // the IP budget is given back as well: successful sign-ins behind one NAT do not use it up
  const b = createLoginLimiter({ max: 100, ipMax: 3 });
  for (let i = 0; i < 10; i++) b.begin('203.0.113.9', `user${i}`).release();
  assert.doesNotThrow(() => b.check('203.0.113.9', 'x'));
});

test('SSO via the AD identifier without service account: role and projects come from the token', async () => {
  const { accountForSso } = await import('../src/routes/oidc.js');
  const { users } = S.ctx;
  const ad = users.upsertExternal({ source: 'ldap', username: 'c.chefin', displayName: 'Clara Chefin', email: 'c.chefin@firma.local', externalId: 'c0'.repeat(16), sid: 'S-1-5-21-1-2-3-2001', role: 'admin' });
  users.upsertExternal({ source: 'ldap', username: 'z.zweit', displayName: 'Zweite Admin', email: 'z.zweit@firma.local', externalId: 'c1'.repeat(16), sid: 'S-1-5-21-1-2-3-2002', role: 'admin' });
  S.ctx.settings.set('ldap.enabled', false); // no AD connection: the known account is used
  const cfg = { adminGroup: 'Helfi-Admins', allowCreate: true, projectGroups: [] };
  const info = { adId: { sid: 'S-1-5-21-1-2-3-2001' }, groups: { admin: false, user: true, projects: [] }, username: 'clara@firma.local', displayName: 'Clara Chefin', externalId: 'iss|clara' };
  const r = await accountForSso(S.ctx, info, cfg);
  assert.equal(r.user.id, ad.id, 'signed in as the AD account');
  assert.equal(S.db.prepare('SELECT role FROM users WHERE id=?').get(ad.id).role, 'user', 'removed from the admin group: no longer admin');
  // in the admin group again: admin again
  await accountForSso(S.ctx, { ...info, groups: { admin: true, user: true, projects: [] } }, cfg);
  assert.equal(S.db.prepare('SELECT role FROM users WHERE id=?').get(ad.id).role, 'admin');
  // a locked role stays
  S.db.prepare('UPDATE users SET role_locked=1 WHERE id=?').run(ad.id);
  await accountForSso(S.ctx, info, cfg);
  assert.equal(S.db.prepare('SELECT role FROM users WHERE id=?').get(ad.id).role, 'admin');
});

test('Review: removing or renaming a passkey needs the second factor (else: remove + add own passkey)', async () => {
  await S.user('vera', 'user');
  const first = await jar().login('vera');
  const pk = softPasskey();
  const added = (await addPasskey(first, pk)).body.passkey;
  const pwOnly = await jar().login('vera');
  const st = (await pwOnly('GET', '/api/me/passkeys')).body;
  assert.equal(st.canManage, false);
  let r = await pwOnly('DELETE', `/api/me/passkeys/${added.id}`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'err.passkeyManageSecondFactor');
  assert.equal((await pwOnly('PATCH', `/api/me/passkeys/${added.id}`, { name: 'x' })).status, 403);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM user_passkeys WHERE user_id=?').get(S.ids.vera).n, 1);
  // signed in with the passkey: allowed
  const c = jar();
  const o = await c('POST', '/api/auth/passkey/options');
  assert.equal((await c('POST', '/api/auth/passkey/login', { response: pk.signIn(o.body) })).status, 200);
  r = await c('DELETE', `/api/me/passkeys/${added.id}`);
  assert.equal(r.status, 200);
});

test('Review: sign-in with 2FA required never enrolls an app for an account that has a passkey', async () => {
  await S.user('ute', 'user');
  const first = await jar().login('ute');
  assert.equal((await addPasskey(first, softPasskey())).status, 200);
  S.ctx.settings.set('mfa.internal', 'all');
  try {
    const c = jar();
    const r = await c('POST', '/api/auth/login', { username: 'ute', password: 'Sehrgeheim123' });
    assert.equal(r.status, 200);
    assert.equal(r.body.passkey, true, 'the passkey is offered');
    const e = await c('POST', '/api/auth/mfa/enroll');
    assert.equal(e.status, 403);
    assert.equal(e.body.error.code, 'err.mfaUsePasskey');
    assert.equal((await c('POST', '/api/auth/mfa', { code: '123456' })).status, 403);
    assert.equal(S.db.prepare('SELECT totp_enabled FROM users WHERE id=?').get(S.ids.ute).totp_enabled, 0);
  } finally { S.ctx.settings.set('mfa.internal', ''); }
});

test('Review: a pending address change ends with a password change, a reset or an admin change', async () => {
  const sent = [];
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  const wolf = await S.user('wolf', 'user');
  const pending = () => S.db.prepare("SELECT COUNT(*) n FROM account_tokens WHERE kind='email' AND user_id=?").get(S.ids.wolf).n;
  assert.equal((await wolf('PATCH', '/api/me', { email: 'angreifer@extern.example', currentPassword: 'Sehrgeheim123' })).status, 200);
  assert.equal(pending(), 1);
  // the owner reacts to the notice: changes the password → the link is void
  assert.equal((await wolf('PATCH', '/api/me', { currentPassword: 'Sehrgeheim123', newPassword: 'Neues-Kennwort-2026' })).status, 200);
  assert.equal(pending(), 0);
  await new Promise((r) => setTimeout(r, 30));
  const link = /email\/confirm#([A-Za-z0-9_-]+)/.exec(sent.find((m) => m.to === 'angreifer@extern.example').text)[1];
  assert.equal((await jar()('POST', '/api/auth/email/confirm', { token: link })).status, 400);
  assert.equal(S.ctx.users.byName('wolf').email, 'wolf@firma.local');
  // an admin change ends it as well
  assert.equal((await wolf('PATCH', '/api/me', { email: 'zweit@extern.example', currentPassword: 'Neues-Kennwort-2026' })).status, 200);
  assert.equal(pending(), 1);
  assert.equal((await S.admin('PATCH', `/api/users/${S.ids.wolf}`, { email: 'wolf.richtig@firma.local' })).status, 200);
  assert.equal(pending(), 0);
});

test('Review: without mail sending the profile request saves nothing at all', async () => {
  const xaver = await S.user('xaver', 'user');
  S.ctx.mailer.enabled = () => false;
  const r = await xaver('PATCH', '/api/me', { displayName: 'Xaver Neu', email: 'x.neu@firma.local', currentPassword: 'Sehrgeheim123', newPassword: 'Anderes-Kennwort-1' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.emailChangeNoMail');
  assert.equal(S.ctx.users.byName('xaver').display_name, 'xaver', 'name not saved either');
  assert.equal((await jar()('POST', '/api/auth/login', { username: 'xaver', password: 'Sehrgeheim123' })).status, 200, 'old password still works');
});

test('Review: SSO token without groups claim changes nothing (no flip of rights)', async () => {
  const { accountForSso } = await import('../src/routes/oidc.js');
  const ad = S.ctx.users.upsertExternal({ source: 'ldap', username: 'g.gruppe', displayName: 'G', email: 'g.gruppe@firma.local', externalId: 'd0'.repeat(16), sid: 'S-1-5-21-1-2-3-3001', role: 'admin' });
  S.ctx.settings.set('ldap.enabled', false);
  const info = { adId: { sid: 'S-1-5-21-1-2-3-3001' }, groups: { admin: false, projects: [] }, groupsPresent: false, username: 'g@firma.local', displayName: 'G', externalId: 'iss|g' };
  await accountForSso(S.ctx, info, { adminGroup: 'Helfi-Admins', allowCreate: true });
  assert.equal(S.db.prepare('SELECT role FROM users WHERE id=?').get(ad.id).role, 'admin');
});
