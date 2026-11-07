// Resolutions of done tickets: rejected (reason required, goes to the reporter instead of the
// "Resolved" mail, no survey) and duplicate (linked with the original, standard note). Bulk,
// filter, reopening, reports, catalog rejection and the import mapping.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let lisa;
const sent = [];
const wait = () => new Promise((r) => setTimeout(r, 60));
const mailsTo = (to) => sent.filter((m) => m.to === to);
before(async () => {
  S = await startServer('resolutions');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  lisa = await S.user('lisa', 'user');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  S.ctx.settings.set('survey.enabled', true);
});
after(() => S.stop());
const mk = async (who, title) => (await who('POST', '/api/tickets', { title })).body.ticket;
const get = async (key) => (await S.admin('GET', `/api/tickets/${key}`)).body.ticket;

test('reject: reason required, reply instead of "Resolved" mail, no survey, history', async () => {
  const tk = await mk(karl, 'Bitte Spielekonsole für die Teeküche');
  assert.equal((await anna('POST', `/api/tickets/${tk.key}/resolve`, { resolution: 'rejected', reason: '  ' })).status, 400);
  assert.equal((await karl('POST', `/api/tickets/${tk.key}/resolve`, { resolution: 'rejected', reason: 'x' })).status, 403, 'users may not');
  assert.equal((await anna('POST', `/api/tickets/${tk.key}/resolve`, { resolution: 'magic', reason: 'x' })).status, 400);
  await wait(); sent.length = 0;
  const r = await anna('POST', `/api/tickets/${tk.key}/resolve`, { resolution: 'rejected', reason: 'Hallo {melder}, das ist leider nicht vorgesehen.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.status, 'done');
  assert.equal(r.body.ticket.resolution, 'rejected');
  await wait();
  const m = mailsTo('karl@firma.local');
  assert.equal(m.length, 1, 'only the reply');
  assert.match(m[0].text, /Hallo karl, das ist leider nicht vorgesehen/);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM ticket_ratings WHERE ticket_id=?').get(tk.id).n, 0, 'no survey');
  const act = (await get(tk.key)).activity.find((a) => a.action === 'resolution');
  assert.equal(act.field, 'rejected');
  // users see it as rejected too
  assert.equal((await karl('GET', `/api/tickets/${tk.key}`)).body.ticket.resolution, 'rejected');
});

test('duplicate: original required, linked, standard note, optional participants on the original', async () => {
  const orig = await mk(lisa, 'Drucker im 2. OG druckt nicht');
  const dup = await mk(karl, 'Drucker 2. Stock geht nicht');
  assert.equal((await anna('POST', `/api/tickets/${dup.key}/resolve`, { resolution: 'duplicate' })).status, 400);
  assert.equal((await anna('POST', `/api/tickets/${dup.key}/resolve`, { resolution: 'duplicate', duplicateOf: dup.key })).status, 400, 'not itself');
  assert.equal((await anna('POST', `/api/tickets/${dup.key}/resolve`, { resolution: 'duplicate', duplicateOf: 'IT-9999' })).status, 400);
  await wait(); sent.length = 0;
  const r = await anna('POST', `/api/tickets/${dup.key}/resolve`, { resolution: 'duplicate', duplicateOf: orig.key.toLowerCase(), addToOriginal: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.resolution, 'duplicate');
  assert.equal(r.body.ticket.duplicateOf, orig.key);
  await wait();
  const m = mailsTo('karl@firma.local');
  assert.equal(m.length, 1);
  assert.match(m[0].text, new RegExp(`bereits im Ticket ${orig.key}`));
  const o = await get(orig.key);
  assert.ok(o.links.some((l) => l.ticket.key === dup.key), 'linked');
  assert.ok(o.participants.some((p) => p.id === S.ids.karl), 'karl follows the original');
  assert.equal((await karl('GET', `/api/tickets/${orig.key}`)).status, 200);
  // the original cannot become a duplicate of its own duplicate
  assert.equal((await anna('POST', `/api/tickets/${orig.key}/resolve`, { resolution: 'duplicate', duplicateOf: dup.key })).status, 400);
});

test('already done: changing the resolution; a reply from the reporter reopens and clears it', async () => {
  const tk = await mk(karl, 'Monitor flackert');
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  assert.equal((await get(tk.key)).resolution, 'done');
  const r = await anna('POST', `/api/tickets/${tk.key}/resolve`, { resolution: 'rejected', reason: 'Kein Defekt, Einstellung angepasst.' });
  assert.equal(r.body.ticket.resolution, 'rejected');
  await karl('POST', `/api/tickets/${tk.key}/comments`, { body: 'Flackert immer noch!' });
  const t2 = await get(tk.key);
  assert.equal(t2.status, 'open');
  assert.equal(t2.resolution, null);
  assert.equal(S.db.prepare('SELECT resolution FROM tickets WHERE id=?').get(tk.id).resolution, null);
});

test('bulk: reject several with one reason (placeholders per ticket), filter by resolution', async () => {
  const a = await mk(karl, 'Wunsch A'); const b = await mk(lisa, 'Wunsch B');
  assert.equal((await anna('POST', '/api/tickets/bulk', { keys: [a.key, b.key], resolve: { resolution: 'rejected' } })).status, 400, 'reason required');
  assert.equal((await anna('POST', '/api/tickets/bulk', { keys: [a.key], comment: 'x', internal: true, resolve: { resolution: 'rejected' } })).status, 400, 'reason is a reply');
  await wait(); sent.length = 0;
  const r = await anna('POST', '/api/tickets/bulk', { keys: [a.key, b.key], comment: 'Hallo {melder}, leider nein.', resolve: { resolution: 'rejected' } });
  assert.deepEqual(r.body.ok.sort(), [a.key, b.key].sort());
  await wait();
  assert.match(mailsTo('lisa@firma.local').map((m) => m.text).join(), /Hallo lisa, leider nein/);
  const rejected = (await anna('GET', '/api/tickets?status=done&resolution=rejected')).body.tickets.map((x) => x.key);
  assert.ok(rejected.includes(a.key) && rejected.includes(b.key));
  const done = (await anna('GET', '/api/tickets?resolution=done')).body.tickets.map((x) => x.key);
  assert.ok(!done.includes(a.key));
  // bulk duplicate with the standard note
  const c = await mk(karl, 'Drucker auch kaputt');
  const orig = (await anna('GET', '/api/tickets?q=Drucker%20OG')).body.tickets[0];
  const r2 = await anna('POST', '/api/tickets/bulk', { keys: [c.key], resolve: { resolution: 'duplicate', duplicateOf: orig.key } });
  assert.deepEqual(r2.body.ok, [c.key]);
  assert.equal((await get(c.key)).duplicateOf, orig.key);
});

test('reports: rejected and duplicates are counted apart and do not count towards the resolution time', async () => {
  const comp = (await S.admin('POST', `/api/projects/${(await S.admin('GET', '/api/projects')).body.projects[0].id}/components`, { name: 'Wünsche' })).body.component;
  const x = await mk(karl, 'Wunsch X'); const y = await mk(karl, 'Wunsch Y');
  for (const k of [x.key, y.key]) await anna('PATCH', `/api/tickets/${k}`, { componentId: comp.id });
  S.db.prepare("UPDATE tickets SET created_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(y.id);
  await anna('PATCH', `/api/tickets/${x.key}`, { status: 'done' });
  await anna('POST', `/api/tickets/${y.key}/resolve`, { resolution: 'rejected', reason: 'nein' });
  const rep = (await anna('GET', '/api/reports?from=2025-12-01')).body;
  const row = rep.components.find((r) => r.componentId === comp.id);
  assert.equal(row.resolved, 2);
  assert.equal(row.rejected, 1);
  assert.ok(row.avgResolutionHours < 24, 'the old rejected one does not drag the average');
});

test('catalog: a rejected approval closes the request as rejected', async () => {
  const item = (await S.admin('POST', '/api/catalog', { title: 'Software', fields: [], approverIds: [S.ids.anna] })).body.item;
  const tk = (await karl('POST', `/api/catalog/${item.id}/order`, { answers: {} })).body.ticket;
  await anna('POST', `/api/tickets/${tk.key}/approval`, { decision: 'reject', comment: 'Keine Lizenz' });
  const t2 = await get(tk.key);
  assert.equal(t2.status, 'done');
  assert.equal(t2.resolution, 'rejected');
});

test('import: resolution from Jira resolution or status name', async () => {
  const { suggestResolution } = await import('../src/import/core.js');
  assert.equal(suggestResolution("Won't Do", 'Done'), 'rejected');
  assert.equal(suggestResolution('Declined', ''), 'rejected');
  assert.equal(suggestResolution('', 'Abgelehnt'), 'rejected');
  assert.equal(suggestResolution('Duplicate', 'Closed'), 'duplicate');
  assert.equal(suggestResolution('Fixed', 'Done'), 'done');
  assert.equal(suggestResolution('', ''), 'done');
});
