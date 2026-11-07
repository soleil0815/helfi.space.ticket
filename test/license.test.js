// License: AGPL-3.0-or-later everywhere, and every instance offers its source code (AGPL section 13).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers/server.js';

const root = new URL('../', import.meta.url);
let S;
before(async () => { S = await startServer('license'); });
after(() => S.stop());

test('license is AGPL-3.0-or-later in LICENSE, package.json, lock file and image label', () => {
  const lic = fs.readFileSync(new URL('LICENSE', root), 'utf8');
  assert.match(lic, /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
  assert.match(lic, /13\. Remote Network Interaction; Use with the GNU General Public License\./);
  assert.equal(JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).license, 'AGPL-3.0-or-later');
  assert.equal(JSON.parse(fs.readFileSync(new URL('package-lock.json', root), 'utf8')).packages[''].license, 'AGPL-3.0-or-later');
  assert.match(fs.readFileSync(new URL('Dockerfile', root), 'utf8'), /org\.opencontainers\.image\.licenses="AGPL-3\.0-or-later"/);
});

test('bootstrap offers the source code link, also before sign-in', async () => {
  const r = { body: await (await fetch(`${S.base}/api/bootstrap`)).json() };
  assert.equal(r.body.app.license, 'AGPL-3.0-or-later');
  assert.equal(r.body.app.sourceUrl, 'https://github.com/soleil0815/helfi.space.ticket');
});

test('HELFI_SOURCE_URL: own source for modified versions, only http(s)', async () => {
  const load = async (v) => {
    const old = process.env.HELFI_SOURCE_URL;
    process.env.HELFI_SOURCE_URL = v;
    try { return (await import(`../src/config.js?source=${encodeURIComponent(v)}`)).config.sourceUrl; } finally {
      if (old === undefined) delete process.env.HELFI_SOURCE_URL; else process.env.HELFI_SOURCE_URL = old;
    }
  };
  assert.equal(await load('https://git.firma.example/it/helfi'), 'https://git.firma.example/it/helfi');
  assert.equal(await load('javascript:alert(1)'), 'https://github.com/soleil0815/helfi.space.ticket');
  assert.equal(await load('https://x.example/"><script>'), 'https://github.com/soleil0815/helfi.space.ticket');
});
