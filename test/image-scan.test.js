// Tests: weekly scan of the published image → issue (open / update / close), slim image (Dockerfile)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, '.github/scripts/scan-issue.sh');

/** Runs the script with a fake "gh" that logs its calls; openIssue = number of an open issue or '' */
function run(reports, openIssue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-scan-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *"issues?state=open"*) printf '%s\\n' "${openIssue}" ;;
  *"-X POST repos/o/r/issues -f"*) echo 7 ;;
esac
`, { mode: 0o755 });
  const files = reports.map((r, i) => { const f = path.join(dir, `r${i}.json`); fs.writeFileSync(f, JSON.stringify(r)); return f; });
  const out = execFileSync('sh', [script, ...files], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '1' },
    encoding: 'utf8',
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, calls };
}
const vuln = (id, pkg) => ({ VulnerabilityID: id, PkgName: pkg, InstalledVersion: '1.0', FixedVersion: '1.1', Severity: 'HIGH' });
const report = (...v) => ({ Results: [{ Target: 'alpine', Vulnerabilities: v }] });

let hasJq = true;
try { execFileSync('jq', ['--version']); } catch { hasJq = false; }

test('Scan: findings open an issue (deduplicated across architectures)', { skip: !hasJq && 'jq missing' }, () => {
  const { out, calls } = run([report(vuln('CVE-1', 'openssl')), report(vuln('CVE-1', 'openssl'), vuln('CVE-2', 'busybox'))], '');
  assert.match(out, /Opened issue #7 \(2 findings\)/);
  assert.match(calls, /-X POST repos\/o\/r\/issues -f title=Published image/);
  assert.match(calls, /labels\[\]=image-scan/);
  assert.match(calls, /CVE-2 \| busybox/);
});

test('Scan: an open issue is updated instead of opening a second one', { skip: !hasJq && 'jq missing' }, () => {
  const { out, calls } = run([report(vuln('CVE-3', 'node'))], '12');
  assert.match(out, /Updated issue #12 \(1 findings\)/);
  assert.match(calls, /-X PATCH repos\/o\/r\/issues\/12 -f body=/);
  assert.doesNotMatch(calls, /-X POST repos\/o\/r\/issues -f title/);
});

test('Scan: clean image closes the open issue, nothing to do otherwise', { skip: !hasJq && 'jq missing' }, () => {
  let r = run([report(), { Results: [] }], '12');
  assert.match(r.out, /Closed issue #12/);
  assert.match(r.calls, /issues\/12 -f state=closed/);
  r = run([report()], '');
  assert.doesNotMatch(r.calls, /-X (POST|PATCH)/);
});

test('Scan workflow: weekly, only reads the repo, writes issues, pinned actions', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/image-scan.yml'), 'utf8');
  assert.match(yml, /schedule:\n\s+- cron:/);
  assert.match(yml, /issues: write/);
  assert.doesNotMatch(yml, /contents: write|packages: write/, 'publishes nothing');
  for (const u of yml.match(/uses: \S+/g)) assert.match(u, /@[0-9a-f]{40}$/, u);
  assert.match(yml, /TRIVY_PLATFORM: linux\/arm64/);
});

test('Dockerfile: yarn removed, node_modules pruned and the driver checked', () => {
  const df = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(df, /\/opt\/yarn-v\* \/usr\/local\/bin\/yarn \/usr\/local\/bin\/yarnpkg/);
  assert.match(df, /prune-modules\.sh \/app\/node_modules/);
  assert.match(df, /sqlite_version\(\)/);
  const smoke = fs.readFileSync(path.join(root, '.github/scripts/smoke-test.sh'), 'utf8');
  assert.match(smoke, /left in the image/);
});
