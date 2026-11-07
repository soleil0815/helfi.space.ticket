// Examples to take over: shared canned responses and catalog offerings (admins), knowledge
// articles (agents); German or English; existing ones are skipped; neutral placeholders only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; let CANNED_EXAMPLES; let CATALOG_EXAMPLES; let KB_EXAMPLES;
before(async () => {
  S = await startServer('examples');
  ({ CANNED_EXAMPLES, CATALOG_EXAMPLES, KB_EXAMPLES } = await import('../src/examples.js')); // after the server set up the data dir
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
});
after(() => S.stop());

test('examples are complete in both languages and use neutral names only', () => {
  for (const list of [CANNED_EXAMPLES, CATALOG_EXAMPLES, KB_EXAMPLES]) {
    const keys = list.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length, 'unique keys');
    for (const x of list) {
      for (const l of ['de', 'en']) {
        assert.ok(x[l].title, `${x.key} ${l} title`);
        const text = JSON.stringify(x[l]) + JSON.stringify(x.fields || []);
        assert.doesNotMatch(text, /jira/i);
        for (const host of text.match(/[\w.-]+\.(?:local|example|com|de|org|net)\b/g) || []) assert.match(host, /\.(firma\.local|firma\.example)$|^firma\.(local|example)$/, `neutral host: ${host}`);
      }
    }
  }
  for (const x of CATALOG_EXAMPLES) for (const fd of x.fields) if (fd.options) assert.equal(fd.options.de.length, fd.options.en.length, `${x.key}.${fd.id}`);
});

test('rights: catalog and shared canned responses only for admins, articles for agents, nothing for users', async () => {
  assert.equal((await karl('GET', '/api/examples/kb')).status, 403);
  assert.equal((await anna('GET', '/api/examples/canned')).status, 403);
  assert.equal((await anna('POST', '/api/examples/catalog', { keys: ['software'] })).status, 403);
  assert.equal((await anna('GET', '/api/examples/kb')).status, 200);
  assert.equal((await S.admin('GET', '/api/examples/nonsense')).status, 404);
  const list = (await S.admin('GET', '/api/examples/catalog')).body.examples;
  assert.equal(list.length, CATALOG_EXAMPLES.length);
  assert.ok(list[0].de.title && list[0].en.description);
});

test('canned responses: shared, chosen language, existing ones skipped', async () => {
  const r = await S.admin('POST', '/api/examples/canned', { keys: ['received', 'solved'], lang: 'de' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.added, ['Eingang bestätigen', 'Gelöst – bitte bestätigen']);
  const mine = (await anna('GET', '/api/canned')).body.responses;
  const t = mine.find((x) => x.title === 'Eingang bestätigen');
  assert.equal(t.shared, true);
  assert.match(t.body, /\{melder\}/);
  const again = await S.admin('POST', '/api/examples/canned', { keys: ['received', 'restart'], lang: 'en' });
  assert.deepEqual(again.body.added, ['Please restart']);
  assert.deepEqual(again.body.skipped, ['Confirm receipt'], 'German one already there');
});

test('catalog offerings arrive inactive with fields in the chosen language', async () => {
  const r = await S.admin('POST', '/api/examples/catalog', { keys: ['software', 'onboarding'], lang: 'en' });
  assert.deepEqual(r.body.added.sort(), ['Install software', 'New employee']);
  const all = (await S.admin('GET', '/api/catalog?all=1')).body.items;
  const sw = all.find((x) => x.title === 'Install software');
  assert.equal(sw.active, false, 'admins check and switch them on');
  assert.deepEqual(sw.fields.find((x) => x.id === 'licence').options, ['Yes', 'No', 'I do not know', 'Free of charge']);
  assert.equal((await karl('GET', '/api/catalog')).body.items.length, 0, 'users see nothing yet');
});

test('knowledge articles: internal, with category and version note', async () => {
  const r = await anna('POST', '/api/examples/kb', { keys: ['goodTicket', 'vpn'], lang: 'de' });
  assert.equal(r.status, 201);
  assert.equal(r.body.added.length, 2);
  const row = S.db.prepare("SELECT * FROM kb_articles WHERE title='VPN einrichten (Homeoffice)'").get();
  assert.equal(row.visibility, 'internal');
  assert.equal(row.category, 'Anleitungen');
  assert.match(row.body, /vpn\.firma\.example/);
  assert.equal((await anna('POST', '/api/examples/kb', { keys: ['vpn'], lang: 'de' })).body.skipped.length, 1);
});
