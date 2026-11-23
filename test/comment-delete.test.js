// Deleting comments: author, agents of the project and admins; a placeholder stays,
// text, mail HTML, files and mentions are removed for good. Tickets themselves are never deleted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.js';

let S; let karl; let lena; let otto; let hmAgent; let it; let key;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  S = await startServer('cdel');
  it = S.db.prepare("SELECT id FROM projects WHERE key='IT'").get().id;
  const hm = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  karl = await S.user('karl', 'user'); // reporter
  lena = await S.user('lena', 'user'); // agent of IT via the project
  otto = await S.user('otto', 'user'); // another user, not involved
  hmAgent = await S.user('hma', 'user'); // agent of another project only
  S.db.prepare("INSERT INTO project_agents(project_id,user_id,source) VALUES(?,?,'manual')").run(it, S.ids.lena);
  S.db.prepare("INSERT INTO project_agents(project_id,user_id,source) VALUES(?,?,'manual')").run(hm.id, S.ids.hma);
  // log in again so the project rights are loaded
  lena = await S.client().login('lena');
  hmAgent = await S.client().login('hma');
  key = (await karl('POST', '/api/tickets', { title: 'Drucker streikt', description: 'Im 2. Stock', projectId: it })).body.ticket.key;
});
after(() => S?.stop());

const comment = async (who, body, extra = {}) => {
  const r = await who('POST', `/api/tickets/${key}/comments`, { body, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.comment;
};
const del = (who, id) => who('DELETE', `/api/tickets/${key}/comments/${id}`);
const view = async (who) => (await who('GET', `/api/tickets/${key}`)).body.ticket;
const row = (id) => S.db.prepare('SELECT * FROM comments WHERE id=?').get(id);
const ticketId = () => S.ctx.tickets.load(null, key).id;

test('The author deletes their own comment: placeholder with who and when, text gone', async () => {
  const c = await comment(karl, 'Mein Passwort ist aus Versehen hier gelandet');
  assert.equal((await view(karl)).comments.find((x) => x.id === c.id).canDelete, true);
  const r = await del(karl, c.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.comment.body, '');
  assert.equal(r.body.comment.deleted.by.id, S.ids.karl);
  assert.ok(r.body.comment.deleted.at);
  assert.equal(r.body.comment.canDelete, undefined, 'a deleted comment cannot be deleted again');
  assert.equal(row(c.id).body, '', 'removed from the database, not only hidden');
  const seen = (await view(lena)).comments.find((x) => x.id === c.id);
  assert.equal(seen.body, '');
  assert.equal(seen.deleted.by.displayName, 'karl');
  // the history notes it (agents)
  assert.ok((await view(lena)).activity.some((a) => a.action === 'commentDeleted' && a.user.id === S.ids.karl));
  // a second click changes nothing
  const again = await del(karl, c.id);
  assert.equal(again.status, 200);
  assert.equal(again.body.comment.deleted.by.id, S.ids.karl);
});

test('Others cannot delete someone else\'s comment; agents of the project and admins can', async () => {
  const c = await comment(karl, 'Bitte schnell');
  assert.equal((await otto('GET', `/api/tickets/${key}`)).status, 404, 'otto cannot even see the ticket');
  assert.equal((await del(otto, c.id)).status, 404);
  assert.equal((await del(hmAgent, c.id)).status, 404, 'agent of another project: ticket not visible');
  // a participant sees the ticket, but the comment is not theirs
  await karl('POST', `/api/tickets/${key}/participants`, { userId: S.ids.otto });
  assert.equal((await view(otto)).comments.find((x) => x.id === c.id).canDelete, undefined);
  assert.equal((await del(otto, c.id)).status, 403);
  assert.equal(row(c.id).deleted_at, null);
  // agent of the project
  const own = await comment(lena, 'Ich schaue es mir an');
  assert.equal((await view(karl)).comments.find((x) => x.id === own.id).canDelete, undefined, 'the reporter cannot delete the agent\'s reply');
  assert.equal((await del(karl, own.id)).status, 403);
  assert.equal((await view(lena)).comments.find((x) => x.id === c.id).canDelete, true);
  assert.equal((await del(lena, c.id)).status, 200);
  assert.equal(row(c.id).deleted_by, S.ids.lena);
  // admin
  assert.equal((await del(S.admin, own.id)).status, 200);
  assert.equal(row(own.id).deleted_by, (S.db.prepare("SELECT id FROM users WHERE username='admin'").get()).id);
});

test('Internal notes: invisible to users (404 instead of 403), agents delete them', async () => {
  const n = await comment(lena, 'Intern: Kennwort steht im Tresor', { internal: true });
  assert.equal((await del(karl, n.id)).status, 404);
  assert.equal((await del(lena, n.id)).status, 200);
  assert.equal((await view(karl)).comments.some((x) => x.id === n.id), false, 'a deleted internal note stays internal');
});

test('Files, pictures in the text, mail HTML and mentions of the comment are removed', async () => {
  const fd = new FormData();
  fd.append('draft', 'file');
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'screenshot.png');
  const up = await fetch(`${S.base}/api/tickets/${key}/attachments`, { method: 'POST', headers: { 'X-Helfi-Request': '1', cookie: karl.cookie() }, body: fd });
  const [fileId] = (await up.json()).ids;
  const c = await comment(karl, 'Siehe Bild', { attachmentIds: [fileId] });
  // a picture that came with a mail (inline) and the stored mail HTML
  const inline = S.ctx.tickets.addAttachment(ticketId(), { filename: 'logo.png', mime: 'image/png', buffer: PNG }, S.ids.karl, c.id, { inline: true });
  S.ctx.tickets.saveMailHtml(ticketId(), c.id, '<p>Siehe Bild</p>');
  S.db.prepare('INSERT INTO comment_mentions(comment_id,ticket_id,user_id) VALUES(?,?,?)').run(c.id, ticketId(), S.ids.lena);
  const files = S.db.prepare('SELECT * FROM attachments WHERE comment_id=?').all(c.id);
  assert.equal(files.length, 2);
  const dir = path.join(process.env.HELFI_DATA_DIR, 'attachments', String(ticketId()));
  for (const f of files) assert.ok(fs.existsSync(path.join(dir, f.storage_name)));
  assert.ok((await view(karl)).attachments.some((a) => a.id === fileId));

  const r = await del(karl, c.id);
  assert.equal(r.status, 200);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM attachments WHERE comment_id=?').get(c.id).n, 0);
  for (const f of files) assert.equal(fs.existsSync(path.join(dir, f.storage_name)), false, `${f.filename} deleted from disk`);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM mail_html WHERE comment_id=?').get(c.id).n, 0);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM comment_mentions WHERE comment_id=?').get(c.id).n, 0);
  assert.equal((await karl('GET', `/api/attachments/${fileId}`)).status, 404);
  assert.equal((await karl('GET', `/api/attachments/${inline}`)).status, 404);
  const tk = await view(karl);
  assert.equal(tk.attachments.some((a) => a.id === fileId), false);
  assert.equal(tk.comments.find((x) => x.id === c.id).hasHtml, false);
  assert.equal((await karl('GET', `/api/tickets/${key}/mail-html?comment=${c.id}`)).status, 404);
});

