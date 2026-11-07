// Follow-up work on code audit 2026-11: SSO as second factor (levels), merging via AD ID,
// limited pending SSO logins, agent mails in a separate column, previous version of the description,
// recovery codes with scrypt, IMAP keyword, news, migration 24.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let key;
const mod = {};
before(async () => {
  S = await startServer('followup');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  key = (await karl('POST', '/api/tickets', { title: 'Drucker PR-0001', description: 'Erste Fassung\nZeile zwei' })).body.ticket.key;
  mod.oidc = await import('../src/auth/oidc.js');
  mod.oidcRoutes = await import('../src/routes/oidc.js');
  mod.ldap = await import('../src/auth/ldap.js');
  mod.totp = await import('../src/auth/totp.js');
  mod.imap = await import('../src/mail/imap.js');
  mod.db = await import('../src/db.js');
  mod.news = await import('../src/news.js');
});
after(() => S.stop());

// ---------- SSO as second factor ----------
test('SSO second factor: never / only if the provider reports MFA / always', () => {
  const { mfaConfirmed, claimsToUser } = mod.oidc;
  const { ssoSecondFactor } = mod.oidcRoutes;
  assert.equal(mfaConfirmed({ amr: ['pwd', 'mfa'] }), true, 'Entra ID');
  assert.equal(mfaConfirmed({ amr: 'otp' }), true, 'amr as string');
  assert.equal(mfaConfirmed({ amr: ['pwd'] }), false, 'password only');
  assert.equal(mfaConfirmed({}), false);
  assert.equal(mfaConfirmed({ acr: '2' }, { mfaAcr: 'gold, 2' }), true, 'acr from the list');
  assert.equal(mfaConfirmed({ acr: '1' }, { mfaAcr: 'gold, 2' }), false);
  assert.equal(mfaConfirmed({ acr: '2' }, {}), false, 'without a list acr does not count');

  const settings = (mode) => ({ get: (k) => (k === 'mfa.ssoSecondFactor' ? mode : null) });
  const withMfa = claimsToUser({ sub: 's', preferred_username: 'x', amr: ['mfa'] }, {});
  const without = claimsToUser({ sub: 's', preferred_username: 'x', amr: ['pwd'] }, {});
  assert.equal(ssoSecondFactor(settings('confirmed'), withMfa), true);
  assert.equal(ssoSecondFactor(settings('confirmed'), without), false, 'without MFA at the provider: own code required');
  assert.equal(ssoSecondFactor(settings('always'), without), true);
  assert.equal(ssoSecondFactor(settings('never'), withMfa), false);
  assert.equal(S.ctx.settings.get('mfa.ssoSecondFactor'), 'confirmed', 'default for new installations');
});

