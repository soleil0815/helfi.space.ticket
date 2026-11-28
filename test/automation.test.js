// Automation rules: triggers, conditions, actions, rights, loop protection, emergency brake, time rules,
// preview and the example rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let karl; let lena; let otto; const sent = [];
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  S = await startServer('automation');
  karl = await S.user('karl', 'user');
  lena = await S.user('lena', 'agent');
  otto = await S.user('otto', 'user');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
  S.db.prepare("UPDATE users SET email='admin@firma.local' WHERE username='admin'").run();
});
after(() => S.stop());

const pid = () => S.db.prepare("SELECT id FROM projects WHERE key='IT'").get().id;
const mk = async (title, description = '') => (await karl('POST', '/api/tickets', { projectId: pid(), title, description })).body.ticket.key;
const get = async (key) => (await S.admin('GET', `/api/tickets/${key}`)).body.ticket;
const rule = async (body, who = S.admin) => {
  const r = await who('POST', '/api/automation/rules', { projectId: pid(), enabled: true, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.rule;
};
const off = (id) => S.admin('PATCH', `/api/automation/rules/${id}`, { enabled: false });

test('Created + keywords → priority; history names the rule; runs are recorded', async () => {
  const r = await rule({ name: 'Konto gesperrt', trigger: { type: 'created' }, conditions: { keywords: ['gesperrt'] }, actions: [{ type: 'setPriority', priority: 'high' }] });
  const hit = await mk('Mein Konto ist gesperrt');
  const miss = await mk('Drucker druckt nicht');
  await wait();
  const t = await get(hit);
  assert.equal(t.priority, 'high');
  const a = t.activity.find((x) => x.field === 'priority');
  assert.equal(a.via, 'automation');
  assert.equal(a.viaName, 'Konto gesperrt');
  assert.equal(a.user, null);
  assert.equal((await get(miss)).priority, 'medium');
  const runs = (await S.admin('GET', `/api/automation/rules/${r.id}/runs`)).body.runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].ticketKey, hit);
  assert.equal(runs[0].ok, true);
  await off(r.id);
});

test('Customer replies → internal note + mail to the lead; reply to customer and close (quiet)', async () => {
  const note = await rule({ name: 'Kunde hat geantwortet', trigger: { type: 'customerReplied' },
    actions: [{ type: 'note', text: 'Kunde {kunde} hat geantwortet' }, { type: 'notify', roles: ['lead'], userIds: [], text: 'Bitte ansehen.' }] });
  const key = await mk('VPN geht nicht');
  await S.admin('POST', `/api/tickets/${key}/comments`, { body: 'Bitte neu starten' });
  sent.length = 0;
  await karl('POST', `/api/tickets/${key}/comments`, { body: 'Hat nicht geholfen' });
  await wait(150);
  const comments = (await S.admin('GET', `/api/tickets/${key}`)).body.ticket.comments;
  const n = comments.find((c) => c.internal && c.body === 'Kunde karl hat geantwortet');
  assert.ok(n, 'internal note with placeholder');
  assert.equal(n.author.automation, true);
  assert.equal(n.author.displayName, 'Kunde hat geantwortet');
  // customers never see internal notes; the mail to the lead (admin) names ticket and rule
  assert.ok(!(await karl('GET', `/api/tickets/${key}`)).body.ticket.comments.some((c) => c.internal));
  const mail = sent.find((m) => m.to === 'admin@firma.local' && /Kunde hat geantwortet/.test(m.text));
  assert.ok(mail, JSON.stringify(sent.map((m) => m.to)));
  assert.match(mail.text, /Bitte ansehen\./);
  assert.match(mail.text, new RegExp(key));
  assert.ok(!sent.some((m) => m.to === 'karl@firma.local' && /Kunde karl hat geantwortet/.test(m.text)), 'internal note never mailed to the customer');
  await off(note.id);
});

