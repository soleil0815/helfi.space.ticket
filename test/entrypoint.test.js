// Tests for docker/entrypoint.sh (needs root for chown; skipped otherwise)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = fs.existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh';
const skip = process.getuid?.() !== 0 && 'can only be tested as root';

function run(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-ep-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // Fake su-exec: only print what would be started
  fs.writeFileSync(path.join(bin, 'su-exec'), '#!/bin/sh\necho "su-exec $*"\n', { mode: 0o755 });
  const r = spawnSync(SHELL, [path.join(root, 'docker/entrypoint.sh'), 'node', 'x.js'], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  return { ...r, dir };
}

test('Symbolic links in the data folder are not followed (Audit)', { skip }, () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-data-'));
  const outside = path.join(os.tmpdir(), `helfi-fremd-${process.pid}`);
  fs.writeFileSync(outside, 'geheim');
  fs.chownSync(outside, 0, 0);
  fs.writeFileSync(path.join(data, 'helfi.sqlite'), 'x');
  fs.symlinkSync(outside, path.join(data, 'falle'));
  const r = run({ HELFI_DATA_DIR: data, PUID: '1234', PGID: '1234' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /su-exec 1234:1234 node x\.js/);
  assert.equal(fs.statSync(path.join(data, 'helfi.sqlite')).uid, 1234);
  assert.equal(fs.statSync(outside).uid, 0, 'file outside still belongs to root');
  fs.rmSync(outside, { force: true });
});

test('PUID/PGID 0 and garbage are rejected (Audit)', () => {
  for (const env of [{ PUID: '0', PGID: '1000' }, { PUID: '1000', PGID: '0' }, { PUID: 'abc', PGID: '1' }]) {
    // Own throwaway folder – never os.tmpdir() itself (a faulty script would change its permissions)
    const r = run({ HELFI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-ep-uid-')), ...env });
    assert.equal(r.status, 1, JSON.stringify(env));
  }
});
