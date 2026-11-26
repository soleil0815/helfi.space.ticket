// Time-limited exceptions for fixable vulnerabilities: a finding no build can fix yet does not stop every
// release – CRITICAL 7 days, HIGH 14 days from the day first seen, longer only by .github/vuln-exceptions.tsv
// (at most 30 days ahead, with reason); secrets never. Plus the GitHub release that survives GitHub disturbances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(root, '.github/scripts');
const SHELL = fs.existsSync('/bin/dash') ? '/bin/dash' : 'sh';
const hasJq = spawnSync('jq', ['--version']).status === 0;
const skip = !hasJq && 'jq missing';
const TODAY = '2026-11-26';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-grace-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'test/fixtures/fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'exc.tsv'), '# none\n');
  return dir;
}
const vuln = (id, pkg, sev, extra = {}) => ({ VulnerabilityID: id, PkgName: pkg, Severity: sev, InstalledVersion: '1.0', FixedVersion: '1.1', PublishedDate: '2026-10-01T00:00:00Z', ...extra });
function report(dir, name, vulns, secrets = []) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ Results: [{ Target: 'helfi (alpine 3.22)', Vulnerabilities: vulns, ...(secrets.length ? { Secrets: secrets } : {}) }] }));
  return f;
}
function sh(dir, script, argv, env = {}) {
  return spawnSync(SHELL, [path.join(scripts, script), ...argv], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, FAKE_GH_DIR: dir, GH_TOKEN: 'x', GITHUB_REPOSITORY: 'firma/helfi', VULN_TODAY: TODAY, VULN_EXCEPTIONS: path.join(dir, 'exc.tsv'), VULN_RETRY_DELAY: '0', GH_RELEASE_DELAY: '0', GH_RELEASE_LIST_PAUSE: '0', ...env },
  });
}
const state = (dir, lines) => { const f = path.join(dir, 'state.tsv'); fs.writeFileSync(f, lines.map((l) => l.join('\t')).join('\n') + '\n'); return f; };
const ghState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('trivy-check.sh: new finding → warning; after 7 (CRITICAL) / 14 (HIGH) days → blocks', { skip }, () => {
  const dir = tmp();
  const r0 = report(dir, 'a.json', [vuln('CVE-NEW', 'node', 'CRITICAL')]);
  let r = sh(dir, 'trivy-check.sh', [r0, state(dir, [])]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /::warning title=Time-limited exception::CRITICAL CVE-NEW in node 1\.0 → 1\.1 .*allowed until 2026-12-03 \(first seen 2026-11-26, grace 7 days\)/);
  assert.match(r.stdout, /1 fixable vulnerabilities allowed for a limited time/);

  const r1 = report(dir, 'b.json', [vuln('CVE-C', 'node', 'CRITICAL'), vuln('CVE-H', 'openssl', 'HIGH')]);
  // day 7 of CRITICAL: still allowed; HIGH 10 days old: allowed
  r = sh(dir, 'trivy-check.sh', [r1, state(dir, [['CVE-C', 'node', '2026-11-19', TODAY], ['CVE-H', 'openssl', '2026-11-16', TODAY]])]);
  assert.equal(r.status, 0, r.stdout);
  // CRITICAL 8 days, HIGH 15 days: both block
  r = sh(dir, 'trivy-check.sh', [r1, state(dir, [['CVE-C', 'node', '2026-11-18', TODAY], ['CVE-H', 'openssl', '2026-11-11', TODAY]])]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::CRITICAL CVE-C in node .*time limit ended 2026-11-25 \(first seen 2026-11-18\)/);
  assert.match(r.stdout, /::error::HIGH CVE-H in openssl .*time limit ended 2026-11-25/);
  assert.match(r.stdout, /2 fixable vulnerabilities \(HIGH\/CRITICAL\) without a valid time limit/);
});

