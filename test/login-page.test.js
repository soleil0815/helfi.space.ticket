// Tests: eigene Texte der Anmeldeseite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-login-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');

let server; let base; let db; let ctx;
before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Ohne Anmeldung: Texte der Anmeldeseite (leer als Standard)', async () => {
  const b = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.deepEqual(b.login, { title: '', text: { de: '', en: '' }, userLabel: { de: '', en: '' } });
});

test('Eigene Texte werden ausgeliefert und begrenzt', async () => {
  ctx.settings.set('login.title', 'HELFI Hilfecenter');
  ctx.settings.set('login.textDe', '**IT-Hilfe erhalten**\nSchreiben Sie an helpdesk@firma.local');
  ctx.settings.set('login.textEn', 'x'.repeat(5000));
  ctx.settings.set('login.userLabelDe', 'Windows-Anmeldename');
  const b = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(b.login.title, 'HELFI Hilfecenter');
  assert.match(b.login.text.de, /^\*\*IT-Hilfe erhalten\*\*/);
  assert.equal(b.login.text.en.length, 4000);
  assert.equal(b.login.userLabel.de, 'Windows-Anmeldename');
});
