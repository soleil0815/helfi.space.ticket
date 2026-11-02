// Antwort- und Erledigt-Mails: Absender bleibt das Ticketsystem, der Bearbeiter steht im Text
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let tom; let karl; const sent = [];
const wait = () => new Promise((r) => setTimeout(r, 50));
before(async () => {
  S = await startServer('mailcontact');
  anna = await S.user('anna', 'agent');
  tom = await S.user('tom', 'agent');
  karl = await S.user('karl', 'user');
  S.db.prepare("UPDATE users SET display_name='Anna Berger' WHERE username='anna'").run();
  S.db.prepare("UPDATE users SET display_name='Tom Schulz' WHERE username='tom'").run();
  S.ctx.settings.set('general.title', 'IT-Helpdesk');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
});
after(() => S.stop());

test('Antwort: Gruß mit Namen des Bearbeiters, Ansprechpartner nur wenn jemand anderes zugewiesen ist', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'Drucker' })).body.ticket;
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Ich schaue es mir an.' });
  await wait();
  const m1 = sent.find((m) => m.to === 'karl@firma.local');
  assert.match(m1.text, /Anna Berger hat auf Ihr Ticket/);
  assert.match(m1.text, /Viele Grüße\nAnna Berger\nIT-Helpdesk$/);
  assert.doesNotMatch(m1.text, /Ansprechpartner/, 'niemand zugewiesen');
  assert.equal(m1.from, undefined, 'kein eigener Absender – der kommt aus den Einstellungen');

  await anna('PATCH', `/api/tickets/${tk.key}`, { assigneeId: S.ids.anna });
  sent.length = 0;
  await tom('POST', `/api/tickets/${tk.key}/comments`, { body: 'Kurz vertretungsweise: Toner ist bestellt.' });
  await wait();
  const m2 = sent.find((m) => m.to === 'karl@firma.local');
  assert.match(m2.text, /Ihr Ansprechpartner: Anna Berger/);
  assert.match(m2.text, /Viele Grüße\nTom Schulz\nIT-Helpdesk$/);
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Toner ist da.' });
  await wait();
  assert.doesNotMatch(sent.find((m) => m.to === 'karl@firma.local').text, /Ansprechpartner/, 'antwortet selbst');
});

test('Erledigt: Ansprechpartner und Gruß; interne Notizen gehen nicht raus', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'VPN' })).body.ticket;
  await anna('PATCH', `/api/tickets/${tk.key}`, { assigneeId: S.ids.anna });
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'intern', internal: true });
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  await wait();
  const mails = sent.filter((m) => m.to === 'karl@firma.local');
  assert.equal(mails.length, 1, 'nur die Erledigt-Mail');
  assert.match(mails[0].text, /Ihr Ansprechpartner: Anna Berger\nhttps?:\/\//);
  assert.match(mails[0].text, /Viele Grüße\nAnna Berger\nIT-Helpdesk$/);
});

test('Englisch', async () => {
  S.db.prepare("UPDATE users SET language='en' WHERE username='karl'").run();
  const tk = (await karl('POST', '/api/tickets', { title: 'Printer' })).body.ticket;
  sent.length = 0;
  await tom('POST', `/api/tickets/${tk.key}/comments`, { body: 'On it.' });
  await wait();
  assert.match(sent.find((m) => m.to === 'karl@firma.local').text, /Kind regards\nTom Schulz\nIT-Helpdesk$/);
});
