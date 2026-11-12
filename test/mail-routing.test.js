// Mail routing via components: a new mail goes to the project of the best-matching component of all
// projects; nothing matches → the inbox project, whose people sort it (or the AI over all projects).
// Agents may move a ticket into any project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers/server.js';

// Fake model: "#hm" in the mail → the heating component (written without its keywords)
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    const user = json.messages?.[1]?.content || '';
    const want = user.includes('#hm') ? 'Haustechnik / Heizung & Klima' : null;
    const content = want ? `{"component": "${want}", "reason": "passt"}` : '{"component": null, "reason": "unklar"}';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

let S; let it; let hm; let hmLead; let heating; let printer; let ita;
let n = 0;
const mail = async (subject, body = 'Bitte um Hilfe.', from = 'erika@firma.local') => {
  n++;
  const raw = Buffer.from([`From: Erika Muster <${from}>`, 'To: helpdesk@firma.local', `Subject: ${subject}`, `Message-ID: <route${n}@firma.local>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'));
  const p = S.ctx.processor;
  const r = p.process(await p.parse(raw));
  return S.db.prepare('SELECT t.*, p.key project_key FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(r.ticketId);
};
const idle = async () => { await new Promise((r) => setTimeout(r, 30)); await S.ctx.aiClassifier.idle(); };

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await startServer('mailroute');
  ita = await S.user('ita', 'agent');
  await S.user('hausmeister', 'user');
  hmLead = S.ids.hausmeister;
  it = (await S.admin('GET', '/api/projects')).body.projects.find((p) => p.key === 'IT');
  hm = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project;
  // the facilities lead works on HM (project lead) and is the heating component's person
  assert.equal((await S.admin('PUT', `/api/projects/${hm.id}/agents`, { lead: { userId: hmLead } })).status, 200);
  heating = (await S.admin('POST', `/api/projects/${hm.id}/components`, { name: 'Heizung & Klima', keywords: 'heizung, heizkörper', leadId: hmLead })).body.component;
  printer = (await S.admin('POST', `/api/projects/${it.id}/components`, { name: 'Drucker', keywords: 'drucker, toner', leadId: S.ids.ita })).body.component;
  assert.ok(heating && printer);
  S.ctx.settings.set('imap.project', 'IT');
});
after(async () => { await S?.stop(); fake.close(); });

test('A mail goes to the project of the matching component, with component and its person', async () => {
  const t = await mail('Heizung in Raum 12 kalt', 'Der Heizkörper bleibt kalt.');
  assert.equal(t.project_key, 'HM');
  assert.equal(t.component_id, heating.id);
  assert.equal(t.assignee_id, hmLead, 'the component person gets it');
  const p = await mail('Drucker im 2. OG', 'Toner leer');
  assert.equal(p.project_key, 'IT');
  assert.equal(p.component_id, printer.id);
});

test('Nothing matches: the inbox project, without component; the inbox shows in the project list', async () => {
  const t = await mail('Frage zu meinem Vertrag');
  assert.equal(t.project_key, 'IT');
  assert.equal(t.component_id, null);
  const list = (await S.admin('GET', '/api/projects')).body.projects;
  assert.equal(list.find((p) => p.key === 'IT').inbox, true);
  assert.equal(list.find((p) => p.key === 'HM').inbox, false);
});

test('A sender rule with a project still wins', async () => {
  S.ctx.settings.set('imap.senderRules', JSON.stringify([{ pattern: 'monitor@firma.local', action: 'ticket', project: 'IT' }]));
  try {
    const t = await mail('Heizung Serverraum: Temperaturalarm', 'Heizung aus?', 'monitor@firma.local');
    assert.equal(t.project_key, 'IT');
  } finally { S.ctx.settings.set('imap.senderRules', '[]'); }
});

test('Agents move a ticket into any project – also one they do not work on', async () => {
  // hausmeister works on HM only; a mail landed wrongly in HM
  const t = await mail('Heizung? Nein: mein Laptop startet nicht', 'heizung');
  assert.equal(t.project_key, 'HM');
  const hmUser = await S.client().login('hausmeister');
  const r = await hmUser('PATCH', `/api/tickets/HM-${t.number}`, { projectId: it.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.projectKey, 'IT');
  assert.equal(r.body.ticket.assignee, null, 'the HM person is not assigned in IT');
  assert.equal((await hmUser('GET', `/api/tickets/${r.body.ticket.key}`)).status, 404, 'gone from their view');
  assert.equal((await ita('GET', `/api/tickets/${r.body.ticket.key}`)).body.ticket.agentView, true);
});

test('AI: a mail in the inbox picks from the components of all projects and moves the ticket', async () => {
  await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `http://127.0.0.1:${fake.address().port}/v1`, 'ai.model': 'test-model', 'ai.reasoning': 'off', 'ai.classify': true, 'ai.classifyMode': 'suggest' } });
  try {
    const t = await mail('Es ist eiskalt im Büro', '#hm');
    assert.equal(t.project_key, 'IT', 'no keyword: inbox first');
    await idle();
    const d = (await ita('GET', `/api/tickets/IT-${t.number}`)).body.ticket;
    assert.equal(d.componentSuggestion?.name, 'Haustechnik / Heizung & Klima');
    const acc = await ita('POST', `/api/tickets/IT-${t.number}/component-suggestion/accept`);
    assert.equal(acc.status, 200);
    assert.equal(acc.body.ticket.projectKey, 'HM');
    assert.equal(acc.body.ticket.component.id, heating.id);
    assert.equal(acc.body.ticket.assignee.id, hmLead);
    // auto mode: moves right away
    await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.classifyMode': 'auto' } });
    const u = await mail('Zu kalt hier', '#hm');
    await idle();
    const moved = S.db.prepare('SELECT t.*, p.key project_key FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(u.id);
    assert.equal(moved.project_key, 'HM');
    assert.equal(moved.component_id, heating.id);
    // tickets created in a project by hand: only that project's components (no moving)
    const web = (await ita('POST', '/api/tickets', { title: 'Raum zu kalt', description: '#hm', projectId: it.id })).body.ticket;
    await idle();
    assert.equal(S.db.prepare('SELECT project_id FROM tickets WHERE id=?').get(web.id).project_id, it.id);
  } finally {
    await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': false, 'ai.classifyMode': 'suggest' } });
  }
});

test('Examples cover facilities and administration with many keywords', async () => {
  const { EXAMPLES } = await import('../src/components.js');
  const keys = EXAMPLES.flatMap((g) => g.items.map((i) => i.key));
  for (const k of ['fac.water', 'fac.cleaning', 'fac.building', 'fac.safety', 'adm.finance', 'adm.events']) assert.ok(keys.includes(k), k);
  for (const i of EXAMPLES.flatMap((g) => g.items)) assert.ok(i.keywords.length >= 10, i.key);
});