test('Status trigger from/to; close with reply sends one mail, survey-free, resolution set', async () => {
  const r = await rule({ name: 'Erledigt wenn auf In Arbeit', trigger: { type: 'statusChanged', from: 'open', to: 'in_progress' }, conditions: { types: ['question'] },
    actions: [{ type: 'reply', text: 'Hallo {kunde}, wir schließen {ticket}.' }, { type: 'setStatus', status: 'done', resolution: 'done' }] });
  const key = await mk('Frage zur Software');
  await S.admin('PATCH', `/api/tickets/${key}`, { type: 'question' });
  sent.length = 0;
  await S.admin('PATCH', `/api/tickets/${key}`, { status: 'in_progress' });
  await wait(200);
  const t = await get(key);
  assert.equal(t.status, 'done');
  const toKarl = sent.filter((m) => m.to === 'karl@firma.local');
  assert.equal(toKarl.length, 1, `one mail to the customer, got ${toKarl.map((m) => m.subject)}`);
  assert.match(toKarl[0].text, new RegExp(`wir schließen ${key}`));
  // customer sees the reply as written by the ticket system, not the rule's name
  const c = (await karl('GET', `/api/tickets/${key}`)).body.ticket.comments.at(-1);
  assert.equal(c.author.displayName, 'Helfi.Space');
  await off(r.id);
});

test('Loop protection: a rule never reacts to its own change; chains stop', async () => {
  // A: status → in_progress sets waiting; B: waiting → in_progress. Without protection this would loop.
  const a = await rule({ name: 'A', trigger: { type: 'statusChanged', to: 'in_progress' }, actions: [{ type: 'setStatus', status: 'waiting' }] });
  const b = await rule({ name: 'B', trigger: { type: 'statusChanged', to: 'waiting' }, actions: [{ type: 'setStatus', status: 'in_progress' }] });
  const key = await mk('Schleife');
  await S.admin('PATCH', `/api/tickets/${key}`, { status: 'in_progress' });
  await wait(400);
  const ra = (await S.admin('GET', `/api/automation/rules/${a.id}/runs`)).body.runs.length;
  const rb = (await S.admin('GET', `/api/automation/rules/${b.id}/runs`)).body.runs.length;
  assert.ok(ra + rb <= 3, `chain stopped (A ${ra}, B ${rb})`);
  await wait(300);
  assert.equal((await S.admin('GET', `/api/automation/rules/${a.id}/runs`)).body.runs.length, ra, 'no further runs');
  await off(a.id); await off(b.id);
});

test('Assign only to the chosen person, and only while they work on the project', async () => {
  const r = await rule({ name: 'Drucker an Lena', trigger: { type: 'created' }, conditions: { keywords: ['drucker'] }, actions: [{ type: 'assign', userId: S.ids.lena }] });
  const k1 = await mk('Drucker kaputt');
  await wait();
  assert.equal((await get(k1)).assignee?.id, S.ids.lena);
  // Nothing else is ever assigned automatically
  const k2 = await mk('Monitor flackert');
  await wait();
  assert.equal((await get(k2)).assignee, null);
  // Lena deactivated: skipped, never someone else
  S.db.prepare('UPDATE users SET active=0 WHERE id=?').run(S.ids.lena);
  const k3 = await mk('Drucker schon wieder');
  await wait();
  assert.equal((await get(k3)).assignee, null);
  const runs = (await S.admin('GET', `/api/automation/rules/${r.id}/runs`)).body.runs;
  assert.equal(runs[0].detail[0].skipped, 'assignee');
  S.db.prepare('UPDATE users SET active=1 WHERE id=?').run(S.ids.lena);
  // A rule cannot even be saved with someone who does not work on the project
  const bad = await S.admin('POST', '/api/automation/rules', { projectId: pid(), name: 'x', trigger: { type: 'created' }, actions: [{ type: 'assign', userId: S.ids.karl }] });
  assert.equal(bad.status, 400);
  await off(r.id);
});

