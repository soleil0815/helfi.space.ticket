// Wissensdatenbank
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl;
before(async () => {
  S = await startServer('kb');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
});
after(() => S.stop());

test('Artikel anlegen, Sichtbarkeit, Suche mit Titel vor Text', async () => {
  const pub = (await anna('POST', '/api/kb', { title: 'Drucker: Papierstau beheben', body: 'Fach 2 öffnen und Papier entnehmen.', visibility: 'public', category: 'Drucker' })).body.article;
  const intern = (await anna('POST', '/api/kb', { title: 'VPN-Server neu starten', body: 'Nur für die IT: Dienst neu starten, danach Drucker prüfen.', visibility: 'internal' })).body.article;
  assert.equal((await karl('POST', '/api/kb', { title: 'x' })).status, 403);
  assert.equal((await anna('POST', '/api/kb', { title: '  ' })).status, 400);
  // Benutzer sehen nur öffentliche Artikel
  assert.deepEqual((await karl('GET', '/api/kb')).body.articles.map((a) => a.id), [pub.id]);
  assert.equal((await karl('GET', `/api/kb/${intern.id}`)).status, 404);
  // Suche: Titeltreffer zuerst; Stoppwörter zählen nicht
  const r = (await anna('GET', '/api/kb?q=drucker')).body.articles.map((a) => a.id);
  assert.deepEqual(r, [pub.id, intern.id]);
  assert.deepEqual((await anna('GET', '/api/kb?q=der%20die%20das')).body.articles.length, 2, 'nur Stoppwörter → alles');
  assert.deepEqual((await anna('GET', '/api/kb?category=Drucker')).body.categories, [{ name: 'Drucker', count: 1 }]);
  // Vorschläge beim Melden: nur öffentlich, höchstens 3
  assert.deepEqual((await karl('GET', '/api/kb/suggest?q=Drucker%20druckt%20nicht')).body.articles.map((a) => a.id), [pub.id]);
  // Aufrufe zählen
  await karl('GET', `/api/kb/${pub.id}?view=1`);
  assert.equal((await anna('GET', `/api/kb/${pub.id}`)).body.article.views, 1);
  // Bearbeiten und Löschen
  const u = await anna('PUT', `/api/kb/${intern.id}`, { title: 'VPN-Server neu starten', body: 'neu', visibility: 'public' });
  assert.equal(u.body.article.visibility, 'public');
  assert.equal((await karl('DELETE', `/api/kb/${intern.id}`)).status, 403);
  assert.equal((await anna('DELETE', `/api/kb/${intern.id}`)).status, 200);
  assert.equal((await anna('GET', `/api/kb/${intern.id}`)).status, 404);
});

test('Entwurf aus Ticket mit Lösung und Verlauf im Ticket', async () => {
  const key = (await karl('POST', '/api/tickets', { title: 'Outlook startet nicht', description: 'Fehlermeldung beim Start.' })).body.ticket.key;
  await anna('POST', `/api/tickets/${key}/comments`, { body: 'Bitte Outlook im abgesicherten Modus starten.' });
  await anna('POST', `/api/tickets/${key}/comments`, { body: 'interne Notiz', internal: true });
  const d = (await anna('GET', `/api/tickets/${key}/kb-draft`)).body.draft;
  assert.equal(d.title, 'Outlook startet nicht');
  assert.match(d.body, /Fehlermeldung beim Start\./);
  assert.match(d.body, /abgesicherten Modus/);
  assert.doesNotMatch(d.body, /interne Notiz/);
  assert.equal((await karl('GET', `/api/tickets/${key}/kb-draft`)).status, 403);
  const a = (await anna('POST', '/api/kb', { ...d })).body.article;
  assert.equal(a.sourceTicket, key);
  assert.ok((await anna('GET', `/api/tickets/${key}`)).body.ticket.activity.some((x) => x.action === 'kbCreated' && x.newValue === `KB-${a.id}`));
});
