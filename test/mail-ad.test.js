// Tests: look up email senders in AD and retention of processed mails in the mailbox
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mailad-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { createMailProcessor, purgeProcessed, effectiveKeepDays, purgeFolder, MAX_PURGE_PER_RUN } = await import('../src/mail/imap.js');
const { buildEmailFilter } = await import('../src/auth/ldap.js');

let server; let base; let db; let ctx;

before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' },
    body: JSON.stringify({ token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' }),
  });
  assert.equal(r.status, 200);
  const s = ctx.settings;
  s.set('ldap.enabled', true);
  s.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  s.set('ldap.adminGroup', 'Helfi-Admins');
  db.prepare("UPDATE projects SET agent_group='Helfi-Bearbeiter' WHERE key='IT'").run();
  s.set('imap.project', 'IT');
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const AD = {
  'm.muster@firma.local': { username: 'm.muster', displayName: 'Max Muster', email: 'm.muster@firma.local', externalId: 'guid-mm', groups: { admin: false, agent: false, user: true } },
  // Secondary address (proxyAddresses): the primary address in AD is a different one
  'erika.alt@firma.de': { username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: 'guid-eb', groups: { admin: false, agent: false, user: true } },
  'b.bearbeiter@firma.local': { username: 'b.bearbeiter', displayName: 'Bea Bearbeiter', email: 'b.bearbeiter@firma.local', externalId: 'guid-bb', groups: { admin: false, user: true, projects: [1] } },
  'doppelt@firma.local': { ambiguous: true },
  'gesperrt@firma.local': { username: 'gesperrt', displayName: 'Nicht zugelassen', email: 'gesperrt@firma.local', externalId: 'guid-gs', groups: { admin: false, agent: false, user: false } },
};

function processorWith(lookup) {
  const calls = [];
  const adLookup = async (cfg, email) => {
    calls.push(email);
    return lookup(cfg, email);
  };
  const p = createMailProcessor({ db, settings: ctx.settings, tickets: ctx.tickets, users: ctx.users, adLookup });
  let n = 0;
  const mail = async (from, extra = []) => {
    const parsed = await p.parse(Buffer.from([`From: ${from}`, 'To: helpdesk@firma.local', 'Subject: Drucker', `Message-ID: <ad-${Date.now()}-${n++}@test>`, ...extra, '', 'Geht nicht'].join('\r\n')));
    const sender = await p.lookupSender(parsed);
    return { result: p.process(parsed, sender ? { sender } : {}), sender };
  };
  return { p, mail, calls };
}
const userByEmail = (e) => db.prepare('SELECT * FROM users WHERE lower(email)=?').get(e);
const reporterOf = (ticketId) => db.prepare('SELECT u.* FROM tickets t JOIN users u ON u.id=t.reporter_id WHERE t.id=?').get(ticketId);

test('LDAP filter: address is escaped, disabled accounts excluded', () => {
  const f = buildEmailFilter('A*)(objectClass=*)@Firma.local');
  assert.ok(!f.includes('*)(objectClass=*)@'), f);
  assert.match(f, /a\\2a\\29\\28objectclass=\\2a\\29@firma\.local/);
  assert.match(f, /userAccountControl:1\.2\.840\.113556\.1\.4\.803:=2/);
  assert.match(f, /proxyAddresses=smtp:/);
});

test('Sender in AD: created as AD user, ticket belongs to them', async () => {
  const { mail, calls } = processorWith((cfg, e) => AD[e] || null);
  const { result } = await mail('Max Muster <M.Muster@firma.local>');
  assert.equal(result.action, 'ticket');
  const u = reporterOf(result.ticketId);
  assert.equal(u.source, 'ldap');
  assert.equal(u.username, 'm.muster');
  assert.equal(u.external_id, 'guid-mm');
  assert.equal(u.role, 'user');
  assert.equal(u.password_hash, null);
  assert.deepEqual(calls, ['m.muster@firma.local']);
  // Second mail: account is known, no new lookup
  await mail('m.muster@firma.local');
  assert.equal(calls.length, 1);
});

test('Existing email contact becomes an AD user, old tickets stay with them', async () => {
  const off = processorWith(() => null);
  ctx.settings.set('imap.adLookup', false);
  const { result: first } = await off.mail('anna.neu@firma.local');
  ctx.settings.set('imap.adLookup', true);
  const contact = userByEmail('anna.neu@firma.local');
  assert.equal(contact.source, 'email');
  assert.equal(off.calls.length, 0, 'switch off = no lookup');

  const { mail } = processorWith((cfg, e) => (e === 'anna.neu@firma.local'
    ? { username: 'a.neu', displayName: 'Anna Neu', email: 'anna.neu@firma.local', externalId: 'guid-an', groups: { admin: false, agent: false, user: true } }
    : null));
  const { result: second } = await mail('anna.neu@firma.local');
  const u = userByEmail('anna.neu@firma.local');
  assert.equal(u.id, contact.id, 'same account');
  assert.equal(u.source, 'ldap');
  assert.equal(u.username, 'a.neu');
  assert.equal(reporterOf(first.ticketId).id, u.id);
  assert.equal(reporterOf(second.ticketId).id, u.id);
});

test('Secondary address (proxyAddresses): ticket goes to the AD account with the primary address', async () => {
  const { mail } = processorWith((cfg, e) => AD[e] || null);
  const { result } = await mail('erika.alt@firma.de');
  const u = reporterOf(result.ticketId);
  assert.equal(u.username, 'e.beispiel');
  assert.equal(u.email, 'e.beispiel@firma.local');
  assert.equal(userByEmail('erika.alt@firma.de'), undefined, 'no additional contact');
});

