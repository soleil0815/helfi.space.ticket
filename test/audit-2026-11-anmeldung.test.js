// Regressionstests Audit 2026-11, Bereich Anmeldung/Rechte/Einstellungen
// (jeder Test scheitert am Stand vor der Behebung)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { spawnSync } from 'node:child_process';
import { startServer } from './helpers/server.js';

let S;
before(async () => { S = await startServer('audit-anmeldung'); });
after(async () => { await S.stop(); });

const PH = '••••••••';

/** Client mit Cookie-Dose (mehrere Cookies, z. B. helfi_mfa + helfi_sid) */
function jarClient() {
  const jar = {};
  return async (method, url, body) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(S.base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = kv.slice(i + 1);
      if (/Expires=Thu, 01 Jan 1970/i.test(sc) || v === '') delete jar[k]; else jar[k] = v;
    }
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

// Zwei unterschiedliche, selbst signierte Beispiel-Zertifikate (nur für den Vergleich, keine echten Schlüssel)
const mkCert = (cn) => {
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', '/dev/null', '-subj', `/CN=${cn}`, '-days', '1'], { encoding: 'utf8' });
  return r.stdout;
};
const CA1 = mkCert('ca.firma.local');
const CA2 = mkCert('fremd.example');

test('Geheimnis bleibt beim Server-Wechsel nicht erhalten (LDAP, SSO, IMAP, SMTP)', { skip: !CA1 && 'openssl fehlt' }, async () => {
  const { admin, ctx } = S;
  const put = (settings) => admin('PUT', '/api/admin/settings', { settings });
  assert.equal((await put({ 'ldap.host': 'dc01.firma.local', 'ldap.bindDn': 'CN=svc,DC=firma,DC=local', 'ldap.bindPassword': 'Dienst!Pass1' })).status, 200);

  // anderer Server, Platzhalter zurückgeschickt → abgelehnt, nichts gespeichert
  let r = await put({ 'ldap.host': 'fremd.example', 'ldap.bindPassword': PH });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.secretRebind');
  assert.match(r.body.error.message, /Kennwort/);
  assert.equal(ctx.settings.get('ldap.host'), 'dc01.firma.local');
  assert.equal(ctx.settings.get('ldap.bindPassword'), 'Dienst!Pass1');
  // ohne Kennwortfeld ebenso
  assert.equal((await put({ 'ldap.port': 389 })).status, 400);
  // Zertifikatsprüfung abschwächen bindet ebenfalls
  assert.equal((await put({ 'ldap.tlsMode': 'insecure', 'ldap.bindPassword': PH })).status, 400);
  assert.equal((await put({ 'ldap.verifyHostname': false, 'ldap.bindPassword': PH })).status, 400);
  // gepinntes Zertifikat → Systemzertifikate ist ebenfalls schwächer (jede öffentliche CA würde reichen)
  assert.equal((await put({ 'ldap.tlsMode': 'system', 'ldap.bindPassword': PH })).status, 400);
  // anderes hinterlegtes Zertifikat (eigene CA unterschieben) bindet ebenfalls, das erste nicht
  assert.equal((await put({ 'ldap.caPem': CA1, 'ldap.bindPassword': PH })).status, 200);
  assert.equal((await put({ 'ldap.caPem': CA1, 'ldap.bindPassword': PH })).status, 200, 'gleiches Zertifikat erneut speichern');
  assert.equal((await put({ 'ldap.caPem': CA2, 'ldap.bindPassword': PH })).status, 400);
  assert.equal(ctx.settings.get('ldap.bindPassword'), 'Dienst!Pass1');
  // gleicher Server, andere Felder: erlaubt
  assert.equal((await put({ 'ldap.bindPassword': PH, 'ldap.host': 'dc01.firma.local', 'ldap.baseDn': 'DC=firma,DC=local' })).status, 200);
  assert.equal(ctx.settings.get('ldap.bindPassword'), 'Dienst!Pass1');
  // mit neu eingegebenem Kennwort: erlaubt
  assert.equal((await put({ 'ldap.host': 'dc02.firma.local', 'ldap.tlsMode': 'insecure', 'ldap.bindPassword': 'Neu!Pass2' })).status, 200);
  assert.equal(ctx.settings.get('ldap.host'), 'dc02.firma.local');
  assert.equal(ctx.settings.get('ldap.bindPassword'), 'Neu!Pass2');
  // von insecure zurück auf system: strenger, erlaubt
  assert.equal((await put({ 'ldap.tlsMode': 'system', 'ldap.bindPassword': PH })).status, 200);

  // Verbindungstest: abgeschwächte Prüfung schickt das gespeicherte Kennwort nicht mit
  assert.equal(ctx.settings.mergedGroup('ldap', { 'ldap.tlsMode': 'insecure', 'ldap.bindPassword': PH }).bindPassword, '');
  assert.equal(ctx.settings.mergedGroup('ldap', { 'ldap.tlsMode': 'system', 'ldap.bindPassword': PH }).bindPassword, 'Neu!Pass2');

  // SSO
  assert.equal((await put({ 'oidc.issuer': 'https://idp.firma.local', 'oidc.clientId': 'helfi', 'oidc.clientSecret': 'OIDC-GEHEIM' })).status, 200);
  assert.equal((await put({ 'oidc.issuer': 'https://fremd.example' })).status, 400);
  assert.equal(ctx.settings.get('oidc.issuer'), 'https://idp.firma.local');
  assert.equal((await put({ 'oidc.buttonLabel': 'Firmenkonto', 'oidc.issuer': 'https://idp.firma.local', 'oidc.clientSecret': PH })).status, 200);

  // IMAP/SMTP
  assert.equal((await put({ 'imap.host': 'mail.firma.local', 'imap.user': 'helpdesk', 'imap.password': 'Imap!Pass' })).status, 200);
  assert.equal((await put({ 'imap.host': 'fremd.example', 'imap.password': PH })).status, 400);
  assert.equal((await put({ 'imap.verifyTls': false, 'imap.password': PH })).status, 400);
  assert.equal(ctx.settings.get('imap.password'), 'Imap!Pass');
  assert.equal((await put({ 'smtp.host': 'mail.firma.local', 'smtp.user': 'helpdesk', 'smtp.password': 'Smtp!Pass' })).status, 200);
  assert.equal((await put({ 'smtp.user': 'jemand', 'smtp.password': PH })).status, 400);
  assert.equal(ctx.settings.get('smtp.user'), 'helpdesk');

  // ohne gespeichertes Geheimnis gibt es nichts zu schützen
  ctx.settings.set('smtp.password', '');
  assert.equal((await put({ 'smtp.host': 'neu.firma.local', 'smtp.password': '' })).status, 200);
});

test('SSO: Name/E-Mail aus unbestätigter Adresse führen nicht mit dem AD-Konto zusammen', async () => {
  const { ctx } = S;
  const { claimsToUser } = await import('../src/auth/oidc.js');
  const { roleFromGroups } = await import('../src/users.js');
  const chef = ctx.users.upsertExternal({ source: 'ldap', username: 'chef', displayName: 'Chef', email: 'chef@firma.local', externalId: 'guid-chef', role: 'admin' });
  const cfg = { ...ctx.settings.group('oidc'), mergeDomain: 'firma.local' };

  const evil = claimsToUser({ iss: 'https://idp', sub: 'fremd-1', email: 'chef@firma.local', email_verified: false }, cfg);
  assert.equal(evil.trustName, false);
  assert.equal(evil.trustEmail, false);
  assert.equal(evil.username, 'oidc:chef@firma.local');
  const got = ctx.users.upsertExternal({ source: 'oidc', ...evil, role: roleFromGroups(evil.groups, cfg), allowCreate: true });
  assert.notEqual(got.id, chef.id);
  assert.equal(got.role, 'user');
  assert.equal(got.email, null);
  // ohne email_verified ebenso; auch wenn der Admin "email" als Namens-Claim gewählt hat
  assert.equal(claimsToUser({ sub: 'x', email: 'chef@firma.local' }, cfg).trustName, false);
  assert.equal(claimsToUser({ sub: 'x', email: 'chef@firma.local' }, { ...cfg, usernameClaim: 'email' }).trustName, false);

  // bestätigte Adresse: wie bisher
  const ok = claimsToUser({ sub: 'x', email: 'chef@firma.local', email_verified: true }, cfg);
  assert.deepEqual([ok.username, ok.trustName, ok.trustEmail], ['chef', true, true]);
  // preferred_username/UPN-Weg unverändert; gleiche Adresse wie der Name gilt als bestätigt (Entra ID)
  const upn = claimsToUser({ sub: 'x', preferred_username: 'chef@firma.local', email: 'chef@firma.local' }, cfg);
  assert.deepEqual([upn.username, upn.trustName, upn.trustEmail], ['chef', true, true]);
  const noMail = claimsToUser({ sub: 'x', preferred_username: 'chef@firma.local' }, cfg);
  assert.deepEqual([noMail.email, noMail.trustEmail], ['chef@firma.local', true]);
  // abweichende, unbestätigte Adresse wird nicht übernommen
  assert.equal(claimsToUser({ sub: 'x', preferred_username: 'chef@firma.local', email: 'kontakt@firma.local' }, cfg).trustEmail, false);
});

test('Sitzung: absolute Höchstdauer 30 Tage ab Anmeldung', async () => {
  const { db } = S;
  const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  const u = await S.user('sitz', 'user');
  const sid = db.prepare('SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC').get(S.ids.sitz).id;
  // knapp unter der Höchstdauer: gültig, Verlängerung höchstens bis zur Höchstdauer
  const created = Date.now() - SESSION_MAX_AGE_MS + 3600e3;
  db.prepare('UPDATE sessions SET created_at=?, expires_at=? WHERE id=?').run(created, Date.now() + 120e3, sid);
  assert.equal((await u('GET', '/api/me')).status, 200);
  const exp = db.prepare('SELECT expires_at FROM sessions WHERE id=?').get(sid).expires_at;
  assert.ok(exp <= created + SESSION_MAX_AGE_MS, 'nicht über die Höchstdauer verlängert');
  // älter als 30 Tage: ungültig und gelöscht, auch wenn expires_at noch in der Zukunft liegt
  db.prepare('UPDATE sessions SET created_at=?, expires_at=? WHERE id=?').run(Date.now() - SESSION_MAX_AGE_MS - 1000, Date.now() + 3600e3, sid);
  assert.equal((await u('GET', '/api/me')).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(sid).n, 0);
  assert.equal((await import('../src/auth/session.js')).SESSION_MAX_AGE_MS, SESSION_MAX_AGE_MS);
});

test('2FA-Ersteinrichtung bei der Anmeldung überschreibt keinen inzwischen eingerichteten Faktor', async () => {
  const { admin, db, ctx } = S;
  const { totpAt, currentStep } = await import('../src/auth/totp.js');
  const code = (secret) => totpAt(secret, currentStep());
  await admin('POST', '/api/users', { username: 'zweif', displayName: 'Zweif', email: 'zweif@firma.local', role: 'user', password: 'Sehrgeheim123' });
  ctx.settings.set('mfa.internal', 'all');
  try {
    const a = jarClient(); const b = jarClient();
    assert.deepEqual((await a('POST', '/api/auth/login', { username: 'zweif', password: 'Sehrgeheim123' })).body, { mfa: 'enroll' });
    assert.deepEqual((await b('POST', '/api/auth/login', { username: 'zweif', password: 'Sehrgeheim123' })).body, { mfa: 'enroll' });
    const ia = (await a('POST', '/api/auth/mfa/enroll')).body;
    const ib = (await b('POST', '/api/auth/mfa/enroll')).body;
    assert.equal((await a('POST', '/api/auth/mfa', { code: code(ia.secret) })).status, 200);
    const before = db.prepare("SELECT totp_secret, recovery_codes FROM users WHERE username='zweif'").get();
    const r = await b('POST', '/api/auth/mfa', { code: code(ib.secret) });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'err.mfaExpired');
    assert.equal((await b('GET', '/api/me')).status, 401);
    assert.deepEqual(db.prepare("SELECT totp_secret, recovery_codes FROM users WHERE username='zweif'").get(), before);
  } finally { ctx.settings.set('mfa.internal', ''); }
});

