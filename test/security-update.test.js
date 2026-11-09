// Security update on patch day (second Tuesday of the month): patchday.sh, version/tag, package diff, workflow
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(root, '.github/scripts');
const sh = (script, args, opts = {}) => spawnSync('sh', [path.join(scripts, script), ...args], { encoding: 'utf8', ...opts });

test('patchday.sh: exactly the second Tuesday of every month, bad input → 2', () => {
  const start = Date.UTC(2026, 10, 1);
  const got = [];
  const want = [];
  for (let n = 0; n < 800; n++) {
    const d = new Date(start + n * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const rc = sh('patchday.sh', [iso]).status;
    assert.ok(rc === 0 || rc === 1, iso);
    if (rc === 0) got.push(iso);
    if (d.getUTCDay() === 2 && d.getUTCDate() >= 8 && d.getUTCDate() <= 14) want.push(iso);
  }
  assert.deepEqual(got, want);
  assert.equal(got[0], '2026-11-10', 'the first one');
  for (const bad of ['2026-13-01', 'morgen', '2026-1-5']) assert.equal(sh('patchday.sh', [bad]).status, 2, bad);
});

test('security-tag.sh: highest program release, next free -s number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-sec-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const run = () => sh('security-tag.sh', [], { cwd: dir });
  assert.equal(run().status, 1, 'no release yet');
  for (const t of ['v1.9.0', 'v1.10.0', 'v1.2.0', 'v1.10.0-beta', 'v01.99.0']) git('tag', t);
  assert.equal(run().stdout, 'version=1.10.0\ntag=1.10.0-s1\n', 'numeric order, only real releases');
  for (const t of ['v1.10.0-s1', 'v1.10.0-s2', 'v1.10.0-s10', 'v1.9.0-s30', 'v1.10.0-sx']) git('tag', t);
  assert.equal(run().stdout, 'version=1.10.0\ntag=1.10.0-s11\n');
  git('tag', 'v1.11.0');
  assert.equal(run().stdout, 'version=1.11.0\ntag=1.11.0-s1\n', 'a new program version starts again at s1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('package-diff.sh: nothing changed → 3, otherwise a Markdown list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-diff-'));
  const f = (n, t) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
  const a = f('a', 'apk openssl-3.5.1-r0\nnode v24.11.0\nnpm express@5.1.0\n');
  assert.equal(sh('package-diff.sh', [a, f('b', 'node v24.11.0\napk openssl-3.5.1-r0\nnpm express@5.1.0\n')]).status, 3, 'order does not matter');
  const r = sh('package-diff.sh', [a, f('c', 'apk openssl-3.5.2-r0\nnode v24.11.0\nnpm express@5.1.0\n')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\*\*New or updated:\*\*\n- `apk openssl-3\.5\.2-r0`/);
  assert.match(r.stdout, /\*\*Replaced or removed:\*\*\n- `apk openssl-3\.5\.1-r0`/);
  assert.equal(sh('package-diff.sh', [f('e', ''), a]).status, 0, 'no published image yet: everything is new');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('security-update.yml: patch day only, from main, release state, checks before publishing, pinned actions', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/security-update.yml'), 'utf8');
  const job = (name) => {
    const start = yml.indexOf(`\n  ${name}:\n`);
    assert.ok(start > 0, name);
    const next = yml.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1 ? yml.slice(start) : yml.slice(start, start + 1 + next);
  };
  assert.match(yml, /cron: '\d+ [0-6] \* \* 2'/, 'every Tuesday early …');
  assert.match(job('patchday'), /sh \.github\/scripts\/patchday\.sh/, '… only patch day goes on');
  assert.match(job('patchday'), /\[ "\$EVENT" != schedule \]/, 'by hand: any day');
  assert.match(yml, /workflow_dispatch:/);
  assert.match(job('prepare'), /if: needs\.patchday\.outputs\.due == 'true' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(job('prepare'), /: write/, 'preparing writes nothing');
  assert.match(job('prepare'), /git worktree add --detach release "v\$v"/, 'code of the highest release, not main');
  assert.match(job('prepare'), /npm audit fix --no-fund/);
  assert.doesNotMatch(yml, /^\s+npm audit fix.*--force/m, 'no version jumps');
  assert.match(job('prepare'), /run: npm test/);
  assert.match(job('build'), /no-cache: true/);
  assert.match(job('build'), /smoke-test\.sh/);
  assert.match(job('build'), /ubuntu-24\.04-arm/, 'arm64 natively, no QEMU');
  const pub = job('publish');
  assert.match(pub, /environment: release/);
  const order = ['package-diff.sh', 'security-tag.sh', 'trivy-check.sh trivy-amd64.json', 'trivy-check.sh trivy-arm64.json',
    'attest-build-provenance', 'Reserve the number', 'imagetools create -t "$IMAGE:$TAG" -t "$IMAGE:latest"', 'action-gh-release'];
  const pos = order.map((s) => pub.indexOf(s));
  assert.ok(pos.every((p) => p > 0), JSON.stringify(pos));
  assert.deepEqual(pos, [...pos].sort((x, y) => x - y), 'compare → still highest → scan → sign → tag → publish → release');
  assert.match(pub, /not overwritten/);
  assert.match(yml, /concurrency:\n {2}group: security-update\n {2}cancel-in-progress: false/);
  assert.match(yml, /^permissions: \{\}$/m);
  for (const u of yml.match(/uses: \S+/g)) assert.match(u, /@[0-9a-f]{40}$/, u);
});

test('image-scan.yml: daily, points to the security update', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/image-scan.yml'), 'utf8');
  assert.match(yml, /cron: '\d+ \d+ \* \* \*'/);
  const issue = fs.readFileSync(path.join(scripts, 'scan-issue.sh'), 'utf8');
  assert.match(issue, /Actions → Security update → Run workflow/);
});
