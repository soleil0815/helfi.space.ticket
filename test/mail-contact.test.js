// Reply and resolved mails: the sender stays the ticket system, the agent is named in the text
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

test('Reply: signature with the agent name, contact person only if someone else is assigned', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'Drucker' })).body.ticket;
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Ich schaue es mir an.' });
  await wait();
  const m1 = sent.find((m) => m.to === 'karl@firma.local');
  assert.match(m1.text, /Anna Berger hat auf Ihr Ticket/);
  assert.match(m1.text, /Viele Grüße\nAnna Berger\nIT-Helpdesk$/);
  assert.doesNotMatch(m1.text, /Ansprechpartner/, 'nobody assigned');
  assert.equal(m1.from, undefined, 'no own sender – it comes from the settings');

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
  assert.doesNotMatch(sent.find((m) => m.to === 'karl@firma.local').text, /Ansprechpartner/, 'replies themselves');
});

test('Resolved: contact person and signature; internal notes are not sent', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'VPN' })).body.ticket;
  await anna('PATCH', `/api/tickets/${tk.key}`, { assigneeId: S.ids.anna });
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'intern', internal: true });
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  await wait();
  const mails = sent.filter((m) => m.to === 'karl@firma.local');
  assert.equal(mails.length, 1, 'only the resolved mail');
  assert.doesNotMatch(mails[0].text, /Ansprechpartner/, 'resolves it themselves – no reference to themselves');
  assert.match(mails[0].text, /Viele Grüße\nAnna Berger\nIT-Helpdesk$/);
  // If someone else resolves it, the assignee is listed as contact person
  const tk2 = (await karl('POST', '/api/tickets', { title: 'WLAN' })).body.ticket;
  await anna('PATCH', `/api/tickets/${tk2.key}`, { assigneeId: S.ids.anna });
  sent.length = 0;
  await tom('PATCH', `/api/tickets/${tk2.key}`, { status: 'done' });
  await wait();
  const m2 = sent.find((m) => m.to === 'karl@firma.local');
  assert.match(m2.text, /Ihr Ansprechpartner: Anna Berger\nhttps?:\/\//);
  assert.match(m2.text, /Viele Grüße\nTom Schulz\nIT-Helpdesk$/);
});

test('English', async () => {
  S.db.prepare("UPDATE users SET language='en' WHERE username='karl'").run();
  const tk = (await karl('POST', '/api/tickets', { title: 'Printer' })).body.ticket;
  sent.length = 0;
  await tom('POST', `/api/tickets/${tk.key}/comments`, { body: 'On it.' });
  await wait();
  assert.match(sent.find((m) => m.to === 'karl@firma.local').text, /Kind regards\nTom Schulz\nIT-Helpdesk$/);
});
