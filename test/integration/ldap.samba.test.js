// Integration test against a real Samba AD (only if HELFI_TEST_LDAP_HOST is set).
//   HELFI_TEST_LDAP_HOST=dc01.firma.local HELFI_TEST_LDAP_BINDPW=... node --test test/integration/
// Expects the users/groups from scripts/test-samba-ad.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ldap from '../../src/auth/ldap.js';

const host = process.env.HELFI_TEST_LDAP_HOST;
const skip = !host && 'HELFI_TEST_LDAP_HOST not set';

const base = {
  host, port: 636, security: 'ldaps', tlsMode: 'pinned', verifyHostname: true, caPem: '',
  baseDn: 'DC=firma,DC=local', bindDn: 'svc-helfi@firma.local', bindPassword: process.env.HELFI_TEST_LDAP_BINDPW || 'Dienst!Pass2026',
  userFilter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={{username}}))',
  usernameAttr: 'sAMAccountName', displayNameAttr: 'displayName', emailAttr: 'mail',
  nestedGroups: true, adminGroup: 'Helfi-Admins', userGroup: '', timeoutMs: 8000,
};

test('LDAPS: fetch certificate and trust it', { skip }, async () => {
  const r = await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' });
  assert.ok(r.chain.length >= 1);
  assert.match(r.chain[0].fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  base.caPem = r.pem;
  const res = await ldap.testConnection({ ...base });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.equal(res.rootDse.defaultNamingContext.toLowerCase(), 'dc=firma,dc=local');
});

test('StartTLS: fetch certificate', { skip }, async () => {
  const r = await ldap.fetchCertificateChain({ host, port: 389, security: 'starttls' });
  assert.ok(r.chain.length >= 1);
  const res = await ldap.testConnection({ ...base, port: 389, security: 'starttls', caPem: r.pem });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
});

test('LDAPS: foreign certificate is rejected', { skip }, async () => {
  // Create a real but foreign certificate (openssl)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=dc01.firma.local', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const other = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  const res = await ldap.testConnection({ ...base, caPem: other });
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((st) => st.key === 'bind'), undefined, 'must not get as far as the bind');
});

test('Login, roles from (nested) groups', { skip }, async () => {
  const cfg = { ...base };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;

  const max = await ldap.authenticate(cfg, 'FIRMA\\m.muster', 'Muster!Pass2026');
  assert.equal(max.username, 'm.muster');
  assert.equal(max.email, 'm.muster@firma.local');
  assert.deepEqual(max.groups, { admin: false, user: true, projects: [] });

  const erika = await ldap.authenticate(cfg, 'e.beispiel@firma.local', 'Beispiel!Pass2026');
  assert.equal(erika.groups.admin, true, 'nested group IT-Team → Helfi-Admins');

  const flat = await ldap.authenticate({ ...cfg, nestedGroups: false }, 'e.beispiel', 'Beispiel!Pass2026');
  assert.equal(flat.groups.admin, false, 'no admin without nesting');

  // Project groups (by name, in another OU; nested): member = agent of that project
  const pg = { ...cfg, projectGroups: [{ id: 7, key: 'HM', group: 'Helfi-Support' }, { id: 8, key: 'IT', group: 'IT-Team' }] };
  assert.deepEqual((await ldap.authenticate(pg, 'm.muster', 'Muster!Pass2026')).groups.projects, [7]);
  assert.deepEqual((await ldap.authenticate(pg, 'e.beispiel', 'Beispiel!Pass2026')).groups.projects, [8]);
  const test = await ldap.testConnection(pg, { username: 'm.muster', password: 'Muster!Pass2026' });
  assert.ok(test.steps.some((st) => st.key === 'projectGroup' && st.project === 'HM' && st.ok), JSON.stringify(test.steps));
  assert.deepEqual(test.steps.find((st) => st.key === 'user').user.groups.projects, ['HM']);

  assert.equal(await ldap.authenticate(cfg, 'm.muster', 'falsch'), null);
  assert.equal(await ldap.authenticate(cfg, 'm.muster', ''), null, 'empty password = never anonymous');
  assert.equal(await ldap.authenticate(cfg, 'gibtsnicht', 'x'), null);
  assert.equal(await ldap.authenticate(cfg, 'm.muster)(|(sAMAccountName=*', 'x'), null, 'Filter-Injection');
});

