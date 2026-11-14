// Tests: pasted images (drafts, assignment to comment/description, visibility)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-paste-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { inlineImagesAsText } = await import('../src/mail/smtp.js');

let server; let base; let db; let ctx;
before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => setTimeout(r, 100)); server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const fn = async (method, url, body) => {
    const headers = { Accept: 'application/json', 'X-Helfi-Request': '1' };
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body instanceof FormData ? body : (body !== undefined ? JSON.stringify(body) : undefined) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => null) : null };
  };
  return fn;
}
const admin = client();
const anna = client();
const karl = client();
// small valid PNG (1×1)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const form = (draft, name = 'Bildschirmfoto.png', type = 'image/png', data = PNG) => {
  const fd = new FormData();
  if (draft) fd.append('draft', '1');
  fd.append('files', new Blob([data], { type }), name);
  return fd;
};
let key;

test('Setup', async () => {
  assert.equal((await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  for (const [u, role] of [['anna', 'agent'], ['karl', 'user']]) await admin('POST', '/api/users', { username: u, displayName: u, email: `${u}@firma.local`, role: role === 'agent' ? 'user' : role, password: 'Sehrgeheim123' });
  // legacy all-projects agents: the API no longer gives out role 'agent'
  db.prepare("UPDATE users SET role='agent' WHERE username IN ('anna')").run();
  for (const [c, u] of [[anna, 'anna'], [karl, 'karl']]) assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'Sehrgeheim123' })).status, 200);
  key = (await karl('POST', '/api/tickets', { title: 'Fehlermeldung' })).body.ticket.key;
});

test('Draft: only for agents and the uploader, not in the attachment list', async () => {
  const r = await anna('POST', `/api/tickets/${key}/attachments`, form(true));
  assert.equal(r.status, 201);
  const id = r.body.ids[0];
  assert.equal((await anna('GET', `/api/attachments/${id}`)).status, 200);
  assert.equal((await karl('GET', `/api/attachments/${id}`)).status, 404, 'reporter does not see the draft');
  assert.deepEqual((await karl('GET', `/api/tickets/${key}`)).body.ticket.attachments, []);
  assert.deepEqual((await anna('GET', `/api/tickets/${key}`)).body.ticket.attachments, [], 'not in the agents\' list either');
  assert.ok(!(await anna('GET', `/api/tickets/${key}`)).body.ticket.activity.some((a) => a.action === 'attached'), 'no activity entry for drafts');
});

test('Image in an internal note stays internal', async () => {
  const id = (await anna('POST', `/api/tickets/${key}/attachments`, form(true))).body.ids[0];
  assert.equal((await anna('POST', `/api/tickets/${key}/comments`, { body: `Siehe Log:\n![log.png](/api/attachments/${id})`, internal: true })).status, 201);
  assert.equal((await karl('GET', `/api/attachments/${id}`)).status, 404);
  assert.ok(!(await karl('GET', `/api/tickets/${key}`)).body.ticket.attachments.some((a) => a.id === id));
  const row = db.prepare('SELECT draft, comment_id FROM attachments WHERE id=?').get(id);
  assert.equal(row.draft, 0);
  assert.ok(row.comment_id, 'assigned to the note');
});

test('Image in a public reply is visible to the reporter', async () => {
  const id = (await anna('POST', `/api/tickets/${key}/attachments`, form(true))).body.ids[0];
  await anna('POST', `/api/tickets/${key}/comments`, { body: `Klicken Sie hier:\n![schritt.png](/api/attachments/${id})` });
  assert.equal((await karl('GET', `/api/attachments/${id}`)).status, 200);
  assert.ok((await karl('GET', `/api/tickets/${key}`)).body.ticket.attachments.some((a) => a.id === id));
});

test('Reporter pastes an image into the description', async () => {
  const id = (await karl('POST', `/api/tickets/${key}/attachments`, form(true))).body.ids[0];
  assert.equal((await karl('GET', `/api/attachments/${id}`)).status, 200, 'own draft visible');
  assert.equal((await karl('PATCH', `/api/tickets/${key}`, { description: `Diese Meldung:\n![fehler.png](/api/attachments/${id})` })).status, 200);
  assert.equal(db.prepare('SELECT draft FROM attachments WHERE id=?').get(id).draft, 0);
  assert.equal((await anna('GET', `/api/attachments/${id}`)).status, 200);
});

