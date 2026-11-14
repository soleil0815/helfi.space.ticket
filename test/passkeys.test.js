// Passkeys (WebAuthn): add in the profile, sign in without password, AD check via service account,
// rules for where the first passkey may be added, administration. Software passkey from helpers/webauthn.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { softPasskey } from './helpers/webauthn.js';

let S;
let relyingParty; // imported after startServer (the config reads HELFI_DATA_DIR)
const GUID = 'a1'.repeat(16);
let adEntry; // what the (mocked) AD returns for the account
let adFail = false;

/** Client with a real cookie jar (the passkey challenge cookie and the session cookie side by side) */
function jar() {
  const cookies = new Map();
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(S.base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
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
  call.cookies = cookies;
  return call;
}

async function addPasskey(c, pk, name = 'iPhone') {
  const o = await c('POST', '/api/me/passkeys/options');
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const r = await c('POST', '/api/me/passkeys', { response: pk.register(o.body), name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.passkey;
}

async function signIn(pk, opts = {}) {
  const c = jar();
  const o = await c('POST', '/api/auth/passkey/options');
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const r = await c('POST', '/api/auth/passkey/login', { response: pk.signIn(o.body, opts) });
  return { c, r, options: o.body };
}

before(async () => {
  S = await startServer('passkeys');
  ({ relyingParty } = await import('../src/auth/passkeys.js'));
  await S.user('karl', 'user');
  await S.user('anna', 'admin');
  S.ctx.directory = {
    byGuid: async (cfg, id) => { if (adFail) throw new Error('connect ECONNREFUSED'); return id === GUID ? adEntry : null; },
    bySid: async () => null,
  };
});
after(() => S.stop());

test('Relying party: host name of HELFI_BASE_URL; HTTPS (or localhost) and no IP address', () => {
  assert.deepEqual(relyingParty('https://helfi.firma.local'), { rpID: 'helfi.firma.local', origin: 'https://helfi.firma.local' });
  assert.deepEqual(relyingParty('https://helfi.firma.local:8443/'), { rpID: 'helfi.firma.local', origin: 'https://helfi.firma.local:8443' });
  assert.deepEqual(relyingParty('http://localhost:8080'), { rpID: 'localhost', origin: 'http://localhost:8080' });
  assert.equal(relyingParty('http://helfi.firma.local'), null, 'no HTTPS');
  assert.equal(relyingParty('https://10.0.10.25'), null, 'IP address');
  assert.equal(relyingParty('https://[2001:db8::1]'), null, 'IPv6 address');
});

test('Add a passkey and sign in with it: no password, no code, counts as 2FA', async () => {
  const karl = await jar().login('karl');
  let st = await karl('GET', '/api/me/passkeys');
  assert.deepEqual({ available: st.body.available, canAdd: st.body.canAdd, n: st.body.passkeys.length }, { available: true, canAdd: true, n: 0 });
  const pk = softPasskey();
  const added = await addPasskey(karl, pk, 'iPhone von Karl');
  assert.equal(added.name, 'iPhone von Karl');
  assert.equal(added.synced, true);
  // Options demand user verification (Face ID/PIN) and a discoverable passkey; the own passkey is excluded
  const o = await karl('POST', '/api/me/passkeys/options');
  assert.equal(o.body.authenticatorSelection.userVerification, 'required');
  assert.equal(o.body.authenticatorSelection.residentKey, 'required');
  assert.deepEqual(o.body.excludeCredentials.map((c) => c.id), [pk.id]);
  assert.equal(o.body.rp.id, 'localhost');

  const { c, r } = await signIn(pk);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.username, 'karl');
  assert.equal((await c('GET', '/api/me')).body.user.username, 'karl');
  const sess = S.db.prepare('SELECT auth_method, mfa FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(S.ids.karl);
  assert.deepEqual({ ...sess }, { auth_method: 'passkey', mfa: 1 });
  const row = S.db.prepare('SELECT counter, last_used_at FROM user_passkeys WHERE credential_id=?').get(pk.id);
  assert.equal(row.counter, 1);
  assert.ok(row.last_used_at > 0);
  st = await karl('GET', '/api/me/passkeys');
  assert.ok(st.body.passkeys[0].lastUsedAt);
  // Bootstrap tells the sign-in page that passkeys are available
  assert.equal((await jar()('GET', '/api/bootstrap')).body.auth.passkeys, 'localhost', 'host name the passkeys belong to');
});

test('Sign-in is refused: replayed answer, wrong site, no Face ID/PIN, cloned passkey, unknown passkey', async () => {
  const karl = await jar().login('karl');
  const pk = softPasskey();
  await addPasskey(karl, pk, 'Test');

  // Replay: the same answer a second time (new challenge on the server)
  const { r: first, options } = await signIn(pk);
  assert.equal(first.status, 200);
  const c = jar();
  await c('POST', '/api/auth/passkey/options');
  assert.equal((await c('POST', '/api/auth/passkey/login', { response: pk.signIn(options) })).status, 401);
  // Without a challenge cookie at all
  assert.equal((await jar()('POST', '/api/auth/passkey/login', { response: pk.signIn(options) })).status, 401);

  assert.equal((await signIn(pk, { originOverride: 'https://evil.example' })).r.status, 401, 'other origin');
  assert.equal((await signIn(pk, { rpOverride: 'evil.example' })).r.status, 401, 'other RP ID');
  assert.equal((await signIn(pk, { uv: false })).r.status, 401, 'without user verification');
  // Counter did not go up after the last successful sign-in: sign of a copied passkey
  assert.equal((await signIn(pk)).r.status, 200);
  assert.equal((await signIn(pk, { keepCounter: true })).r.status, 401, 'counter not increased');
  assert.equal((await signIn(softPasskey())).r.status, 401, 'passkey unknown to the server');
  assert.equal((await signIn(pk)).r.status, 200, 'still works normally');
});

test('Registration is refused with a wrong origin, without user verification and twice for the same passkey', async () => {
  const karl = await jar().login('karl');
  const pk = softPasskey();
  let o = await karl('POST', '/api/me/passkeys/options');
  assert.equal((await karl('POST', '/api/me/passkeys', { response: pk.register(o.body, { originOverride: 'https://evil.example' }) })).status, 400);
  o = await karl('POST', '/api/me/passkeys/options');
  assert.equal((await karl('POST', '/api/me/passkeys', { response: pk.register(o.body, { uv: false }) })).status, 400);
  // Without fresh options: no challenge
  assert.equal((await karl('POST', '/api/me/passkeys', { response: pk.register(o.body) })).status, 400);
  await addPasskey(karl, pk);
  o = await karl('POST', '/api/me/passkeys/options');
  assert.equal((await karl('POST', '/api/me/passkeys', { response: pk.register(o.body) })).body.error.code, 'err.passkeyExists');
});

test('Rename and remove only own passkeys; a removed passkey no longer signs in', async () => {
  const karl = await jar().login('karl');
  const anna = await jar().login('anna');
  const pk = softPasskey();
  const p = await addPasskey(karl, pk, 'Alt');
  assert.equal((await anna('PATCH', `/api/me/passkeys/${p.id}`, { name: 'Fremd' })).status, 404);
  assert.equal((await anna('DELETE', `/api/me/passkeys/${p.id}`)).status, 404);
  assert.equal((await karl('PATCH', `/api/me/passkeys/${p.id}`, { name: '  Büro-Mac\u0007 ' })).status, 200);
  assert.equal(S.db.prepare('SELECT name FROM user_passkeys WHERE id=?').get(p.id).name, 'Büro-Mac');
  assert.equal((await karl('DELETE', `/api/me/passkeys/${p.id}`)).status, 200);
  assert.equal((await signIn(pk)).r.status, 401);
});

test('Deactivated accounts cannot sign in with a passkey', async () => {
  await S.user('dora', 'user');
  const dora = await jar().login('dora');
  const pk = softPasskey();
  await addPasskey(dora, pk);
  await S.admin('PATCH', `/api/users/${S.ids.dora}`, { active: false });
  assert.equal((await signIn(pk)).r.status, 401);
  await S.admin('PATCH', `/api/users/${S.ids.dora}`, { active: true });
  assert.equal((await signIn(pk)).r.status, 200);
});

test('First passkey from outside only after a sign-in with second factor', async () => {
  await S.user('eva', 'user');
  const s = S.ctx.settings;
  s.set('mfa.internalNetworks', '10.0.10.0/24'); // the test client is now "outside"
  s.set('mfa.external', 'none'); // and needs no 2FA there
  try {
    const eva = await jar().login('eva');
    const st = await eva('GET', '/api/me/passkeys');
    assert.equal(st.body.canAdd, false);
    const o = await eva('POST', '/api/me/passkeys/options');
    assert.equal(o.status, 403);
    assert.equal(o.body.error.code, 'err.passkeyAddInternal');
    // Explicitly allowed: enrollment from outside
    s.set('mfa.enrollExternal', true);
    assert.equal((await eva('GET', '/api/me/passkeys')).body.canAdd, true);
  } finally {
    s.set('mfa.enrollExternal', false);
    s.set('mfa.external', '');
    s.set('mfa.internalNetworks', '127.0.0.1, ::1');
  }
});

test('Switched off: no button, no sign-in, nothing to add', async () => {
  const karl = await jar().login('karl');
  const pk = softPasskey();
  await addPasskey(karl, pk);
  S.ctx.settings.set('passkeys.enabled', false);
  try {
    assert.equal((await jar()('GET', '/api/bootstrap')).body.auth.passkeys, false);
    assert.equal((await jar()('POST', '/api/auth/passkey/options')).status, 404);
    assert.equal((await karl('GET', '/api/me/passkeys')).body.reason, 'off');
    assert.equal((await karl('POST', '/api/me/passkeys/options')).status, 400);
  } finally { S.ctx.settings.set('passkeys.enabled', true); }
  assert.equal((await signIn(pk)).r.status, 200);
});

test('Admin setting is saved as a boolean; the network info names the passkey host', async () => {
  let r = await S.admin('PUT', '/api/admin/settings', { settings: { 'passkeys.enabled': 0 } });
  assert.equal(r.status, 200);
  assert.equal(S.ctx.settings.get('passkeys.enabled'), false);
  r = await S.admin('PUT', '/api/admin/settings', { settings: { 'passkeys.enabled': 1 } });
  assert.equal(S.ctx.settings.get('passkeys.enabled'), true);
  r = await S.admin('GET', '/api/admin/mfa/network');
  assert.equal(r.body.passkeyRp, 'localhost');
});

test('Administration: passkey count per person, "remove passkeys" signs the person out', async () => {
  await S.user('fritz', 'user');
  const fritz = await jar().login('fritz');
  const pk1 = softPasskey(); const pk2 = softPasskey();
  await addPasskey(fritz, pk1, 'iPhone');
  await addPasskey(fritz, pk2, 'Mac');
  let list = await S.admin('GET', '/api/users?all=1');
  assert.equal(list.body.users.find((u) => u.username === 'fritz').passkeys, 2);
  const karl = await jar().login('karl');
  assert.equal((await karl('PATCH', `/api/users/${S.ids.fritz}`, { removePasskeys: true })).status, 403, 'only admins');
  assert.equal((await S.admin('PATCH', `/api/users/${S.ids.fritz}`, { removePasskeys: true })).status, 200);
  list = await S.admin('GET', '/api/users?all=1');
  assert.equal(list.body.users.find((u) => u.username === 'fritz').passkeys, 0);
  assert.equal((await fritz('GET', '/api/me')).status, 401, 'signed out');
  assert.equal((await signIn(pk1)).r.status, 401);
});

test('SSO accounts: no passkeys (they sign in at their provider)', async () => {
  const u = S.ctx.users.upsertExternal({ source: 'oidc', username: 'sso.person', displayName: 'SSO Person', email: 'sso@firma.local', externalId: 'sub-1', role: 'user' });
  const c = jar();
  // Session directly (no SSO provider in the test)
  const res = { cookie: (k, v) => c.cookies.set(k, v), clearCookie: () => {} };
  S.ctx.sessions.create(res, u.id, '127.0.0.1', 'oidc', { mfa: true });
  const st = await c('GET', '/api/me/passkeys');
  assert.equal(st.status, 200);
  assert.deepEqual({ available: st.body.available, reason: st.body.reason }, { available: false, reason: 'sso' });
  assert.equal((await c('POST', '/api/me/passkeys/options')).body.error.code, 'err.passkey.sso');
});

test('AD accounts: only with service account; each sign-in checks the account in AD and updates the role', async () => {
  const s = S.ctx.settings;
  s.set('ldap.enabled', true);
  s.set('ldap.adminGroup', 'Helfi-Admins');
  s.set('ldap.userGroup', 'Helfi-Benutzer');
  adEntry = { username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: GUID, sid: '', dn: 'CN=Erika Beispiel,CN=Users,DC=firma,DC=local', groups: { admin: false, user: true, projects: [] } };
  const u = S.ctx.users.upsertExternal({ source: 'ldap', username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: GUID, role: 'user' });
  const c = jar();
  S.ctx.sessions.create({ cookie: (k, v) => c.cookies.set(k, v) }, u.id, '127.0.0.1', 'ldap', { mfa: false });

  // Without service account: explained, nothing can be added
  let st = await c('GET', '/api/me/passkeys');
  assert.deepEqual({ available: st.body.available, reason: st.body.reason }, { available: false, reason: 'adNoServiceAccount' });
  assert.equal((await c('POST', '/api/me/passkeys/options')).body.error.code, 'err.passkey.adNoServiceAccount');

  s.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  st = await c('GET', '/api/me/passkeys');
  assert.equal(st.body.available, true);
  const pk = softPasskey();
  await addPasskey(c, pk, 'Diensthandy');

  let r = (await signIn(pk)).r;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'user');

  // Made admin in AD: the role follows on the next passkey sign-in
  adEntry = { ...adEntry, groups: { admin: true, user: true, projects: [] } };
  r = (await signIn(pk)).r;
  assert.equal(r.body.user.role, 'admin');

  // Removed from the allowed group
  adEntry = { ...adEntry, groups: { admin: false, user: false, projects: [] } };
  r = (await signIn(pk)).r;
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'err.notInGroup');

  // Disabled or deleted in AD (lookup finds no active account)
  adEntry = null;
  r = (await signIn(pk)).r;
  assert.equal(r.status, 401);

  // AD not reachable: clear message, no sign-in
  adEntry = { username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: GUID, sid: '', dn: 'x', groups: { admin: false, user: true, projects: [] } };
  adFail = true;
  r = (await signIn(pk)).r;
  assert.equal(r.status, 503);
  adFail = false;

  // Service account removed later: passkey sign-in of AD accounts stops
  s.set('ldap.bindDn', '');
  r = (await signIn(pk)).r;
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'err.passkey.adNoServiceAccount');
  s.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  assert.equal((await signIn(pk)).r.status, 200);
  s.set('ldap.enabled', false);
});