test('Time rule: once per phase; a customer answer starts a new phase', async () => {
  const r = await rule({ name: 'Erinnern', trigger: { type: 'time', basis: 'status', status: 'waiting', hours: 168 }, actions: [{ type: 'reply', text: 'Erinnerung zu {ticket}' }] });
  const key = await mk('Wartet lange');
  await S.admin('POST', `/api/tickets/${key}/comments`, { body: 'Frage an dich' }); // → Waiting
  const id = S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number=?").get(key).id;
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  S.db.prepare("UPDATE activity SET created_at=? WHERE ticket_id=? AND field='status'").run(ago(8), id);
  assert.equal(S.ctx.automation.checkTime(), 1);
  assert.equal(S.ctx.automation.checkTime(), 0, 'not again in the same phase');
  await wait();
  assert.ok((await get(key)).status === 'waiting', 'automation reply does not change the status');
  const reminders = () => S.db.prepare("SELECT COUNT(*) n FROM comments WHERE ticket_id=? AND source='automation' AND body LIKE 'Erinnerung%'").get(id).n;
  assert.equal(reminders(), 1);
  // customer answers → open; agent asks again → new phase, after 7 days the next reminder
  await karl('POST', `/api/tickets/${key}/comments`, { body: 'Hier die Antwort' });
  await S.admin('POST', `/api/tickets/${key}/comments`, { body: 'Noch eine Frage' });
  S.db.prepare("UPDATE activity SET created_at=? WHERE ticket_id=? AND field='status'").run(ago(9), id);
  S.db.prepare("UPDATE activity SET created_at=? WHERE id=(SELECT MAX(id) FROM activity WHERE ticket_id=? AND field='status')").run(ago(7.5), id);
  assert.equal(S.ctx.automation.checkTime(), 1);
  assert.equal(reminders(), 2);
  await off(r.id);
});

test('Emergency brake: too many runs per hour switch the rule off and mail the admins', async () => {
  const r = await rule({ name: 'Zu eifrig', trigger: { type: 'created' }, actions: [{ type: 'note', text: 'x' }] });
  const ins = S.db.prepare('INSERT INTO automation_runs(rule_id,ticket_id,event) VALUES(?,NULL,?)');
  for (let i = 0; i < 200; i++) ins.run(r.id, 'created');
  sent.length = 0;
  await mk('noch eins');
  await wait(100);
  const now = (await S.admin('GET', '/api/automation/rules')).body.rules.find((x) => x.id === r.id);
  assert.equal(now.enabled, false);
  assert.equal(now.disabledReason, 'runaway');
  assert.ok(sent.some((m) => /Zu eifrig/.test(m.subject)), 'admins informed');
  // switched on again: the reason goes away
  const back = (await S.admin('PATCH', `/api/automation/rules/${r.id}`, { enabled: true })).body.rule;
  assert.equal(back.disabledReason, null);
  await off(r.id);
});

test('Rights: lead/deputy of the project only; "all projects" admins only; users nothing', async () => {
  S.db.prepare('UPDATE projects SET deputy_id=? WHERE id=?').run(S.ids.otto, pid());
  const asDeputy = await otto('POST', '/api/automation/rules', { projectId: pid(), name: 'Von der Vertretung', trigger: { type: 'created' }, actions: [{ type: 'setPriority', priority: 'low' }] });
  assert.equal(asDeputy.status, 201);
  assert.equal(asDeputy.body.rule.enabled, false, 'new rules start switched off');
  assert.equal((await otto('POST', '/api/automation/rules', { name: 'global', trigger: { type: 'created' }, actions: [{ type: 'setPriority', priority: 'low' }] })).status, 403);
  assert.equal((await karl('GET', '/api/automation/rules')).body.rules.length, 0);
  assert.equal((await karl('POST', '/api/automation/rules', { projectId: pid(), name: 'x', trigger: { type: 'created' }, actions: [{ type: 'setPriority', priority: 'low' }] })).status, 403);
  assert.equal((await karl('PATCH', `/api/automation/rules/${asDeputy.body.rule.id}`, { enabled: true })).status, 403);
  // Global rule (admin): no components or persons, mails only to roles
  const g = await S.admin('POST', '/api/automation/rules', { name: 'Global', trigger: { type: 'created' }, actions: [{ type: 'notify', roles: ['lead'], userIds: [] }] });
  assert.equal(g.status, 201);
  assert.equal((await S.admin('POST', '/api/automation/rules', { name: 'Global', trigger: { type: 'created' }, actions: [{ type: 'assign', userId: S.ids.lena }] })).status, 400);
  // No typed addresses: unknown fields are dropped, a notify without users/roles is refused
  assert.equal((await S.admin('POST', '/api/automation/rules', { projectId: pid(), name: 'x', trigger: { type: 'created' }, actions: [{ type: 'notify', to: 'jemand@extern.example' }] })).status, 400);
  S.db.prepare('UPDATE projects SET deputy_id=NULL WHERE id=?').run(pid());
  assert.equal((await otto('GET', `/api/automation/rules?projectId=${pid()}`)).status, 403, 'no longer deputy → no rights');
  await S.admin('DELETE', `/api/automation/rules/${g.body.rule.id}`);
});

