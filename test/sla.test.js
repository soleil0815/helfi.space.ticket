// SLA: Geschäftszeiten, Uhren, Pause bei „Wartet“, Warnungen
process.env.TZ = 'Europe/Berlin';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

const L = (s) => new Date(s).getTime(); // lokale Zeit (Europe/Berlin)
let M; let S; let anna; let karl;
before(async () => {
  M = await import('../src/itil/sla.js');
  S = await startServer('sla');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
});
after(() => S.stop());

test('Geschäftsminuten und Fälligkeit (Mo–Fr 8–17 Uhr, Feiertag)', () => {
  const cal = M.calendarFrom('{"days":[1,2,3,4,5],"start":"08:00","end":"17:00"}', '2026-11-04 Testfeiertag\nkein Datum');
  assert.equal(M.businessMinutes(L('2026-11-02T07:00'), L('2026-11-02T09:00'), cal), 60, 'vor Arbeitsbeginn zählt nicht');
  assert.equal(M.businessMinutes(L('2026-11-06T16:00'), L('2026-11-09T09:00'), cal), 120, 'Wochenende zählt nicht');
  assert.equal(M.businessMinutes(L('2026-11-03T16:00'), L('2026-11-05T09:00'), cal), 120, 'Feiertag zählt nicht');
  assert.equal(M.businessMinutes(L('2026-11-02T10:00'), L('2026-11-02T09:00'), cal), 0);
  assert.equal(M.addBusinessMinutes(L('2026-11-06T16:30'), 60, cal), L('2026-11-09T08:30'));
  assert.equal(M.addBusinessMinutes(L('2026-11-07T12:00'), 30, cal), L('2026-11-09T08:30'), 'Start am Samstag');
  assert.equal(M.addBusinessMinutes(L('2026-11-02T10:00'), 60, M.calendarFrom('{"days":[]}', '')), null, 'kein Arbeitstag');
});

test('Uhren: erste Reaktion, Lösung, Pause bei „Wartet“, Warnungen einmalig', async () => {
  S.ctx.settings.setMany({ 'sla.enabled': true, 'sla.holidays': '' });
  const tk = (await karl('POST', '/api/tickets', { title: 'Drucker', priority: 'highest' })).body.ticket;
  await anna('PATCH', `/api/tickets/${tk.key}`, { priority: 'highest' });
  // Erstellt Mo 08:00
  S.db.prepare('UPDATE tickets SET created_at=? WHERE id=?').run(new Date(L('2026-11-02T08:00')).toISOString(), tk.id);
  const row = () => S.ctx.tickets.rawById(tk.id);
  let s = S.ctx.sla.forRow(row(), L('2026-11-02T08:20'));
  assert.equal(s.response.state, 'ok');
  assert.equal(s.response.remaining, 10);
  assert.equal(s.response.due, new Date(L('2026-11-02T08:30')).toISOString());
  assert.equal(S.ctx.sla.forRow(row(), L('2026-11-02T08:25')).response.state, 'warning', 'ab 80 %');
  assert.equal(S.ctx.sla.forRow(row(), L('2026-11-02T08:31')).response.state, 'breached');
  // Warnungen werden je Stufe nur einmal festgehalten
  assert.equal(S.ctx.sla.check(L('2026-11-02T08:31')), 1);
  assert.equal(S.ctx.sla.check(L('2026-11-02T08:32')), 0);
  assert.ok((await anna('GET', `/api/tickets/${tk.key}`)).body.ticket.activity.some((a) => a.action === 'sla' && a.field === 'response' && a.newValue === 'breached'));
  // Antwort eines Bearbeiters stoppt die Reaktionsuhr
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Ich schaue es mir an.' });
  S.db.prepare('UPDATE comments SET created_at=? WHERE ticket_id=?').run(new Date(L('2026-11-02T08:40')).toISOString(), tk.id);
  s = S.ctx.sla.forRow(row(), L('2026-11-02T12:00'));
  assert.equal(s.response.state, 'missed');
  assert.equal(s.response.elapsed, 40);
  // Wartet von 09:00 bis 11:00 → Lösung zählt 1 h + 1 h
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'waiting' });
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'in_progress' });
  const acts = S.db.prepare("SELECT id FROM activity WHERE ticket_id=? AND field='status' ORDER BY id").all(tk.id);
  S.db.prepare('UPDATE activity SET created_at=? WHERE id=?').run(new Date(L('2026-11-02T09:00')).toISOString(), acts[0].id);
  S.db.prepare('UPDATE activity SET created_at=? WHERE id=?').run(new Date(L('2026-11-02T11:00')).toISOString(), acts[1].id);
  s = S.ctx.sla.forRow(row(), L('2026-11-02T12:00'));
  assert.equal(s.resolve.elapsed, 120);
  assert.equal(s.resolve.state, 'ok');
});

test('Nicht anwendbar: Aufgaben und eigene Tickets der Bearbeiter; SLA aus', async () => {
  const task = (await anna('POST', '/api/tickets', { title: 'Wartung', type: 'task' })).body.ticket;
  assert.equal(S.ctx.sla.forRow(S.ctx.tickets.rawById(task.id)), null);
  const own = (await anna('POST', '/api/tickets', { title: 'Eigenes', type: 'incident' })).body.ticket;
  assert.equal(S.ctx.sla.forRow(S.ctx.tickets.rawById(own.id)), null);
  assert.equal((await karl('GET', `/api/tickets/${task.key}`)).status, 404);
});

test('Liste: SLA-Stand, Filter „gefährdet“, Zähler; Benutzer sehen nichts', async () => {
  const fresh = (await karl('POST', '/api/tickets', { title: 'Neu', priority: 'low' })).body.ticket;
  const all = (await anna('GET', '/api/tickets')).body.tickets;
  assert.equal(all.find((x) => x.key === fresh.key).sla.state, 'ok');
  const old = (await karl('POST', '/api/tickets', { title: 'Alt' })).body.ticket;
  S.db.prepare('UPDATE tickets SET created_at=? WHERE id=?').run('2026-10-01T08:00:00.000Z', old.id);
  const risk = (await anna('GET', '/api/tickets?sla=risk')).body.tickets;
  assert.ok(risk.some((x) => x.key === old.key) && risk.every((x) => ['warning', 'breached'].includes(x.sla.state)));
  assert.equal((await anna('GET', '/api/queues')).body.counts.slaRisk, risk.length);
  assert.equal((await karl('GET', '/api/tickets')).body.tickets[0].sla, undefined);
  assert.equal((await karl('GET', `/api/tickets/${fresh.key}`)).body.ticket.sla, undefined);
  S.ctx.settings.set('sla.enabled', false);
  assert.equal((await anna('GET', '/api/tickets')).body.tickets[0].sla, undefined);
});
