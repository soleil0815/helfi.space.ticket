// Problem management and extra fields
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl;
before(async () => {
  S = await startServer('problem');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
});
after(() => S.stop());

test('Users cannot create problems', async () => {
  const r = await karl('POST', '/api/tickets', { title: 'x', type: 'problem' });
  assert.equal(r.body.ticket.type, 'request');
});

test('Problem from incident, fields, known error, banner and notice to affected tickets', async () => {
  const inc = (await karl('POST', '/api/tickets', { title: 'Drucker druckt nicht', type: 'incident' })).body.ticket.key;
  assert.equal((await karl('POST', `/api/tickets/${inc}/problem`, {})).status, 403);
  const p = (await anna('POST', `/api/tickets/${inc}/problem`, {})).body.ticket;
  assert.equal(p.type, 'problem');
  assert.equal(p.title, 'Drucker druckt nicht');
  let tk = (await anna('GET', `/api/tickets/${p.key}`)).body.ticket;
  assert.deepEqual(tk.fields, { rootCause: '', workaround: '', knownError: false });
  assert.equal(tk.affectedCount, 1);
  const r = await anna('PATCH', `/api/tickets/${p.key}/fields`, { rootCause: 'Treiber 3.2', workaround: 'Treiber 3.1 verwenden', knownError: true, unbekannt: 'x' });
  assert.deepEqual(r.body.fields, { rootCause: 'Treiber 3.2', workaround: 'Treiber 3.1 verwenden', knownError: true });
  tk = (await anna('GET', `/api/tickets/${p.key}`)).body.ticket;
  assert.ok(tk.activity.some((a) => a.field === 'rootCause' && a.newValue === null), 'text without content in the activity log');
  assert.ok(tk.activity.some((a) => a.field === 'knownError' && a.newValue === '1'));
  const i = (await anna('GET', `/api/tickets/${inc}`)).body.ticket;
  assert.deepEqual(i.problems, [{ key: p.key, title: 'Drucker druckt nicht', status: 'open', workaround: 'Treiber 3.1 verwenden', knownError: true }]);
  assert.equal((await karl('GET', `/api/tickets/${inc}`)).body.ticket.problems, undefined, 'users do not see the banner');
  assert.equal((await karl('PATCH', `/api/tickets/${p.key}/fields`, { rootCause: 'x' })).status, 403);
  assert.deepEqual((await anna('GET', '/api/known-errors')).body.knownErrors.map((k) => k.key), [p.key]);
  // Notice to all affected incidents
  const b = await anna('POST', `/api/tickets/${p.key}/broadcast`, { body: 'Bitte Treiber 3.1 verwenden.' });
  assert.deepEqual(b.body, { notified: 2, resolved: 0 });
  assert.equal((await karl('GET', `/api/tickets/${inc}`)).body.ticket.comments.at(-1).body, 'Bitte Treiber 3.1 verwenden.');
  // Fields only exist for matching types
  assert.equal((await anna('PATCH', `/api/tickets/${inc}/fields`, { rootCause: 'x' })).status, 400);
  assert.equal((await anna('GET', '/api/queues')).body.counts.problems, 1);
});

test('Migration 12 rebuilds tickets without losing comments, links or attachments', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const { MIGRATIONS, openDatabase } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mig12-'));
  const file = path.join(dir, 'h.sqlite');
  // Create the state before migration 12 with data
  const d = new Database(file);
  d.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS.filter((x) => x.id < 12)) d.exec(m.sql);
  d.exec("INSERT INTO meta(key,value) VALUES('schema_version','11'),('app_version','1.5.0')");
  d.exec("INSERT INTO projects(id,key,name) VALUES(1,'IT','IT')");
  d.exec("INSERT INTO tickets(id,project_id,number,title,type,impact,major) VALUES(1,1,1,'A','incident','high',1),(2,1,2,'B','request',NULL,0)");
  d.exec("INSERT INTO comments(ticket_id,body) VALUES(1,'Hallo')");
  d.exec("INSERT INTO ticket_links(from_id,to_id,kind) VALUES(1,2,'causes')");
  assert.throws(() => d.exec("INSERT INTO tickets(project_id,number,title,type) VALUES(1,3,'C','problem')"), /CHECK/);
  d.close();
  const db = await openDatabase(file, { appVersion: '1.6.0', backupDir: path.join(dir, 'b') });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM comments').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ticket_links').get().n, 1);
  assert.deepEqual({ ...db.prepare('SELECT impact, major FROM tickets WHERE id=1').get() }, { impact: 'high', major: 1 });
  db.prepare("INSERT INTO tickets(project_id,number,title,type) VALUES(1,3,'C','problem')").run();
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys back on');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  // Foreign keys still work: a comment on an unknown ticket is rejected
  assert.throws(() => db.prepare("INSERT INTO comments(ticket_id,body) VALUES(999,'x')").run(), /FOREIGN KEY/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
