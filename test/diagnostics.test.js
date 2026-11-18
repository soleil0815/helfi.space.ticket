// Diagnosis package (src/diagnostics.js): complete (every setting, registered sections, log) and
// anonymous (no secrets, names, addresses, host names, ticket contents) – also for settings added later:
// every free-text setting is filled with a marker that must not appear in the package.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { startServer } from './helpers/server.js';

let S; let D; let L; let C; let P; let agent; let ticket; let agentStatus;
before(async () => {
  S = await startServer('diagnostics');
  // Accounts and a ticket first: afterwards every free-text setting holds a marker (sign-in would no longer work)
  agent = await S.user('ulli', 'agent');
  await S.user('erika.muster', 'agent');
  S.db.prepare("UPDATE users SET display_name='Erika Musterfrau', email='erika@beispiel-gmbh.de' WHERE username='erika.muster'").run();
  agentStatus = (await agent('GET', '/api/admin/diagnostics')).status;
  ticket = await S.admin('POST', '/api/tickets', { title: 'Geheimprojekt Sonnenblume Drucker', description: 'Vertraulicher Inhalt Kassenbuch' });
  D = await import('../src/diagnostics.js');
  L = await import('../src/lib/log.js');
  C = await import('../src/cli.js');
  ({ paths: P } = await import('../src/config.js'));
  L.setLogFile(P.logFile);
});
after(() => { L.setLogFile(null); S.stop(); });

const SECRETS = {
  'ldap.bindPassword': 'Pw-GEHEIM-ldap-4711',
  'smtp.password': 'Pw-GEHEIM-smtp-4712',
  'imap.password': 'Pw-GEHEIM-imap-4713',
  'oidc.clientSecret': 'Pw-GEHEIM-oidc-4714',
  'ai.apiKey': 'sk-GEHEIM-4715',
};

async function fillEverything() {
  const { DEFAULTS, SECRET_KEYS } = await import('../src/settings.js');
  const markers = {};
  let i = 0;
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (typeof def !== 'string' || SECRET_KEYS.has(key) || key === 'sla.hours' || key === 'sla.targets') continue;
    // Free text that could identify the organisation (unknown to the package by design)
    const v = `Zzmark${++i}Wert`;
    markers[key] = v;
    S.db.prepare('INSERT INTO settings(key,value,secret) VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(v));
  }
  for (const [k, v] of Object.entries(SECRETS)) S.ctx.settings.set(k, v);
  return markers;
}

test('Anonymizer: placeholders per kind, consistent within one package; code, files and versions stay', () => {
  const a = new D.Anonymizer();
  a.add('Erika Musterfrau', 'person');
  a.add('erika.muster', 'person');
  const text = a.text([
    'Login erika.muster from 198.51.100.23 and 10.0.10.25 and 127.0.0.1 (::ffff:10.0.10.7, 2001:db8::42)',
    'Erika Musterfrau <erika@beispiel-gmbh.de> again 198.51.100.23 at https://dc01.firma.local:636/x',
    'Bind CN=svc-helfi,OU=Dienste,DC=firma,DC=local failed; getaddrinfo ENOTFOUND mail.beispiel-gmbh.de',
    'in src/auth/passkeys.js ctx.poller v1.48.0 Node v24.1.0 at 12:34:56 erika.musterhaus stays',
  ].join('\n'));
  for (const bad of ['erika.muster ', 'Erika', 'Musterfrau', '198.51.100.23', '10.0.10.25', '10.0.10.7', '2001:db8::42', 'beispiel-gmbh', 'dc01.firma', 'svc-helfi', 'DC=firma']) {
    assert.ok(!text.includes(bad), `${bad} in ${text}`);
  }
  const m = /Login (<person-\d+>) from (<ip-\d+ public>) and <ip-\d+ private> and <ip-\d+ loopback> \(<ip-\d+ private>, <ip-\d+ public>\)/.exec(text);
  assert.ok(m, text);
  assert.ok(text.includes(`<<mail-1>> again ${m[2]} at https://<host-1>:636/x`), 'same address → same placeholder');
  assert.ok(!text.split('\n')[1].includes(m[1]), 'user name and display name are different people placeholders');
  assert.match(text, /Bind <dn-1> failed; getaddrinfo ENOTFOUND <host-2>/);
  assert.match(text, /src\/auth\/passkeys\.js ctx\.poller v1\.48\.0 Node v24\.1\.0 at 12:34:56 erika\.musterhaus stays/, 'only whole names are replaced');
  // A new instance numbers anew
  // A bare scheme in a sentence is no host (from an .env comment: "… starts with https://)")
  assert.equal(new D.Anonymizer().text('default: on if HELFI_BASE_URL starts with https://)'), 'default: on if HELFI_BASE_URL starts with https://)');
  const b = new D.Anonymizer();
  assert.equal(b.text('198.51.100.99'), '<ip-1 public>');
});

