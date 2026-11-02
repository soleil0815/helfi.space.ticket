// Tests: Teilnehmer beim Hinzufügen aus dem AD suchen und übernehmen (AD nachgebildet)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let agent; let karl; let ticket;
const GUID = { erika: 'a1'.repeat(16), max: 'b2'.repeat(16), gast: 'c3'.repeat(16), ohne: 'd4'.repeat(16) };
const AD = [
  { username: 'e.beispiel', displayName: 'Erika Beispiel', email: 'e.beispiel@firma.local', externalId: GUID.erika, aliases: ['erika.alt@firma.local'], groups: { admin: false, agent: false, user: true } },
  { username: 'm.muster', displayName: 'Max Muster', email: 'm.muster@firma.local', externalId: GUID.max, aliases: [], groups: { admin: false, agent: true, user: true } },
  { username: 'g.gast', displayName: 'Gerd Gast', email: 'g.gast@firma.local', externalId: GUID.gast, aliases: [], groups: { admin: false, agent: false, user: false } },
  { username: 'o.ohne', displayName: 'Olga Ohnemail', email: '', externalId: GUID.ohne, aliases: [], groups: { admin: false, agent: false, user: false } },
];
const calls = { search: 0, byGuid: 0, byEmail: 0 };
let fail = false;
const strip = ({ aliases, groups, ...p }) => p;
const full = (p) => ({ ...strip(p), dn: `CN=${p.displayName},CN=Users,DC=firma,DC=local`, groups: p.groups });

before(async () => {
  S = await startServer('adpeople');
  const s = S.ctx.settings;
  s.set('ldap.enabled', true);
  s.set('ldap.bindDn', 'CN=svc-helfi,CN=Users,DC=firma,DC=local');
  s.set('ldap.agentGroup', 'Helfi-Bearbeiter');
  s.set('ldap.userGroup', 'Helfi-Benutzer');
  S.ctx.directory = {
    search: async (cfg, q) => {
      calls.search++;
      if (fail) throw new Error('connect ECONNREFUSED');
      const words = q.toLowerCase().split(/\s+/);
      return AD.filter((p) => words.every((w) => [p.username, p.displayName, p.email, ...p.aliases].some((v) => v.toLowerCase().includes(w)))).map(strip);
    },
    byGuid: async (cfg, id) => { calls.byGuid++; if (fail) throw new Error('timeout'); const p = AD.find((x) => x.externalId === id); return p ? full(p) : null; },
    byEmail: async (cfg, e) => { calls.byEmail++; if (fail) throw new Error('timeout'); const p = AD.find((x) => x.email === e || x.aliases.includes(e)); return p ? full(p) : null; },
  };
  agent = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  const r = await karl('POST', '/api/tickets', { title: 'Drucker PR-0001 druckt nicht', description: 'Papierstau' });
  ticket = r.body.ticket.key;
});
after(() => S.stop());

test('Bearbeiter finden Personen aus dem AD, Benutzer nicht', async () => {
  let r = await agent('GET', '/api/people?q=beisp');
  assert.equal(r.status, 200);
  const hit = r.body.people.find((p) => p.source === 'ad');
  assert.deepEqual(hit, { adId: GUID.erika, displayName: 'Erika Beispiel', username: 'e.beispiel', email: 'e.beispiel@firma.local', source: 'ad' });
  const before = calls.search;
  r = await karl('GET', '/api/people?q=beisp');
  assert.equal(r.body.people.length, 0);
  assert.equal(calls.search, before, 'Benutzer lösen keine AD-Suche aus');
  r = await agent('GET', '/api/people?q=be');
  assert.equal(calls.search, before, 'erst ab 3 Zeichen');
});

test('Suche per Mailadresse findet auch Zweitadressen', async () => {
  const r = await agent('GET', '/api/people?q=erika.alt@firma.local');
  assert.equal(r.body.people.filter((p) => p.source === 'ad').length, 1);
});

test('AD nicht erreichbar: lokale Treffer und Hinweis', async () => {
  fail = true;
  const r = await agent('GET', '/api/people?q=karl');
  fail = false;
  assert.equal(r.status, 200);
  assert.equal(r.body.adError, true);
  assert.ok(r.body.people.some((p) => p.username === 'karl'));
});