test('Ambiguous, not found, not allowed: email contact; negative cache prevents repeated lookups', async () => {
  const { mail, calls } = processorWith((cfg, e) => AD[e] || null);
  for (const e of ['doppelt@firma.local', 'fremd@kunde.example', 'gesperrt@firma.local']) {
    const { result } = await mail(e);
    assert.equal(result.action, 'ticket');
    assert.equal(reporterOf(result.ticketId).source, 'email', e);
  }
  assert.equal(calls.length, 3);
  await mail('fremd@kunde.example');
  assert.equal(calls.length, 3, 'unknown address is not looked up again for one hour');
});

test('AD unreachable: ticket is created anyway (as contact)', async () => {
  const { mail } = processorWith(() => { throw new Error('connect ECONNREFUSED'); });
  const { result } = await mail('offline@firma.local');
  assert.equal(result.action, 'ticket');
  assert.equal(reporterOf(result.ticketId).source, 'email');
});

test('Agent from AD: account with its project group, the mail itself stays a report', async () => {
  const { mail } = processorWith((cfg, e) => AD[e] || null);
  const { result } = await mail('b.bearbeiter@firma.local');
  const u = reporterOf(result.ticketId);
  assert.equal(u.role, 'user', 'stored role');
  assert.ok(db.prepare("SELECT 1 FROM project_agents WHERE user_id=? AND source='group'").get(u.id), 'works on IT via its group');
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(result.ticketId);
  assert.equal(t.assignee_id, null, 'mail assigns nothing');
  assert.equal(t.reporter_id, u.id);
});

test('No lookup without service account, without AD login or for automated mails', async () => {
  const { mail, calls } = processorWith((cfg, e) => AD[e] || null);
  ctx.settings.set('ldap.bindDn', '');
  await mail('ohne.dienstkonto@firma.local');
  ctx.settings.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  ctx.settings.set('ldap.enabled', false);
  await mail('ohne.ad@firma.local');
  ctx.settings.set('ldap.enabled', true);
  await mail('abwesend@firma.local', ['Auto-Submitted: auto-replied']);
  assert.equal(calls.length, 0);
});

// ---------- Retention ----------
function fakeClient(mails) {
  const log = { locks: [], deleted: [], searches: [] };
  return {
    log,
    getMailboxLock: async (folder) => { log.locks.push(folder); return { release: () => {} }; },
    search: async (q) => { log.searches.push(q); return mails.filter((m) => m.date < q.before).map((m) => m.uid); },
    messageDelete: async (range) => { log.deleted.push(...String(range).split(',').map(Number)); return true; },
  };
}
const NOW = new Date('2026-11-01T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 3600 * 1000);

test('Retention: 0 = never, minimum 7 days', () => {
  assert.equal(effectiveKeepDays(0), 0);
  assert.equal(effectiveKeepDays(''), 0);
  assert.equal(effectiveKeepDays(-5), 0);
  assert.equal(effectiveKeepDays(1), 7);
  assert.equal(effectiveKeepDays(90), 90);
  assert.equal(effectiveKeepDays('30'), 30);
});

test('Retention: never in the inbox or without a dedicated folder', async () => {
  assert.equal(purgeFolder({ processedFolder: '', folder: 'INBOX' }), null);
  assert.equal(purgeFolder({ processedFolder: 'INBOX', folder: 'INBOX' }), null);
  assert.equal(purgeFolder({ processedFolder: 'inbox', folder: 'Helpdesk' }), null);
  assert.equal(purgeFolder({ processedFolder: 'Helpdesk', folder: 'helpdesk' }), null);
  assert.equal(purgeFolder({ processedFolder: 'Helfi', folder: 'INBOX' }), 'Helfi');
  const c = fakeClient([{ uid: 1, date: daysAgo(200) }]);
  for (const cfg of [{ processedFolder: '', processedKeepDays: 90 }, { processedFolder: 'INBOX', processedKeepDays: 90 }, { processedFolder: 'Helfi', processedKeepDays: 0 }]) {
    const r = await purgeProcessed(c, cfg, NOW);
    assert.equal(r.skipped, true);
  }
  assert.deepEqual(c.log.locks, [], 'no folder opened');
  assert.deepEqual(c.log.deleted, []);
});

test('Retention: deletes only older mails in the folder, at most 500 per run', async () => {
  const mails = [{ uid: 1, date: daysAgo(120) }, { uid: 2, date: daysAgo(91) }, { uid: 3, date: daysAgo(89) }, { uid: 4, date: daysAgo(1) }];
  const c = fakeClient(mails);
  const r = await purgeProcessed(c, { processedFolder: 'Helfi', folder: 'INBOX', processedKeepDays: 90 }, NOW);
  assert.deepEqual(r, { deleted: 2, days: 90 });
  assert.deepEqual(c.log.locks, ['Helfi']);
  assert.deepEqual(c.log.deleted, [1, 2]);
  assert.equal(c.log.searches[0].before.toISOString(), daysAgo(90).toISOString());

  const many = Array.from({ length: 700 }, (_, i) => ({ uid: i + 1, date: daysAgo(400) }));
  const c2 = fakeClient(many);
  const r2 = await purgeProcessed(c2, { processedFolder: 'Helfi', processedKeepDays: 3 }, NOW);
  assert.equal(r2.deleted, MAX_PURGE_PER_RUN);
  assert.equal(r2.days, 7, 'too small a value counts as 7');
});
