// Migration list: numbers unique and ascending (1.48.0 shipped two migrations numbered 47 by mistake);
// databases of 1.48.0 continue without trouble.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HELFI_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-migrations-'));
const { MIGRATIONS, SCHEMA_VERSION, openDatabase } = await import('../src/db.js');

test('Migration numbers are unique and strictly ascending, each with a name', () => {
  let last = 0;
  for (const m of MIGRATIONS) {
    assert.ok(m.id > last, `migration ${m.id} after ${last}`);
    assert.ok(String(m.name || '').trim(), `migration ${m.id} without name`);
    last = m.id;
  }
  assert.equal(SCHEMA_VERSION, last);
});

const hasColumn = (d) => !!d.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name='passkey_prompt_until'").get();

test('Database of 1.48.0 (schema 47 incl. passkey hint): only the number moves on, data stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mig48-'));
  try {
    const file = path.join(dir, 'h.sqlite');
    let d = await openDatabase(file, { appVersion: '1.48.0', backupDir: path.join(dir, 'b') });
    d.prepare("INSERT INTO users(username, display_name, role, source, passkey_prompt_until) VALUES('karl','Karl','user','local',-1)").run();
    d.prepare("UPDATE meta SET value='47' WHERE key='schema_version'").run();
    d.close();
    d = await openDatabase(file, { appVersion: '1.48.1', backupDir: path.join(dir, 'b') });
    assert.equal(d.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION));
    assert.equal(d.prepare("SELECT passkey_prompt_until v FROM users WHERE username='karl'").get().v, -1);
    d.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Schema 47 without the hint column (start interrupted between the two): column is added', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-mig48b-'));
  try {
    const file = path.join(dir, 'h.sqlite');
    let d = await openDatabase(file, { appVersion: '1.48.0', backupDir: path.join(dir, 'b') });
    d.exec('ALTER TABLE users DROP COLUMN passkey_prompt_until');
    d.prepare("UPDATE meta SET value='47' WHERE key='schema_version'").run();
    assert.equal(hasColumn(d), false);
    d.close();
    d = await openDatabase(file, { appVersion: '1.48.1', backupDir: path.join(dir, 'b') });
    assert.equal(hasColumn(d), true);
    d.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
