// Tests für .github/scripts/next-version.sh (automatisches Hochzählen der Version beim Release)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'scripts', 'next-version.sh');
const shell = fs.existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh';

function repo(tags, pkgVersion = '1.0.0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-nv-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'ci@firma.local');
  git('config', 'user.name', 'CI');
  fs.writeFileSync(path.join(dir, 'package.json'), `{\n  "name": "helfi",\n  "version": "${pkgVersion}",\n  "dependencies": { "x": { "version": "9.9.9" } }\n}\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  for (const t of tags) git('tag', t);
  return dir;
}

function run(dir, mode) {
  const r = spawnSync(shell, [script, mode], { cwd: dir, encoding: 'utf8' });
  const out = Object.fromEntries(r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('=')));
  return { code: r.status, out, err: r.stderr };
}

test('Patch/Minor/Major zählen vom höchsten Tag hoch (numerisch, nicht alphabetisch)', () => {
  const dir = repo(['v1.0.0', 'v1.2.9', 'v1.10.0', 'v0.9.0', 'test-tag']);
  assert.deepEqual(run(dir, 'patch').out, { version: '1.10.1', latest: 'true' });
  assert.deepEqual(run(dir, 'minor').out, { version: '1.11.0', latest: 'true' });
  assert.deepEqual(run(dir, 'major').out, { version: '2.0.0', latest: 'true' });
});

test('Ohne Tag gilt die Version aus package.json als erste Version', () => {
  const dir = repo([], '1.0.0');
  assert.deepEqual(run(dir, 'patch').out, { version: '1.0.0', latest: 'true' });
});

test('Von Hand gesetzter Tag: Version übernehmen, latest nur beim höchsten', () => {
  const dir = repo(['v1.0.0', 'v1.1.0', 'v1.0.5']);
  assert.deepEqual(run(dir, 'tag:v1.1.0').out, { version: '1.1.0', latest: 'true' });
  assert.deepEqual(run(dir, 'tag:v1.0.5').out, { version: '1.0.5', latest: 'false' });
});

test('Ungültige Eingaben werden abgelehnt', () => {
  const dir = repo(['v1.0.0']);
  assert.notEqual(run(dir, 'tag:v1.0').code, 0);
  assert.notEqual(run(dir, 'tag:v1.0.0;rm').code, 0);
  assert.equal(run(dir, 'irgendwas').code, 2);
  assert.notEqual(run(repo([], 'kaputt'), 'patch').code, 0);
});
