// Audit 2026-11f (auth/rights): since migration 42 project agents are role 'user' in the database
// and become 'agent' per request (withProjects). These tests cover places that used the raw role
// or ignored project rights.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

const plan = { changeType: 'normal', reason: 'x', risk: 'medium', plannedStart: '2026-11-07T08:00:00Z', plannedEnd: '2026-11-07T10:00:00Z', implementationPlan: 'a', backoutPlan: 'b', testPlan: 'c' };
let S; let anna; let hma; let zoe; let plain; let HM;
const sent = [];
const tick = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  S = await startServer('audit11f-auth');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  anna = await S.user('anna', 'agent'); // legacy all-projects agent
  hma = await S.user('hma', 'user');
  zoe = await S.user('zoe', 'user');
  plain = await S.user('plain', 'user');
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project.id;
  await S.admin('PUT', `/api/projects/${HM}/agents`, { members: [{ userId: S.ids.hma }] });
  assert.equal((await hma('GET', '/api/me')).body.user.role, 'agent');
});
after(() => S.stop());

async function changeInApproval(title, approverIds) {
  const key = (await anna('POST', '/api/tickets', { title, type: 'change', projectId: 1, description: 'vertraulich' })).body.ticket.key;
  assert.equal((await anna('PATCH', `/api/tickets/${key}/fields`, plan)).status, 200);
  S.ctx.settings.set('change.approvers', approverIds.join(','));
  assert.equal((await anna('POST', `/api/tickets/${key}/change/transition`, { to: 'approval' })).status, 200);
  return key;
}

test('Closing as duplicate requires agent rights on the original (and along the chain)', async () => {
  const itKey = await changeInApproval('Geheimer IT-Change', [S.ids.hma]);
  assert.equal((await hma('GET', `/api/tickets/${itKey}`)).status, 200, 'hma sees the change as approver');
  const hmKey = (await zoe('POST', '/api/tickets', { title: 'Heizung', projectId: HM })).body.ticket.key;
  const r = await hma('POST', `/api/tickets/${hmKey}/resolve`, { resolution: 'duplicate', duplicateOf: itKey, addToOriginal: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'err.duplicateTarget');
  assert.equal((await zoe('GET', `/api/tickets/${itKey}`)).status, 404, 'zoe did not become a participant');
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM ticket_links WHERE kind='duplicates'").get().n, 0);
  // Bulk resolve: the same rule, reported per ticket
  const b = await hma('POST', '/api/tickets/bulk', { keys: [hmKey], resolve: { resolution: 'duplicate', duplicateOf: itKey, addToOriginal: true } });
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.ok, []);
  assert.equal(b.body.failed.length, 1);
  assert.equal((await zoe('GET', `/api/tickets/${itKey}`)).status, 404);
  // Chain: HM ticket closed (by an admin) as duplicate of the IT change – hma may not follow it there
  const hmA = (await zoe('POST', '/api/tickets', { title: 'Heizung 2', projectId: HM })).body.ticket.key;
  assert.equal((await S.admin('POST', `/api/tickets/${hmA}/resolve`, { resolution: 'duplicate', duplicateOf: itKey })).status, 200);
  const c = await hma('POST', `/api/tickets/${hmKey}/resolve`, { resolution: 'duplicate', duplicateOf: hmA, addToOriginal: true });
  assert.equal(c.status, 400);
  assert.equal(c.body.error.code, 'err.duplicateTarget');
  assert.equal((await zoe('GET', `/api/tickets/${itKey}`)).status, 404);
  // Within the own project it still works
  const hmB = (await zoe('POST', '/api/tickets', { title: 'Heizung 3', projectId: HM })).body.ticket.key;
  assert.equal((await hma('POST', `/api/tickets/${hmB}/resolve`, { resolution: 'duplicate', duplicateOf: hmKey })).status, 200);
});