test('Settings: switches, numbers and choices visible; free text only "set"; secrets only whether set', () => {
  assert.equal(D.describeSetting('passkeys.enabled', true), 'on');
  assert.equal(D.describeSetting('ldap.port', 636), '636');
  assert.equal(D.describeSetting('mfa.mode', 'always'), 'always');
  assert.equal(D.describeSetting('mfa.mode', 'irgendwas'), 'set');
  assert.equal(D.describeSetting('ldap.host', ''), 'empty (default)');
  assert.equal(D.describeSetting('ldap.host', 'dc01.firma.local'), 'set');
  assert.equal(D.describeSetting('imap.folder', 'INBOX'), 'default (INBOX)');
  assert.equal(D.describeSetting('ldap.bindPassword', 'x'), 'secret, set');
  assert.equal(D.describeSetting('register.domains', 'firma.local\nfirma.de'), 'set (2 lines)');
  assert.equal(D.describeSetting('mfa.internalNetworks', '10.0.10.0/24, 192.168.0.0/16'), 'set (2 entries)');
  assert.equal(D.describeSetting('ldap.bindDn', 'CN=Dienst Helfi,OU=Dienste,DC=firma,DC=local'), 'set');
  assert.equal(D.describeSetting('ldap.baseDn', 'DC=firma,DC=local'), 'set');
  assert.equal(D.describeSetting('ldap.caPem', '-----BEGIN CERTIFICATE-----\nAAA\nBBB\n-----END CERTIFICATE-----'), 'set (PEM, 1 certificate)');
  assert.equal(D.describeSetting('login.textDe', 'Willkommen, bitte anmelden'), 'set');
  assert.equal(D.describeSetting('imap.senderRules', '[{"pattern":"a@b.de"},{"pattern":"c"}]'), 'set (JSON, 2 entries)');
  assert.equal(D.describeSetting('reminder.time', '07:30'), '07:30');
});

