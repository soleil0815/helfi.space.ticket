// ITIL-Kennzahlen: Wiedereröffnung, erster Kontakt, SLA-Einhaltung, Changes je Monat, Probleme
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl;
before(async () => {
  S = await startServer('itilrep');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
});
after(() => S.stop());

const done = (key) => anna('PATCH', `/api/tickets/${key}`, { status: 'done' });
const mk = async (title) => (await karl('POST', '/api/tickets', { title })).body.ticket.key;

test('Wiedereröffnung und Lösung beim ersten Kontakt', async () => {
  // 1) eine Antwort, erledigt → erster Kontakt
  const a = await mk('A');
  await anna('POST', `/api/tickets/${a}/comments`, { body: 'Neu gestartet, geht wieder.' });
  await done(a);
  // 2) Rückfrage (wartet) → kein erster Kontakt
  const b = await mk('B');
  await anna('PATCH', `/api/tickets/${b}`, { status: 'waiting' });
  await done(b);
  // 3) erledigt, wieder geöffnet, erneut erledigt → Wiedereröffnung
  const c = await mk('C');
  await done(c);
  await anna('PATCH', `/api/tickets/${c}`, { status: 'in_progress' });
  await done(c);
  // 4) zwei Antworten → kein erster Kontakt
  const d = await mk('D');
  await anna('POST', `/api/tickets/${d}/comments`, { body: 'eins' });
  await anna('POST', `/api/tickets/${d}/comments`, { body: 'zwei' });
  await done(d);
  // eigene Tickets der IT zählen nicht
  const own = (await anna('POST', '/api/tickets', { title: 'intern' })).body.ticket.key;
  await done(own);

  assert.equal((await karl('GET', '/api/reports/itil')).status, 403);
  const r = (await anna('GET', '/api/reports/itil')).body;
  assert.deepEqual(r.quality, { resolved: 4, reopened: 1, reopenRate: 25, firstContact: 1, firstContactRate: 25 });
  assert.deepEqual(r.sla, { enabled: false });
});

test('SLA-Einhaltung nach Priorität', async () => {
  S.ctx.settings.set('sla.enabled', true);
  S.ctx.settings.set('sla.hours', JSON.stringify({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }));
  const late = await mk('alt');
  const row = S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(late);
  S.db.prepare("UPDATE tickets SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'), priority='highest' WHERE id=?").run(row.id);
  await done(late);
  const r = (await anna('GET', '/api/reports/itil')).body.sla;
  assert.equal(r.enabled, true);
  assert.equal(r.count, 5);
  assert.equal(r.resolveMet, 4);
  assert.equal(r.resolveRate, 80);
  const hi = r.byPriority.find((x) => x.priority === 'highest');
  assert.deepEqual([hi.count, hi.resolveMet, hi.responseMet], [1, 0, 0]);
  S.ctx.settings.set('sla.enabled', false);
});

test('Changes je Monat mit Erfolgsquote und Notfallanteil; Probleme', async () => {
  const mkChange = async (title, fields) => {
    const key = (await anna('POST', '/api/tickets', { title, type: 'change' })).body.ticket.key;
    const id = S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(key).id;
    for (const [k, v] of Object.entries(fields)) S.db.prepare('INSERT INTO ticket_fields(ticket_id, name, value) VALUES(?,?,?)').run(id, k, v);
    return key;
  };
  await mkChange('C1', { changeType: 'normal', phase: 'closed', outcome: 'successful' });
  await mkChange('C2', { changeType: 'emergency', phase: 'closed', outcome: 'rolledBack' });
  await mkChange('C3', { changeType: 'standard', phase: 'closed', outcome: 'successful' });
  await mkChange('C4', { changeType: 'normal', phase: 'rejected' });
  const prob = (await anna('POST', '/api/tickets', { title: 'P', type: 'problem' })).body.ticket.key;
  await anna('PATCH', `/api/tickets/${prob}/fields`, { knownError: true });

  const r = (await anna('GET', '/api/reports/itil')).body;
  const tot = r.changes.totals;
  assert.deepEqual([tot.total, tot.closed, tot.successful, tot.rolledBack, tot.rejected, tot.emergency], [4, 3, 2, 1, 1, 1]);
  assert.equal(tot.successRate, 66.7);
  assert.equal(tot.emergencyShare, 25);
  assert.equal(r.changes.months.length, 1);
  assert.equal(r.changes.months[0].month, new Date().toISOString().slice(0, 7));
  assert.deepEqual(r.problems, { created: 1, resolved: 0, open: 1, knownErrors: 1 });
  assert.equal((await anna('GET', '/api/reports/itil?project=XX')).status, 404);
});