test('Other people\'s drafts cannot be taken over; only images as drafts', async () => {
  const id = (await anna('POST', `/api/tickets/${key}/attachments`, form(true))).body.ids[0];
  await karl('POST', `/api/tickets/${key}/comments`, { body: `![x](/api/attachments/${id})` });
  assert.equal(db.prepare('SELECT draft FROM attachments WHERE id=?').get(id).draft, 1, 'stays Anna\'s draft');
  assert.equal((await karl('GET', `/api/attachments/${id}`)).status, 404);
  assert.equal((await anna('POST', `/api/tickets/${key}/attachments`, form(true, 'skript.sh', 'text/x-sh', Buffer.from('rm -rf')))).status, 400);
  // A draft of another ticket stays with that ticket
  const other = (await karl('POST', '/api/tickets', { title: 'Anderes' })).body.ticket.key;
  const oid = (await karl('POST', `/api/tickets/${other}/attachments`, form(true))).body.ids[0];
  await karl('POST', `/api/tickets/${key}/comments`, { body: `![x](/api/attachments/${oid})` });
  assert.equal(db.prepare('SELECT draft FROM attachments WHERE id=?').get(oid).draft, 1);
});

test('Files for a reply (draft=file): any type, claimed via attachmentIds, internal notes keep them internal', async () => {
  const fileForm = (name, type, data) => { const fd = new FormData(); fd.append('draft', 'file'); fd.append('files', new Blob([data], { type }), name); return fd; };
  const up = await anna('POST', `/api/tickets/${key}/attachments`, fileForm('protokoll-PC-0001.txt', 'text/plain', Buffer.from('Fehler 49\n')));
  assert.equal(up.status, 201, 'any file type as a reply draft');
  const id = up.body.ids[0];
  assert.equal(db.prepare('SELECT draft, comment_id FROM attachments WHERE id=?').get(id).draft, 1);
  assert.ok(!(await karl('GET', `/api/tickets/${key}`)).body.ticket.attachments.some((a) => a.id === id), 'draft not listed');
  assert.equal((await karl('GET', `/api/attachments/${id}`)).status, 404, 'reporter does not see the draft');
  // Internal note claims it: stays internal
  const note = await anna('POST', `/api/tickets/${key}/comments`, { body: 'Protokoll anbei', internal: true, attachmentIds: [id, 'x', -3] });
  assert.equal(note.status, 201);
  const row = db.prepare('SELECT draft, comment_id FROM attachments WHERE id=?').get(id);
  assert.deepEqual([row.draft, row.comment_id], [0, note.body.comment.id]);
  assert.equal((await karl('GET', `/api/attachments/${id}`)).status, 404, 'internal attachment hidden from the reporter');
  assert.ok(!(await karl('GET', `/api/tickets/${key}`)).body.ticket.attachments.some((a) => a.id === id));
  assert.ok((await anna('GET', `/api/tickets/${key}`)).body.ticket.attachments.some((a) => a.id === id && a.commentId === note.body.comment.id));
  // Someone else's draft cannot be claimed; a public reply makes its own file visible
  const other = (await anna('POST', `/api/tickets/${key}/attachments`, fileForm('liste.csv', 'text/csv', Buffer.from('a;b\n')))).body.ids[0];
  await karl('POST', `/api/tickets/${key}/comments`, { body: 'Meins?', attachmentIds: [other] });
  assert.equal(db.prepare('SELECT draft FROM attachments WHERE id=?').get(other).draft, 1, 'stays Anna\'s draft');
  const mine = (await karl('POST', `/api/tickets/${key}/attachments`, fileForm('bericht.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n')))).body.ids[0];
  const reply = await karl('POST', `/api/tickets/${key}/comments`, { body: 'Bericht anbei', attachmentIds: [mine] });
  assert.equal(reply.status, 201);
  assert.equal((await anna('GET', `/api/attachments/${mine}`)).status, 200);
  assert.ok((await karl('GET', `/api/tickets/${key}`)).body.ticket.attachments.some((a) => a.id === mine && a.commentId === reply.body.comment.id));
});

test('Bootstrap tells the upload limit', async () => {
  assert.equal(typeof (await karl('GET', '/api/bootstrap')).body.maxUploadMb, 'number');
});

test('In mails the image becomes a placeholder note', () => {
  assert.equal(inlineImagesAsText('Siehe:\n![schritt.png](/api/attachments/12)\nDanke', 'de'), 'Siehe:\n[Bild: schritt.png]\nDanke');
  assert.equal(inlineImagesAsText('![](/api/attachments/3)', 'en'), '[Image: …]');
  assert.equal(inlineImagesAsText('![a](https://evil.example/x.png)', 'de'), '![a](https://evil.example/x.png)', 'own attachments only');
});
