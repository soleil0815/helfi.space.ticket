// Tests für docker/entrypoint.sh (braucht root für chown; sonst übersprungen)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = fs.existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh';
const skip = process.getuid?.() !== 0 && 'nur als root prüfbar';

function run(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-ep-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // su-exec nachbauen: nur ausgeben, womit gestartet würde
  fs.writeFileSync(path.join(bin, 'su-exec'), '#!/bin/sh\necho "su-exec $*"\n', { mode: 0o755 });
  const r = spawnSync(SHELL, [path.join(root, 'docker/entrypoint.sh'), 'node', 'x.js'], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  return { ...r, dir };
}

test('Symbolische Links im Datenordner werden nicht verfolgt (Audit)', { skip }, () => {
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
  assert.equal(fs.statSync(outside).uid, 0, 'Datei außerhalb gehört weiter root');
  fs.rmSync(outside, { force: true });
});

test('PUID/PGID 0 und Unsinn werden abgelehnt (Audit)', () => {
  for (const env of [{ PUID: '0', PGID: '1000' }, { PUID: '1000', PGID: '0' }, { PUID: 'abc', PGID: '1' }]) {
    // Eigener Wegwerf-Ordner – nie os.tmpdir() selbst (ein fehlerhaftes Skript würde dessen Rechte ändern)
    const r = run({ HELFI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-ep-uid-')), ...env });
    assert.equal(r.status, 1, JSON.stringify(env));
  }
});
