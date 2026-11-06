// CI economy: which jobs run for which change (.github/scripts/changes.sh and ci.yml)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, '.github/scripts/changes.sh');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-ci-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@firma.example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@firma.example' } }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  git('add', '.'); git('commit', '-qm', 'base');
  const commit = (files) => {
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
    git('add', '-A'); git('commit', '-qm', 'change');
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function run(dir, base, head) {
  const out = path.join(dir, '.out');
  fs.rmSync(out, { force: true });
  execFileSync('sh', [script, base, head], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out } });
  return Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split('=')));
}

test('changes.sh: docs only → no image/AD; code → image; sign-in/dependencies/workflows → AD; no PR → everything', () => {
  const r = repo();
  try {
    const base = r.git('rev-parse', 'HEAD');
    const docs = r.commit({ 'README.en.md': 'y', 'docs/manual/handbuch.de.html': '<p>', 'docs/manual/img/de/x jpg.jpg': 'b' });
    assert.deepEqual(run(r.dir, base, docs), { code: 'false', ad: 'false' });
    const code = r.commit({ 'src/tickets.js': '1' });
    assert.deepEqual(run(r.dir, docs, code), { code: 'true', ad: 'false' });
    for (const f of ['src/auth/ldap.js', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/test-samba-ad.sh']) {
      const c = r.commit({ [f]: String(Math.random()) });
      const prev = r.git('rev-parse', 'HEAD~1');
      assert.deepEqual(run(r.dir, prev, c), { code: 'true', ad: 'true' }, f);
    }
    assert.deepEqual(run(r.dir, '', ''), { code: 'true', ad: 'true' }, 'push/release: everything');
    assert.deepEqual(run(r.dir, 'deadbeef', 'HEAD'), { code: 'true', ad: 'true' }, 'unknown base: everything (safe side)');
  } finally { r.done(); }
});

test('ci.yml: releases run every check, main after a merge only builds the image, outdated PR runs are cancelled', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const job = (name) => {
    const start = yml.indexOf(`\n  ${name}:\n`);
    assert.ok(start > 0, name);
    const next = yml.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    return yml.slice(start, next > 0 ? start + 1 + next : undefined);
  };
  assert.match(yml, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(job('test'), /if: github\.event_name != 'push'/);
  assert.match(job('ad-integration'), /if: github\.event_name != 'push' && needs\.changes\.outputs\.ad == 'true'/);
  assert.match(job('image'), /!cancelled\(\) && !contains\(needs\.\*\.result, 'failure'\)/);
  assert.match(job('release-check'), /needs: \[image\]/);
  // every job has a time limit (a hanging job must not run for hours)
  for (const name of ['changes', 'test', 'ad-integration', 'image', 'release-check', 'release-build', 'publish']) assert.match(job(name), /timeout-minutes: \d+/, name);
  // workflow_dispatch (release) is not a pull request → changes.sh gets no SHAs → everything runs
  assert.match(job('changes'), /github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| ''/);
});
