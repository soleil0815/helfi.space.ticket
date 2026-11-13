// Pictures in notification mails: travel with the mail as inline attachments (cid:) and are shown in
// the HTML part – only pictures of this ticket, saved, of a picture type, at most 2 MB and 5 per mail,
// never from internal notes for customers. The text part keeps the note "[Image: name]".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let tk; let other; const sent = [];
const wait = () => new Promise((r) => setTimeout(r, 80));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let add;
before(async () => {
  S = await startServer('mailimages');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  tk = (await karl('POST', '/api/tickets', { projectId: 1, type: 'task', title: 'Drucker', description: '' })).body.ticket;
  other = (await anna('POST', '/api/tickets', { projectId: 1, type: 'task', title: 'Anderes', description: '' })).body.ticket;
  const id = (key) => S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(key).id;
  add = (key, filename, opts = {}) => S.ctx.tickets.addAttachment(id(key), { filename, mime: opts.mime || 'image/png', buffer: opts.buffer || PNG }, S.ids.anna, opts.commentId ?? null, { silent: true, inline: true });
});
after(() => S?.stop());

const lastTo = (to) => sent.filter((x) => x.to === to).at(-1);

test('Reply with pictures: inline in the HTML part, note in the text part', async () => {
  const a = add(tk.key, 'drucker.png');
  sent.length = 0;
  const r = await anna('POST', `/api/tickets/${tk.key}/comments`, { body: `Bitte so einstellen:\n\n![drucker.png](/api/attachments/${a})\n\nDanke`, format: 'md', internal: false });
  assert.equal(r.status, 201);
  await wait();
  const m = lastTo('karl@firma.local');
  assert.ok(m, 'reply mail sent');
  assert.equal(m.attachments.length, 1);
  const att = m.attachments[0];
  assert.equal(att.contentDisposition, 'inline');
  assert.equal(att.contentType, 'image/png');
  assert.equal(att.filename, 'drucker.png');
  assert.ok(m.html.includes(`<img src="cid:${att.cid}" alt="drucker.png"`));
  assert.match(m.text, /\[Bild: drucker\.png\]/);
  assert.doesNotMatch(m.html, /\/api\/attachments/, 'no link that needs sign-in');
});

test('Plain comments with pictures get an HTML part too; without pictures none', async () => {
  const a = add(tk.key, 'plain.png');
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: `Siehe <hier>:\n![plain.png](/api/attachments/${a})`, internal: false });
  await wait();
  const m = lastTo('karl@firma.local');
  assert.equal(m.attachments.length, 1);
  assert.match(m.html, /Siehe &lt;hier&gt;:/);
  assert.match(m.html, /<img src="cid:/);
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Nur Text', internal: false });
  await wait();
  assert.equal(lastTo('karl@firma.local').html, undefined);
});

test('Only pictures of this ticket, of a picture type, small enough, at most 5', async () => {
  const foreign = add(other.key, 'fremd.png');
  const pdf = add(tk.key, 'doku.pdf', { mime: 'application/pdf' });
  const svg = add(tk.key, 'bild.svg', { mime: 'image/svg+xml' });
  const big = add(tk.key, 'gross.png', { buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 1) });
  const ok = Array.from({ length: 6 }, (_, i) => add(tk.key, `ok${i}.png`));
  const body = [foreign, pdf, svg, big, ...ok].map((id, i) => `![b${i}](/api/attachments/${id})`).join('\n\n');
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body, format: 'md', internal: false });
  await wait();
  const m = lastTo('karl@firma.local');
  assert.deepEqual(m.attachments.map((x) => x.filename), ['ok0.png', 'ok1.png', 'ok2.png', 'ok3.png', 'ok4.png'], 'max 5, only allowed ones');
  // The rest stay a note
  assert.match(m.html, /\[Bild: b0\]/);
  assert.match(m.html, /\[Bild: b9\]/);
  assert.doesNotMatch(m.html, /\/api\/attachments/);
});

test('Pictures of internal notes: not for customers, but in mention mails to agents', async () => {
  const note = (await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Intern', internal: true })).body.comment;
  const secret = add(tk.key, 'intern.png', { commentId: note.id });
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: `Öffentlich mit Verweis ![intern.png](/api/attachments/${secret})`, format: 'md', internal: false });
  await wait();
  const m = lastTo('karl@firma.local');
  assert.equal(m.attachments.length, 0);
  assert.match(m.html, /\[Bild: intern\.png\]/);
  // Mention of an agent in an internal note: the picture comes along
  const bob = await S.user('bob', 'agent');
  void bob;
  sent.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: `@[bob](user:${S.ids.bob}) schau mal ![intern.png](/api/attachments/${secret})`, format: 'md', internal: true });
  await wait();
  const mm = lastTo('bob@firma.local');
  assert.ok(mm, 'mention mail');
  assert.deepEqual(mm.attachments.map((x) => x.filename), ['intern.png']);
  assert.equal(lastTo('karl@firma.local'), undefined, 'internal note: no mail to the customer');
});

test('Draft uploads are not sent', async () => {
  const id = S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(tk.key).id;
  const draft = S.ctx.tickets.addAttachment(id, { filename: 'entwurf.png', mime: 'image/png', buffer: PNG }, S.ids.karl, null, { draft: true });
  assert.equal(S.ctx.tickets.mailImage(id, draft), null);
  assert.equal(S.ctx.tickets.mailImage(id, 999999), null);
});

test('nodemailer builds a mail with the picture embedded (Content-ID, inline)', async () => {
  const nodemailer = (await import('nodemailer')).default;
  const { commentMail } = await import('../src/mail/smtp.js');
  const id = S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(tk.key).id;
  const a = add(tk.key, 'echt.png');
  const { html, attachments } = commentMail({ format: 'md', body: `Hier: ![echt.png](/api/attachments/${a})` }, 'de', 'mail.comment.body',
    { key: tk.key, title: 'x', name: 'Karl', author: 'Anna', body: 'Hier: [Bild: echt.png]', link: 'https://h.example', app: 'Helfi', contact: '', closing: '' },
    (aid) => S.ctx.tickets.mailImage(id, aid));
  const tr = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await tr.sendMail({ from: 'helfi@firma.local', to: 'karl@firma.local', subject: 's', text: 't', html, attachments });
  const raw = info.message.toString();
  assert.match(raw, /multipart\/related/);
  assert.ok(raw.includes(`Content-ID: <${attachments[0].cid}>`));
  assert.match(raw, /Content-Disposition: inline; filename=echt\.png/);
  assert.match(raw, /Content-Type: image\/png/);
});