test('Without service account: search as the user logging in', { skip }, async () => {
  const cfg = { ...base, bindDn: '', bindPassword: '' };
  cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;
  const u = await ldap.authenticate(cfg, 'k.kunde', 'Kunde!Pass2026');
  assert.equal(u.username, 'k.kunde');
  assert.deepEqual(u.groups, { admin: false, user: true, projects: [] });
  assert.equal(await ldap.authenticate(cfg, 'k.kunde', 'falsch'), null);
});

test('Hostname check: via IP without name in the certificate fails, can be disabled', { skip }, async () => {
  const pem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;
  const strict = await ldap.testConnection({ ...base, host: '127.0.0.1', caPem: pem, verifyHostname: true });
  assert.equal(strict.ok, false);
  const relaxed = await ldap.testConnection({ ...base, host: '127.0.0.1', caPem: pem, verifyHostname: false });
  assert.equal(relaxed.ok, true, JSON.stringify(relaxed.steps));
});

test('Find sender by email: primary address, UPN, secondary address, not disabled, not ambiguous', { skip }, async () => {
  const cfg = { ...base };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;

  // Test setup as domain admin: secondary address for Erika
  const { Change, Attribute } = await import('ldapts');
  const adm = await ldap.connect(cfg);
  try {
    await adm.bind('Administrator@firma.local', 'Passw0rd!2026');
    await adm.modify('CN=Erika Beispiel,CN=Users,DC=firma,DC=local', [
      new Change({ operation: 'replace', modification: new Attribute({ type: 'proxyAddresses', values: ['SMTP:e.beispiel@firma.local', 'smtp:erika.alt@firma.de'] }) }),
    ]);
  } finally { await adm.unbind().catch(() => {}); }

  const max = await ldap.findByEmail({ ...cfg, projectGroups: [{ id: 9, key: 'IT', group: 'Helfi-Bearbeiter' }] }, 'M.Muster@firma.local');
  assert.equal(max.username, 'm.muster');
  assert.deepEqual(max.groups.projects, [9], 'project group also in the sender lookup');
  assert.ok(max.externalId);

  const upn = await ldap.findByEmail(cfg, 'k.kunde@firma.local');
  assert.equal(upn.username, 'k.kunde');

  const alias = await ldap.findByEmail(cfg, 'erika.alt@firma.de');
  assert.equal(alias.username, 'e.beispiel');
  assert.equal(alias.email, 'e.beispiel@firma.local');
  assert.equal(alias.groups.admin, true, 'nested group also in the sender lookup');

  assert.equal(await ldap.findByEmail(cfg, 'd.alt@firma.local'), null, 'disabled account');
  assert.equal(await ldap.findByEmail(cfg, 'niemand@firma.local'), null);
  assert.equal(await ldap.findByEmail(cfg, '*@firma.local'), null, 'wildcard is escaped');
  await assert.rejects(ldap.findByEmail({ ...cfg, bindDn: '' }, 'm.muster@firma.local'), /Dienstkonto/);
});

