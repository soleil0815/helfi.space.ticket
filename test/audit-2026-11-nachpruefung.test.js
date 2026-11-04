// Regression tests audit 2026-11: findings of the second reviewer on our own changes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HELFI_LOG_LEVEL = 'error';
const { pruneBackups } = await import('../src/db.js');

test('Cleanup: leftover partial backups (.part) are removed after one hour, fresh ones stay (Audit)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-part-'));
  const old = Date.now() / 1000 - 2 * 3600;
  const mk = (name, stale) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); if (stale) fs.utimesSync(f, old, old); };
  mk('helfi-vor-1.2.0-2026-10-31T11-00-00.sqlite.part', true);
  mk('helfi-vor-1.2.0-2026-10-31T11-00-00.sqlite.part-journal', true);
  mk('helfi-taeglich-2026-11-03.sqlite.part', false); // may be running right now
  mk('helfi-taeglich-2026-11-02.sqlite', true);
  mk('fremd.sqlite.part', true);
  fs.symlinkSync('/etc/hostname', path.join(dir, 'helfi-x.sqlite.part'));
  pruneBackups(10, dir);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['fremd.sqlite.part', 'helfi-taeglich-2026-11-02.sqlite', 'helfi-taeglich-2026-11-03.sqlite.part', 'helfi-x.sqlite.part']);
  fs.rmSync(dir, { recursive: true, force: true });
});
