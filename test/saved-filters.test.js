// Saved filters and shared queues: personal per agent, shared by admins, counts, order, permissions
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let bert; let karl; let admin;
before(async () => {
  S = await startServer('filters');
  admin = S.admin;
  anna = await S.user('anna', 'agent');
  bert = await S.user('bert', 'agent');
  karl = await S.user('karl', 'user');
  await karl('POST', '/api/tickets', { title: 'Drucker kaputt', priority: 'high' });
  await karl('POST', '/api/tickets', { title: 'VPN', priority: 'high' });
  await karl('POST', '/api/tickets', { title: 'Maus', priority: 'low' });
});
after(() => S?.stop());

test('Query is normalised: allowed keys only, fixed order', async () => {
  const { normalizeQuery } = await import('../src/filters.js');
  assert.equal(normalizeQuery('?priority=high&evil=1&status=unresolved&sort=priority'), 'status=unresolved&priority=high&sort=priority');
  assert.equal(normalizeQuery({ assignee: 'me', q: '  drucker ' }), 'assignee=me&q=drucker');
  assert.equal(normalizeQuery(null), '');
});

test('Personal filters: create, count, rename, only the owner sees them', async () => {
  let r = await anna('POST', '/api/filters', { name: '  Dringend  offen ', query: 'status=unresolved&priority=high' });
  assert.equal(r.status, 201);
  const f = r.body.filter;
  assert.deepEqual([f.name, f.shared, f.canEdit], ['Dringend offen', false, true]);
  r = await anna('GET', '/api/filters');
  assert.deepEqual(r.body.filters.map((x) => [x.name, x.count]), [['Dringend offen', 2]]);
  assert.equal((await bert('GET', '/api/filters')).body.filters.length, 0, 'not visible to others');
  assert.equal((await bert('PATCH', `/api/filters/${f.id}`, { name: 'x' })).status, 404);
  assert.equal((await bert('DELETE', `/api/filters/${f.id}`)).status, 404);
  assert.equal((await anna('PATCH', `/api/filters/${f.id}`, { name: 'Hoch' })).body.filter.name, 'Hoch');
  assert.equal((await anna('POST', '/api/filters', { name: ' ', query: '' })).status, 400);
  assert.equal((await karl('GET', '/api/filters')).status, 403, 'users have no ticket list filters');
});

test('Shared queues: only admins create/edit them, all agents see them first', async () => {
  assert.equal((await anna('POST', '/api/filters', { name: 'Team', query: 'status=unresolved', shared: true })).status, 403);
  const q = (await admin('POST', '/api/filters', { name: 'Nicht zugewiesen, hoch', query: 'assignee=none&priority=high&status=unresolved', shared: true })).body.filter;
  assert.equal(q.shared, true);
  const list = (await anna('GET', '/api/filters')).body.filters;
  assert.deepEqual(list.map((x) => [x.name, x.shared, x.canEdit, x.count]), [['Nicht zugewiesen, hoch', true, false, 2], ['Hoch', false, true, 2]]);
  assert.equal((await anna('PATCH', `/api/filters/${q.id}`, { name: 'meins' })).status, 403);
  assert.equal((await anna('DELETE', `/api/filters/${q.id}`)).status, 403);
  // "me" in a shared queue means the viewer
  const mine = (await admin('POST', '/api/filters', { name: 'Meine', query: 'assignee=me', shared: true })).body.filter;
  const t1 = (await anna('GET', '/api/tickets')).body.tickets[0];
  await anna('PATCH', `/api/tickets/${t1.key}`, { assigneeId: S.ids.anna });
  const c = (who) => who('GET', '/api/filters').then((r) => r.body.filters.find((x) => x.id === mine.id).count);
  assert.equal(await c(anna), 1);
  assert.equal(await c(bert), 0);
});

test('Order and delete', async () => {
  const a = (await anna('POST', '/api/filters', { name: 'A', query: 'type=incident' })).body.filter;
  const b = (await anna('POST', '/api/filters', { name: 'B', query: 'type=task' })).body.filter;
  const r = await anna('POST', '/api/filters/order', { ids: [b.id, a.id] });
  assert.deepEqual(r.body.filters.filter((x) => !x.shared).map((x) => x.name), ['B', 'A', 'Hoch']);
  assert.equal((await anna('POST', '/api/filters/order', { ids: [], shared: true })).status, 403);
  assert.equal((await anna('DELETE', `/api/filters/${a.id}`)).status, 200);
  assert.ok(!(await anna('GET', '/api/filters')).body.filters.some((x) => x.id === a.id));
});
