// Einzeltests ohne Server: Kryptografie, E-Mail-Auswertung, LDAP-Hilfen, Übersetzungen
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, encrypt, decrypt, setMasterKeyForTests } from '../src/lib/crypto.js';
import { ticketKeyFromSubject, cleanSubject, stripQuotedReply, isAutomated, isEmail } from '../src/mail/parse.js';
import { escapeFilter, normalizeUsername, domainFromBaseDn, mergePem, splitPem, dnsDomain } from '../src/auth/ldap.js';
import { claimsToUser } from '../src/auth/oidc.js';
import { roleFromGroups } from '../src/users.js';
import { normalizeLabels } from '../src/tickets.js';
import { redact } from '../src/lib/log.js';
import { _dicts as serverDicts, langFromHeader, t } from '../src/i18n.js';

setMasterKeyForTests(crypto.randomBytes(32));
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Kennwort-Hash', () => {
  const h = hashPassword('richtig-1234');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('richtig-1234', h), true);
  assert.equal(verifyPassword('falsch-1234', h), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.notEqual(hashPassword('a'), hashPassword('a'), 'Salz');
});

test('Geheimnisse verschlüsseln', () => {
  const c = encrypt('Dienst!Pass');
  assert.ok(c.startsWith('v1:'));
  assert.ok(!c.includes('Dienst'));
  assert.equal(decrypt(c), 'Dienst!Pass');
  assert.equal(encrypt(''), '');
  const tampered = c.slice(0, -4) + (c.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => decrypt(tampered));
});

test('Protokoll schwärzt Kennwörter', () => {
  assert.deepEqual(redact({ user: 'a', password: 'x', nested: { clientSecret: 'y', token: 'z' } }), { user: 'a', password: '***', nested: { clientSecret: '***', token: '***' } });
});

test('Ticketnummer im Betreff', () => {
  assert.deepEqual(ticketKeyFromSubject('AW: [IT-42] Drucker'), { projectKey: 'IT', number: 42 });
  assert.deepEqual(ticketKeyFromSubject('Re: [hs-7] x'), { projectKey: 'HS', number: 7 });
  assert.equal(ticketKeyFromSubject('IT-42 ohne Klammern'), null);
  assert.equal(cleanSubject('AW: WG: Re: [IT-42] Drucker kaputt'), 'Drucker kaputt');
  assert.equal(cleanSubject('Fwd: AW[2]: Test'), 'Test');
});

test('Zitierten Verlauf abschneiden (Outlook, Gmail, Thunderbird)', () => {
  assert.equal(stripQuotedReply('Danke!\n\nAm 31.10.2026 um 10:00 schrieb Helfi <h@x>:\n> alt'), 'Danke!');
  assert.equal(stripQuotedReply('Thanks\n\nOn Sat, Oct 31, 2026 at 10:00 AM Helfi <h@x> wrote:\n> old'), 'Thanks');
  assert.equal(stripQuotedReply('Geht wieder.\n\nVon: Helfi.Space <h@x>\nGesendet: Samstag\nAn: ich\nBetreff: x\n\nalt'), 'Geht wieder.');
  assert.equal(stripQuotedReply('Ok\n-----Ursprüngliche Nachricht-----\nalt'), 'Ok');
  assert.equal(stripQuotedReply('Ok\n________________________________\nFrom: x\nSent: y'), 'Ok');
  assert.equal(stripQuotedReply('Von: Abteilung Einkauf brauchen wir X'), 'Von: Abteilung Einkauf brauchen wir X', '„Von:“ im Text ist kein Zitat');
  assert.equal(stripQuotedReply('> nur Zitat'), '> nur Zitat', 'nie leer');
});

test('Automatische Mails erkennen', () => {
  const H = (o) => new Map(Object.entries(o));
  assert.equal(isAutomated(H({ 'auto-submitted': 'auto-replied' }), 'a@b.de'), true);
  assert.equal(isAutomated(H({ 'auto-submitted': 'no' }), 'a@b.de'), false);
  assert.equal(isAutomated(H({ precedence: 'bulk' }), 'a@b.de'), true);
  assert.equal(isAutomated(H({}), 'MAILER-DAEMON@x.de'), true);
  assert.equal(isAutomated(H({}), 'noreply@x.de'), true);
  assert.equal(isAutomated(H({}), 'paula@x.de'), false);
  assert.equal(isEmail('a@b.de'), true);
  assert.equal(isEmail('a b@c'), false);
});

