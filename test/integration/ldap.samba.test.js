// Integrationstest gegen ein echtes Samba-AD (nur wenn HELFI_TEST_LDAP_HOST gesetzt ist).
//   HELFI_TEST_LDAP_HOST=dc01.firma.local HELFI_TEST_LDAP_BINDPW=... node --test test/integration/
// Erwartet die Benutzer/Gruppen aus scripts/test-samba-ad.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ldap from '../../src/auth/ldap.js';

const host = process.env.HELFI_TEST_LDAP_HOST;
const skip = !host && 'HELFI_TEST_LDAP_HOST nicht gesetzt';

const base = {
  host, port: 636, security: 'ldaps', tlsMode: 'pinned', verifyHostname: true, caPem: '',
  baseDn: 'DC=firma,DC=local', bindDn: 'svc-helfi@firma.local', bindPassword: process.env.HELFI_TEST_LDAP_BINDPW || 'Dienst!Pass2026',
  userFilter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={{username}}))',
  usernameAttr: 'sAMAccountName', displayNameAttr: 'displayName', emailAttr: 'mail',
  nestedGroups: true, adminGroup: 'Helfi-Admins', agentGroup: 'Helfi-Bearbeiter', userGroup: '', timeoutMs: 8000,
};

test('LDAPS: Zertifikat abrufen und damit vertrauen', { skip }, async () => {
  const r = await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' });
  assert.ok(r.chain.length >= 1);
  assert.match(r.chain[0].fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  base.caPem = r.pem;
  const res = await ldap.testConnection({ ...base });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.equal(res.rootDse.defaultNamingContext.toLowerCase(), 'dc=firma,dc=local');
});

test('StartTLS: Zertifikat abrufen', { skip }, async () => {
  const r = await ldap.fetchCertificateChain({ host, port: 389, security: 'starttls' });
  assert.ok(r.chain.length >= 1);
  const res = await ldap.testConnection({ ...base, port: 389, security: 'starttls', caPem: r.pem });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
});

test('LDAPS: fremdes Zertifikat wird abgelehnt', { skip }, async () => {
  // Echtes, aber fremdes Zertifikat erzeugen (openssl)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=dc01.firma.local', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const other = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  const res = await ldap.testConnection({ ...base, caPem: other });
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((st) => st.key === 'bind'), undefined, 'darf nicht bis zur Anmeldung kommen');
});

test('Anmeldung, Rollen aus (verschachtelten) Gruppen', { skip }, async () => {
  const cfg = { ...base };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;

  const max = await ldap.authenticate(cfg, 'FIRMA\\m.muster', 'Muster!Pass2026');
  assert.equal(max.username, 'm.muster');
  assert.equal(max.email, 'm.muster@firma.local');
  assert.deepEqual(max.groups, { admin: false, agent: true, user: true });

  const erika = await ldap.authenticate(cfg, 'e.beispiel@firma.local', 'Beispiel!Pass2026');
  assert.equal(erika.groups.admin, true, 'verschachtelte Gruppe IT-Team → Helfi-Admins');

  const flat = await ldap.authenticate({ ...cfg, nestedGroups: false }, 'e.beispiel', 'Beispiel!Pass2026');
  assert.equal(flat.groups.admin, false, 'ohne Verschachtelung kein Admin');

  assert.equal(await ldap.authenticate(cfg, 'm.muster', 'falsch'), null);
  assert.equal(await ldap.authenticate(cfg, 'm.muster', ''), null, 'leeres Kennwort = nie anonym');
  assert.equal(await ldap.authenticate(cfg, 'gibtsnicht', 'x'), null);
  assert.equal(await ldap.authenticate(cfg, 'm.muster)(|(sAMAccountName=*', 'x'), null, 'Filter-Injection');
});

test('Ohne Dienstkonto: Suche als anmeldender Benutzer', { skip }, async () => {
  const cfg = { ...base, bindDn: '', bindPassword: '' };
  cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;
  const u = await ldap.authenticate(cfg, 'k.kunde', 'Kunde!Pass2026');
  assert.equal(u.username, 'k.kunde');
  assert.deepEqual(u.groups, { admin: false, agent: false, user: true });
  assert.equal(await ldap.authenticate(cfg, 'k.kunde', 'falsch'), null);
});

test('Hostname-Prüfung: per IP ohne Namen im Zertifikat schlägt fehl, abschaltbar', { skip }, async () => {
  const pem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;
  const strict = await ldap.testConnection({ ...base, host: '127.0.0.1', caPem: pem, verifyHostname: true });
  assert.equal(strict.ok, false);
  const relaxed = await ldap.testConnection({ ...base, host: '127.0.0.1', caPem: pem, verifyHostname: false });
  assert.equal(relaxed.ok, true, JSON.stringify(relaxed.steps));
});