test('Validation: closing must be the last change; bad values refused', async () => {
  const base = { projectId: pid(), name: 'x', trigger: { type: 'created' } };
  assert.equal((await S.admin('POST', '/api/automation/rules', { ...base, actions: [{ type: 'setStatus', status: 'done' }, { type: 'setPriority', priority: 'low' }] })).status, 400);
  assert.equal((await S.admin('POST', '/api/automation/rules', { ...base, actions: [{ type: 'setStatus', status: 'done' }, { type: 'note', text: 'ok' }] })).status, 201);
  assert.equal((await S.admin('POST', '/api/automation/rules', { ...base, trigger: { type: 'time', basis: 'status', hours: 5 }, actions: [{ type: 'note', text: 'x' }] })).status, 400, 'status needed');
  assert.equal((await S.admin('POST', '/api/automation/rules', { ...base, trigger: { type: 'nope' }, actions: [{ type: 'note', text: 'x' }] })).status, 400);
  assert.equal((await S.admin('POST', '/api/automation/rules', { ...base, actions: [] })).status, 400);
  assert.equal((await S.admin('POST', '/api/automation/rules', { ...base, conditions: { priorities: ['urgent'] }, actions: [{ type: 'note', text: 'x' }] })).status, 400);
});

test('Preview changes nothing; templates come switched off and in the user\'s language', async () => {
  const key = await mk('Kennwort vergessen');
  await wait();
  const before = await get(key);
  const p = await S.admin('POST', '/api/automation/preview', { projectId: pid(), name: 'p', trigger: { type: 'created' }, conditions: { keywords: ['kennwort'] }, actions: [{ type: 'setPriority', priority: 'highest' }] });
  assert.equal(p.status, 200);
  assert.ok(p.body.tickets.some((x) => x.key === key));
  assert.equal((await get(key)).priority, before.priority);
  const tpls = (await S.admin('GET', '/api/automation/templates?lang=en')).body.templates;
  assert.deepEqual(tpls.map((x) => x.key), ['waiting-remind', 'waiting-close', 'urgent-unassigned', 'account-priority', 'no-component']);
  assert.match(tpls[0].actions[0].text, /still waiting/);
  for (const k of tpls.map((x) => x.key)) {
    const r = await S.admin('POST', `/api/automation/templates/${k}`, { projectId: pid(), lang: 'de' });
    assert.equal(r.status, 201, k);
    assert.equal(r.body.rule.enabled, false);
    assert.equal(r.body.rule.template, k);
  }
  const close = (await S.admin('GET', `/api/automation/rules?projectId=${pid()}`)).body.rules.find((x) => x.template === 'waiting-close');
  assert.equal(close.name, 'Kunde meldet sich nicht: schließen');
  assert.equal(close.trigger.hours, 336);
  assert.equal(close.actions.at(-1).status, 'done');
});

test('Example "waiting-close": after 14 days in Waiting the ticket is closed with a message; reopens on answer', async () => {
  const close = (await S.admin('GET', `/api/automation/rules?projectId=${pid()}`)).body.rules.find((x) => x.template === 'waiting-close');
  await S.admin('PATCH', `/api/automation/rules/${close.id}`, { enabled: true });
  const key = await mk('Niemand antwortet');
  await S.admin('POST', `/api/tickets/${key}/comments`, { body: 'Geht es jetzt?' });
  const id = S.db.prepare("SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number=?").get(key).id;
  S.db.prepare("UPDATE activity SET created_at=? WHERE ticket_id=? AND field='status'").run(new Date(Date.now() - 15 * 86400000).toISOString(), id);
  S.ctx.automation.checkTime();
  await wait(100);
  const t = await get(key);
  assert.equal(t.status, 'done');
  assert.equal(t.resolution, 'done');
  const last = (await karl('GET', `/api/tickets/${key}`)).body.ticket.comments.at(-1);
  assert.match(last.body, /schließen wir/);
  await karl('POST', `/api/tickets/${key}/comments`, { body: 'Doch noch aktuell!' });
  assert.equal((await get(key)).status, 'open');
  await off(close.id);
});
