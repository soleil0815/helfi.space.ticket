// Zufriedenheitsumfrage: Links in der „Erledigt“-Mail, Bewertung ohne Anmeldung, im Ticket, Auswertung
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let lisa; const sent = [];
const wait = () => new Promise((r) => setTimeout(r, 50));
before(async () => {
  S = await startServer('survey');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  lisa = await S.user('lisa', 'user');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
});
after(() => S.stop());

async function resolvedTicket(title) {
  const tk = (await karl('POST', '/api/tickets', { title })).body.ticket;
  await anna('PATCH', `/api/tickets/${tk.key}`, { assigneeId: S.ids.anna });
  sent.length = 0;
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  await wait();
  return tk;
}
const tokenIn = (m) => /\/rate\/([\w-]+)\?r=5/.exec(m?.text || '')?.[1];

test('ausgeschaltet: keine Links in der Mail', async () => {
  await resolvedTicket('Ohne Umfrage');
  const m = sent.find((x) => x.to === 'karl@firma.local');
  assert.ok(m, 'Erledigt-Mail geht raus');
  assert.equal(tokenIn(m), undefined);
});

test('Links nur für den Melder, Bewertung ohne Anmeldung', async () => {
  S.ctx.settings.set('survey.enabled', true);
  const tk = (await karl('POST', '/api/tickets', { title: 'Drucker druckt nicht' })).body.ticket;
  await karl('POST', `/api/tickets/${tk.key}/participants`, { userId: S.ids.lisa });
  await anna('PATCH', `/api/tickets/${tk.key}`, { assigneeId: S.ids.anna });
  sent.length = 0;
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  await wait();
  const mk = sent.find((x) => x.to === 'karl@firma.local');
  const ml = sent.find((x) => x.to === 'lisa@firma.local');
  const token = tokenIn(mk);
  assert.ok(token, 'Melder bekommt Bewertungslinks');
  assert.match(mk.text, /★★★★★/);
  if (ml) assert.equal(tokenIn(ml), undefined, 'Teilnehmer nicht');
  assert.ok(!S.db.prepare('SELECT 1 FROM ticket_ratings WHERE token_hash=?').get(token), 'nur der Hash ist gespeichert');

  const anon = S.client();
  assert.equal((await anon('GET', '/api/public/rating/falsch-falsch-falsch-falsch')).status, 404);
  const info = (await anon('GET', `/api/public/rating/${token}`)).body;
  assert.equal(info.key, tk.key);
  assert.equal(info.rating, null);
  assert.equal(info.description, undefined, 'keine Inhalte des Tickets');
  assert.equal((await anon('POST', `/api/public/rating/${token}`, { rating: 7 })).status, 400);
  assert.equal((await anon('POST', `/api/public/rating/${token}`, { rating: 4 })).body.rating, 4);
  assert.equal((await anon('POST', `/api/public/rating/${token}`, { rating: 4, comment: 'schnell erledigt' })).body.comment, 'schnell erledigt');
  const det = (await anna('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.deepEqual([det.rating.value, det.rating.comment], [4, 'schnell erledigt']);
  assert.equal(det.activity.filter((a) => a.action === 'rated').length, 1, 'nur Änderungen der Sterne im Verlauf');

  // abgelaufen
  S.db.prepare("UPDATE ticket_ratings SET sent_at='2020-01-01T00:00:00.000Z' WHERE ticket_id=?").run(det.id);
  assert.equal((await anon('POST', `/api/public/rating/${token}`, { rating: 1 })).status, 410);
  S.db.prepare("UPDATE ticket_ratings SET sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ticket_id=?").run(det.id);

  // Wiedereröffnet und neu erledigt → neue Umfrage, alter Link ungültig
  await karl('POST', `/api/tickets/${tk.key}/comments`, { body: 'geht doch nicht' });
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'inprogress' });
  sent.length = 0;
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  await wait();
  assert.equal((await anon('GET', `/api/public/rating/${token}`)).status, 404);
  const t2 = tokenIn(sent.find((x) => x.to === 'karl@firma.local'));
  assert.equal((await anon('GET', `/api/public/rating/${t2}`)).body.rating, null);
});

test('Bewertung im Ticket durch den Melder', async () => {
  const tk = await resolvedTicket('VPN langsam');
  const mine = (await karl('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.equal(mine.rating.open, true);
  assert.equal((await lisa('POST', `/api/tickets/${tk.key}/rating`, { rating: 1 })).status, 404, 'sieht das Ticket nicht');
  assert.equal((await anna('POST', `/api/tickets/${tk.key}/rating`, { rating: 1 })).status, 403);
  const r = await karl('POST', `/api/tickets/${tk.key}/rating`, { rating: 2, comment: 'hat lange gedauert' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.rating.value, 2);
  const open = (await karl('POST', '/api/tickets', { title: 'offen' })).body.ticket;
  assert.equal((await karl('POST', `/api/tickets/${open.key}/rating`, { rating: 5 })).status, 400);
});

test('Auswertung', async () => {
  assert.equal((await karl('GET', '/api/reports/satisfaction')).status, 403);
  const r = (await anna('GET', '/api/reports/satisfaction')).body;
  assert.equal(r.sent, 2);
  assert.equal(r.answered, 1, 'neu erledigtes Ticket noch unbeantwortet');
  assert.deepEqual(r.distribution, [0, 1, 0, 0, 0]);
  assert.equal(r.average, 2);
  assert.equal(r.responseRate, 50);
  assert.deepEqual(r.byAssignee, [{ name: 'anna', count: 1, average: 2 }]);
  assert.equal(r.comments[0].comment, 'hat lange gedauert');
});
