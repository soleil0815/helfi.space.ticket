// Servicekatalog mit Formularen und Genehmigungen
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let chefin; let ids;
before(async () => {
  S = await startServer('catalog');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  chefin = await S.user('chefin', 'user');
  const users = (await S.admin('GET', '/api/users?all=1')).body.users;
  ids = Object.fromEntries(users.map((u) => [u.username, u.id]));
});
after(() => S.stop());

const onboarding = () => ({
  title: 'Neuer Mitarbeiter', emoji: '🧑‍💻', description: 'Konto und PC einrichten',
  fields: [
    { id: 'name', label: 'Name', type: 'text', required: true },
    { id: 'start', label: 'Erster Arbeitstag', type: 'date', required: true },
    { id: 'pc', label: 'Gerät', type: 'select', options: 'Notebook\nPC', required: true },
    { id: 'vpn', label: 'VPN-Zugang', type: 'checkbox' },
    { id: 'notes', label: 'Hinweise', type: 'textarea' },
  ],
  approverIds: [ids.chefin], approvalMode: 'any',
});

test('Verwaltung nur für Admins, Felder werden geprüft', async () => {
  assert.equal((await anna('POST', '/api/catalog', onboarding())).status, 403);
  assert.equal((await S.admin('POST', '/api/catalog', { ...onboarding(), fields: [{ label: '', type: 'text' }] })).status, 400);
  assert.equal((await S.admin('POST', '/api/catalog', { ...onboarding(), fields: [{ label: 'X', type: 'select', options: '' }] })).status, 400);
  const r = await S.admin('POST', '/api/catalog', onboarding());
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.item.fields.find((f) => f.id === 'pc').options, ['Notebook', 'PC']);
  assert.deepEqual(r.body.item.approverIds, [ids.chefin]);
  // Benutzer sehen keine Verwaltungsdaten
  const list = (await karl('GET', '/api/catalog')).body.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].needsApproval, true);
  assert.equal(list[0].approverIds, undefined);
  // ausgeblendet = für Benutzer weg
  const hidden = (await S.admin('POST', '/api/catalog', { title: 'Alt', active: false })).body.item;
  assert.equal((await karl('GET', `/api/catalog/${hidden.id}`)).status, 404);
  assert.equal((await S.admin('GET', '/api/catalog?all=1')).body.items.length, 2);
  assert.equal((await S.admin('DELETE', `/api/catalog/${hidden.id}`)).status, 200);
  assert.equal((await karl('GET', '/api/bootstrap')).body.hasCatalog, true);
});

test('Anfrage mit Pflichtfeldern, Genehmigung durch Vorgesetzte ohne Bearbeiter-Rolle', async () => {
  const item = (await karl('GET', '/api/catalog')).body.items[0];
  let r = await karl('POST', `/api/catalog/${item.id}/order`, { answers: { name: 'Erika Muster' } });
  assert.equal(r.status, 400, 'Pflichtfeld fehlt');
  r = await karl('POST', `/api/catalog/${item.id}/order`, { answers: { name: 'Erika Muster', start: '2026-12-01', pc: 'Tablet' } });
  assert.equal(r.status, 400, 'ungültige Auswahl');
  r = await karl('POST', `/api/catalog/${item.id}/order`, { answers: { name: 'Erika Muster', start: '2026-12-01', pc: 'Notebook', vpn: true } });
  assert.equal(r.status, 201);
  const tk = r.body.ticket;
  assert.equal(tk.title, 'Neuer Mitarbeiter: Erika Muster');
  assert.equal(tk.type, 'request');
  assert.match(tk.description, /\*\*Gerät:\*\* Notebook/);
  assert.match(tk.description, /\*\*VPN-Zugang:\*\* ✔/);
  assert.equal(tk.approval.state, 'pending');
  assert.equal(tk.approval.canDecide, false);

  // Die Vorgesetzte sieht genau diese Anfrage und ihre offenen Genehmigungen
  assert.equal((await chefin('GET', '/api/bootstrap')).body.pendingApprovals, 1);
  const mine = (await chefin('GET', '/api/tickets?approval=mine')).body;
  assert.deepEqual((mine.tickets || mine.items).map((x) => x.key), [tk.key]);
  const seen = (await chefin('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.equal(seen.approval.canDecide, true);

  // Andere dürfen nicht entscheiden
  assert.notEqual((await karl('POST', `/api/tickets/${tk.key}/approval`, { decision: 'approve' })).status, 200);
  assert.notEqual((await anna('POST', `/api/tickets/${tk.key}/approval`, { decision: 'approve' })).status, 200);

  const d = await chefin('POST', `/api/tickets/${tk.key}/approval`, { decision: 'approve', comment: 'passt' });
  assert.equal(d.status, 200);
  assert.equal(d.body.ticket.approval.state, 'approved');
  const after = (await karl('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.ok(after.comments.some((c) => /passt/.test(c.body)), 'Melder sieht die Entscheidung als Antwort');
  assert.notEqual(after.status, 'done');
  assert.equal((await chefin('POST', `/api/tickets/${tk.key}/approval`, { decision: 'reject' })).status, 400, 'schon entschieden');
  assert.equal((await chefin('GET', '/api/bootstrap')).body.pendingApprovals, 0);
});

test('Ablehnung schließt die Anfrage; ohne Genehmiger keine Genehmigung', async () => {
  const item = (await karl('GET', '/api/catalog')).body.items[0];
  const tk = (await karl('POST', `/api/catalog/${item.id}/order`, { answers: { name: 'Max', start: '2026-12-01', pc: 'PC' } })).body.ticket;
  const d = await chefin('POST', `/api/tickets/${tk.key}/approval`, { decision: 'reject', comment: 'kein Budget' });
  assert.equal(d.body.ticket.approval.state, 'rejected');
  assert.equal((await karl('GET', `/api/tickets/${tk.key}`)).body.ticket.status, 'done');

  const plain = (await S.admin('POST', '/api/catalog', { title: 'Passwort zurücksetzen', fields: [] })).body.item;
  const t2 = (await karl('POST', `/api/catalog/${plain.id}/order`, { answers: {} })).body.ticket;
  assert.equal(t2.title, 'Passwort zurücksetzen');
  assert.equal(t2.approval, undefined);
});
