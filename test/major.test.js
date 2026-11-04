// Impact × urgency and major incident
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';


let S; let anna; let karl; let erika;
before(async () => {
  S = await startServer('major');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  erika = await S.user('erika', 'user');
});
after(() => S.stop());

test('Priority from impact × urgency; can be overridden manually', async () => {
  const { PRIORITY_MATRIX } = await import('../src/tickets.js');
  assert.equal(PRIORITY_MATRIX.high.high, 'highest');
  assert.equal(PRIORITY_MATRIX.low.low, 'low');
  const key = (await karl('POST', '/api/tickets', { title: 'Drucker' })).body.ticket.key;
  let tk = (await anna('PATCH', `/api/tickets/${key}`, { impact: 'high' })).body.ticket;
  assert.equal(tk.priority, 'medium', 'only one of both → unchanged');
  tk = (await anna('PATCH', `/api/tickets/${key}`, { urgency: 'high' })).body.ticket;
  assert.equal(tk.priority, 'highest');
  tk = (await anna('PATCH', `/api/tickets/${key}`, { urgency: 'low' })).body.ticket;
  assert.equal(tk.priority, 'medium');
  tk = (await anna('PATCH', `/api/tickets/${key}`, { priority: 'low' })).body.ticket;
  assert.equal(tk.priority, 'low', 'overridden by hand');
  assert.equal((await anna('PATCH', `/api/tickets/${key}`, { impact: 'riesig' })).status, 400);
  // Users may not change this
  await karl('PATCH', `/api/tickets/${key}`, { impact: 'low', urgency: 'low' });
  const after = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(after.impact, 'high');
  assert.ok(after.activity.some((a) => a.field === 'urgency' && a.newValue === 'high'));
});

test('Major incident: banner for agents, message to all affected, resolve all', async () => {
  const major = (await anna('POST', '/api/tickets', { title: 'Netzwerk 2. OG gestört', type: 'incident' })).body.ticket.key;
  const k1 = (await karl('POST', '/api/tickets', { title: 'Kein Internet' })).body.ticket.key;
  const k2 = (await erika('POST', '/api/tickets', { title: 'Drucker offline' })).body.ticket.key;
  assert.equal((await anna('POST', `/api/tickets/${major}/broadcast`, { body: 'x' })).body.error.code, 'err.notMajor');
  await anna('PATCH', `/api/tickets/${major}`, { major: true });
  assert.deepEqual((await anna('GET', '/api/bootstrap')).body.majorIncidents.map((m) => m.key), [major]);
  assert.deepEqual((await karl('GET', '/api/bootstrap')).body.majorIncidents, [], 'users do not see the banner');
  for (const k of [k1, k2]) await anna('POST', `/api/tickets/${major}/links`, { kind: 'causes', target: k });
  assert.equal((await anna('GET', `/api/tickets/${major}`)).body.ticket.affectedCount, 2);
  assert.equal((await karl('POST', `/api/tickets/${major}/broadcast`, { body: 'x' })).status, 403);
  let r = await anna('POST', `/api/tickets/${major}/broadcast`, { body: 'Wir arbeiten daran.' });
  assert.deepEqual(r.body, { notified: 3, resolved: 0 });
  const c1 = (await karl('GET', `/api/tickets/${k1}`)).body.ticket.comments;
  assert.equal(c1.at(-1).body, 'Wir arbeiten daran.');
  assert.equal(c1.at(-1).internal, false);
  r = await anna('POST', `/api/tickets/${major}/broadcast`, { body: 'Behoben.', resolve: true });
  assert.deepEqual(r.body, { notified: 3, resolved: 3 });
  for (const k of [major, k1, k2]) assert.equal((await anna('GET', `/api/tickets/${k}`)).body.ticket.status, 'done');
  assert.deepEqual((await anna('GET', '/api/bootstrap')).body.majorIncidents, [], 'resolved → no banner anymore');
});