test('Search people (participants from AD) and fetch by objectGUID', { skip }, async () => {
  const cfg = { ...base };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;

  const byName = await ldap.searchPeople(cfg, 'Muster');
  assert.deepEqual(byName.map((p) => p.username), ['m.muster']);
  assert.equal(byName[0].email, 'm.muster@firma.local');
  assert.match(byName[0].externalId, /^[0-9a-f]{32}$/);

  assert.deepEqual((await ldap.searchPeople(cfg, 'max mus')).map((p) => p.username), ['m.muster'], 'several word parts');
  assert.deepEqual((await ldap.searchPeople(cfg, 'k.kunde@firma')).map((p) => p.username), ['k.kunde'], 'part of the email address');
  assert.deepEqual((await ldap.searchPeople(cfg, 'erika.alt@firma.de')).map((p) => p.username), ['e.beispiel'], 'secondary address');
  assert.deepEqual(await ldap.searchPeople(cfg, 'Dora'), [], 'disabled account not found');
  assert.deepEqual(await ldap.searchPeople(cfg, '*'), [], 'wildcard is escaped');
  assert.ok((await ldap.searchPeople(cfg, 'firma.local', { limit: 2 })).length <= 2, 'limit');

  // The GUID from the search must return the same person as the login (externalId)
  const got = await ldap.findByGuid({ ...cfg, projectGroups: [{ id: 9, key: 'IT', group: 'Helfi-Bearbeiter' }] }, byName[0].externalId);
  assert.equal(got.username, 'm.muster');
  assert.deepEqual(got.groups.projects, [9]);
  const login = await ldap.authenticate(cfg, 'm.muster', 'Muster!Pass2026');
  assert.equal(login.externalId, byName[0].externalId, 'same ID as at login');
  assert.equal(await ldap.findByGuid(cfg, '00'.repeat(16)), null);
  assert.equal(await ldap.findByGuid(cfg, 'kein-guid'), null);
  await assert.rejects(ldap.searchPeople({ ...cfg, bindDn: '' }, 'Muster'), /Dienstkonto/);
});

test('Without service account: login checks the password on the account found', { skip }, async () => {
  // Samba does not even allow the actual collision (UPN of one account = sAMAccountName@domain of another)
  // ("implied by userPrincipalName"); here the path via the second bind to the DN is tested.
  const cfg = { ...base, bindDn: '', bindPassword: '' };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;
  const ok = await ldap.authenticate(cfg, 'k.kunde', 'Kunde!Pass2026');
  assert.equal(ok?.username, 'k.kunde');
  assert.match(ok.sid, /^S-1-5-21-\d+-\d+-\d+-\d+$/, 'objectSid is included');
  assert.match(ok.externalId, /^[0-9a-f]{32}$/, 'objectGUID as hex');
  assert.equal(await ldap.authenticate(cfg, 'k.kunde', 'falsch'), null);
  assert.equal(await ldap.authenticate(cfg, 'm.muster', 'Kunde!Pass2026'), null, 'someone else\'s password');
});

test('objectSid: find account by SID (SSO merging)', { skip }, async () => {
  const cfg = { ...base };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;
  const max = await ldap.findByEmail(cfg, 'm.muster@firma.local');
  assert.match(max.sid, /^S-1-5-21-/);
  const bySid = await ldap.findBySid(cfg, max.sid);
  assert.equal(bySid.username, 'm.muster');
  assert.equal(bySid.externalId, max.externalId);
  assert.equal(await ldap.findBySid(cfg, 'S-1-5-21-1-2-3-999999'), null);
});

test('Group given by name only is found outside the base DN (groups in their own OU)', { skip }, async () => {
  // Base DN = the users' container, the group lives in OU=Gruppen – before, only the full DN worked
  const cfg = { ...base, baseDn: 'CN=Users,DC=firma,DC=local', adminGroup: 'helfi-admins', projectGroups: [{ id: 5, key: 'IT', group: 'Helfi-Support' }] };
  const max = await ldap.authenticate(cfg, 'm.muster', 'Muster!Pass2026');
  assert.deepEqual(max.groups.projects, [5], 'group name alone, group in another OU');
  const erika = await ldap.authenticate(cfg, 'e.beispiel', 'Beispiel!Pass2026');
  assert.equal(erika.groups.admin, true, 'name in other letter case, nested');
  assert.deepEqual(erika.groups.projects, []);
  // the connection test shows the resolved DN
  const t = await ldap.testConnection(cfg);
  const step = t.steps.find((s) => s.key === 'projectGroup' && s.project === 'IT');
  assert.equal(step.ok, true);
  assert.match(step.dn, /^CN=Helfi-Support,OU=Gruppen,DC=firma,DC=local$/i);
});