test('Change approval: approvers without rights on the change project can decide and the phase moves on', async () => {
  // Approver who works on another project only
  const k1 = await changeInApproval('FW', [S.ids.hma]);
  const d = (await hma('GET', `/api/tickets/${k1}`)).body.ticket;
  assert.equal(d.change?.canDecide, true, 'decision offered to the approver');
  assert.equal(d.fields, undefined, 'no plan fields for a non-agent');
  let r = await hma('POST', `/api/tickets/${k1}/approval`, { decision: 'approve' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let tk = (await anna('GET', `/api/tickets/${k1}`)).body.ticket;
  assert.equal(tk.change.phase, 'approved');
  assert.deepEqual(tk.change.next, ['scheduled', 'implementing']);
  // Approver without any project (plain user), rejecting
  const k2 = await changeInApproval('FW2', [S.ids.plain]);
  r = await plain('POST', `/api/tickets/${k2}/approval`, { decision: 'reject', comment: 'zu riskant' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  tk = (await anna('GET', `/api/tickets/${k2}`)).body.ticket;
  assert.equal(tk.change.phase, 'rejected');
  assert.equal(tk.status, 'done');
  // Someone who is not an approver: refused
  const k3 = await changeInApproval('FW3', [S.ids.plain]);
  assert.equal((await zoe('POST', `/api/tickets/${k3}/approval`, { decision: 'approve' })).status, 404);
  assert.equal((await hma('POST', `/api/tickets/${k3}/approval`, { decision: 'approve' })).status, 404);
});

test('Forgot password (mode "users"): no mail for users who work on a project', async () => {
  S.ctx.settings.set('register.passwordReset', 'users');
  const anon = S.client();
  sent.length = 0;
  assert.deepEqual((await anon('POST', '/api/auth/password/forgot', { email: 'hma@firma.local' })).body, { ok: true });
  await tick();
  assert.equal(sent.filter((m) => m.to === 'hma@firma.local').length, 0, 'no reset link that would never work');
  // A plain user still gets one, and it works
  await S.user('eva', 'user');
  assert.deepEqual((await anon('POST', '/api/auth/password/forgot', { email: 'eva@firma.local' })).body, { ok: true });
  await tick();
  const mail = sent.find((m) => m.to === 'eva@firma.local');
  assert.ok(mail);
  const token = mail.text.match(/#([A-Za-z0-9_-]{20,})/)[1];
  assert.equal((await anon('POST', '/api/auth/password/reset', { token, password: 'NeuesKennwort1' })).status, 200);
  S.db.prepare("UPDATE users SET password_hash=NULL WHERE username IN ('zoe','plain','eva')").run();
  // Only admins, legacy agents and project agents left with a password: no link on the sign-in page
  assert.equal((await anon('GET', '/api/bootstrap')).body.auth.passwordReset, false);
});

test('Admin person pickers (GET /api/users) include users who work on a project', async () => {
  const names = (await S.admin('GET', '/api/users')).body.users.map((u) => u.username);
  assert.ok(names.includes('hma'), JSON.stringify(names));
  assert.ok(names.includes('admin') && names.includes('anna'));
  assert.ok(!names.includes('zoe') && !names.includes('plain') && !names.includes('eva'), 'plain users are not agents');
  // Consistent with a project agent's own list
  const own = (await hma('GET', '/api/users')).body.users.map((u) => u.username);
  assert.ok(own.includes('hma') && !own.includes('zoe'));
});

test('The legacy role agent cannot be given out any more, but stays on accounts that have it', async () => {
  const c = await S.admin('POST', '/api/users', { username: 'neu', displayName: 'Neu', email: 'neu@firma.local', role: 'agent', password: 'Sehrgeheim123' });
  assert.equal(c.status, 400);
  assert.equal(S.db.prepare("SELECT 1 FROM users WHERE username='neu'").get(), undefined);
  const p = await S.admin('PATCH', `/api/users/${S.ids.zoe}`, { role: 'agent' });
  assert.equal(p.status, 400);
  assert.equal(S.db.prepare('SELECT role FROM users WHERE id=?').get(S.ids.zoe).role, 'user');
  // An existing legacy agent: saving with its current role still works
  const k = await S.admin('PATCH', `/api/users/${S.ids.anna}`, { role: 'agent', displayName: 'Anna A.' });
  assert.equal(k.status, 200);
  assert.equal(k.body.user.role, 'agent');
});

test('An internal note is never downgraded to a public reply', async () => {
  const hmKey = (await zoe('POST', '/api/tickets', { title: 'Licht', projectId: HM })).body.ticket.key;
  const ownIt = (await hma('POST', '/api/tickets', { title: 'Mein Laptop', projectId: 1 })).body.ticket.key;
  const countComments = (key) => S.db.prepare(`SELECT COUNT(*) n FROM comments c JOIN tickets t ON t.id=c.ticket_id JOIN projects p ON p.id=t.project_id
    WHERE p.key=? AND t.number=?`).get(key.split('-')[0], Number(key.split('-')[1])).n;
  // Single comment on the own request in a foreign project: refused
  const s = await hma('POST', `/api/tickets/${ownIt}/comments`, { body: 'INTERN: Kennwort xyz', internal: true });
  assert.equal(s.status, 403);
  assert.equal(countComments(ownIt), 0);
  // Bulk over mixed tickets: the foreign one is skipped with an error, nothing public is written
  sent.length = 0;
  const b = await hma('POST', '/api/tickets/bulk', { keys: [hmKey, ownIt], comment: 'INTERN: Kennwort xyz', internal: true });
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.ok, [hmKey]);
  assert.deepEqual(b.body.failed.map((f) => f.key), [ownIt]);
  assert.equal(countComments(ownIt), 0);
  const note = (await hma('GET', `/api/tickets/${hmKey}`)).body.ticket.comments.find((c) => c.body.includes('Kennwort'));
  assert.equal(note.internal, true);
  await tick();
  assert.ok(!sent.some((m) => String(m.text).includes('Kennwort xyz')), 'nothing mailed');
});

test('2FA level "agents" applies to running sessions of project agents', async () => {
  S.ctx.settings.set('mfa.external', 'agents');
  S.ctx.settings.set('mfa.internal', 'none');
  const late = await S.user('late', 'user'); // signed in as a plain user, made a project agent afterwards
  await S.admin('PUT', `/api/projects/${HM}/agents`, { members: [{ userId: S.ids.hma }, { userId: S.ids.late }] });
  assert.equal((await hma('GET', '/api/tickets')).status, 200, 'internal: no 2FA required');
  // The same sessions are now used from outside
  S.ctx.settings.set('mfa.internalNetworks', '10.99.0.0/16');
  for (const c of [anna, hma, late]) {
    const r = await c('GET', '/api/tickets');
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'err.mfaRequired');
  }
  // A plain user is not affected
  assert.equal((await zoe('GET', '/api/tickets')).status, 200);
});
