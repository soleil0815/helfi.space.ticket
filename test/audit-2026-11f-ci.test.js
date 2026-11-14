// Audit 2026-11f (CI / supply chain): security update vs. release, "released" means a published release on main,
// re-run tag filter, patch day check errors fail the run. The workflow shell steps are run with stubbed tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wf = (name) => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');

// The "run: |" block of the step with this name (dedented)
function runBlock(yml, stepName) {
  const lines = yml.split('\n');
  let i = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(i >= 0, `step ${stepName}`);
  while (!/^\s+run: \|$/.test(lines[i])) {
    i++;
    assert.ok(i < lines.length && !/^\s+- (name|uses):/.test(lines[i]), `run block of ${stepName}`);
  }
  const keyIndent = lines[i].search(/\S/);
  const body = [];
  for (i++; i < lines.length; i++) {
    if (lines[i].trim() !== '' && lines[i].search(/\S/) <= keyIndent) break;
    body.push(lines[i]);
  }
  const ind = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(ind)).join('\n') + '\n';
}

// Run a step like GitHub Actions does (bash -e -o pipefail) in dir, with stub commands first in PATH
function runStep(script, dir, env = {}) {
  const out = path.join(dir, 'gh-output');
  fs.writeFileSync(out, '');
  fs.writeFileSync(path.join(dir, 'step.sh'), script);
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', path.join(dir, 'step.sh')], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), ...env },
  });
  return { ...r, output: fs.readFileSync(out, 'utf8') };
}

function stub(dir, name, body) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const p = path.join(dir, 'bin', name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
}

// gh stub: releases/tags/<tag> → .draft from releases.txt ("tag false|true"), "error" → API error, else 404
const GH_STUB = `case "$2" in
  */releases/tags/*) t="\${2##*/}"
    line="$(grep "^$t " "$RELEASES" || true)"
    [ -n "$line" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    case "\${line#* }" in error) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;; esac
    echo "\${line#* }" ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac`;