test('Search no longer finds the deleted text; the ticket itself stays', async () => {
  const c = await comment(karl, 'Zauberwortxyz steht hier');
  const found = async () => (await S.admin('GET', '/api/tickets?q=Zauberwortxyz')).body.tickets.map((t) => t.key);
  assert.deepEqual(await found(), [key], 'found before');
  await del(karl, c.id);
  assert.deepEqual(await found(), [], 'not found after deleting');
  assert.ok(S.ctx.tickets.load(null, key), 'tickets are never deleted');
  assert.ok(row(c.id), 'the comment row stays as placeholder');
});

test('A stored AI summary that may quote the text is dropped', async () => {
  const c = await comment(karl, 'Geheime Notiz');
  S.db.prepare("INSERT OR REPLACE INTO ai_summaries(ticket_id, text, model, lang, basis, created_at) VALUES(?, 'Geheime Notiz …', 'm', 'de', 'x', '2026-01-01')").run(ticketId());
  await del(karl, c.id);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM ai_summaries WHERE ticket_id=?').get(ticketId()).n, 0);
});

test('Notices of Helfi.Space itself (delivery failures) cannot be deleted', async () => {
  const sys = S.ctx.tickets.addComment(null, key, { body: 'Zustellung fehlgeschlagen' }, { source: 'system', authorName: 'Helfi.Space', skipPermission: true, system: true });
  assert.equal((await view(S.admin)).comments.find((x) => x.id === sys.id).canDelete, undefined);
  assert.equal((await del(S.admin, sys.id)).status, 403);
  assert.equal(row(sys.id).body, 'Zustellung fehlgeschlagen');
});

test('A comment id of another ticket is refused', async () => {
  const other = (await karl('POST', '/api/tickets', { title: 'Anderes', projectId: it })).body.ticket.key;
  const c = (await karl('POST', `/api/tickets/${other}/comments`, { body: 'anderswo' })).body.comment;
  assert.equal((await del(karl, c.id)).status, 404);
  assert.equal(row(c.id).deleted_at, null);
});
