// Links and subtasks
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; const k = {};
before(async () => {
  S = await startServer('links');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  for (const n of ['a', 'b', 'c', 'd']) k[n] = (await karl('POST', '/api/tickets', { title: `Ticket ${n}` })).body.ticket.key;
});
after(() => S.stop());

test('Linking in both directions, with activity; users see nothing', async () => {
  let r = await anna('POST', `/api/tickets/${k.a}/links`, { kind: 'blocks', target: k.b.toLowerCase() });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.links.map((l) => [l.kind, l.direction, l.ticket.key]), [['blocks', 'out', k.b]]);
  const b = (await anna('GET', `/api/tickets/${k.b}`)).body.ticket;
  assert.deepEqual(b.links.map((l) => [l.kind, l.direction, l.ticket.key]), [['blocks', 'in', k.a]]);
  assert.ok(b.activity.some((x) => x.action === 'linked' && x.field === 'blocks:in' && x.newValue === k.a));
  assert.equal((await karl('GET', `/api/tickets/${k.b}`)).body.ticket.links, undefined, 'users do not see links');
  assert.equal((await karl('POST', `/api/tickets/${k.a}/links`, { kind: 'relates', target: k.c })).status, 403);
});

test('Error cases: self, duplicate, unknown, wrong kind', async () => {
  assert.equal((await anna('POST', `/api/tickets/${k.a}/links`, { kind: 'relates', target: k.a })).body.error.code, 'err.linkSelf');
  assert.equal((await anna('POST', `/api/tickets/${k.b}/links`, { kind: 'relates', target: k.a })).body.error.code, 'err.linkExists', 'also reversed');
  assert.equal((await anna('POST', `/api/tickets/${k.a}/links`, { kind: 'relates', target: 'IT-999' })).body.error.code, 'err.linkTarget');
  assert.equal((await anna('POST', `/api/tickets/${k.a}/links`, { kind: 'gibtsnicht', target: k.c })).status, 400);
});

test('Subtasks: create, only one parent, no cycles', async () => {
  const r = await anna('POST', `/api/tickets/${k.c}/subtasks`, { title: 'Treiber installieren' });
  assert.equal(r.status, 201);
  assert.equal(r.body.ticket.type, 'task');
  const sub = r.body.ticket.key;
  assert.deepEqual(r.body.links.map((l) => [l.kind, l.direction, l.ticket.key]), [['parent', 'out', sub]]);
  // d as subtask of c (from d's view: "parent" = is subtask of)
  assert.equal((await anna('POST', `/api/tickets/${k.d}/links`, { kind: 'parent', target: k.c })).status, 201);
  assert.equal((await anna('POST', `/api/tickets/${k.d}/links`, { kind: 'parent', target: k.a })).body.error.code, 'err.linkOneParent');
  // c as subtask of a sub-subtask → cycle
  const sub2 = (await anna('POST', `/api/tickets/${sub}/subtasks`, { title: 'Test' })).body.ticket.key;
  assert.equal((await anna('POST', `/api/tickets/${k.c}/links`, { kind: 'parent', target: sub2 })).body.error.code, 'err.linkCycle');
  const c = (await anna('GET', `/api/tickets/${k.c}`)).body.ticket;
  assert.equal(c.links.filter((l) => l.kind === 'parent' && l.direction === 'out').length, 2);
});

test('Removal with activity; only via one of the two tickets', async () => {
  const a = (await anna('GET', `/api/tickets/${k.a}`)).body.ticket;
  const id = a.links[0].id;
  assert.equal((await anna('DELETE', `/api/tickets/${k.c}/links/${id}`)).status, 404, 'unrelated ticket');
  const r = await anna('DELETE', `/api/tickets/${k.a}/links/${id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.links, []);
  assert.ok((await anna('GET', `/api/tickets/${k.b}`)).body.ticket.activity.some((x) => x.action === 'unlinked' && x.oldValue === k.a));
});

test('Suggestions: possible cause (open problems, major incidents) and similar tickets', async () => {
  const { significantWords } = await import('../src/itil/links.js');
  const w = significantWords([{ title: 'Drucker im 2. OG druckt nicht', text: 'Hallo, der Drucker zeigt Toner leer. Bitte' }]);
  assert.deepEqual(w.slice(0, 2), ['drucker', 'druckt'], 'title words count most');
  assert.ok(w.includes('toner') && !w.includes('hallo') && !w.includes('bitte') && !w.includes('nicht'), 'filler words left out');
  const problem = (await anna('POST', '/api/tickets', { title: 'Druckserver hängt', type: 'problem' })).body.ticket.key;
  const closedProblem = (await anna('POST', '/api/tickets', { title: 'Alter Fehler', type: 'problem' })).body.ticket.key;
  await anna('PATCH', `/api/tickets/${closedProblem}`, { status: 'done' });
  const p1 = (await karl('POST', '/api/tickets', { title: 'Drucker im 2. OG druckt nicht', description: 'Toner leer' })).body.ticket.key;
  const p2 = (await karl('POST', '/api/tickets', { title: 'Drucker Toner wechseln', description: 'Der Toner ist leer' })).body.ticket.key;
  const other = (await karl('POST', '/api/tickets', { title: 'Outlook startet nicht', description: 'Fehlermeldung beim Start' })).body.ticket.key;
  let r = await anna('GET', `/api/link-suggestions?keys=${p1}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.causes.some((x) => x.key === problem && x.type === 'problem'));
  assert.ok(!r.body.causes.some((x) => x.key === closedProblem), 'finished problems are no candidates');
  assert.deepEqual(r.body.similar.map((x) => x.key), [p2], 'similar, without itself and unrelated tickets');
  assert.ok(!r.body.similar.some((x) => x.key === other));
  // Already linked: not suggested again
  await anna('POST', `/api/tickets/${p1}/links`, { kind: 'relates', target: p2 });
  r = await anna('GET', `/api/link-suggestions?keys=${p1}`);
  assert.ok(!r.body.similar.some((x) => x.key === p2));
  // Multi-select: words of all selected tickets, they themselves left out
  r = await anna('GET', `/api/link-suggestions?keys=${p1},${p2}`);
  assert.ok(!r.body.similar.some((x) => x.key === p1 || x.key === p2));
  // Agents only; unknown keys are ignored
  assert.equal((await karl('GET', `/api/link-suggestions?keys=${p1}`)).status, 403);
  assert.equal((await anna('GET', '/api/link-suggestions?keys=XX-1')).status, 200);
});