test('trivy-check.sh: exceptions file extends with a reason, at most 30 days; secrets never excepted', { skip }, () => {
  const dir = tmp();
  const rep = report(dir, 'a.json', [vuln('CVE-C', 'node', 'CRITICAL'), vuln('CVE-H', 'busybox', 'HIGH')]);
  const st = state(dir, [['CVE-C', 'node', '2026-11-01', TODAY], ['CVE-H', 'busybox', '2026-11-01', TODAY]]);
  fs.writeFileSync(path.join(dir, 'exc.tsv'), [
    '# comment',
    'CVE-C\tnode\t2026-12-20\tNode 24 image with the fix not out yet',
    'CVE-H\t*\t2027-02-01\ttoo far ahead',
  ].join('\n'));
  let r = sh(dir, 'trivy-check.sh', [rep, st]);
  assert.equal(r.status, 1, 'the HIGH one has no valid exception');
  assert.match(r.stdout, /::warning title=Time-limited exception::CRITICAL CVE-C in node .*allowed until 2026-12-20 \(first seen 2026-11-01, grace 7 days; exception: Node 24 image with the fix not out yet\)/);
  assert.match(r.stdout, /::warning title=vuln-exceptions\.tsv::CVE-H: until 2027-02-01 is more than 30 days ahead – not accepted/);
  assert.match(r.stdout, /::error::HIGH CVE-H in busybox/);

  // "*" = any package; an expired exception does not count; missing reason is rejected
  fs.writeFileSync(path.join(dir, 'exc.tsv'), 'CVE-C\tnode\t2026-11-20\told\nCVE-H\t*\t2026-12-24\tAlpine fix pending\nCVE-X\tfoo\t2026-12-01\t\n');
  r = sh(dir, 'trivy-check.sh', [rep, st]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::CRITICAL CVE-C in node/);
  assert.match(r.stdout, /HIGH CVE-H in busybox .*allowed until 2026-12-24/);
  assert.match(r.stdout, /CVE-X: needs ID, package, date and a reason/);

  // Secrets: always an error, even with every vulnerability allowed
  fs.writeFileSync(path.join(dir, 'exc.tsv'), '# none\n');
  const sec = report(dir, 's.json', [vuln('CVE-NEW', 'node', 'HIGH')], [{ RuleID: 'private-key', Severity: 'HIGH', Title: 'Private Key' }]);
  r = sh(dir, 'trivy-check.sh', [sec, state(dir, [])]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::Secret in image: HIGH private-key/);
  assert.match(r.stdout, /CVE-NEW .*allowed until/);
});

test('trivy-check.sh: without state no grace period; state unreadable → counted from the publish date', { skip }, () => {
  const dir = tmp();
  const rep = report(dir, 'a.json', [vuln('CVE-OLD', 'node', 'HIGH'), vuln('CVE-FRESH', 'npm', 'HIGH', { PublishedDate: '2026-11-20T08:00:00Z' })]);
  let r = sh(dir, 'trivy-check.sh', [rep]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /2 fixable vulnerabilities/);
  fs.writeFileSync(path.join(dir, 'u.tsv'), '#unavailable\n');
  r = sh(dir, 'trivy-check.sh', [rep, path.join(dir, 'u.tsv')]);
  assert.equal(r.status, 1, 'published 2026-10-01 + 14 days is over');
  assert.match(r.stdout, /::error::HIGH CVE-OLD in node .*first seen 2026-10-01/);
  assert.match(r.stdout, /CVE-FRESH in npm .*allowed until 2026-12-04/);
});

test('vuln-grace.sh: issue keeps first-seen dates across runs, closes when nothing is current', { skip }, () => {
  const dir = tmp();
  let r = sh(dir, 'vuln-grace.sh', ['read', 'state.tsv']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'state.tsv'), 'utf8').trim(), '');
  // clean image, no issue yet: nothing is opened
  r = sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', report(dir, 'clean.json', [])]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ghState(dir).issues.length, 0);

  const amd = report(dir, 'amd.json', [vuln('CVE-C', 'node', 'CRITICAL')]);
  const arm = report(dir, 'arm.json', [vuln('CVE-C', 'node', 'CRITICAL'), vuln('CVE-H', 'musl', 'HIGH')]);
  r = sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', amd, arm], { VULN_TODAY: '2026-11-20' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  let iss = ghState(dir).issues;
  assert.equal(iss.length, 1);
  assert.deepEqual(iss[0].labels, ['vuln-grace']);
  assert.equal(iss[0].state, 'open');
  assert.match(iss[0].body, /\| CRITICAL \| CVE-C \| node \| 1\.1 \| 2026-11-20 \| 2026-11-27 \| allowed \|/);
  assert.match(iss[0].body, /\| HIGH \| CVE-H \| musl \| 1\.1 \| 2026-11-20 \| 2026-12-04 \| allowed \|/);
  assert.match(iss[0].body, /CRITICAL 7 days, HIGH 14 days/);

  // Later run: dates kept, the expired CRITICAL is marked, state file ready for trivy-check.sh
  r = sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', amd, arm]);
  assert.equal(r.status, 0);
  iss = ghState(dir).issues;
  assert.equal(iss.length, 1, 'same issue');
  assert.match(iss[0].body, /\| CRITICAL \| CVE-C \| node \| 1\.1 \| 2026-11-20 \| 2026-11-27 \| allowed \|/);
  const st = fs.readFileSync(path.join(dir, 'state.tsv'), 'utf8');
  assert.match(st, /^CVE-C\tnode\t2026-11-20\t2026-11-26\tCRITICAL\t1\.1$/m);
  r = sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', amd, arm], { VULN_TODAY: '2026-11-28' });
  assert.match(ghState(dir).issues[0].body, /\| CRITICAL \| CVE-C .*\| \*\*blocks releases\*\* \|/);
  assert.equal(sh(dir, 'trivy-check.sh', [amd, 'state.tsv'], { VULN_TODAY: '2026-11-28' }).status, 1);

  // Fixed: no longer reported → issue closed, the date stays (a finding coming back within 30 days keeps it)
  r = sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', report(dir, 'clean.json', [])], { VULN_TODAY: '2026-12-01' });
  iss = ghState(dir).issues[0];
  assert.equal(iss.state, 'closed');
  assert.match(iss.body, /not seen since 2026-11-28/);
  r = sh(dir, 'vuln-grace.sh', ['read', 'state.tsv'], { VULN_TODAY: '2026-12-02' });
  assert.match(fs.readFileSync(path.join(dir, 'state.tsv'), 'utf8'), /^CVE-C\tnode\t2026-11-20\t/m);
  r = sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', amd], { VULN_TODAY: '2026-12-02' });
  iss = ghState(dir).issues[0];
  assert.equal(iss.state, 'open', 'reopened');
  assert.match(iss.body, /\| CRITICAL \| CVE-C \| node \| 1\.1 \| 2026-11-20 \| 2026-11-27 \| \*\*blocks releases\*\* \|/, 'no new grace period by coming back');
  // 30 days not seen → dropped
  sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', report(dir, 'clean.json', [])], { VULN_TODAY: '2027-01-05' });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'state.tsv'), 'utf8'), /CVE-C/);
  assert.doesNotMatch(ghState(dir).issues[0].body, /CVE-C/);
});