test('security-tag.sh: only a non-draft GitHub release whose tag is on main counts as released', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-11f-tag-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    const commit = (m) => git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', m);
    git('init', '-q', '-b', 'main');
    commit('a'); git('tag', 'v1.47.1'); git('tag', 'v1.47.1-s1');
    commit('b'); git('tag', 'v1.47.2');
    commit('c'); git('tag', 'v1.48.0'); // reserved by a CI release that failed: tag, no GitHub release
    commit('d'); git('tag', 'v1.49.0'); // draft release only
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'side', 'HEAD~3');
    commit('untested'); git('tag', 'v9.0.0'); // hand-made tag on a branch, even with a release
    git('checkout', '-q', 'main');
    stub(dir, 'gh', GH_STUB);
    const releases = path.join(dir, 'releases.txt');
    const write = (lines) => fs.writeFileSync(releases, lines.join('\n') + '\n');
    const run = (env = {}) => spawnSync('dash', [path.join(root, '.github/scripts/security-tag.sh')], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, RELEASES: releases, GITHUB_REPOSITORY: 'firma/helfi', ...env },
    });

    write(['v1.47.1 false', 'v1.47.2 false', 'v1.49.0 true', 'v9.0.0 false']);
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'version=1.47.2\ntag=1.47.2-s1\n', 'skips the branch tag, the draft and the unreleased tag');
    assert.match(r.stderr, /v9\.0\.0: the tag is not on main/);
    assert.match(r.stderr, /v1\.49\.0: the GitHub release is a draft/);
    assert.match(r.stderr, /v1\.48\.0: no GitHub release/);

    write(['v1.47.1 false', 'v1.47.2 false', 'v1.48.0 false', 'v1.49.0 true']);
    assert.equal(run().stdout, 'version=1.48.0\ntag=1.48.0-s1\n', 'a finished release counts');

    write(['v1.47.1 false', 'v1.47.2 false', 'v1.48.0 error']);
    r = run();
    assert.notEqual(r.status, 0, 'an API error never counts as "no release"');
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /HTTP 502/);

    write([]);
    assert.equal(run().status, 1, 'no release at all');
    write(['v1.47.1 false']);
    assert.equal(run().stdout, 'version=1.47.1\ntag=1.47.1-s2\n', 'next -s number still counted');

    assert.equal(run({ GITHUB_REPOSITORY: '' }).status, 1, 'repository needed');
    git('update-ref', '-d', 'refs/remotes/origin/main');
    r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /origin\/main is missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('security-update.yml: prepare reads the releases, publish re-checks with origin/main', () => {
  const yml = wf('security-update.yml');
  const prep = yml.slice(yml.indexOf('- name: Highest release and next security update number'), yml.indexOf('- name: Newest base image'));
  assert.match(prep, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/, 'security-tag.sh needs gh in prepare');
  assert.match(yml.slice(yml.indexOf('\n  prepare:')), /fetch-depth: 0/);
  assert.match(runBlock(yml, 'Still the highest version, tag still free'), /git fetch -q --tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
});

test('release and security update share one concurrency group and never cancel each other', () => {
  const sec = wf('security-update.yml');
  const ci = wf('ci.yml');
  assert.match(sec, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m);
  assert.match(ci, /^concurrency:\n {2}group: \$\{\{ github\.event_name == 'workflow_dispatch' && 'release' \|\|/m);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/, 'releases are never cancelled');
});

// Publish step of the security update with stubbed docker, git and security-tag.sh
function publish(highest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-11f-pub-'));
  try {
    fs.mkdirSync(path.join(dir, '.github/scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github/scripts/security-tag.sh'), `echo version=${highest}\necho tag=${highest}-s9\n`);
    stub(dir, 'git', 'exit 0');
    stub(dir, 'docker', `echo "$*" >> "$LOG"
case "$*" in
  "buildx imagetools inspect"*) [ -f "$STATE" ] || { echo "ERROR: manifest unknown" >&2; exit 1; }; echo "\\"$DIGEST\\"" ;;
  "buildx imagetools create"*) touch "$STATE" ;;
esac`);
    const yml = wf('security-update.yml');
    const r = runStep(runBlock(yml, 'Publish the checked image (same digest)'), dir, {
      IMAGE: 'ghcr.io/firma/helfi', V: '1.47.1', TAG: '1.47.1-s1', DIGEST: 'sha256:abc',
      LOG: path.join(dir, 'docker.log'), STATE: path.join(dir, 'pushed'),
    });
    return { ...r, creates: fs.readFileSync(path.join(dir, 'docker.log'), 'utf8').split('\n').filter((l) => l.includes('imagetools create')) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('security update: latest is moved only if the version is still the highest release right before publishing', () => {
  let r = publish('1.47.1');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.creates, ['buildx imagetools create -t ghcr.io/firma/helfi:1.47.1-s1 -t ghcr.io/firma/helfi:latest ghcr.io/firma/helfi@sha256:abc']);
  assert.match(r.output, /^latest=true$/m);

  r = publish('1.47.2'); // CI released 1.47.2 while this run was scanning
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.creates, ['buildx imagetools create -t ghcr.io/firma/helfi:1.47.1-s1 ghcr.io/firma/helfi@sha256:abc'], 'latest stays on the newer release');
  assert.match(r.output, /^latest=false$/m);
  assert.match(r.stdout, /::warning title=Not latest::v1\.47\.2 was released/);

  const yml = wf('security-update.yml');
  const rel = yml.slice(yml.indexOf('- name: GitHub release'));
  assert.match(rel, /make_latest: \$\{\{ steps\.pub\.outputs\.latest \}\}/, 'GitHub "latest release" follows the same check');
  assert.doesNotMatch(rel, /make_latest: 'true'/);
  assert.match(yml, /- name: Publish the checked image \(same digest\)\n {8}id: pub\n/);
});

test('ci.yml release re-run: a security update tag on the release commit is never taken as the reserved version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-11f-rerun-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    const sha = git('rev-parse', 'HEAD').trim();
    const ci = wf('ci.yml');
    const line = ci.split('\n').find((l) => /^\s+mine="\$\(git tag -l/.test(l)).trim();
    const step = `${line}\necho "mine=$mine"\n`;
    for (const t of ['v1.47.1', 'v1.47.1-s1', 'v1.47.1-s2']) git('tag', t);
    let r = runStep(step, dir, { GITHUB_SHA: sha });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'mine=v1.47.1\n');
    for (const t of ['v1.47.1', 'v1.47.1-s1', 'v1.47.1-s2']) git('tag', '-d', t);
    git('tag', 'v1.47.1-s1');
    r = runStep(step, dir, { GITHUB_SHA: sha });
    assert.equal(r.status, 0, 'only a security update tag: nothing reserved, no failure (pipefail)');
    assert.equal(r.stdout, 'mine=\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const [file, step] of [['security-update.yml', 'Patch day?'], ['zap-scan.yml', 'The week before patch day?']]) {
  test(`${file}: patchday.sh 0 = due, 1 = not due, any other exit code fails the job`, () => {
    const script = runBlock(wf(file), step);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-11f-pd-'));
    try {
      fs.mkdirSync(path.join(dir, '.github/scripts'), { recursive: true });
      const go = (rc, event = 'schedule') => {
        fs.writeFileSync(path.join(dir, '.github/scripts/patchday.sh'), `exit ${rc}\n`);
        return runStep(script, dir, { EVENT: event });
      };
      let r = go(0);
      assert.equal(r.status, 0); assert.equal(r.output, 'due=true\n');
      r = go(1);
      assert.equal(r.status, 0); assert.equal(r.output, 'due=false\n');
      for (const rc of [2, 127]) {
        r = go(rc);
        assert.notEqual(r.status, 0, `exit code ${rc} must fail the run`);
        assert.equal(r.output, '', 'no due output');
        assert.match(r.stdout, /::error/);
      }
      r = go(2, 'workflow_dispatch');
      assert.equal(r.status, 0, 'by hand: always due');
      assert.equal(r.output, 'due=true\n');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
