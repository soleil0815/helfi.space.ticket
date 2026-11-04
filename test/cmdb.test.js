// Devices and services: inventory, ticket linking, history, CSV import
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl;
before(async () => {
  S = await startServer('cmdb');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
});
after(() => S.stop());

test('Reading CSV: delimiters, quotes, line breaks', async () => {
  const { parseCsv } = await import('../src/itil/cmdb.js');
  assert.deepEqual(parseCsv('﻿Name;Ort\r\nPC-0001;"Raum 1; EG"\r\n\r\n"PC-""2""";"zwei\nZeilen"'),
    [['Name', 'Ort'], ['PC-0001', 'Raum 1; EG'], ['PC-"2"', 'zwei\nZeilen']]);
  assert.deepEqual(parseCsv('name,ip\nsrv-01,10.0.10.5'), [['name', 'ip'], ['srv-01', '10.0.10.5']]);
  assert.deepEqual(parseCsv('name\tip\nsrv-01\t10.0.10.5'), [['name', 'ip'], ['srv-01', '10.0.10.5']]);
});

test('Create, search, edit items; agents only', async () => {
  assert.equal((await karl('GET', '/api/cis')).status, 403);
  assert.equal((await karl('POST', '/api/cis', { name: 'PC-0001' })).status, 403);
  assert.equal((await anna('POST', '/api/cis', { name: ' ' })).status, 400);
  const pc = (await anna('POST', '/api/cis', { name: 'PC-0001', kind: 'device', location: 'Raum 1.12', ip: '10.0.10.21', model: 'ThinkCentre' })).body.item;
  assert.equal((await anna('POST', '/api/cis', { name: 'pc-0001' })).status, 409, 'name duplicate ignoring case');
  const srv = (await anna('POST', '/api/cis', { name: 'SRV-FILE01', kind: 'server', ip: '10.0.10.5' })).body.item;
  await anna('POST', '/api/cis', { name: 'Alter Drucker', kind: 'printer', status: 'retired' });
  assert.deepEqual((await anna('GET', '/api/cis')).body.items.map((x) => x.name), ['PC-0001', 'SRV-FILE01'], 'retired ones hidden');
  assert.equal((await anna('GET', '/api/cis?status=all')).body.items.length, 3);
  assert.deepEqual((await anna('GET', '/api/cis?q=10.0.10.5')).body.items.map((x) => x.id), [srv.id]);
  assert.deepEqual((await anna('GET', '/api/cis?q=raum%201')).body.items.map((x) => x.id), [pc.id]);
  assert.deepEqual((await anna('GET', '/api/cis?q=%25')).body.items, [], 'wildcards are not evaluated');
  assert.deepEqual((await anna('GET', '/api/cis?kind=server')).body.items.map((x) => x.id), [srv.id]);
  const u = (await anna('PUT', `/api/cis/${pc.id}`, { status: 'maintenance', ownerId: S.ids?.karl })).body.item;
  assert.equal(u.status, 'maintenance');
  assert.equal(u.location, 'Raum 1.12', 'fields not given stay unchanged');
});

test('Link to tickets, history per device, deletion protection', async () => {
  const [pc] = (await anna('GET', '/api/cis?q=PC-0001')).body.items;
  const tk = (await karl('POST', '/api/tickets', { title: 'PC startet nicht' })).body.ticket;
  assert.equal((await karl('POST', `/api/tickets/${tk.key}/cis`, { ciId: pc.id })).status, 403);
  const r = await anna('POST', `/api/tickets/${tk.key}/cis`, { name: 'pc-0001' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cis.map((x) => x.name), ['PC-0001']);
  await anna('POST', `/api/tickets/${tk.key}/cis`, { ciId: pc.id }); // duplicate → nothing happens
  const det = (await anna('GET', `/api/tickets/${tk.key}`)).body.ticket;
  assert.deepEqual(det.cis.map((x) => x.id), [pc.id]);
  assert.equal(det.activity.filter((a) => a.action === 'ciLinked').length, 1);
  assert.equal((await karl('GET', `/api/tickets/${tk.key}`)).body.ticket.cis, undefined, 'users do not see the inventory');

  const item = (await anna('GET', `/api/cis/${pc.id}`)).body.item;
  assert.deepEqual(item.history.map((x) => x.key), [tk.key]);
  assert.equal(item.openTickets, 1);

  assert.equal((await anna('DELETE', `/api/cis/${pc.id}`)).status, 403);
  assert.equal((await S.admin('DELETE', `/api/cis/${pc.id}`)).status, 409, 'history is preserved');
  const un = await anna('DELETE', `/api/tickets/${tk.key}/cis/${pc.id}`);
  assert.deepEqual(un.body.cis, []);
  assert.equal((await S.admin('DELETE', `/api/cis/${pc.id}`)).status, 200);
});

test('CSV import: German column names, values translated, existing ones updated', async () => {
  const csv = [
    'Hostname;Typ;Standort;IP-Adresse;Seriennummer;Hersteller;Benutzer;Status',
    'PC-0002;Notebook;Raum 2.01;10.0.10.22;SN123;Lenovo;karl;aktiv',
    'SRV-FILE01;Server;Serverraum;10.0.10.5;;;;Wartung',
    ';Drucker;;;;;;',
    'SW-CORE;Switch;Serverraum;10.0.10.1;;;niemand;',
  ].join('\n');
  assert.equal((await anna('POST', '/api/cis/import', { csv })).status, 403);
  const r = (await S.admin('POST', '/api/cis/import', { csv })).body;
  assert.equal(r.created, 2);
  assert.equal(r.updated, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 4);
  assert.ok(r.errors[0].message.length > 5, 'understandable message');
  const all = Object.fromEntries((await anna('GET', '/api/cis?status=all')).body.items.map((x) => [x.name, x]));
  assert.equal(all['PC-0002'].kind, 'device');
  assert.equal(all['PC-0002'].owner.displayName, 'karl');
  assert.equal(all['SRV-FILE01'].status, 'maintenance');
  assert.equal(all['SW-CORE'].kind, 'network');
  assert.equal(all['SW-CORE'].owner, null);
  assert.equal((await S.admin('POST', '/api/cis/import', { csv: 'Ort;IP\nx;y' })).status, 400, 'column Name missing');
  assert.equal((await S.admin('POST', '/api/cis/import', { csv: 'Name' })).status, 400, 'empty');
});
