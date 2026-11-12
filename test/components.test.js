// Components: per project, keywords/sender rules, responsible person (information only – never assigned automatically), ticket field, filter, report
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let bert; let karl; let admin; let vpn; let printer; let monitor; let project;
before(async () => {
  S = await startServer('components');
  admin = S.admin;
  anna = await S.user('anna', 'agent');
  bert = await S.user('bert', 'agent');
  karl = await S.user('karl', 'user');
  project = (await admin('GET', '/api/projects')).body.projects[0];
});
after(() => S?.stop());

test('Matching: title counts more, short words only as a whole word, ties go by order', async () => {
  const { matchComponent } = await import('../src/components.js');
  const list = [
    { id: 1, name: 'PC', keywords: ['pc', 'monitor'], senders: [] },
    { id: 2, name: 'VPN', keywords: ['vpn', 'forticlient'], senders: [] },
    { id: 3, name: 'Drucker', keywords: ['drucker'], senders: ['*@printserver.firma.local'] },
  ];
  assert.equal(matchComponent(list, { title: 'VPN geht nicht', description: 'Monitor flackert auch' }).component.name, 'VPN', 'title 3 beats description 1');
  assert.equal(matchComponent(list, { title: 'Problem mit PCIe-Karte' }), null, '"pc" is not part of "pcie"');
  assert.equal(matchComponent(list, { title: 'Netzwerkdrucker offline' }).component.name, 'Drucker', 'from 4 letters inside words');
  assert.equal(matchComponent(list, { title: 'monitor und vpn' }).component.name, 'PC', 'tie: earlier component wins');
  const m = matchComponent(list, { title: 'VPN', sender: 'Queue@PrintServer.firma.local' });
  assert.equal(m.component.name, 'Drucker', 'sender pattern decides before keywords');
  assert.equal(m.kind, 'sender');
  assert.deepEqual(matchComponent(list, { title: 'FortiClient und VPN' }).words, ['vpn', 'forticlient']);
});

test('Admins manage components; agents read them, users not at all', async () => {
  let r = await admin('POST', `/api/projects/${project.id}/components`, {
    name: 'VPN & Fernzugriff', description: 'VPN-Client, Homeoffice', leadId: S.ids.anna, deputyId: S.ids.bert, keywords: 'VPN, FortiClient\nvpn, homeoffice',
  });
  assert.equal(r.status, 201);
  vpn = r.body.component;
  assert.deepEqual(vpn.keywords, ['vpn', 'forticlient', 'homeoffice'], 'lower case, no duplicates');
  assert.equal(vpn.lead.displayName, 'anna');
  assert.equal((await admin('POST', `/api/projects/${project.id}/components`, { name: 'vpn & fernzugriff' })).status, 409, 'name unique per project');
  assert.equal((await admin('POST', `/api/projects/${project.id}/components`, { name: '  ' })).status, 400);
  assert.equal((await admin('POST', `/api/projects/${project.id}/components`, { name: 'X', leadId: S.ids.karl })).status, 400, 'lead must be an agent');
  printer = (await admin('POST', `/api/projects/${project.id}/components`, { name: 'Drucker', keywords: 'drucker, toner', leadId: S.ids.bert })).body.component;
  monitor = (await admin('POST', `/api/projects/${project.id}/components`, { name: 'Monitoring', senders: '*@zabbix.firma.local, kaputt mit leerzeichen' })).body.component;
  assert.deepEqual(monitor.senders, ['*@zabbix.firma.local'], 'patterns with blanks are dropped');
  assert.equal((await anna('POST', `/api/projects/${project.id}/components`, { name: 'Y' })).status, 403);
  assert.equal((await anna('GET', `/api/projects/${project.id}/components`)).body.components.length, 3);
  assert.equal((await karl('GET', `/api/projects/${project.id}/components`)).status, 403);
  // Order
  r = await admin('POST', `/api/projects/${project.id}/components/order`, { ids: [printer.id, vpn.id] });
  assert.deepEqual(r.body.components.map((c) => c.name), ['Drucker', 'VPN & Fernzugriff', 'Monitoring']);
  // Test field
  r = await admin('POST', `/api/projects/${project.id}/components/test`, { title: 'FortiClient verbindet nicht', description: 'seit heute kein VPN' });
  assert.equal(r.body.component.name, 'VPN & Fernzugriff');
  assert.equal(r.body.kind, 'keywords');
  assert.equal(r.body.detail, 'vpn, forticlient');
  r = await admin('POST', `/api/projects/${project.id}/components/test`, { title: 'Alarm', sender: 'alerts@zabbix.firma.local' });
  assert.deepEqual([r.body.component.name, r.body.detail], ['Monitoring', '*@zabbix.firma.local']);
  assert.equal((await admin('POST', `/api/projects/${project.id}/components/test`, { title: 'Kaffee' })).body.component, null);
});

test('New ticket: component by keywords, nobody assigned automatically, history shows the reason', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'VPN bricht ab', description: 'FortiClient meldet Fehler' })).body.ticket;
  assert.equal(tk.component, null, 'users do not see the component');
  const full = (await anna('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.deepEqual(full.component, { id: vpn.id, name: 'VPN & Fernzugriff' });
  assert.equal(full.assignee, null, 'the responsible person is not assigned – agents take tickets themselves');
  const cl = full.activity.find((a) => a.action === 'classified');
  assert.deepEqual([cl.field, cl.oldValue, cl.newValue], ['keywords', 'vpn, forticlient', 'VPN & Fernzugriff']);
  assert.ok(!full.activity.some((a) => a.action === 'autoAssigned'));
});

