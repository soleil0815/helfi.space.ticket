// Two-factor requirement per role and network, own internet connection
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createNetworkPolicy, mfaLevels, levelApplies, parseOwnAddresses } = await import('../src/auth/network.js');

const req = (ip) => ({ ip, socket: { remoteAddress: ip }, headers: {} });
const mkSettings = (vals) => {
  const v = { 'mfa.internalNetworks': '10.0.10.0/24', 'mfa.mode': 'external', 'mfa.external': '', 'mfa.internal': '', 'mfa.ownAddresses': '', ...vals };
  return { get: (k) => v[k], set: (k, x) => { v[k] = x; } };
};
const INTERN = '10.0.10.25';
const EXTERN = '198.51.100.7';
const OWN = '203.0.113.10';
const admin = { role: 'admin' };
const agent = { role: 'agent' };
const user = { role: 'user' };

test('Levels: who is affected?', () => {
  assert.equal(levelApplies('all', 'user'), true);
  assert.equal(levelApplies('agents', 'user'), false);
  assert.equal(levelApplies('agents', 'agent'), true);
  assert.equal(levelApplies('agents', 'admin'), true);
  assert.equal(levelApplies('admins', 'agent'), false);
  assert.equal(levelApplies('admins', 'admin'), true);
  assert.equal(levelApplies('none', 'admin'), false);
  assert.equal(levelApplies('quatsch', 'admin'), false);
});

test('Previous mode is taken over as long as nothing new is saved', () => {
  assert.deepEqual(mfaLevels(mkSettings({ 'mfa.mode': 'external' })), { external: 'all', internal: 'none' });
  assert.deepEqual(mfaLevels(mkSettings({ 'mfa.mode': 'always' })), { external: 'all', internal: 'all' });
  assert.deepEqual(mfaLevels(mkSettings({ 'mfa.mode': 'off' })), { external: 'none', internal: 'none' });
  assert.deepEqual(mfaLevels(mkSettings({ 'mfa.mode': 'off', 'mfa.external': 'admins', 'mfa.internal': 'none' })), { external: 'admins', internal: 'none' });
});

test('Requirement per role and network', () => {
  const p = createNetworkPolicy(mkSettings({ 'mfa.external': 'agents', 'mfa.internal': 'admins' }), { gateway: null });
  try {
    assert.equal(p.mfaRequired(req(EXTERN), user), false);
    assert.equal(p.mfaRequired(req(EXTERN), agent), true);
    assert.equal(p.mfaRequired(req(EXTERN), admin), true);
    assert.equal(p.mfaRequired(req(INTERN), agent), false);
    assert.equal(p.mfaRequired(req(INTERN), admin), true);
    // without a user (unknown) the role "user" applies
    assert.equal(p.mfaRequired(req(EXTERN)), false);
    assert.equal(p.userMode(admin), 'always');
    assert.equal(p.userMode(agent), 'external');
    assert.equal(p.userMode(user), 'off');
  } finally { p.stop(); }
});

test('Own internet connection: validate entries', () => {
  const r = parseOwnAddresses('203.0.113.10\nhelfi.dyndns.example\n\nkein name!\n2001:db8::1');
  assert.deepEqual(r.ips, ['203.0.113.10', '2001:db8::1']);
  assert.deepEqual(r.names, ['helfi.dyndns.example']);
  assert.deepEqual(r.invalid, ['kein', 'name!']);
});

test('Own internet connection by IP counts as internal', () => {
  const s = mkSettings({ 'mfa.ownAddresses': OWN });
  const p = createNetworkPolicy(s, { gateway: null, resolver: async () => [] });
  try {
    const c = p.classify(req(OWN));
    assert.equal(c.internal, true);
    assert.equal(c.reason, 'ownAddress');
    assert.equal(p.mfaRequired(req(OWN), user), false);
    assert.equal(p.isInternal(req(EXTERN)), false);
    // Entry removed → external again immediately
    s.set('mfa.ownAddresses', '');
    assert.equal(p.isInternal(req(OWN)), false);
  } finally { p.stop(); }
});

test('Own internet connection by DynDNS name, resolution is kept on DNS error', async () => {
  let answer = [{ address: OWN, family: 4 }];
  let fail = false;
  const resolver = async (name) => {
    assert.equal(name, 'helfi.dyndns.example');
    if (fail) { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; }
    return answer;
  };
  const p = createNetworkPolicy(mkSettings({ 'mfa.ownAddresses': 'helfi.dyndns.example' }), { gateway: null, resolver });
  try {
    await p.refreshOwn();
    assert.equal(p.isInternal(req(OWN)), true);
    let info = await p.ownAddresses();
    assert.deepEqual(info.resolved, { 'helfi.dyndns.example': [OWN] });

    // new address from the provider
    answer = [{ address: '203.0.113.20', family: 4 }];
    await p.refreshOwn();
    assert.equal(p.isInternal(req(OWN)), false);
    assert.equal(p.isInternal(req('203.0.113.20')), true);

    // DNS briefly gone → last known address stays valid, error is reported
    fail = true;
    await p.refreshOwn();
    assert.equal(p.isInternal(req('203.0.113.20')), true);
    info = await p.ownAddresses();
    assert.equal(info.errors['helfi.dyndns.example'], 'ENOTFOUND');
  } finally { p.stop(); }
});