test('vuln-grace.sh: GitHub errors never stop the release', { skip }, () => {
  const dir = tmp();
  let r = sh(dir, 'vuln-grace.sh', ['read', 'state.tsv'], { FAKE_GH_FAIL: 'issues?state=all:9' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning title=vuln-grace::Cannot read the issue/);
  assert.equal(fs.readFileSync(path.join(dir, 'state.tsv'), 'utf8'), '#unavailable\n');
  // One failure is retried
  r = sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', report(dir, 'a.json', [vuln('CVE-H', 'musl', 'HIGH')])], { FAKE_GH_FAIL: 'issues?state=all:1,-X POST repos/firma/helfi/issues :1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ghState(dir).issues.length, 1);
  // Writing fails for good: warning, local state still usable
  r = sh(dir, 'vuln-grace.sh', ['update', 'state.tsv', report(dir, 'b.json', [vuln('CVE-H', 'musl', 'HIGH'), vuln('CVE-N', 'npm', 'HIGH')])], { FAKE_GH_FAIL: 'PATCH:9' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning title=vuln-grace::Cannot update issue #1/);
  assert.match(fs.readFileSync(path.join(dir, 'state.tsv'), 'utf8'), /^CVE-N\tnpm\t2026-11-26/m);
});

test('gh-release.sh: draft → files → check → publish, retries GitHub failures, re-run completes the draft', { skip }, () => {
  const dir = tmp();
  const rel = path.join(dir, 'release');
  fs.mkdirSync(rel);
  for (const n of ['helfi-1.0.0-amd64.tar.gz', 'SHA256SUMS', 'update.sh']) fs.writeFileSync(path.join(rel, n), `${n}\n`.repeat(3));
  const files = fs.readdirSync(rel).map((n) => `release/${n}`);
  // Like 2026-11-25: create answers 502 although the draft exists, upload fails twice, one upload arrives short
  let r = sh(dir, 'gh-release.sh', ['v1.0.0', 'v1.0.0', 'abc123', 'true', '-', ...files],
    { FAKE_GH_FAIL: 'release create:1,release upload:2', FAKE_GH_CREATE_ON_FAIL: '1', FAKE_GH_SHORT: 'update.sh' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  let g = ghState(dir);
  assert.equal(g.releases.length, 1, 'no second release');
  assert.equal(g.releases[0].draft, false);
  assert.equal(g.releases[0].latest, true);
  assert.deepEqual(g.releases[0].assets.map((a) => a.name).sort(), ['SHA256SUMS', 'helfi-1.0.0-amd64.tar.gz', 'update.sh']);
  assert.ok(g.releases[0].assets.every((a) => a.size === 3 * (a.name.length + 1)), 'sizes match');
  assert.match(r.stdout, /::warning title=GitHub release::attempt 1 failed/);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.match(calls, /release create v1\.0\.0 --draft --verify-tag --title v1\.0\.0 --target abc123 --generate-notes/);
  assert.ok(calls.indexOf('release upload') < calls.indexOf('release edit v1.0.0 --draft=false --latest=true'), 'published only after the files');

  // Run again (re-run of the job): nothing to do
  r = sh(dir, 'gh-release.sh', ['v1.0.0', 'v1.0.0', 'abc123', 'true', '-', ...files]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already released with all files/);

  // A draft left behind by an aborted run is completed; notes file and latest=false are passed on
  fs.writeFileSync(path.join(dir, 'notes.md'), 'Security update\n');
  g.releases.push({ id: 7, tag_name: 'v1.0.0-s1', draft: true, assets: [] });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(g));
  r = sh(dir, 'gh-release.sh', ['v1.0.0-s1', 'v1.0.0-s1 (security update)', 'abc123', 'false', 'notes.md', ...files]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  g = ghState(dir);
  const s1 = g.releases.find((x) => x.tag_name === 'v1.0.0-s1');
  assert.equal(g.releases.filter((x) => x.tag_name === 'v1.0.0-s1').length, 1);
  assert.equal(s1.draft, false);
  assert.equal(s1.latest, false);
  assert.equal(s1.assets.length, 3);

  // Like 2026-11-26: the new draft is listed only a while after the create → wait, never a second draft
  const d3 = tmp(); fs.cpSync(rel, path.join(d3, 'release'), { recursive: true });
  r = sh(d3, 'gh-release.sh', ['v3.0.0', 'v3.0.0', 'abc', 'true', '-', ...files], { FAKE_GH_LAG: '4', GH_RELEASE_LIST_PAUSE: '0' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ghState(d3).releases.length, 1, 'exactly one release');
  assert.equal(ghState(d3).releases[0].draft, false);
  assert.equal((fs.readFileSync(path.join(d3, 'calls.log'), 'utf8').match(/release create/g) || []).length, 1, 'created once');

  // GitHub down for good: fails (after all retries), never leaves a published half release
  const d2 = tmp(); fs.cpSync(rel, path.join(d2, 'release'), { recursive: true });
  r = sh(d2, 'gh-release.sh', ['v2.0.0', 'v2.0.0', 'abc', 'true', '-', ...files], { FAKE_GH_FAIL: 'release upload:99' });
  assert.equal(r.status, 1);
  assert.equal(ghState(d2).releases[0].draft, true, 'stays a draft (does not count as released)');
  // Bad input is refused before anything happens
  assert.equal(sh(d2, 'gh-release.sh', ['v2.0.0;x', 't', 'abc', 'true', '-', ...files]).status, 1);
  assert.equal(sh(d2, 'gh-release.sh', ['v2.0.0', 't', 'abc', 'yes', '-', ...files]).status, 1);
});

test('Workflows: CI release, security update and image scan use the time limits; release step is robust', () => {
  const wf = (n) => fs.readFileSync(path.join(root, '.github/workflows', n), 'utf8');
  const ci = wf('ci.yml');
  const image = ci.slice(ci.indexOf('\n  image:'), ci.indexOf('\n  release-check:'));
  assert.match(image, /issues: read/);
  assert.match(image, /vuln-grace\.sh read vuln-state\.tsv[\s\S]*trivy-check\.sh trivy\.json vuln-state\.tsv/);
  for (const [name, pub] of [['ci.yml', ci.slice(ci.indexOf('\n  publish:'))], ['security-update.yml', wf('security-update.yml').slice(wf('security-update.yml').indexOf('\n  publish:'))]]) {
    assert.match(pub, /issues: write/, name);
    const order = ['trivy-scan.sh "$IMAGE@$DIGEST" trivy-amd64.json', 'trivy-scan.sh "$IMAGE@$DIGEST" trivy-arm64.json',
      'vuln-grace.sh update vuln-state.tsv trivy-amd64.json trivy-arm64.json', 'trivy-check.sh trivy-amd64.json vuln-state.tsv',
      'trivy-check.sh trivy-arm64.json vuln-state.tsv', 'gh-release.sh'];
    const pos = order.map((s) => pub.indexOf(s));
    assert.ok(pos.every((p) => p > 0), `${name}: ${JSON.stringify(pos)}`);
    assert.deepEqual(pos, [...pos].sort((a, b) => a - b), `${name}: scan both → record → check both → … → release`);
    assert.doesNotMatch(pub, /action-gh-release/, name);
  }
  const scan = wf('image-scan.yml');
  assert.match(scan, /vuln-grace\.sh update vuln-state\.tsv trivy-amd64\.json trivy-arm64\.json/);
  const exc = fs.readFileSync(path.join(root, '.github/vuln-exceptions.tsv'), 'utf8');
  assert.ok(exc.split('\n').every((l) => !l.trim() || l.startsWith('#')), 'no active exception committed by default');
});