test('Package: every setting and section, nothing identifying – also for settings added later', async () => {
  const markers = await fillEverything();
  // People, a ticket with a telling subject (see before()) and a log with everything that must not leak
  assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
  L.log.warn('Sign-in of erika.muster (Erika Musterfrau, erika@beispiel-gmbh.de) failed from 198.51.100.23 via https://dc01.firma-geheim.local:636 CN=Erika Musterfrau,OU=Benutzer,DC=firma,DC=local');
  L.log.error('IMAP: Zzmark3Wert rejected the login', { password: 'Pw-im-Log', host: 'mail.beispiel-gmbh.de' });

  const r = await S.admin('GET', '/api/admin/diagnostics');
  assert.equal(r.status, 200);
  const text = r.body.text;
  const forbidden = [...Object.values(markers), ...Object.values(SECRETS), 'Pw-im-Log', 'erika', 'Erika', 'Musterfrau', 'beispiel-gmbh', 'firma-geheim',
    '198.51.100.23', 'Geheimprojekt', 'Sonnenblume', 'Kassenbuch', 'Vertraulicher', 'OU=Benutzer'];
  for (const bad of forbidden) assert.ok(!text.includes(bad), `"${bad}" must not appear in the package: …${text.slice(Math.max(0, text.indexOf(bad) - 200), text.indexOf(bad) + 60)}`);

  // Complete: every setting, the sections, the log (anonymized)
  const { DEFAULTS } = await import('../src/settings.js');
  for (const key of Object.keys(DEFAULTS)) assert.ok(text.includes(`| ${key} |`), `setting ${key} missing`);
  for (const h of ['## System', '## Environment variables', '## Database', '## Settings', '## Services', '## Admin warnings', '## Error overview', '## Log of this run']) {
    assert.ok(text.includes(h), `${h} missing`);
  }
  assert.match(text, /\| ldap\.bindPassword \| secret, set \|/);
  assert.match(text, /\| passkeys\.enabled \| on \|/);
  assert.match(text, /Sign-in of <person-\d+> \(<person-\d+>, <mail-\d+>\) failed from <ip-\d+ public> via https:\/\/<host-\d+>:636 <dn-\d+>/);
  assert.match(text, /"password":"\*\*\*"/, 'secrets in log details are masked already when logging');
  assert.match(text, /\| Tickets by status \| \{"open":1\} \|/);
  assert.match(text, /\| Schema \(program \/ database\) \| (\d+) \/ \1 \|/);
  assert.match(text, /\| Integrity check \| ok \|/);

  // Saved warnings/errors in the data folder (survive a restart)
  assert.match(fs.readFileSync(P.logFile, 'utf8'), /IMAP: Zzmark3Wert rejected the login/);
  assert.match(text, /## Warnings and errors \(saved, last 500\)[\s\S]*IMAP: <setting-\d+> rejected the login/);
});

test('Own sections via register() are anonymized too', async () => {
  S.ctx.diagnostics.register('Test section', () => ({ host: 'srv9.beispiel-gmbh.de', count: 3, apiToken: 'abc' }));
  const text = (await S.admin('GET', '/api/admin/diagnostics')).body.text;
  assert.match(text, /## Test section[\s\S]*\| host \| <host-\d+> \|[\s\S]*\| count \| 3 \|[\s\S]*\| apiToken \| \[hidden\] \|/);
  S.ctx.diagnostics.register('Broken section', () => { throw new Error('boom at 198.51.100.77'); });
  const t2 = (await S.admin('GET', '/api/admin/diagnostics')).body.text;
  assert.match(t2, /## Broken section[\s\S]*\| error \| boom at <ip-\d+ public> \|/, 'a failing section does not break the package');
});

test('Download as file; admins only', async () => {
  const r = await S.admin.raw('/api/admin/diagnostics?download=1');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="helfi-diagnose-\d{4}-\d{2}-\d{2}\.md"/);
  assert.match(r.headers.get('content-type'), /text\/markdown/);
  assert.match(r.bytes.toString('utf8'), /^# Helfi\.Space – diagnosis package/);
  assert.equal(agentStatus, 403);
});

test('Log file: at most 2 × 1 MB', () => {
  const big = 'x'.repeat(200 * 1024);
  for (let i = 0; i < 12; i++) L.log.warn(`big ${i} ${big}`);
  const a = fs.statSync(P.logFile).size; const b = fs.statSync(`${P.logFile}.1`).size;
  assert.ok(a <= L.LOG_FILE_MAX && b <= L.LOG_FILE_MAX, `${a} ${b}`);
});

test('Command line: helfi-admin diagnose prints the package', async () => {
  let out = '';
  const code = await C.main(['diagnose'], { stdin: Readable.from([]), stdout: new Writable({ write(c, _e, cb) { out += String(c); cb(); } }), stderr: new Writable({ write(_c, _e, cb) { cb(); } }) }, { dbFile: P.db });
  assert.equal(code, 0);
  assert.match(out, /^# Helfi\.Space – diagnosis package/);
  assert.ok(!out.includes('erika'), 'anonymous there too');
});