test('AD-Person hinzufügen: als AD-Benutzer mit Mailadresse angelegt, ein vorhandener E-Mail-Kontakt wird übernommen', async () => {
  // Erika hat früher schon gemailt → reiner E-Mail-Kontakt
  const contact = S.ctx.users.contactForEmail('e.beispiel@firma.local', 'e.beispiel@firma.local');
  let r = await agent('GET', '/api/people?q=beispiel');
  assert.ok(!r.body.people.some((p) => p.id === contact.id && p.source !== 'ad'), 'Kontakt nicht doppelt');

  r = await agent('POST', `/api/tickets/${ticket}/participants`, { adId: GUID.erika });
  assert.equal(r.status, 201);
  const u = S.ctx.users.byEmail('e.beispiel@firma.local');
  assert.equal(u.id, contact.id, 'Kontakt übernommen, kein zweites Konto');
  assert.equal(u.source, 'ldap');
  assert.equal(u.username, 'e.beispiel');
  assert.equal(u.display_name, 'Erika Beispiel');
  assert.equal(u.external_id, GUID.erika);
  assert.equal(u.role, 'user');
  assert.ok(r.body.participants.some((p) => p.id === u.id));

  // Danach erscheint sie als bekannte Person, nicht doppelt
  r = await agent('GET', '/api/people?q=beispiel');
  const hits = r.body.people.filter((p) => p.displayName === 'Erika Beispiel');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, u.id);
  r = await agent('POST', `/api/tickets/${ticket}/participants`, { adId: GUID.erika });
  assert.equal(r.status, 200, 'schon dabei');
});

test('Rolle aus den AD-Gruppen wie bei der Anmeldung', async () => {
  const r = await agent('POST', `/api/tickets/${ticket}/participants`, { adId: GUID.max });
  assert.equal(r.status, 201);
  assert.equal(S.ctx.users.byName('m.muster').role, 'agent');
});

test('Laut Gruppen nicht zugelassen: nur als E-Mail-Kontakt; ohne Adresse abgelehnt', async () => {
  let r = await agent('POST', `/api/tickets/${ticket}/participants`, { adId: GUID.gast });
  assert.equal(r.status, 201);
  const g = S.ctx.users.byEmail('g.gast@firma.local');
  assert.equal(g.source, 'email');
  assert.equal(g.display_name, 'Gerd Gast');
  r = await agent('POST', `/api/tickets/${ticket}/participants`, { adId: GUID.ohne });
  assert.equal(r.status, 400);
});

test('Mailadresse eintippen: Person wird im AD gefunden (auch per Zweitadresse)', async () => {
  const t2 = (await karl('POST', '/api/tickets', { title: 'VPN', description: 'geht nicht' })).body.ticket.key;
  let r = await agent('POST', `/api/tickets/${t2}/participants`, { email: 'erika.alt@firma.local' });
  assert.equal(r.status, 201);
  const erika = S.ctx.users.byName('e.beispiel');
  assert.ok(r.body.participants.some((p) => p.id === erika.id), 'AD-Konto statt neuem Kontakt');
  assert.equal(S.ctx.users.byEmail('erika.alt@firma.local'), undefined, 'kein zusätzlicher Kontakt für die Zweitadresse');
  // Nicht im AD → wie bisher E-Mail-Kontakt
  r = await agent('POST', `/api/tickets/${t2}/participants`, { email: 'extern@lieferant.example' });
  assert.equal(r.status, 201);
  assert.equal(S.ctx.users.byEmail('extern@lieferant.example').source, 'email');
  // AD gestört → trotzdem als Kontakt hinzufügen
  fail = true;
  r = await agent('POST', `/api/tickets/${t2}/participants`, { email: 'nochwer@firma.local' });
  fail = false;
  assert.equal(r.status, 201);
});

test('Schutz: Benutzer, unbekannte Tickets, ungültige Kennung, abgeschaltete Einstellung', async () => {
  const own = (await karl('POST', '/api/tickets', { title: 'Monitor', description: 'flackert' })).body.ticket.key;
  let r = await karl('POST', `/api/tickets/${own}/participants`, { adId: GUID.max });
  assert.equal(r.status, 403, 'Benutzer dürfen nicht ins AD greifen');
  const n = calls.byGuid;
  r = await agent('POST', '/api/tickets/IT-999/participants', { adId: GUID.max });
  assert.equal(r.status, 404);
  assert.equal(calls.byGuid, n, 'erst Zugriff prüfen, dann AD');
  r = await agent('POST', `/api/tickets/${own}/participants`, { adId: 'x)(cn=*' });
  assert.equal(r.status, 400);
  r = await agent('POST', `/api/tickets/${own}/participants`, { adId: 'ee'.repeat(16) });
  assert.equal(r.status, 404, 'nicht (mehr) im AD');
  fail = true;
  r = await agent('POST', `/api/tickets/${own}/participants`, { adId: GUID.max });
  fail = false;
  assert.equal(r.status, 503);

  S.ctx.settings.set('ldap.peopleSearch', false);
  const s0 = calls.search;
  r = await agent('GET', '/api/people?q=muster');
  assert.ok(!r.body.people.some((p) => p.source === 'ad' && !p.id));
  assert.equal(calls.search, s0);
  r = await agent('POST', `/api/tickets/${own}/participants`, { adId: GUID.max });
  assert.equal(r.status, 403);
  S.ctx.settings.set('ldap.peopleSearch', true);
});
