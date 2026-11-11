// Reminder for forgotten tickets: daily mail to the project lead (no lead: admins) listing open tickets
// nobody has been assigned to for X days.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let karl; const sent = [];
const DAY = 86400000;
before(async () => {
  S = await startServer('reminder');
  await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
});
after(() => S.stop());

const set = (values) => { for (const [k, v] of Object.entries(values)) S.ctx.settings.set(k, v); };
// A Wednesday, 10:00 local time – ticket ages are counted back from there
const wed = (h = 10) => new Date(2030, 0, 9, h, 0, 0);
const mk = async (title, ageDays) => {
  const key = (await karl('POST', '/api/tickets', { title })).body.ticket.key;
  const at = new Date(wed().getTime() - ageDays * DAY).toISOString();
  S.db.prepare("UPDATE tickets SET created_at=? WHERE project_id=(SELECT id FROM projects WHERE key='IT') AND number=?").run(at, Number(key.split('-')[1]));
  return key;
};
const project = () => S.db.prepare("SELECT * FROM projects WHERE key='IT'").get();

test('Off by default: no mail', async () => {
  await mk('Alt und vergessen', 10);
  const r = await S.ctx.reminders.check({ now: new Date() });
  assert.deepEqual(r, { mails: 0, projects: 0 });
  assert.equal(sent.length, 0);
});

test('One mail to the project lead with the forgotten tickets only, at most once a day', async () => {
  S.db.prepare('UPDATE projects SET lead_id=? WHERE key=?').run(S.ids.anna, 'IT');
  S.db.prepare("UPDATE tickets SET assignee_id=? WHERE title='Alt und vergessen'").run(S.ids.anna); // from the first test: assigned now
  const old1 = await mk('Drucker 2. OG druckt nicht', 5);
  const old2 = await mk('VPN bricht ab', 4);
  const fresh = await mk('Neu von heute', 0);
  const assigned = await mk('Schon zugewiesen', 8);
  assert.equal((await S.admin('PATCH', `/api/tickets/${assigned}`, { assigneeId: S.ids.anna })).status, 200);
  const done = await mk('Schon erledigt', 9);
  assert.equal((await S.admin('PATCH', `/api/tickets/${done}`, { status: 'done' })).status, 200);
  set({ 'reminder.unassignedDays': 3, 'reminder.time': '08:00', 'reminder.weekdaysOnly': true });
  sent.length = 0;
  // before 08:00: nothing yet
  assert.equal((await S.ctx.reminders.check({ now: wed(7) })).mails, 0);
  const r = await S.ctx.reminders.check({ now: wed(10) });
  assert.deepEqual(r, { mails: 1, projects: 1 });
  assert.equal(sent[0].to, 'anna@firma.local');
  assert.match(sent[0].subject, /2 Tickets in .+ warten auf Bearbeitung/);
  for (const k of [old1, old2]) assert.ok(sent[0].text.includes(k), k);
  for (const k of [fresh, assigned, done]) assert.ok(!sent[0].text.includes(`${k} `), k);
  assert.ok(sent[0].text.indexOf(old1) < sent[0].text.indexOf(old2), 'oldest first');
  assert.match(sent[0].text, /\/issues\?project=IT&assignee=none&status=unresolved/);
  assert.match(sent[0].text, /seit 5 Tagen/);
  // same day again: nothing
  assert.equal((await S.ctx.reminders.check({ now: wed(15) })).mails, 0);
  // next day: again
  assert.equal((await S.ctx.reminders.check({ now: new Date(2030, 0, 10, 9) })).mails, 1);
  // Saturday with "weekdays only": nothing; switched off: nothing
  assert.equal((await S.ctx.reminders.check({ now: new Date(2030, 0, 12, 9) })).mails, 0);
  set({ 'reminder.weekdaysOnly': false });
  assert.equal((await S.ctx.reminders.check({ now: new Date(2030, 0, 12, 9) })).mails, 1);
  set({ 'reminder.unassignedDays': 0 });
  assert.equal((await S.ctx.reminders.check({ now: new Date(2030, 0, 13, 9), force: true })).mails, 0);
  set({ 'reminder.unassignedDays': 3 });
});

test('Without a lead the admins get it; long lists are cut; archived projects are skipped', async () => {
  S.db.prepare('UPDATE projects SET lead_id=NULL WHERE key=?').run('IT');
  S.db.prepare("UPDATE users SET email='admin@firma.local' WHERE username='admin'").run();
  for (let i = 0; i < 32; i++) await mk(`Alte Anfrage ${i}`, 6);
  sent.length = 0;
  const r = await S.ctx.reminders.check({ now: wed(), force: true });
  assert.equal(r.mails, 1);
  assert.equal(sent[0].to, 'admin@firma.local');
  assert.equal((sent[0].text.match(/^• /gm) || []).length, 30);
  assert.match(sent[0].text, /… und 4 weitere/); // 2 from before + 32 = 34
  // inactive lead → admins as well
  S.db.prepare('UPDATE users SET active=0 WHERE username=?').run('anna');
  S.db.prepare('UPDATE projects SET lead_id=? WHERE key=?').run(S.ids.anna, 'IT');
  sent.length = 0;
  await S.ctx.reminders.check({ now: wed(), force: true });
  assert.deepEqual(sent.map((m) => m.to), ['admin@firma.local']);
  S.db.prepare('UPDATE users SET active=1 WHERE username=?').run('anna');
  S.db.prepare('UPDATE projects SET archived=1 WHERE key=?').run('IT');
  sent.length = 0;
  assert.equal((await S.ctx.reminders.check({ now: wed(), force: true })).mails, 0);
  S.db.prepare('UPDATE projects SET archived=0 WHERE key=?').run('IT');
  assert.equal(project().archived, 0);
});

test('Admin: "Check now" button route, settings validated, agents not allowed', async () => {
  // the button checks with the real clock
  S.db.prepare('UPDATE tickets SET created_at=?').run(new Date(Date.now() - 10 * DAY).toISOString());
  sent.length = 0;
  const r = await S.admin('POST', '/api/admin/reminder/run');
  assert.equal(r.status, 200);
  assert.equal(r.body.mails, 1);
  for (const bad of [{ 'reminder.unassignedDays': 61 }, { 'reminder.unassignedDays': -1 }, { 'reminder.time': '25:00' }, { 'reminder.time': 'morgens' }]) {
    assert.equal((await S.admin('PUT', '/api/admin/settings', { settings: bad })).status, 400, JSON.stringify(bad));
  }
  const ok = await S.admin('PUT', '/api/admin/settings', { settings: { 'reminder.unassignedDays': 7, 'reminder.time': '7:30', 'reminder.weekdaysOnly': false } });
  assert.equal(ok.status, 200);
  assert.equal(S.ctx.settings.get('reminder.unassignedDays'), 7);
  const anna = await S.client().login('anna');
  assert.equal((await anna('POST', '/api/admin/reminder/run')).status, 403);
});
