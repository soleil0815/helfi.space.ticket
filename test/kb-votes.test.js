// Knowledge articles: "Was this article helpful?" – votes, notes for agents, reset, "needs rework"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let otto; let pub; let int; let other;
before(async () => {
  S = await startServer('kbvotes');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  otto = await S.user('otto', 'user');
  pub = (await anna('POST', '/api/kb', { title: 'VPN einrichten', body: 'Schritt 1', visibility: 'public' })).body.article;
  other = (await anna('POST', '/api/kb', { title: 'Drucker', body: 'x', visibility: 'public' })).body.article;
  int = (await anna('POST', '/api/kb', { title: 'Intern', body: 'x', visibility: 'internal' })).body.article;
});
after(() => S?.stop());

test('Vote, change, withdraw; counts and the own vote come with the article', async () => {
  let r = await karl('POST', `/api/kb/${pub.id}/vote`, { vote: 1 });
  assert.deepEqual(r.body.rating, { up: 1, down: 0, mine: 1 });
  r = await otto('POST', `/api/kb/${pub.id}/vote`, { vote: -1 });
  assert.deepEqual(r.body.rating, { up: 1, down: 1, mine: -1 });
  r = await karl('POST', `/api/kb/${pub.id}/vote`, { vote: -1 });
  assert.deepEqual(r.body.rating, { up: 0, down: 2, mine: -1 }, 'changed, not counted twice');
  r = await karl('POST', `/api/kb/${pub.id}/vote`, { vote: 0 });
  assert.deepEqual(r.body.rating, { up: 0, down: 1, mine: 0 }, 'withdrawn');
  const a = (await karl('GET', `/api/kb/${pub.id}`)).body.article;
  assert.deepEqual(a.rating, { up: 0, down: 1, mine: 0 });
  assert.equal((await anna('GET', `/api/kb/${pub.id}`)).body.article.rating.feedback, 0, 'agents also get the number of notes');
  assert.equal((await karl('POST', `/api/kb/${pub.id}/vote`, { vote: 5 })).status, 400);
});

test('Users cannot rate internal articles; notes only with "not helpful" and only agents read them', async () => {
  assert.equal((await karl('POST', `/api/kb/${int.id}/vote`, { vote: 1 })).status, 404);
  assert.equal((await karl('POST', `/api/kb/${pub.id}/feedback`, { body: 'Schritt 2 fehlt' })).status, 400, 'no "not helpful" vote');
  await karl('POST', `/api/kb/${pub.id}/vote`, { vote: -1 });
  assert.equal((await karl('POST', `/api/kb/${pub.id}/feedback`, { body: '   ' })).status, 400);
  assert.equal((await karl('POST', `/api/kb/${pub.id}/feedback`, { body: 'Schritt 2 fehlt' })).status, 201);
  assert.equal((await karl('GET', `/api/kb/${pub.id}/feedback`)).status, 403, 'users never read notes');
  const fb = (await anna('GET', `/api/kb/${pub.id}/feedback`)).body;
  assert.deepEqual(fb.current.map((f) => [f.body, f.author]), [['Schritt 2 fehlt', 'karl']]);
  // Notes are not part of the public comments
  assert.ok(!(await karl('GET', `/api/kb/${pub.id}/comments`)).body.comments.some((c) => c.body.includes('Schritt 2')));
});

test('Agents: rating in the list, "needs rework" filter, reset keeps the notes as earlier', async () => {
  await karl('POST', `/api/kb/${other.id}/vote`, { vote: 1 });
  const list = (await anna('GET', '/api/kb')).body.articles;
  assert.deepEqual(list.find((a) => a.id === pub.id).rating, { up: 0, down: 2 });
  assert.equal((await karl('GET', '/api/kb')).body.articles[0].rating, undefined, 'users do not get counts in the list');
  const need = (await anna('GET', '/api/kb?sort=needsWork')).body.articles;
  assert.deepEqual(need.map((a) => a.id), [pub.id], 'only articles with "not helpful" votes');
  assert.equal((await karl('POST', `/api/kb/${pub.id}/rating/reset`)).status, 403);
  const r = await anna('POST', `/api/kb/${pub.id}/rating/reset`);
  assert.deepEqual(r.body.rating, { up: 0, down: 0, mine: 0, feedback: 0 });
  const fb = (await anna('GET', `/api/kb/${pub.id}/feedback`)).body;
  assert.equal(fb.current.length, 0);
  assert.equal(fb.earlier.length, 1);
  assert.equal((await karl('GET', `/api/kb/${pub.id}`)).body.article.rating.mine, 0, 'own vote gone after reset');
});

test('Limits: notes per person, votes per time', async () => {
  await otto('POST', `/api/kb/${other.id}/vote`, { vote: -1 });
  for (let i = 0; i < 5; i++) assert.equal((await otto('POST', `/api/kb/${other.id}/feedback`, { body: `Notiz ${i}` })).status, 201);
  assert.equal((await otto('POST', `/api/kb/${other.id}/feedback`, { body: 'zu viel' })).status, 429);
  let last;
  for (let i = 0; i < 70; i++) last = await karl('POST', `/api/kb/${other.id}/vote`, { vote: i % 2 ? 1 : -1 });
  assert.equal(last.status, 429);
});