test('2FA-Fehlversuche zählen je Konto, nicht je normalisiertem Namen', async () => {
  const { admin, ctx } = S;
  for (const username of ['maxi', 'maxi@firma.local']) {
    const r = await admin('POST', '/api/users', { username, displayName: username, email: `${username.replace('@firma.local', '2')}@firma.local`, role: 'user', password: 'Sehrgeheim123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  ctx.settings.set('mfa.internal', 'all');
  try {
    // "maxi": 8 falsche Codes (zwei Anmeldungen, je höchstens 5 Versuche)
    let left = 8;
    while (left > 0) {
      const c = jarClient();
      assert.deepEqual((await c('POST', '/api/auth/login', { username: 'maxi', password: 'Sehrgeheim123' })).body, { mfa: 'enroll' });
      await c('POST', '/api/auth/mfa/enroll');
      for (let i = 0; i < 4 && left > 0; i++, left--) await c('POST', '/api/auth/mfa', { code: '000000' });
    }
    // "maxi@firma.local" ist davon nicht gesperrt
    const d = jarClient();
    assert.deepEqual((await d('POST', '/api/auth/login', { username: 'maxi@firma.local', password: 'Sehrgeheim123' })).body, { mfa: 'enroll' });
    await d('POST', '/api/auth/mfa/enroll');
    const r = await d('POST', '/api/auth/mfa', { code: '000000' });
    assert.equal(r.body.error.code, 'err.mfaInvalid');
  } finally { ctx.settings.set('mfa.internal', ''); }
});

test('Deaktiviertes lokales Konto: gleiche Antwort wie bei falschem Kennwort', async () => {
  const { admin } = S;
  const r = await admin('POST', '/api/users', { username: 'weg', displayName: 'Weg', email: 'weg@firma.local', role: 'user', password: 'Sehrgeheim123' });
  assert.equal((await admin('PATCH', `/api/users/${r.body.user.id}`, { active: false })).status, 200);
  const c = jarClient();
  const right = await c('POST', '/api/auth/login', { username: 'weg', password: 'Sehrgeheim123' });
  const wrong = await c('POST', '/api/auth/login', { username: 'weg', password: 'Falsch1234567' });
  assert.equal(right.status, 401);
  assert.deepEqual(right.body, wrong.body);
});

test('Melder-Adresse/-Anmeldename nur für Bearbeiter und den Melder selbst', async () => {
  const mel = await S.user('melder', 'user');
  const teil = await S.user('teilnehm', 'user');
  const ag = await S.user('bearb', 'agent');
  const t = await mel('POST', '/api/tickets', { title: 'Drucker' });
  assert.ok((await mel('POST', `/api/tickets/${t.body.ticket.key}/participants`, { userId: S.ids.teilnehm })).status < 300);
  const seen = (await teil('GET', `/api/tickets/${t.body.ticket.key}`)).body.ticket.reporter;
  assert.equal(seen.displayName, 'melder');
  assert.equal(seen.email, undefined);
  assert.equal(seen.username, undefined);
  const list = (await teil('GET', '/api/tickets')).body.tickets.find((x) => x.key === t.body.ticket.key);
  assert.equal(list.reporter.email, undefined);
  assert.equal((await mel('GET', `/api/tickets/${t.body.ticket.key}`)).body.ticket.reporter.email, 'melder@firma.local');
  const asAgent = (await ag('GET', `/api/tickets/${t.body.ticket.key}`)).body.ticket.reporter;
  assert.deepEqual([asAgent.email, asAgent.username], ['melder@firma.local', 'melder']);
});

test('HELFI_TRUST_PROXY: true/Zahl/ungültig → Warnung und „loopback“, kein Absturz', async () => {
  const { applyTrustProxy } = await import('../src/app.js');
  for (const raw of ['true', 'TRUE', 'false', '1', '2', 'kein-proxy', '', undefined]) {
    const app = express();
    assert.equal(applyTrustProxy(app, raw), 'loopback', String(raw));
    const fn = app.get('trust proxy fn');
    assert.equal(fn('203.0.113.9', 0), false, `${raw}: fremde Adresse nicht vertraut`);
    assert.equal(fn('0.0.0.1', 0), false, `${raw}: "1" ist keine Adresse`);
    assert.equal(fn('127.0.0.1', 0), true);
  }
  const app = express();
  assert.equal(applyTrustProxy(app, 'loopback, 10.0.10.5'), 'loopback, 10.0.10.5');
  assert.equal(app.get('trust proxy fn')('10.0.10.5', 0), true);
});

test('SVG-Logo: Namensraum-Präfix, CSS-Escapes und Zeichenreferenzen werden abgelehnt', async () => {
  const { checkSvg } = await import('../src/brand.js');
  for (const bad of [
    '<svg xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></svg>',
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject><div/></s:foreignObject></svg>',
    '<svg><style>rect{fill:u\\72l(https://example.com/a)}</style><rect/></svg>',
    '<svg><rect style="fill:u\\72l(https://example.com/a)"/></svg>',
    '<svg><a href="jav&#x61;script:alert(1)"><rect/></a></svg>',
    "<svg><a href='javascript&colon;alert(1)'><rect/></a></svg>",
    '<svg><style>rect{fill:u&#x72;l(https://example.com/a)}</style></svg>',
  ]) assert.equal(checkSvg(Buffer.from(bad)), 'err.brandUnsafeSvg', bad);
  // Übliche Logos bleiben erlaubt
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><title>Firma &amp; Co</title><style>.a{fill:#0052CC}</style><defs><linearGradient id="g"/></defs><rect class="a" fill="url(#g)" width="10" height="10"/><text>A &amp; B</text><use xlink:href="#g"/></svg>';
  assert.equal(checkSvg(Buffer.from(ok)), null);
});
