// Audit 2026-11f, outgoing mail: one failing recipient must not stop the mails to the others (a refused
// mail with pictures is sent again as plain text), inline pictures are attached once each and limited
// in total size, and the picture type comes from the file, not from the upload's claim.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let tk; let tkId; let add;
const wait = () => new Promise((r) => setTimeout(r, 120));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const bigPng = (bytes) => Buffer.concat([PNG, Buffer.alloc(bytes - PNG.length, 7)]);
let sendImpl;
const calls = [];

before(async () => {
  S = await startServer('audit11fmail');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  await S.user('paula', 'user');
  await S.user('bob', 'agent');
  await S.user('cleo', 'agent');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { calls.push(m); return sendImpl(m); };
  tk = (await karl('POST', '/api/tickets', { projectId: 1, type: 'task', title: 'Drucker', description: '' })).body.ticket;
  const pr = await karl('POST', `/api/tickets/${tk.key}/participants`, { userId: S.ids.paula });
  assert.ok(pr.status < 300, `participant added (${pr.status})`);
  tkId = S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number = ?").get(tk.key).id;
  add = (filename, opts = {}) => S.ctx.tickets.addAttachment(tkId, { filename, mime: opts.mime || 'image/png', buffer: opts.buffer || PNG }, S.ids.anna, null, { silent: true, inline: true });
});
after(() => S?.stop());

const delivered = () => calls.filter((c) => c.ok).map((c) => c.to);
function failFirst(pred = () => true) {
  let failed = null;
  sendImpl = async (m) => {
    if (!failed && pred(m)) { failed = m.to; throw new Error('552 message size exceeds fixed limit'); }
    calls.at(-1).ok = true;
    return true;
  };
  return () => failed;
}

test('a failing reply mail to one customer does not stop the mail to the other customers', async () => {
  calls.length = 0;
  const failed = failFirst((m) => !m.html);
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Antwort', internal: false });
  await wait();
  assert.ok(failed(), 'first recipient failed');
  const other = ['karl@firma.local', 'paula@firma.local'].find((x) => x !== failed());
  assert.deepEqual(delivered(), [other]);
});

test('a refused mail with pictures is sent once more as plain text with the image note', async () => {
  const a = add('drucker.png');
  calls.length = 0;
  failFirst((m) => !!m.html);
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: `So:\n\n![drucker.png](/api/attachments/${a})`, format: 'md', internal: false });
  await wait();
  const ok = calls.filter((c) => c.ok);
  assert.equal(ok.length, 2, 'both customers got the reply');
  const retried = ok.find((c) => !c.html);
  assert.ok(retried, 'retry without HTML part');
  assert.equal(retried.attachments, undefined);
  assert.match(retried.text, /\[Bild: drucker\.png\]/);
  assert.equal(calls.length, 3);
});

test('a failing mention mail does not stop the mails to the other mentioned people', async () => {
  // The first mentioned address refuses every mail (also the plain-text retry)
  let first = null;
  sendImpl = async (m) => {
    first ??= m.to;
    if (m.to === first) throw new Error('550 mailbox unavailable');
    calls.at(-1).ok = true;
    return true;
  };
  calls.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: `@[bob](user:${S.ids.bob}) @[cleo](user:${S.ids.cleo}) bitte schauen`, format: 'md', internal: true });
  await wait();
  assert.ok(['bob@firma.local', 'cleo@firma.local'].includes(first));
  const other = ['bob@firma.local', 'cleo@firma.local'].find((x) => x !== first);
  assert.deepEqual(delivered(), [other]);
  assert.equal(calls.filter((c) => c.to === first).length, 2, 'one retry, then give up');
});

test('the same picture used twice is attached once and both places show it', async () => {
  sendImpl = async () => true;
  const a = add('twice.png');
  calls.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: `![eins](/api/attachments/${a})\n\n![zwei](/api/attachments/${a})`, format: 'md', internal: false });
  await wait();
  const m = calls.filter((x) => x.to === 'karl@firma.local').at(-1);
  assert.equal(m.attachments.length, 1);
  const cid = m.attachments[0].cid;
  assert.equal(m.html.split(`src="cid:${cid}"`).length - 1, 2, 'both images use the one cid');
  assert.match(m.html, /alt="eins"/);
  assert.match(m.html, /alt="zwei"/);
});

test('inline pictures are limited to about 5 MB per mail, the rest stay a note', async () => {
  sendImpl = async () => true;
  const ids = ['g1.png', 'g2.png', 'g3.png'].map((n) => add(n, { buffer: bigPng(2 * 1024 * 1024 - 100) }));
  calls.length = 0;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: ids.map((id, i) => `![g${i + 1}](/api/attachments/${id})`).join('\n\n'), format: 'md', internal: false });
  await wait();
  const m = calls.filter((x) => x.to === 'karl@firma.local').at(-1);
  assert.deepEqual(m.attachments.map((x) => x.filename), ['g1.png', 'g2.png']);
  assert.match(m.html, /\[Bild: g3\]/);
});

test('inline pictures: the type is taken from the file content, not from the upload', async () => {
  const fake = add('fake.png', { buffer: Buffer.from('%PDF-1.4 not a picture at all') });
  assert.equal(S.ctx.tickets.mailImage(tkId, fake), null, 'non-picture declared as PNG is not sent inline');
  const jpeg = add('foto.png', { buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]) });
  assert.equal(S.ctx.tickets.mailImage(tkId, jpeg)?.mime, 'image/jpeg');
});