test('Profile: SSO accounts see the level instead of a yes/no', async () => {
  S.db.prepare("UPDATE users SET source='oidc' WHERE username='karl'").run();
  try {
    let r = await karl('GET', '/api/me/mfa');
    if (r.status === 404) r = await karl('GET', '/api/mfa/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.sso, 'confirmed');
  } finally { S.db.prepare("UPDATE users SET source='local' WHERE username='karl'").run(); }
});

// ---------- AD ID ----------
test('AD ID from the claim: SID, GUID (text form, hex, Base64)', () => {
  const { parseAdId } = mod.oidc;
  assert.deepEqual(parseAdId('S-1-5-21-1004336348-1177238915-682003330-1105'), { sid: 'S-1-5-21-1004336348-1177238915-682003330-1105' });
  // Text form: the first three groups are reversed in the bytes
  assert.deepEqual(parseAdId('01234567-89ab-cdef-0123-456789abcdef'), { guid: '67452301ab89efcd0123456789abcdef' });
  assert.deepEqual(parseAdId('{01234567-89AB-CDEF-0123-456789ABCDEF}'), { guid: '67452301ab89efcd0123456789abcdef' });
  const bytes = crypto.randomBytes(16);
  assert.deepEqual(parseAdId(bytes.toString('base64')), { guid: bytes.toString('hex') }, 'onPremisesImmutableId');
  assert.deepEqual(parseAdId(bytes.toString('hex').toUpperCase()), { guid: bytes.toString('hex') });
  assert.deepEqual(parseAdId(['S-1-5-21-1-2-3-4']), { sid: 'S-1-5-21-1-2-3-4' }, 'as list');
  for (const bad of ['', 'm.muster', 'S-1-x', '1234', null, undefined, 'aGFsbG8=']) assert.equal(parseAdId(bad), null, String(bad));
});

test('objectSid: bytes ↔ text', () => {
  const { sidToString, sidToBuffer } = mod.ldap;
  const sid = 'S-1-5-21-3623811015-3361044348-30300820-1013';
  const b = sidToBuffer(sid);
  assert.equal(b.toString('hex'), '010500000000000515000000c7f7fed77c7755c8945ace01f5030000');
  assert.equal(sidToString(b), sid);
  assert.equal(sidToBuffer('S-1-5-21-99999999999-1'), null, 'sub-authority too large');
  assert.equal(sidToString(Buffer.from('0105', 'hex')), '');
  assert.equal(sidToString('S-1-5'), '');
});

test('With a claim for the AD ID: never merge by name', () => {
  const { claimsToUser } = mod.oidc;
  const claims = { iss: 'https://idp.firma.local', sub: 'abc', preferred_username: 'm.muster@firma.local', email: 'm.muster@firma.local', email_verified: true };
  const byName = claimsToUser(claims, { mergeDomain: 'firma.local' });
  assert.equal(byName.username, 'm.muster');
  assert.equal(byName.trustName, true, 'previously: via domain');
  const strict = claimsToUser(claims, { mergeDomain: 'firma.local', adIdClaim: 'onprem_sid' });
  assert.equal(strict.username, 'oidc:m.muster@firma.local', 'freely selectable name no longer counts');
  assert.equal(strict.trustName, false);
  assert.equal(strict.adId, null, 'claim missing');
  const withSid = claimsToUser({ ...claims, onprem_sid: 'S-1-5-21-1-2-3-1105' }, { adIdClaim: 'onprem_sid' });
  assert.deepEqual(withSid.adId, { sid: 'S-1-5-21-1-2-3-1105' });
});

test('Merging via AD ID: AD account, checked against AD at every login', async () => {
  const { adAccountFor } = mod.oidcRoutes;
  const { users, settings } = S.ctx;
  const guid = 'ab'.repeat(16);
  const ad = users.upsertExternal({ source: 'ldap', username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: guid, sid: 'S-1-5-21-1-2-3-1201', role: 'user' });
  assert.equal(ad.ad_sid, 'S-1-5-21-1-2-3-1201', 'objectSid stored');
  // without AD connection: known account
  assert.equal((await adAccountFor(S.ctx, { sid: 'S-1-5-21-1-2-3-1201' })).user.id, ad.id);
  assert.equal((await adAccountFor(S.ctx, { guid })).user.id, ad.id);
  assert.deepEqual(await adAccountFor(S.ctx, { sid: 'S-1-5-21-1-2-3-1300' }), { none: true });
  // store SID only for AD accounts
  const other = users.upsertExternal({ source: 'oidc', username: 'oidc:x', displayName: 'X', email: '', externalId: 'iss|x', sid: 'S-1-5-21-1-2-3-1202' });
  assert.equal(other.ad_sid, null);

  settings.set('ldap.enabled', true);
  settings.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  const dir = {
    'S-1-5-21-1-2-3-1201': { username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: guid, sid: 'S-1-5-21-1-2-3-1201', groups: { user: true, agent: false, admin: false } },
    'S-1-5-21-1-2-3-1300': { username: 'm.muster', displayName: 'Max Muster', email: 'm.muster@firma.local', externalId: 'cd'.repeat(16), sid: 'S-1-5-21-1-2-3-1300', groups: { user: true, agent: false, admin: false } },
  };
  const saved = S.ctx.directory;
  S.ctx.directory = { bySid: async (cfg, sid) => dir[sid] || null, byGuid: async () => { throw new Error('ECONNREFUSED'); } };
  try {
    const max = (await adAccountFor(S.ctx, { sid: 'S-1-5-21-1-2-3-1300' })).user;
    assert.equal(max.username, 'm.muster', 'unknown: looked up in AD and created');
    assert.equal(max.ad_sid, 'S-1-5-21-1-2-3-1300');
    assert.deepEqual(await adAccountFor(S.ctx, { sid: 'S-1-5-21-1-2-3-1301' }), { none: true }, 'not in AD');
    await assert.rejects(adAccountFor(S.ctx, { guid: 'ef'.repeat(16) }), /ECONNREFUSED/, 'failure → abort instead of a separate account');
    // "Existing accounts only": no new account via the AD ID
    dir['S-1-5-21-1-2-3-1400'] = { ...dir['S-1-5-21-1-2-3-1300'], username: 'n.neu', externalId: '12'.repeat(16), sid: 'S-1-5-21-1-2-3-1400' };
    assert.deepEqual(await adAccountFor(S.ctx, { sid: 'S-1-5-21-1-2-3-1400' }, { allowCreate: false }), { denied: 'noAccount' });
    // removed from the group or disabled in AD: no more SSO login immediately
    settings.set('ldap.userGroup', 'Helfi-Benutzer');
    dir['S-1-5-21-1-2-3-1201'].groups = { user: false, agent: false, admin: false };
    assert.deepEqual(await adAccountFor(S.ctx, { sid: 'S-1-5-21-1-2-3-1201' }), { denied: 'notInGroup' });
    delete dir['S-1-5-21-1-2-3-1201'];
    assert.deepEqual(await adAccountFor(S.ctx, { sid: 'S-1-5-21-1-2-3-1201' }), { denied: 'noAccount' }, 'known, but gone from AD');
    // Role follows the AD groups
    settings.set('ldap.agentGroup', 'Helfi-Bearbeiter');
    dir['S-1-5-21-1-2-3-1300'].groups = { user: true, agent: true, admin: false };
    assert.equal((await adAccountFor(S.ctx, { sid: 'S-1-5-21-1-2-3-1300' })).user.role, 'agent');
  } finally {
    S.ctx.directory = saved;
    settings.set('ldap.enabled', false);
    settings.set('ldap.userGroup', '');
    settings.set('ldap.agentGroup', '');
  }
});

test('AD account with mangled objectGUID (up to 1.12) is taken over, not duplicated', () => {
  const { users } = S.ctx;
  S.db.prepare("INSERT INTO users(username,display_name,role,source,external_id) VALUES('g.alt','G Alt','agent','ldap',?)").run('\u0001A\u0002b€text');
  const u = users.upsertExternal({ source: 'ldap', username: 'g.alt', displayName: 'G Alt', email: '', externalId: '0a'.repeat(16), role: null });
  assert.equal(u.username, 'g.alt', 'no second account "ldap:g.alt"');
  assert.equal(u.external_id, '0a'.repeat(16), 'ID corrected');
  assert.equal(u.role, 'agent');
  // a genuinely different identity (hex) stays separate
  S.db.prepare("INSERT INTO users(username,display_name,role,source,external_id) VALUES('h.alt','H Alt','user','ldap',?)").run('1b'.repeat(16));
  assert.equal(users.upsertExternal({ source: 'ldap', username: 'h.alt', displayName: 'H', email: '', externalId: '2c'.repeat(16), role: null }).username, 'ldap:h.alt');
});

test('Pending SSO logins: expired ones removed, at most 20 per address, at most 1000 in total', () => {
  const { rememberPending, MAX_PENDING, MAX_PENDING_PER_IP } = mod.oidcRoutes;
  assert.equal(MAX_PENDING, 1000);
  assert.equal(MAX_PENDING_PER_IP, 20);
  const m = new Map();
  const now = Date.now();
  rememberPending(m, 'alt', { at: now - 11 * 60 * 1000, ip: '10.0.10.5' }, { now });
  rememberPending(m, 'echt', { at: now, ip: '10.0.10.5' }, { now });
  assert.deepEqual([...m.keys()], ['echt'], 'expired removed');
  // A flood from one address does not push out another address's login
  for (let i = 0; i < 1500; i++) rememberPending(m, `x${i}`, { at: now, ip: '203.0.113.66' }, { now });
  assert.ok(m.has('echt'));
  assert.equal([...m.values()].filter((v) => v.ip === '203.0.113.66').length, 20);
  assert.ok(m.has('x1499') && !m.has('x0'));
  // limited in total
  const n = new Map();
  for (let i = 0; i < 1500; i++) rememberPending(n, `y${i}`, { at: now, ip: `10.1.${i >> 8}.${i & 255}` }, { now });
  assert.equal(n.size, 1000);
  assert.ok(!n.has('y0') && n.has('y1499'), 'the oldest drop out');
});

// ---------- Description ----------
test('Changing the description: previous version stays in the activity log, retrievable by agents only', async () => {
  let r = await karl('PATCH', `/api/tickets/${key}`, { description: 'Erste Fassung\nZeile zwei geändert' });
  assert.equal(r.status, 200);
  const t = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  const a = t.activity.find((x) => x.field === 'description' && x.action === 'changed');
  assert.ok(a, 'entry in the activity log');
  assert.equal(a.hasText, true);
  assert.equal(a.oldValue, null, 'do not deliver texts with every ticket');
  r = await anna('GET', `/api/tickets/${key}/description-versions/${a.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.old, 'Erste Fassung\nZeile zwei');
  assert.equal(r.body.new, 'Erste Fassung\nZeile zwei geändert');
  assert.equal(r.body.user.displayName, 'karl');
  r = await karl('GET', `/api/tickets/${key}/description-versions/${a.id}`);
  assert.equal(r.status, 403, 'users do not see the history');
  r = await anna('GET', `/api/tickets/${key}/description-versions/999999`);
  assert.equal(r.status, 404);
  // another activity entry (no description change) returns nothing
  await anna('PATCH', `/api/tickets/${key}`, { priority: 'high' });
  const other = (await anna('GET', `/api/tickets/${key}`)).body.ticket.activity.find((x) => x.field === 'priority');
  r = await anna('GET', `/api/tickets/${key}/description-versions/${other.id}`);
  assert.equal(r.status, 404);
});

// ---------- Recovery codes ----------
test('Recovery codes: scrypt with salt, existing SHA-256 codes remain valid', () => {
  const { generateRecoveryCodes, useRecoveryCode } = mod.totp;
  const { codes, hashes } = generateRecoveryCodes(3);
  for (const x of hashes) assert.match(x, /^r1\$4096\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(hashes[0].split('$')[2], hashes[1].split('$')[2], 'own salt per code');
  assert.equal(useRecoveryCode(hashes, codes[1]).length, 2);
  assert.equal(useRecoveryCode(hashes, 'abcd-efgh'), null);
  assert.equal(useRecoveryCode(hashes, '123456'), null, 'TOTP code is not even checked');
  const legacy = crypto.createHash('sha256').update('abcdefgh').digest('hex');
  assert.deepEqual(useRecoveryCode([legacy, hashes[0]], 'ABCD-EFGH'), [hashes[0]], 'old format');
  assert.equal(useRecoveryCode(['r1$1$x$y', 'quatsch'], 'abcd-efgh'), null, 'broken entries');
});

// ---------- IMAP keyword ----------
test('IMAP: own keyword if the server supports it – already read mails are processed too', async () => {
  const { createImapPoller, DONE_KEYWORD, pendingQuery } = mod.imap;
  assert.deepEqual(pendingQuery(false), { seen: false });
  const since = new Date('2026-11-03T10:00:00Z');
  assert.deepEqual(pendingQuery(true, since), { unKeyword: DONE_KEYWORD, or: [{ seen: false }, { since }] });

  const eml = (lines) => Buffer.from(lines.join('\r\n'));
  const mails = { 7: eml(['From: kollege@extern.example', 'To: helpdesk@firma.local', 'Subject: Schon gelesen', 'Message-ID: <kw7@extern.example>', '', 'Bitte trotzdem bearbeiten']) };
  const queries = []; const flags = [];
  const fake = (permanentFlags) => class {
    constructor() { this.mailbox = { permanentFlags }; }
    on() {}
    async connect() {}
    async mailboxCreate() {}
    async getMailboxLock() { return { release() {} }; }
    async search(q) { queries.push(q); return [7]; }
    async fetchOne(uid, what) { return what.size ? { size: 100 } : { source: mails[uid] }; }
    async messageFlagsAdd(uid, f) { flags.push(f); }
    async messageMove() {}
    async logout() {}
    close() {}
  };
  const s = S.ctx.settings;
  s.set('imap.enabled', true); s.set('imap.host', '127.0.0.1'); s.set('imap.user', 'helpdesk'); s.set('imap.project', 'IT');
  try {
    const before = S.db.prepare('SELECT COUNT(*) n FROM tickets').get().n;
    let poller = createImapPoller({ settings: s, processor: S.ctx.processor, ImapClient: fake(new Set(['\\Seen', '\\Flagged', '\\*'])) });
    await poller.pollOnce();
    assert.equal(S.db.prepare('SELECT COUNT(*) n FROM tickets').get().n, before + 1, 'mail processed');
    assert.equal(queries[0].unKeyword, DONE_KEYWORD);
    assert.ok(queries[0].or.some((q) => q.since instanceof Date), 'since the keyword was introduced');
    assert.ok(s.get('imap.keywordSince'), 'start time recorded');
    assert.deepEqual(flags[0], ['\\Seen', DONE_KEYWORD]);

    // Server without custom keywords: as before
    queries.length = 0; flags.length = 0;
    poller = createImapPoller({ settings: s, processor: S.ctx.processor, ImapClient: fake(new Set(['\\Seen'])) });
    await poller.pollOnce();
    assert.deepEqual(queries[0], { seen: false });
    assert.deepEqual(flags[0], ['\\Seen']);
  } finally {
    s.set('imap.enabled', false);
  }
});

// ---------- News ----------
test('news.json: valid, bilingual, at most one entry for the upcoming version', () => {
  const entries = mod.news.loadNews();
  assert.ok(entries.length >= 1);
  assert.ok(entries.filter((e) => !e.version).length <= 1, 'at most one entry with version ""');
  const versions = entries.filter((e) => e.version).map((e) => e.version);
  for (const v of versions) assert.match(v, /^\d+\.\d+\.\d+$/);
  const num = (v) => v.split('.').map(Number).reduce((a, x) => a * 1000 + x, 0);
  assert.deepEqual([...versions].sort((a, b) => num(b) - num(a)), versions, 'newest first');
  assert.ok(entries.slice(1).every((e) => e.version), 'upcoming version (version "") is at the top');
  for (const e of entries) {
    assert.ok(e.items.length, e.version);
    for (const i of e.items) {
      assert.ok(mod.news.AUDIENCES.includes(i.audience), `${e.version}: ${i.audience}`);
      assert.ok(i.de && i.en, `${e.version}: both languages`);
      assert.doesNotMatch(`${i.de} ${i.en}`, /jira/i, 'name of another ticket system');
    }
  }
});

test('News: matching the role, once after the update, new accounts without notice', async () => {
  const entries = [
    { version: '', items: [{ audience: 'all', de: 'Für alle', en: 'For all' }, { audience: 'admin', de: 'Nur Admins', en: 'Admins only' }] },
    { version: '1.0.0', items: [{ audience: 'agent', de: 'Alt', en: 'Old' }] },
  ];
  const news = mod.news.createNews(S.db, { entries, version: '9.9.9' });
  const user = { id: -1, role: 'user', news_seen: null }; // not a real account (markSeen writes to the database)
  assert.deepEqual(news.list(user).map((e) => e.version), ['9.9.9'], 'users only see their items');
  assert.equal(news.list({ role: 'admin' })[0].items.length, 2);
  assert.equal(news.list({ role: 'agent' }).length, 2);
  assert.equal(news.unseen(user).version, '9.9.9', 'existing account (nothing seen yet)');
  news.markSeen(user);
  assert.equal(news.unseen({ ...user, news_seen: '9.9.9' }), null);
  assert.equal(news.unseen({ id: 1, role: 'agent', news_seen: '1.0.0' }).version, '9.9.9', 'again after the next update');

  // new accounts start at the current state (trigger), no notice via the API
  const boot = (await karl('GET', '/api/bootstrap')).body;
  assert.equal(boot.news, null);
  S.db.prepare("UPDATE users SET news_seen=NULL WHERE username='karl'").run();
  const boot2 = (await karl('GET', '/api/bootstrap')).body;
  assert.ok(boot2.news === null || boot2.news.version, 'existing account: notice if there are items for users');
  assert.equal((await karl('POST', '/api/news/seen')).status, 200);
  assert.equal((await karl('GET', '/api/bootstrap')).body.news, null);
  const all = (await anna('GET', '/api/news')).body;
  assert.ok(all.entries.length >= 2);
  assert.ok(all.entries.every((e) => e.version), 'upcoming version with number');
});

// ---------- Migration 24 ----------
async function migrateFrom23(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-m24-'));
  const file = path.join(dir, 'h.sqlite');
  let d = await mod.db.openDatabase(file, { appVersion: '1.12.0', backupDir: path.join(dir, 'b') });
  d.exec("DROP INDEX idx_tickets_resolution; ALTER TABLE tickets DROP COLUMN duplicate_of; ALTER TABLE tickets DROP COLUMN resolution; ALTER TABLE component_suggestions DROP COLUMN backfill; ALTER TABLE mail_messages DROP COLUMN recipient; ALTER TABLE users DROP COLUMN theme; ALTER TABLE kb_comments DROP COLUMN format; ALTER TABLE comments DROP COLUMN format; DROP TABLE component_suggestions; DROP TABLE saved_filters; DROP INDEX idx_tickets_component; ALTER TABLE tickets DROP COLUMN component_id; DROP TABLE components; DROP TABLE kb_feedback; DROP TABLE kb_votes; DROP TABLE comment_mentions; ALTER TABLE sessions DROP COLUMN last_seen; DROP TABLE ai_summaries; DROP TABLE account_tokens; ALTER TABLE users DROP COLUMN approval_pending; ALTER TABLE users DROP COLUMN self_registered; DROP INDEX idx_users_ad_sid; ALTER TABLE users DROP COLUMN ad_sid; DROP TRIGGER users_news_seen; ALTER TABLE users DROP COLUMN news_seen; ALTER TABLE mail_messages DROP COLUMN agent_only; DROP TABLE ticket_fts; CREATE VIRTUAL TABLE ticket_fts USING fts5(title, public_text, internal_text, people, tokenize='trigram'); DELETE FROM settings WHERE key='mfa.ssoSecondFactor';");
  d.prepare("UPDATE meta SET value='23' WHERE key='schema_version'").run();
  setup(d);
  d.close();
  d = await mod.db.openDatabase(file, { appVersion: '1.13.0', backupDir: path.join(dir, 'b') });
  return { d, done: () => { d.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('Migration 24: old agent marker taken over, SSO behaviour stays, accounts see news once', async () => {
  const set = (d, k, v) => d.prepare('INSERT OR REPLACE INTO settings(key,value,secret) VALUES(?,?,0)').run(k, JSON.stringify(v));
  // active SSO, trustSso never saved (= on) → "always" stays
  let m = await migrateFrom23((d) => {
    set(d, 'oidc.enabled', true);
    d.prepare("INSERT INTO users(username,display_name,role,source) VALUES('alt','Alt','user','local')").run();
    d.prepare("INSERT INTO projects(key,name) VALUES('IT','IT')").run();
    d.prepare("INSERT INTO tickets(project_id,number,title,description,type,status,priority,labels,source) VALUES(1,1,'t','d','incident','open','medium','','web')").run();
    d.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction) VALUES('helfi.1.1730500000000.0123456789abcdef0123456789abcdef.agent@firma.local',1,'out')").run();
    d.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction) VALUES('helfi.1.1730500000001.0123456789abcdef0123456789abcdef@firma.local',1,'out')").run();
  });
  try {
    const flag = (id) => m.d.prepare('SELECT agent_only FROM mail_messages WHERE message_id LIKE ?').get(`helfi.1.${id}.%`).agent_only;
    assert.equal(flag('1730500000000'), 1, 'old marker ".agent" taken over');
    assert.equal(flag('1730500000001'), 0);
    assert.equal(JSON.parse(m.d.prepare("SELECT value FROM settings WHERE key='mfa.ssoSecondFactor'").get().value), 'always');
    assert.equal(m.d.prepare("SELECT news_seen FROM users WHERE username='alt'").get().news_seen, null, 'existing account: notice once');
    m.d.prepare("INSERT INTO users(username,display_name,role,source) VALUES('neu','Neu','user','local')").run();
    assert.equal(m.d.prepare("SELECT news_seen FROM users WHERE username='neu'").get().news_seen, '1.13.0', 'new account: current state');
    assert.equal(m.d.prepare('SELECT COUNT(*) n FROM search_dirty').get().n, 1, 'search index is rebuilt');
  } finally { m.done(); }

  // SSO off, trustSso off → "never"; SSO off, nothing saved → default (no entry)
  m = await migrateFrom23((d) => set(d, 'mfa.trustSso', false));
  try { assert.equal(JSON.parse(m.d.prepare("SELECT value FROM settings WHERE key='mfa.ssoSecondFactor'").get().value), 'never'); } finally { m.done(); }
  m = await migrateFrom23(() => {});
  try { assert.equal(m.d.prepare("SELECT value FROM settings WHERE key='mfa.ssoSecondFactor'").get(), undefined); } finally { m.done(); }
});

test('Agent mail in the old format (sent before the update): reply becomes an internal note', async () => {
  const t = (await karl('POST', '/api/tickets', { title: 'Alt-Mail', description: 'x' })).body.ticket;
  const id = `helfi.${t.id}.1730500000000.00112233445566778899aabbccddeeff.agent@firma.local`;
  S.db.prepare("INSERT INTO mail_messages(message_id,ticket_id,direction,agent_only) VALUES(?,?,'out',1)").run(id, t.id);
  const parsed = await S.ctx.processor.parse(Buffer.from(['From: anna@firma.local', 'To: helpdesk@firma.local', `Subject: Re: [${t.key}]`,
    'Message-ID: <alt1@firma.local>', `In-Reply-To: <${id}>`, '', 'Intern'].join('\r\n')));
  const r = S.ctx.processor.process(parsed);
  assert.equal(r.action, 'comment');
  assert.equal(S.db.prepare('SELECT internal FROM comments WHERE ticket_id=? ORDER BY id DESC').get(t.id).internal, 1);
});
