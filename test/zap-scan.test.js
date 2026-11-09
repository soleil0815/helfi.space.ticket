// ZAP scan as part of the monthly code audit: schedule, scope, pinning, no secrets
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yml = fs.readFileSync(path.join(root, '.github/workflows/zap-scan.yml'), 'utf8');
const script = fs.readFileSync(path.join(root, '.github/scripts/zap-scan.sh'), 'utf8');

test('zap-scan.yml: the Tuesday one week before patch day, by hand, PRs only for the scan itself', () => {
  assert.match(yml, /cron: '\d+ [0-5] \* \* 2'/, 'Tuesday night');
  assert.match(yml, /sh \.github\/scripts\/patchday\.sh "\$\(date -u -d '\+7 days' \+%F\)"/, 'patch day in 7 days');
  assert.match(yml, /workflow_dispatch:/);
  const paths = yml.slice(yml.indexOf('pull_request:'), yml.indexOf('\npermissions:'));
  assert.match(paths, /paths:/, 'never for normal program changes');
  for (const p of paths.match(/- (\S+)/g)) assert.match(p, /zap/i, p);
});

test('zap-scan.yml: read-only, pinned actions, ZAP image pinned by digest, report kept for the audit', () => {
  assert.match(yml, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(yml, /: write/);
  for (const u of yml.match(/uses: \S+/g)) assert.match(u, /@[0-9a-f]{40}$/, u);
  assert.match(yml, /ZAP_IMAGE: ghcr\.io\/zaproxy\/zaproxy:stable@sha256:[0-9a-f]{64}\n/);
  assert.match(yml, /name: zap-report/);
  assert.match(yml, /retention-days: 90/);
});

test('zap-scan.sh: throwaway container only, no login, no fixed password, setup code never logged', () => {
  assert.match(script, /^#!\/bin\/sh\nset -eu|^#!\/bin\/sh/);
  assert.match(script, /-t "http:\/\/\$APP:8080"/, 'only the throwaway container');
  assert.match(script, /--read-only/);
  assert.match(script, /--cap-drop ALL/);
  assert.match(script, /\/dev\/urandom/, 'random throwaway password');
  assert.doesNotMatch(script, /"password":"[^%]/, 'no fixed password');
  assert.match(script, /unset pw/);
  assert.match(script, /grep -viE 'setup code\|Einrichtungscode'/, 'setup code filtered from error output');
  assert.match(script, /OUT="\$\(cd "\$OUT" && pwd\)"/, 'absolute report path for docker -v');
  assert.match(script, /scanner\.maxScanDurationInMins=\$MINUTES/, 'time limit');
  assert.doesNotMatch(script, /--auth|-z ".*auth/i, 'no login');
});

test('.zap/rules.tsv: only comments or "<id> TAB IGNORE TAB <reason>"', () => {
  const lines = fs.readFileSync(path.join(root, '.zap/rules.tsv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  for (const l of lines) assert.match(l, /^\d+\tIGNORE\t\S.{9,}$/, l);
});