test('Absender per E-Mail finden: Hauptadresse, UPN, Zweitadresse, nicht deaktiviert, nicht mehrdeutig', { skip }, async () => {
  const cfg = { ...base };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;

  // Testvorbereitung als Domänen-Admin: Zweitadresse für Erika
  const { Change, Attribute } = await import('ldapts');
  const adm = await ldap.connect(cfg);
  try {
    await adm.bind('Administrator@firma.local', 'Passw0rd!2026');
    await adm.modify('CN=Erika Beispiel,CN=Users,DC=firma,DC=local', [
      new Change({ operation: 'replace', modification: new Attribute({ type: 'proxyAddresses', values: ['SMTP:e.beispiel@firma.local', 'smtp:erika.alt@firma.de'] }) }),
    ]);
  } finally { await adm.unbind().catch(() => {}); }

  const max = await ldap.findByEmail(cfg, 'M.Muster@firma.local');
  assert.equal(max.username, 'm.muster');
  assert.equal(max.groups.agent, true);
  assert.ok(max.externalId);

  const upn = await ldap.findByEmail(cfg, 'k.kunde@firma.local');
  assert.equal(upn.username, 'k.kunde');

  const alias = await ldap.findByEmail(cfg, 'erika.alt@firma.de');
  assert.equal(alias.username, 'e.beispiel');
  assert.equal(alias.email, 'e.beispiel@firma.local');
  assert.equal(alias.groups.admin, true, 'verschachtelte Gruppe auch bei der Absender-Suche');

  assert.equal(await ldap.findByEmail(cfg, 'd.alt@firma.local'), null, 'deaktiviertes Konto');
  assert.equal(await ldap.findByEmail(cfg, 'niemand@firma.local'), null);
  assert.equal(await ldap.findByEmail(cfg, '*@firma.local'), null, 'Platzhalter wird maskiert');
  await assert.rejects(ldap.findByEmail({ ...cfg, bindDn: '' }, 'm.muster@firma.local'), /Dienstkonto/);
});

test('Personen suchen (Teilnehmer aus dem AD) und per objectGUID holen', { skip }, async () => {
  const cfg = { ...base };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;

  const byName = await ldap.searchPeople(cfg, 'Muster');
  assert.deepEqual(byName.map((p) => p.username), ['m.muster']);
  assert.equal(byName[0].email, 'm.muster@firma.local');
  assert.match(byName[0].externalId, /^[0-9a-f]{32}$/);

  assert.deepEqual((await ldap.searchPeople(cfg, 'max mus')).map((p) => p.username), ['m.muster'], 'mehrere Wortteile');
  assert.deepEqual((await ldap.searchPeople(cfg, 'k.kunde@firma')).map((p) => p.username), ['k.kunde'], 'Teil der Mailadresse');
  assert.deepEqual((await ldap.searchPeople(cfg, 'erika.alt@firma.de')).map((p) => p.username), ['e.beispiel'], 'Zweitadresse');
  assert.deepEqual(await ldap.searchPeople(cfg, 'Dora'), [], 'deaktiviertes Konto nicht');
  assert.deepEqual(await ldap.searchPeople(cfg, '*'), [], 'Platzhalter wird maskiert');
  assert.ok((await ldap.searchPeople(cfg, 'firma.local', { limit: 2 })).length <= 2, 'Begrenzung');

  // GUID aus der Suche muss dieselbe Person liefern wie die Anmeldung (externalId)
  const got = await ldap.findByGuid(cfg, byName[0].externalId);
  assert.equal(got.username, 'm.muster');
  assert.equal(got.groups.agent, true);
  const login = await ldap.authenticate(cfg, 'm.muster', 'Muster!Pass2026');
  assert.equal(login.externalId, byName[0].externalId, 'gleiche Kennung wie bei der Anmeldung');
  assert.equal(await ldap.findByGuid(cfg, '00'.repeat(16)), null);
  assert.equal(await ldap.findByGuid(cfg, 'kein-guid'), null);
  await assert.rejects(ldap.searchPeople({ ...cfg, bindDn: '' }, 'Muster'), /Dienstkonto/);
});

test('Ohne Dienstkonto: Anmeldung prüft das Kennwort am gefundenen Konto', { skip }, async () => {
  // Die eigentliche Kollision (UPN eines Kontos = sAMAccountName@Domäne eines anderen) lässt Samba gar nicht
  // erst zu („implied by userPrincipalName“); hier wird der Weg über den zweiten Bind auf den DN geprüft.
  const cfg = { ...base, bindDn: '', bindPassword: '' };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;
  const ok = await ldap.authenticate(cfg, 'k.kunde', 'Kunde!Pass2026');
  assert.equal(ok?.username, 'k.kunde');
  assert.match(ok.sid, /^S-1-5-21-\d+-\d+-\d+-\d+$/, 'objectSid wird mitgeliefert');
  assert.match(ok.externalId, /^[0-9a-f]{32}$/, 'objectGUID als Hex');
  assert.equal(await ldap.authenticate(cfg, 'k.kunde', 'falsch'), null);
  assert.equal(await ldap.authenticate(cfg, 'm.muster', 'Kunde!Pass2026'), null, 'fremdes Kennwort');
});

test('objectSid: Konto über die SID finden (SSO-Zusammenführung)', { skip }, async () => {
  const cfg = { ...base };
  if (!cfg.caPem) cfg.caPem = (await ldap.fetchCertificateChain({ host, port: 636, security: 'ldaps' })).pem;
  const max = await ldap.findByEmail(cfg, 'm.muster@firma.local');
  assert.match(max.sid, /^S-1-5-21-/);
  const bySid = await ldap.findBySid(cfg, max.sid);
  assert.equal(bySid.username, 'm.muster');
  assert.equal(bySid.externalId, max.externalId);
  assert.equal(await ldap.findBySid(cfg, 'S-1-5-21-1-2-3-999999'), null);
});
