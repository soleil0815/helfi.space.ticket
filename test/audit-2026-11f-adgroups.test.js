// Tests: AD groups given by name are resolved only via sAMAccountName and only among security groups
// (ldapts Client mocked – no directory needed)
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'ldapts';

const ldap = await import('../src/auth/ldap.js');

const SEC = -2147483646; // global security group
const DIST = 2; // global distribution group

/** Tiny fake directory: evaluates the equality terms of the group filter the code sends. */
function fakeDirectory(groups) {
  const filters = [];
  mock.method(Client.prototype, 'bind', async () => {});
  mock.method(Client.prototype, 'unbind', async () => {});
  mock.method(Client.prototype, 'search', async (base, opts) => {
    if (!/objectClass=group/.test(opts.filter)) {
      if (base === '') return { searchEntries: [{ defaultNamingContext: 'DC=firma,DC=local' }] };
      return { searchEntries: [] };
    }
    filters.push(opts.filter);
    const needsSecurity = /\(groupType:1\.2\.840\.113556\.1\.4\.803:=2147483648\)/.test(opts.filter);
    const hits = groups.filter((g) => {
      if (needsSecurity && !((g.groupType >>> 0) & 0x80000000)) return false;
      return ['cn', 'sAMAccountName', 'name', 'displayName'].some((a) => g[a] && opts.filter.includes(`(${a}=${g[a]})`));
    });
    return { searchEntries: hits.map((g) => ({ dn: g.dn })) };
  });
  return filters;
}

const cfg = (adminGroup, extra = {}) => ({
  host: 'dc01.firma.local', port: 389, security: 'none', timeoutMs: 2000,
  baseDn: 'CN=Users,DC=firma,DC=local', bindDn: 'CN=svc-helfi,CN=Users,DC=firma,DC=local', bindPassword: 'x',
  adminGroup, userGroup: '', projectGroups: [], ...extra,
});
const groupStep = (r, role = 'admin') => r.steps.find((s) => s.key === 'group' && s.role === role);

afterEach(() => mock.restoreAll());

test('Group name filter matches sAMAccountName only and requires the security-group bit', async () => {
  const filters = fakeDirectory([]);
  await ldap.testConnection(cfg('Helfi-Admins', { userGroup: 'Helfi-Benutzer', projectGroups: [{ id: 1, key: 'IT', group: 'Helpdesk' }] }));
  assert.equal(filters.length, 3, 'admin, allowed-users and project group all use the same lookup');
  for (const f of filters) {
    assert.match(f, /\(sAMAccountName=[^)]+\)/);
    assert.match(f, /\(groupType:1\.2\.840\.113556\.1\.4\.803:=2147483648\)/);
    assert.doesNotMatch(f, /displayName=|\(cn=|\(name=/);
  }
  assert.equal(filters[0], '(&(objectClass=group)(groupType:1.2.840.113556.1.4.803:=2147483648)(sAMAccountName=Helfi-Admins))');
});

test('A group matching only by displayName or cn is not accepted', async () => {
  // The real admin group is missing: a self-service group renamed to "Helfi-Admins" must not become the match
  for (const g of [
    { dn: 'CN=Selfservice,OU=Verteiler,DC=firma,DC=local', cn: 'Selfservice', sAMAccountName: 'Selfservice', displayName: 'Helfi-Admins', groupType: SEC },
    { dn: 'CN=Helfi-Admins,OU=Spass,DC=firma,DC=local', cn: 'Helfi-Admins', name: 'Helfi-Admins', sAMAccountName: 'helfi-admins-x', groupType: SEC },
  ]) {
    fakeDirectory([g]);
    const st = groupStep(await ldap.testConnection(cfg('Helfi-Admins')));
    assert.equal(st.ok, false, JSON.stringify(st));
    assert.equal(st.dn, '');
    mock.restoreAll();
  }
});

test('A distribution group with the right sAMAccountName is not accepted; the security group is', async () => {
  fakeDirectory([
    { dn: 'CN=Helfi-Admins,OU=Verteiler,DC=firma,DC=local', cn: 'Helfi-Admins', sAMAccountName: 'Verteiler-Admins', displayName: 'Helfi-Admins', groupType: DIST },
    { dn: 'CN=Verteiler-Admins,OU=Verteiler,DC=firma,DC=local', cn: 'Verteiler-Admins', sAMAccountName: 'Verteiler-Admins', groupType: DIST },
    { dn: 'CN=Helfi Admins,OU=Gruppen,DC=firma,DC=local', cn: 'Helfi Admins', sAMAccountName: 'Helfi-Admins', groupType: SEC },
  ]);
  const ok = groupStep(await ldap.testConnection(cfg('Helfi-Admins')));
  assert.equal(ok.dn, 'CN=Helfi Admins,OU=Gruppen,DC=firma,DC=local', 'unambiguous security group by sAMAccountName');
  const dist = groupStep(await ldap.testConnection(cfg('Verteiler-Admins')));
  assert.equal(dist.ok, false, 'distribution group is never a match');
});

test('Full DN is used unchanged without a group search; name values are filter-escaped', async () => {
  const filters = fakeDirectory([]);
  const dn = 'CN=Helfi-Admins,OU=Gruppen,DC=firma,DC=local';
  assert.equal(groupStep(await ldap.testConnection(cfg(dn))).dn, dn);
  assert.equal(filters.length, 0);
  assert.equal(ldap.groupNameFilter(' a*b(c) '), '(&(objectClass=group)(groupType:1.2.840.113556.1.4.803:=2147483648)(sAMAccountName=a\\2ab\\28c\\29))');
});