test('Too many attempts with one passkey are blocked', async () => {
  const karl = await jar().login('karl');
  const pk = softPasskey();
  await addPasskey(karl, pk);
  let last;
  for (let i = 0; i < 9; i++) last = (await signIn(pk, { uv: false })).r;
  assert.equal(last.status, 429);
  assert.equal((await signIn(pk)).r.status, 429, 'blocked even with a valid answer');
});

test('Hint on the start page: only without passkey and where adding works; "later" 14 days, "never" for good', async () => {
  await S.user('hanna', 'user');
  const c = await jar().login('hanna');
  const prompt = async () => (await c('GET', '/api/me/passkeys')).body.prompt;
  assert.equal(await prompt(), true);
  // Switched off by the admin
  S.ctx.settings.set('passkeys.prompt', false);
  assert.equal(await prompt(), false);
  S.ctx.settings.set('passkeys.prompt', true);
  // "Later": hidden for 14 days, then back
  assert.equal((await c('POST', '/api/me/passkeys/prompt', { action: 'later' })).status, 200);
  assert.equal(await prompt(), false);
  const until = S.db.prepare('SELECT passkey_prompt_until v FROM users WHERE id=?').get(S.ids.hanna).v;
  const days = (until - Date.now()) / 86400000;
  assert.ok(days > 13.9 && days <= 14, `${days}`);
  S.db.prepare('UPDATE users SET passkey_prompt_until=? WHERE id=?').run(Date.now() - 1000, S.ids.hanna);
  assert.equal(await prompt(), true, 'shown again after the 14 days');
  // Only "later" and "never"
  assert.equal((await c('POST', '/api/me/passkeys/prompt', { action: 'forever' })).status, 400);
  // "Never": gone for good
  await c('POST', '/api/me/passkeys/prompt', { action: 'never' });
  assert.equal(S.db.prepare('SELECT passkey_prompt_until v FROM users WHERE id=?').get(S.ids.hanna).v, -1);
  assert.equal(await prompt(), false);
  // Admin setting is saved as a boolean
  await S.admin('PUT', '/api/admin/settings', { settings: { 'passkeys.prompt': 0 } });
  assert.equal(S.ctx.settings.get('passkeys.prompt'), false);
  await S.admin('PUT', '/api/admin/settings', { settings: { 'passkeys.prompt': 1 } });
  assert.equal(S.ctx.settings.get('passkeys.prompt'), true);
});