test('LDAP-Hilfen', () => {
  assert.equal(escapeFilter('a*b(c)\\d\0'), 'a\\2ab\\28c\\29\\5cd\\00');
  assert.equal(normalizeUsername('FIRMA\\m.muster'), 'm.muster');
  assert.equal(normalizeUsername('m.muster@firma.local'), 'm.muster');
  assert.equal(domainFromBaseDn('DC=firma,DC=local'), 'firma.local');
  assert.equal(domainFromBaseDn('OU=x,dc=a,dc=b,dc=c'), 'a.b.c');
  assert.equal(dnsDomain({ baseDn: '', host: 'dc01.firma.local' }), 'firma.local');
  assert.equal(dnsDomain({ baseDn: '', host: '10.0.10.5' }), '');
});

test('PEM zusammenführen ohne Doppelte', () => {
  const pem = fs.readFileSync(path.join(root, 'test/fixtures/test-ca.pem'), 'utf8');
  assert.equal(splitPem(pem).length, 1);
  const merged = mergePem(pem, pem + '\nmüll\n');
  assert.equal(splitPem(merged).length, 1);
  assert.equal(mergePem('', 'kein pem'), '');
});

test('Rollen aus Gruppen', () => {
  assert.equal(roleFromGroups({ admin: true, agent: true }, { adminGroup: 'A', agentGroup: 'B' }), 'admin');
  assert.equal(roleFromGroups({ admin: false, agent: true }, { adminGroup: 'A', agentGroup: 'B' }), 'agent');
  assert.equal(roleFromGroups({ admin: false, agent: false }, { adminGroup: 'A', agentGroup: '' }), 'user');
  assert.equal(roleFromGroups({ admin: true }, { adminGroup: '', agentGroup: '' }), null, 'ohne Gruppen: Rolle bleibt');
});

test('SSO-Claims', () => {
  const cfg = { usernameClaim: 'preferred_username', groupsClaim: 'groups', adminGroup: 'helfi-admins, andere', agentGroup: '', mergeDomain: 'firma.local' };
  const u = claimsToUser({ iss: 'https://idp', sub: '123', preferred_username: 'J.Doe@firma.local', name: 'J Doe', groups: ['Helfi-Admins'] }, cfg);
  assert.equal(u.username, 'J.Doe');
  assert.equal(u.trustName, true);
  assert.equal(u.email, 'J.Doe@firma.local');
  assert.deepEqual(u.groups, { admin: true, agent: false });
  assert.equal(u.externalId, 'https://idp|123');
  assert.equal(u.trustEmail, true, 'Adresse der freigegebenen Domäne');
  assert.equal(claimsToUser({ sub: '9', preferred_username: 'x@firma.local', email: 'x@gmail.example' }, cfg).trustEmail, false, 'fremde, unbestätigte Adresse');
});

test('SSO: fremde Domäne wird nie auf AD-Konten abgebildet (Regression)', () => {
  const base = { usernameClaim: 'preferred_username', groupsClaim: 'groups', adminGroup: '', agentGroup: '' };
  const guest = claimsToUser({ sub: '1', preferred_username: 'admin@fremd.example' }, { ...base, mergeDomain: 'firma.local' });
  assert.equal(guest.username, 'oidc:admin@fremd.example');
  assert.equal(guest.trustName, false);
  const noMerge = claimsToUser({ sub: '2', preferred_username: 'm.muster@firma.local', email_verified: true }, { ...base, mergeDomain: '' });
  assert.equal(noMerge.username, 'oidc:m.muster@firma.local');
  assert.equal(noMerge.trustName, false);
  assert.equal(noMerge.trustEmail, true);
  // Audit: Namen ohne "@" sind nie vertrauenswürdig (bei manchen Anbietern frei wählbar)
  const bare = claimsToUser({ sub: '3', preferred_username: 'chef' }, { ...base, mergeDomain: 'firma.local' });
  assert.equal(bare.username, 'oidc:chef');
  assert.equal(bare.trustName, false);
});

