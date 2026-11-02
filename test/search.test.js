// Volltextsuche: Antworten, Namen, Anhänge, Reihenfolge, Phrasen, Ausschluss, Rechte (interne Notizen)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let lisa; const k = {};
const keys = async (who, q, extra = '') => (await who('GET', `/api/tickets?q=${encodeURIComponent(q)}${extra}`)).body.tickets.map((x) => x.key);
before(async () => {
  S = await startServer('search');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  lisa = await S.user('lisa', 'user');
  S.db.prepare("UPDATE users SET display_name='Karl Muster' WHERE username='karl'").run();
  const mk = async (who, title, description = '') => (await who('POST', '/api/tickets', { title, description })).body.ticket.key;
  k.printer = await mk(karl, 'Drucker im 2. OG', 'Seit heute kommt eine Meldung.');
  k.paper = await mk(karl, 'Papierstau', 'Fach 2 am Drucker klemmt ständig');
  k.toner = await mk(lisa, 'Toner leer', 'Drucker zeigt Toner leer');
  k.vpn = await mk(karl, 'VPN langsam', '');
  await anna('POST', `/api/tickets/${k.vpn}/comments`, { body: 'Bitte den Client aus dem Softwarecenter neu installieren.' });
  await anna('POST', `/api/tickets/${k.vpn}/comments`, { body: 'Geheimtipp Firewallregel prüfen', internal: true });
});
after(() => S.stop());

test('Wortteile, beliebige Reihenfolge, Titel vor Text', async () => {
  assert.deepEqual((await keys(anna, 'druck')).slice(0, 1), [k.printer], 'Titeltreffer zuerst');
  assert.deepEqual((await keys(anna, 'druck')).sort(), [k.printer, k.paper, k.toner].sort());
  assert.deepEqual(await keys(anna, 'Drucker Fach 2'), [k.paper], 'Reihenfolge egal, kurze Begriffe als Teiltext');
  assert.deepEqual(await keys(anna, '"Fach 2"'), [k.paper]);
  assert.deepEqual(await keys(anna, '"2 Fach"'), [], 'genaue Folge');
  assert.deepEqual((await keys(anna, 'Drucker -Toner')).sort(), [k.printer, k.paper].sort());
  assert.deepEqual(await keys(anna, `${k.paper}`), [k.paper], 'Ticketnummer');
});

test('Antworten, Namen und Anhänge; Fundstelle', async () => {
  const r = (await anna('GET', '/api/tickets?q=softwarecenter')).body;
  assert.deepEqual(r.tickets.map((x) => x.key), [k.vpn]);
  assert.deepEqual(r.searchTerms, ['softwarecenter']);
  assert.equal(r.tickets[0].match.source, 'comment');
  assert.equal(r.tickets[0].match.author, 'anna');
  assert.match(r.tickets[0].match.text, /Softwarecenter/);
  assert.deepEqual((await keys(anna, 'Karl Muster')).sort(), [k.printer, k.paper, k.vpn].sort(), 'Name des Melders');
  const fd = new FormData();
  fd.append('files', new Blob(['x'], { type: 'text/plain' }), 'Rechnung_Lieferant_2026.txt');
  const login = await fetch(`${S.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ username: 'anna', password: 'Sehrgeheim123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const up = await fetch(`${S.base}/api/tickets/${k.toner}/attachments`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie }, body: fd });
  assert.equal(up.status, 201);
  const a = (await anna('GET', '/api/tickets?q=lieferant')).body.tickets;
  assert.deepEqual(a.map((x) => x.key), [k.toner]);
  assert.equal(a[0].match.source, 'attachment');
});

test('Interne Notizen: nur Bearbeiter finden sie, Benutzer nur eigene Tickets', async () => {
  assert.deepEqual(await keys(anna, 'Geheimtipp'), [k.vpn]);
  assert.equal((await anna('GET', '/api/tickets?q=Geheimtipp')).body.tickets[0].match.source, 'internal');
  assert.deepEqual(await keys(karl, 'Geheimtipp'), [], 'Melder findet sein Ticket nicht über eine interne Notiz');
  assert.deepEqual(await keys(karl, 'Firewallregel -xyz'), []);
  assert.deepEqual(await keys(karl, 'softwarecenter'), [k.vpn]);
  assert.deepEqual(await keys(lisa, 'druck'), [k.toner], 'nur eigene Tickets');
  // Ausschnitt nie aus interner Notiz für Benutzer
  const kv = (await karl('GET', '/api/tickets?q=prüfen')).body.tickets;
  assert.ok(kv.every((x) => x.match?.source !== 'internal'));
});

test('Index folgt Änderungen: Titel, gelöschte Kommentare, Umbenennen', async () => {
  await anna('PATCH', `/api/tickets/${k.vpn}`, { title: 'VPN Abbruch Homeoffice' });
  assert.deepEqual(await keys(anna, 'homeoffice'), [k.vpn]);
  S.db.prepare("UPDATE users SET display_name='Karla Neuname' WHERE username='karl'").run();
  assert.deepEqual((await keys(anna, 'Neuname')).sort(), [k.printer, k.paper, k.vpn].sort());
  S.db.prepare("DELETE FROM comments WHERE body LIKE 'Bitte den Client%'").run();
  assert.deepEqual(await keys(anna, 'softwarecenter'), []);
  // Filter lassen sich weiter kombinieren, Sortierung wählbar
  assert.deepEqual(await keys(anna, 'druck', '&status=open&sort=created'), [k.toner, k.paper, k.printer]);
});