test('Hint: not once a passkey exists, not where adding is not allowed', async () => {
  await S.user('ida', 'user');
  const c = await jar().login('ida');
  assert.equal((await c('GET', '/api/me/passkeys')).body.prompt, true);
  assert.equal((await c('GET', '/api/bootstrap')).body.mfa.passkey, false);
  await addPasskey(c, softPasskey());
  assert.equal((await c('GET', '/api/me/passkeys')).body.prompt, false, 'has a passkey');
  assert.equal((await c('GET', '/api/bootstrap')).body.mfa.passkey, true, 'a passkey counts as second factor: no "set up 2FA" banner');

  await S.user('jan', 'user');
  const s = S.ctx.settings;
  s.set('mfa.internalNetworks', '10.0.10.0/24');
  s.set('mfa.external', 'none');
  try {
    const j = await jar().login('jan');
    assert.equal((await j('GET', '/api/me/passkeys')).body.prompt, false, 'outside without second factor');
  } finally {
    s.set('mfa.external', '');
    s.set('mfa.internalNetworks', '127.0.0.1, ::1');
  }
});

test('Flood of passkey requests from one address: 429 after 120 per minute', async () => {
  const karl = await jar().login('karl');
  const pk = softPasskey();
  await addPasskey(karl, pk);
  // A sign-in in progress (challenge issued) before the flood
  const c = jar();
  const o = await c('POST', '/api/auth/passkey/options');
  let last;
  for (let i = 0; i < 130; i++) last = await jar()('POST', '/api/auth/passkey/options');
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, 'err.tooManyAttempts');
  assert.equal((await c('POST', '/api/auth/passkey/login', { response: pk.signIn(o.body) })).status, 429, 'same address is blocked for the minute');
});
