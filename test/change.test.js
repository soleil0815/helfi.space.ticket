// Change management: phases, required fields, approval, emergency, standard, calendar
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let tom; let lena; let karl;
const plan = (start, end) => ({ reason: 'Sicherheitsupdate', risk: 'medium', plannedStart: start, plannedEnd: end, implementationPlan: '1. Sicherung 2. Update', backoutPlan: 'Snapshot zurückspielen', testPlan: 'Anmeldung testen' });
const tr = (c, key, to, extra = {}) => c('POST', `/api/tickets/${key}/change/transition`, { to, ...extra });
before(async () => {
  S = await startServer('change');
  anna = await S.user('anna', 'agent');
  tom = await S.user('tom', 'agent');
  lena = await S.user('lena', 'agent');
  karl = await S.user('karl', 'user');
});
after(() => S.stop());

test('Normal change: required fields, approval (one vote is enough), implementation, closure', async () => {
  const key = (await anna('POST', '/api/tickets', { title: 'Firewall-Update', type: 'change' })).body.ticket.key;
  let tk = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.change.phase, 'draft');
  assert.deepEqual(tk.change.next, ['approval']);
  // without approvers / without required fields
  let r = await tr(anna, key, 'approval');
  assert.equal(r.body.error.code, 'err.changeMissing');
  await anna('PATCH', `/api/tickets/${key}/fields`, { changeType: 'normal', ...plan('2026-11-07T08:00:00Z', '2026-11-07T10:00:00Z'), phase: 'closed' });
  assert.equal((await anna('GET', `/api/tickets/${key}`)).body.ticket.change.phase, 'draft', 'phase only via the workflow');
  assert.equal((await tr(anna, key, 'approval')).body.error.code, 'err.noApprovers');
  S.ctx.settings.set('change.approvers', `${S.ids.tom}, ${S.ids.lena}`);
  r = await tr(anna, key, 'approval');
  assert.equal(r.status, 200);
  tk = r.body.ticket;
  assert.equal(tk.change.phase, 'approval');
  assert.deepEqual(tk.change.approvals.items.map((a) => a.name), ['tom', 'lena']);
  assert.equal(tk.change.canDecide, false, 'requester is not an approver');
  assert.equal((await anna('POST', `/api/tickets/${key}/approval`, { decision: 'approve' })).status, 403);
  assert.equal((await tom('GET', '/api/approvals/mine')).body.tickets[0].key, key);
  r = await tom('POST', `/api/tickets/${key}/approval`, { decision: 'approve', comment: 'ok' });
  assert.equal(r.body.ticket.change.phase, 'approved');
  assert.equal((await tom('POST', `/api/tickets/${key}/approval`, { decision: 'reject' })).body.error.code, 'err.alreadyDecided');
  assert.deepEqual((await tom('GET', '/api/approvals/mine')).body.tickets, []);
  assert.equal((await tr(anna, key, 'implementing')).body.ticket.status, 'in_progress');
  await tr(anna, key, 'review');
  assert.equal((await tr(anna, key, 'closed', { outcome: 'rolledBack' })).body.error.code, 'err.changeMissing', 'review required');
  r = await tr(anna, key, 'closed', { outcome: 'rolledBack', review: 'Treiber inkompatibel, zurückgerollt' });
  assert.equal(r.body.ticket.change.phase, 'closed');
  assert.equal(r.body.ticket.status, 'done');
  assert.equal(r.body.ticket.fields.outcome, 'rolledBack');
  assert.ok(r.body.ticket.activity.some((a) => a.action === 'approval' && a.field === 'approve'));
  assert.equal((await tr(anna, key, 'draft')).body.error.code, 'err.changePhase');
});

test('All must approve; one rejection rejects; revising possible', async () => {
  S.ctx.settings.set('change.approvalMode', 'all');
  const key = (await anna('POST', '/api/tickets', { title: 'Mailserver', type: 'change' })).body.ticket.key;
  await anna('PATCH', `/api/tickets/${key}/fields`, plan('2026-11-07T09:00:00Z', '2026-11-07T11:00:00Z'));
  await tr(anna, key, 'approval');
  let r = await tom('POST', `/api/tickets/${key}/approval`, { decision: 'approve' });
  assert.equal(r.body.ticket.change.phase, 'approval', 'one of two votes');
  r = await lena('POST', `/api/tickets/${key}/approval`, { decision: 'reject', comment: 'Zeitfenster ungünstig' });
  assert.equal(r.body.ticket.change.phase, 'rejected');
  assert.equal((await tr(anna, key, 'draft')).body.ticket.status, 'open');
  r = await tr(anna, key, 'approval');
  assert.equal(r.body.ticket.change.approvals.round, 2, 'new round');
  S.ctx.settings.set('change.approvalMode', 'any');
});

test('Standard change without approval; emergency change immediately, approval afterwards', async () => {
  const std = (await anna('POST', '/api/tickets', { title: 'Switch-Firmware', type: 'change' })).body.ticket.key;
  await anna('PATCH', `/api/tickets/${std}/fields`, { changeType: 'standard', ...plan('2026-11-08T08:00:00Z', '2026-11-08T09:00:00Z') });
  assert.equal((await tr(anna, std, 'scheduled')).body.ticket.change.phase, 'scheduled');
  const em = (await anna('POST', '/api/tickets', { title: 'Notfall-Patch', type: 'change' })).body.ticket.key;
  await anna('PATCH', `/api/tickets/${em}/fields`, { changeType: 'emergency', implementationPlan: 'Patch einspielen', backoutPlan: 'Snapshot' });
  assert.equal((await tr(anna, em, 'implementing')).body.ticket.change.phase, 'implementing');
  const r = await anna('POST', `/api/tickets/${em}/change/request-approval`);
  assert.equal(r.body.ticket.change.approvals.round, 1);
  assert.equal(r.body.ticket.change.phase, 'implementing', 'phase stays');
  await tom('POST', `/api/tickets/${em}/approval`, { decision: 'approve' });
  assert.equal((await anna('GET', `/api/tickets/${em}`)).body.ticket.change.phase, 'implementing');
});

test('Calendar with overlaps; permissions', async () => {
  const db2 = (await anna('POST', '/api/tickets', { title: 'Datenbank', type: 'change' })).body.ticket.key;
  await anna('PATCH', `/api/tickets/${db2}/fields`, plan('2026-11-07T10:00:00Z', '2026-11-07T12:00:00Z'));
  const r = await anna('GET', '/api/changes/calendar?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z');
  const byTitle = Object.fromEntries(r.body.changes.map((c) => [c.title, c]));
  assert.ok(!byTitle['Firewall-Update'] || byTitle['Firewall-Update'].phase === 'closed');
  assert.deepEqual(byTitle.Mailserver.conflicts, [db2], 'overlap; closed ones do not count');
  assert.deepEqual(byTitle.Datenbank.conflicts.length, 1);
  assert.ok(byTitle['Switch-Firmware']);
  assert.equal((await karl('GET', '/api/changes/calendar?from=2026-11-01&to=2026-11-30')).status, 403);
  assert.equal((await anna('GET', '/api/changes/calendar?from=x&to=y')).status, 400);
  assert.equal((await karl('POST', '/api/tickets', { title: 'x', type: 'change' })).body.ticket.type, 'request');
});