test('Inactive lead: nobody assigned either; an assignee chosen by hand is kept; no match → nothing', async () => {
  await admin('PATCH', `/api/users/${S.ids.anna}`, { active: false });
  let tk = (await karl('POST', '/api/tickets', { title: 'Homeoffice VPN' })).body.ticket;
  let full = (await bert('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.equal(full.assignee, null, 'not the deputy either');
  await admin('PATCH', `/api/users/${S.ids.anna}`, { active: true });
  tk = (await bert('POST', '/api/tickets', { title: 'Toner leer', assigneeId: S.ids.anna })).body.ticket;
  assert.deepEqual([tk.component.name, tk.assignee.id], ['Drucker', S.ids.anna], 'an agent who picks someone by hand');
  tk = (await karl('POST', '/api/tickets', { title: 'Kaffeemaschine' })).body.ticket;
  full = (await bert('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.equal(full.component, null);
  assert.equal(full.assignee, null);
  assert.ok(!full.activity.some((a) => a.action === 'classified'));
});

test('Mail sender pattern decides; agents choose or change the component, history records it', async () => {
  const t = S.ctx.tickets.create(null, { title: 'PROBLEM: Disk full', projectId: project.id }, { source: 'email', reporterEmail: 'alerts@zabbix.firma.local', reporterId: null });
  assert.equal(t.component.name, 'Monitoring');
  const full = (await bert('GET', `/api/tickets/${t.key}`)).body.ticket;
  assert.deepEqual(full.activity.find((a) => a.action === 'classified').field, 'sender');
  assert.equal(full.assignee, null, 'no lead → stays unassigned');
  // Agent picks the component when creating: no rule, no "classified" entry
  let tk = (await bert('POST', '/api/tickets', { title: 'VPN', componentId: printer.id })).body.ticket;
  assert.equal(tk.component.name, 'Drucker');
  // Change
  let r = await bert('PATCH', `/api/tickets/${tk.key}`, { componentId: vpn.id });
  assert.equal(r.body.ticket.component.name, 'VPN & Fernzugriff');
  const ch = (await bert('GET', `/api/tickets/${tk.key}`)).body.ticket.activity.find((a) => a.action === 'changed' && a.field === 'component');
  assert.deepEqual([ch.oldValue, ch.newValue], ['Drucker', 'VPN & Fernzugriff']);
  assert.equal((await karl('PATCH', `/api/tickets/${tk.key}`, { componentId: printer.id })).status, 404, 'not his ticket');
  // Component of another project is refused
  const other = (await admin('POST', '/api/projects', { key: 'HT', name: 'Haustechnik' })).body.project;
  const heat = (await admin('POST', `/api/projects/${other.id}/components`, { name: 'Heizung' })).body.component;
  assert.equal((await bert('PATCH', `/api/tickets/${tk.key}`, { componentId: heat.id })).status, 400);
  // Project move clears the old component, a new one of the target project can be set at the same time
  r = await bert('PATCH', `/api/tickets/${tk.key}`, { projectId: other.id });
  assert.equal(r.body.ticket.component, null);
  tk = r.body.ticket;
  r = await bert('PATCH', `/api/tickets/${tk.id}`, { projectId: project.id, componentId: printer.id });
  assert.equal(r.body.ticket.component.name, 'Drucker');
  r = await bert('PATCH', `/api/tickets/${tk.id}`, { componentId: null });
  assert.equal(r.body.ticket.component, null);
});

test('List filter by component and report per component', async () => {
  const list = (await bert('GET', `/api/tickets?component=${vpn.id}`)).body.tickets;
  assert.ok(list.length >= 2 && list.every((x) => x.component.id === vpn.id));
  const none = (await bert('GET', '/api/tickets?component=none')).body.tickets;
  assert.ok(none.length && none.every((x) => !x.component));
  const rep = (await bert('GET', '/api/reports')).body.components;
  const row = rep.find((x) => x.componentId === vpn.id);
  assert.ok(row.total >= 2);
  assert.equal(row.projectKey, 'IT');
  assert.ok(rep.some((x) => x.componentId === null), 'tickets without a component are counted too');
  assert.ok(!(await bert('GET', '/api/reports?project=HT')).body.components.some((x) => x.componentId === vpn.id), 'project filter');
});

test('Examples: take over by key, existing names skipped; delete keeps tickets', async () => {
  const ex = (await admin('GET', '/api/components/examples')).body.examples;
  assert.deepEqual(ex.map((s) => s.key), ['it', 'facility', 'admin']);
  const p = (await admin('POST', '/api/projects', { key: 'EX', name: 'Beispiele' })).body.project;
  let r = await admin('POST', `/api/projects/${p.id}/components/examples`, { keys: ['it.vpn', 'it.printer', 'nope'], lang: 'de' });
  assert.deepEqual(r.body.added.map((c) => c.name), ['Drucker & Scanner', 'VPN & Fernzugriff'], 'order of the example list');
  r = await admin('POST', `/api/projects/${p.id}/components/examples`, { keys: ['it.vpn', 'fac.heating'], lang: 'en' });
  assert.deepEqual(r.body.added.map((c) => c.name), ['Heating & air conditioning']);
  assert.deepEqual(r.body.skipped, ['VPN & remote access'], 'already there under its German name');
  // Delete: tickets stay, field empty
  const tk = (await bert('POST', '/api/tickets', { title: 'Druckerproblem', projectId: p.id })).body.ticket;
  assert.equal(tk.component.name, 'Drucker & Scanner');
  const del = await admin('DELETE', `/api/components/${tk.component.id}`);
  assert.equal(del.body.tickets, 1);
  assert.equal((await bert('GET', `/api/tickets/${tk.key}`)).body.ticket.component, null);
});