test('Stichwörter normalisieren', () => {
  assert.equal(normalizeLabels('VPN, netzwerk  vpn;<b>'), 'vpn,netzwerk,b');
  assert.equal(normalizeLabels(['Ä-Test', '']), 'ä-test');
});

test('Übersetzungen: Server Deutsch/Englisch vollständig', () => {
  const de = Object.keys(serverDicts.de).sort();
  const en = Object.keys(serverDicts.en).sort();
  assert.deepEqual(en, de);
  assert.equal(langFromHeader('en-US,en;q=0.9,de;q=0.8'), 'en');
  assert.equal(langFromHeader('fr-FR,de;q=0.5'), 'de');
  assert.equal(t('en', 'mail.created.subject', { key: 'IT-1', title: 'X' }), '[IT-1] Your ticket has been created: X');
});

test('Übersetzungen: Oberfläche Deutsch/Englisch vollständig und alle benutzten Schlüssel vorhanden', async () => {
  // public/js/i18n.js ist ein Browser-Modul ohne Abhängigkeiten – direkt importierbar
  const { _dicts } = await import('../public/js/i18n.js');
  assert.deepEqual(Object.keys(_dicts.en).sort(), Object.keys(_dicts.de).sort());
  const used = new Set();
  const dir = path.join(root, 'public/js');
  const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, 'views')).map((f) => path.join(dir, 'views', f))];
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\('([a-zA-Z]+\.[\w.]+)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in _dicts.de));
  assert.deepEqual(missing, []);
});

test('Anmeldebremse zählt Schreibweisen eines Namens zusammen und begrenzt je IP (Regression)', async () => {
  const { createLoginLimiter } = await import('../src/auth/session.js');
  const l = createLoginLimiter({ max: 3, ipMax: 5 });
  l.fail('1.1.1.1', 'bob'); l.fail('1.1.1.1', 'FIRMA\\bob'); l.fail('1.1.1.1', 'BOB@firma.local');
  assert.throws(() => l.check('1.1.1.1', 'bob'), /err\.tooManyAttempts/);
  assert.throws(() => l.check('2.2.2.2', 'firma\\Bob'), /err\.tooManyAttempts/, 'auch von anderer IP');
  l.fail('9.9.9.9', 'a'); l.fail('9.9.9.9', 'b'); l.fail('9.9.9.9', 'c'); l.fail('9.9.9.9', 'd'); l.fail('9.9.9.9', 'e');
  assert.throws(() => l.check('9.9.9.9', 'neu'), /err\.tooManyAttempts/, 'IP-Grenze');
  assert.doesNotThrow(() => l.check('8.8.8.8', 'neu'));
});

test('Benachrichtigungen: nie für interne Notizen oder Kommentare aus E-Mails (Regression)', async () => {
  const { EventEmitter } = await import('node:events');
  const { wireNotifications } = await import('../src/mail/smtp.js');
  const sent = [];
  const events = new EventEmitter();
  const settings = { get: (k) => (k === 'general.defaultLanguage' ? 'de' : (k === 'general.title' ? 'Helfi.Space' : true)) };
  const tickets = { events, rawById: (id) => (id === 1 ? { id } : undefined) };
  const users = { byId: () => ({ language: 'de' }) };
  const mailer = { enabled: () => true, send: async (m) => { sent.push(m); } };
  wireNotifications({ tickets, mailer, settings, users });
  const ticket = { id: 1, key: 'IT-1', title: 'X', reporter: { id: 5, email: 'p@x.de', displayName: 'P' } };
  const agent = { id: 2, role: 'agent', display_name: 'A' };
  events.emit('commented', { ticket, comment: { body: 'geheim', source: 'web' }, user: agent, internal: true });
  events.emit('commented', { ticket, comment: { body: 'gefälscht', source: 'email' }, user: agent, internal: false });
  events.emit('commented', { ticket: { ...ticket, id: 99 }, comment: { body: 'weg', source: 'web' }, user: agent, internal: false });
  events.emit('commented', { ticket, comment: { body: 'ok', source: 'web' }, user: agent, internal: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /ok/);
});
