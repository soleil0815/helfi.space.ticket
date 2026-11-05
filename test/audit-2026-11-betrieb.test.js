// Audit 2026-11, operations and CI: update.sh (rollback, offline, cleanup), backups,
// env.example, CI release conditions, trivy-check.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = process.env.HELFI_TEST_SHELL || (fs.existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh');
const BASE_PATH = process.env.HELFI_TEST_PATH || '/usr/bin:/bin';
const REPO = 'ghcr.io/soleil0815/helfi.space.ticket';

function setup({ envText = 'HELFI_BASE_URL=http://x\nHELFI_VERSION=latest\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-betrieb-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(root, 'test/fixtures/fake-docker.sh'), path.join(bin, 'docker'));
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  fs.copyFileSync(path.join(root, 'update.sh'), path.join(dir, 'update.sh'));
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  fs.writeFileSync(path.join(dir, 'image-compose.yml'), compose);
  fs.writeFileSync(path.join(dir, 'image-hashes.txt'), fs.readFileSync(path.join(root, 'docker/compose-hashes.txt'), 'utf8'));
  fs.writeFileSync(path.join(dir, '.env'), envText);
  fs.mkdirSync(path.join(dir, 'data/backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/helfi.sqlite'), 'original');
  return { dir, bin, log: path.join(dir, 'docker.log') };
}

function run(ctx, args = [], env = {}, { cwd = ctx.dir, prefix = [] } = {}) {
  const r = spawnSync(prefix[0] || SHELL, [...prefix.slice(1), ...(prefix.length ? [SHELL] : []), path.join(ctx.dir, 'update.sh'), ...args], {
    cwd,
    encoding: 'utf8',
    input: '',
    env: {
      PATH: `${ctx.bin}:${BASE_PATH}`, FAKE_LOG: ctx.log, FAKE_DIR: ctx.dir,
      FAKE_IMAGE_COMPOSE: path.join(ctx.dir, 'image-compose.yml'), FAKE_IMAGE_HASHES: path.join(ctx.dir, 'image-hashes.txt'),
      HELFI_UPDATE_WAIT: '3', LANG: 'de_DE.UTF-8', ...env,
    },
  });
  const calls = fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8') : '';
  return { ...r, calls };
}
const read = (ctx, f) => fs.readFileSync(path.join(ctx.dir, f), 'utf8');
const envVersion = (ctx) => (read(ctx, '.env').match(/^HELFI_VERSION=(.*)$/m) || [])[1];

// --- Finding 1: "compose up" fails ---------------------------------------------------------

test('compose up fails: no "running", exit ≠ 0, .env back to the previous state (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['1.2.0'], { FAKE_UP_FAIL: '1', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /läuft \(1\.2\.0\)/, 'the old container must not be reported as the new version');
  assert.match(r.stderr, /Start der neuen Version fehlgeschlagen/);
  assert.equal(envVersion(ctx), 'latest', 'HELFI_VERSION back to the state before the update');
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'original');
});

test('compose up fails, with -y: previous version started again, exit 1 (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y', '1.2.0'], { FAKE_UP_FAIL: '1', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(envVersion(ctx), '1.1.0');
  assert.match(r.stdout, /Vorherige Version läuft wieder/);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'original', 'without a backup from this update nothing is restored');
  assert.match(r.stdout, /Keine Sicherung .*gefunden/);
});

// --- Finding 2: incomplete backup / slow start -----------------------------------------------

test('Half-finished backup (-journal next to it) is not restored (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_BACKUP_JOURNAL: '1' });
  assert.equal(r.status, 1);
  assert.notEqual(read(ctx, 'data/helfi.sqlite'), 'sicherung-neu');
  assert.match(r.stderr, /unvollständig/);
});

test('Backup only present as .part: clear message, nothing restored (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_BACKUP_PART: '1' });
  assert.equal(r.status, 1);
  assert.notEqual(read(ctx, 'data/helfi.sqlite'), 'sicherung-neu');
  assert.match(r.stderr, /unvollständig/);
});

test('New version still "starting": with -y wait once more instead of aborting (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'starting', FAKE_HEALTHY_AFTER: '2', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Warte noch einmal/);
  assert.match(r.stdout, /läuft \(1\.2\.0\)/);
  assert.doesNotMatch(r.calls, /--pull never/);
});

test('backupDatabase writes to .part first and then renames; .part does not count as a backup (Audit)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-bk-'));
  process.env.HELFI_DATA_DIR ||= dataDir;
  const { backupDatabase, listBackups, backupKind, pruneBackups } = await import('../src/db.js');
  const dir = path.join(dataDir, 'backups');
  const seen = [];
  const fake = { backup: async (dest) => { seen.push(dest); fs.writeFileSync(dest, 'inhalt'); } };
  const file = await backupDatabase(fake, 'vor-9.9.9', dir);
  assert.ok(seen[0].endsWith('.sqlite.part'), `backup target: ${seen[0]}`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'inhalt');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)], 'no .part left behind');

  // Abort halfway: nothing under the final name, temporary file removed
  const broken = { backup: async (dest) => { fs.writeFileSync(dest, 'halb'); fs.writeFileSync(`${dest}-journal`, 'j'); throw new Error('abgebrochen'); } };
  await assert.rejects(backupDatabase(broken, 'vor-9.9.8', dir), /abgebrochen/);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);

  // Leftover .part files (e.g. after a power failure) are never listed or cleaned up
  fs.writeFileSync(path.join(dir, 'helfi-vor-9.9.7-2026-11-01T00-00-00.sqlite.part'), 'halb');
  assert.equal(backupKind('helfi-vor-9.9.7-2026-11-01T00-00-00.sqlite.part'), null);
  assert.deepEqual(listBackups(dir).map((b) => b.name), [path.basename(file)]);
  pruneBackups(1, dir);
  assert.ok(fs.existsSync(path.join(dir, 'helfi-vor-9.9.7-2026-11-01T00-00-00.sqlite.part')));
});

// --- Finding 3: --offline without version ---------------------------------------------------

test('--offline without version: version from the loaded image, not the old one from .env (Audit)', () => {
  const ctx = setup({ envText: 'HELFI_BASE_URL=http://x\nHELFI_VERSION=1.1.0\n' });
  fs.writeFileSync(path.join(ctx.dir, 'helfi-9.9.9.tar.gz'), 'x');
  const r = run(ctx, ['--offline', path.join(ctx.dir, 'helfi-9.9.9.tar.gz')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.calls, /^tag \S+:9\.9\.9 \S+:1\.1\.0/m, 'new image must not be tagged as the old version');
  assert.equal(envVersion(ctx), '9.9.9');
});

test('--offline without version: version label takes precedence, abort without a detectable version (Audit)', () => {
  let ctx = setup();
  fs.writeFileSync(path.join(ctx.dir, 'img.tar'), 'x');
  let r = run(ctx, ['--offline', path.join(ctx.dir, 'img.tar')], { FAKE_LOAD_REF: `${REPO}:latest`, FAKE_NEW_VERSION: '2.0.0' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.calls, new RegExp(`^tag ${REPO}:latest ${REPO}:2\\.0\\.0`, 'm'));
  assert.equal(envVersion(ctx), '2.0.0');

  ctx = setup();
  fs.writeFileSync(path.join(ctx.dir, 'img.tar'), 'x');
  r = run(ctx, ['--offline', path.join(ctx.dir, 'img.tar')], { FAKE_LOAD_REF: `${REPO}:latest` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Version des Images .* nicht erkennbar/);
  assert.doesNotMatch(r.calls, /compose up/);
  assert.equal(envVersion(ctx), 'latest');
});

// --- Finding 4: rollback without version label in the old image -----------------------------

test('Rollback, old image without version label: .env back to the old value, warning (Audit)', () => {
  const ctx = setup({ envText: 'HELFI_BASE_URL=http://x\nHELFI_VERSION=1.0.5\n' });
  const r = run(ctx, ['-y', '1.2.0'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0' });
  assert.equal(r.status, 1);
  assert.equal(envVersion(ctx), '1.0.5', 'do not leave it on the broken 1.2.0');
  assert.match(r.calls, new RegExp(`^tag ${REPO}:previous ${REPO}:1\\.0\\.5`, 'm'));
  assert.doesNotMatch(r.calls, new RegExp(`^tag ${REPO}:previous ${REPO}:1\\.2\\.0`, 'm'));
  assert.match(r.calls, /compose up -d --pull never helfi \[HELFI_VERSION=1\.0\.5\]/);
  assert.match(r.stdout, /WARNUNG/);
});

// --- Finding 5: backups not readable --------------------------------------------------------

test('Backup folder not readable: clear message with sudo hint instead of silence (Audit)', (t) => {
  const ctx = setup();
  let prefix = [];
  if (process.getuid && process.getuid() === 0) {
    if (!fs.existsSync('/usr/bin/setpriv')) { t.skip('cannot be tested as root without setpriv'); return; }
    // Run as user "nobody": everything writable, only the backup folder not readable
    for (const p of [ctx.dir, ctx.bin, path.join(ctx.dir, 'data')]) fs.chmodSync(p, 0o777);
    for (const f of ['.env', 'docker-compose.yml', 'update.sh', 'data/helfi.sqlite']) fs.chmodSync(path.join(ctx.dir, f), 0o666);
    fs.writeFileSync(ctx.log, ''); fs.chmodSync(ctx.log, 0o666);
    fs.chmodSync(path.join(ctx.dir, 'data/backups'), 0o700);
    prefix = ['/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups'];
  } else {
    fs.chmodSync(path.join(ctx.dir, 'data/backups'), 0o000);
  }
  try {
    const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' }, { prefix });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /nicht lesbar/);
    assert.match(r.stderr, /sudo/);
  } finally {
    fs.chmodSync(path.join(ctx.dir, 'data/backups'), 0o755);
  }
});

// --- Finding 6: --cleanup and file names with line breaks ------------------------------------

test('--cleanup: a file name with a line break never deletes another file (Audit)', () => {
  const ctx = setup();
  const sneaky = '.env.tmp.1\nsecret.key';
  fs.writeFileSync(path.join(ctx.dir, sneaky), '');
  fs.writeFileSync(path.join(ctx.dir, 'secret.key'), 'schluessel');
  fs.writeFileSync(path.join(ctx.dir, 'helfi-1.0.0.tar\nkunden-export.csv'), '');
  fs.writeFileSync(path.join(ctx.dir, 'kunden-export.csv'), 'daten');
  fs.writeFileSync(path.join(ctx.dir, 'docker-compose.yml.alt-20260101-000000\nzz-wichtig'), '');
  fs.writeFileSync(path.join(ctx.dir, 'docker-compose.yml.alt-20260102-000000'), '');
  fs.writeFileSync(path.join(ctx.dir, 'zz-wichtig'), 'daten');
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  for (const f of [sneaky, 'secret.key']) fs.utimesSync(path.join(ctx.dir, f), old, old);
  fs.writeFileSync(path.join(ctx.dir, '.env.tmp.4711'), ''); fs.utimesSync(path.join(ctx.dir, '.env.tmp.4711'), old, old);
  const r = run(ctx, ['--cleanup', '-y']);
  assert.equal(r.status, 0, r.stderr);
  for (const kept of ['secret.key', 'kunden-export.csv', 'zz-wichtig', sneaky]) {
    assert.ok(fs.existsSync(path.join(ctx.dir, kept)), `${JSON.stringify(kept)} must not be deleted`);
  }
  assert.doesNotMatch(r.stdout, /Gelöscht: (secret\.key|kunden-export\.csv|zz-wichtig)$/m);
  assert.ok(!fs.existsSync(path.join(ctx.dir, '.env.tmp.4711')), 'ordinary old temporary file is still cleaned up');
});

// --- Finding 7: --offline with relative path ------------------------------------------------

test('--offline with a relative path is resolved from the calling folder (Audit)', () => {
  const ctx = setup();
  const dl = path.join(ctx.dir, 'downloads');
  fs.mkdirSync(dl);
  fs.writeFileSync(path.join(dl, 'helfi-9.9.9.tar'), 'x');
  const r = run(ctx, ['--offline', 'helfi-9.9.9.tar', '9.9.9'], {}, { cwd: dl });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.calls, /^load -i \S*\/downloads\/helfi-9\.9\.9\.tar/m);
});

// --- Finding 8: env.example -----------------------------------------------------------------

test('env.example: commented-out settings have no explanatory text in the value (Audit)', () => {
  const lines = fs.readFileSync(path.join(root, 'env.example'), 'utf8').split('\n');
  for (const l of lines) {
    const m = l.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)$/) || l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    assert.doesNotMatch(m[2], /\s/, `when uncommented, the text would become part of the value: ${l}`);
  }
});

// --- Finding 9: CI release conditions ------------------------------------------------------

test('CI: release only via button from main – not "Run workflow" from a tag, no tag push (Audit)', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const m = yml.match(/\n {2}release-check:\n(?: {4}#.*\n)* {4}if: >-\n((?: {6}.*\n)+)/);
  assert.ok(m, 'condition of release-check not found');
  const expr = m[1].replace(/\s+/g, ' ').trim()
    .replace(/github\.event_name/g, 'c.event').replace(/github\.ref/g, 'c.ref').replace(/inputs\.release/g, 'c.release')
    .replace(/startsWith\(/g, 'sw(').replace(/ == /g, ' === ').replace(/ != /g, ' !== ');
  assert.match(expr, /^[\s\w.,()'"|&=!/*-]+$/, `unexpected expression: ${expr}`);
  // eslint-disable-next-line no-new-func
  const cond = new Function('c', 'sw', `return ${expr};`);
  const sw = (a, b) => String(a).startsWith(b);
  const on = (event, ref, release) => cond({ event, ref, release: release ?? '' }, sw);
  assert.equal(on('workflow_dispatch', 'refs/tags/v1.0.0', 'patch'), false, 'button from a tag');
  assert.equal(on('workflow_dispatch', 'refs/tags/v1.0.0', 'nein'), false);
  assert.equal(on('workflow_dispatch', 'refs/heads/feature', 'patch'), false);
  assert.equal(on('workflow_dispatch', 'refs/heads/main', 'nein'), false);
  assert.equal(on('workflow_dispatch', 'refs/heads/main', 'patch'), true);
  assert.equal(on('push', 'refs/tags/v1.2.3'), false, 'a pushed tag publishes nothing');
  assert.equal(on('push', 'refs/heads/main'), false);
  assert.equal(on('pull_request', 'refs/tags/v1.2.3'), false);
  // In the job: via button only the current state of main
  const job = yml.slice(yml.indexOf('\n  release-check:'), yml.indexOf('\n  release-build:'));
  assert.match(job, /"\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/);  // a tag push does not even start the workflow
  const on_ = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.doesNotMatch(on_, /tags:/, 'no tag trigger');
  // Publishing: unique candidate per run, release by digest, environment
  const pub = yml.slice(yml.indexOf('\n  publish:'));
  assert.match(pub, /environment: release/);
  // Build provenance (public repository): for the checked digest and the offline images, before any tag is set
  assert.match(pub, /attest-build-provenance@[0-9a-f]{40}/);
  assert.match(pub, /subject-digest: \$\{\{ steps\.cand\.outputs\.digest \}\}/);
  assert.match(pub, /subject-path: release\/helfi-\*\.tar\.gz/);
  assert.match(pub, /id-token: write/);
  assert.ok(pub.indexOf('Build provenance (image digest)') > pub.indexOf('Release files'));
  assert.ok(pub.indexOf('Build provenance (offline images)') < pub.indexOf('Publish the checked image'), 'signed before publishing');
  // Set tags only after the release files (otherwise an error leaves a half release in the registry)
  assert.ok(pub.indexOf('Publish the checked image') > pub.indexOf('Release files'), 'publish after the release files');
  assert.ok(pub.indexOf('Publish the checked image') < pub.indexOf('GitHub release'));
  assert.match(pub, /imagetools create \$tags "\$IMAGE@\$DIGEST"/);
  assert.match(yml, /kandidat-\$\{\{ github\.run_id \}\}/);
  assert.match(yml, /\nconcurrency:\n {2}group: \$\{\{ github\.event_name == 'workflow_dispatch' && 'release'/);
});

test('Dockerfile: base image pinned by digest (Audit)', () => {
  const df = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const froms = df.match(/^FROM .*$/gm);
  assert.ok(froms.length >= 2);
  for (const f of froms) assert.match(f, /^FROM node:\d+-alpine@sha256:[0-9a-f]{64}( AS \w+)?$/, f);
});

// --- Finding 11: trivy-check.sh also counts secrets ------------------------------------------

const hasJq = spawnSync('jq', ['--version']).status === 0;
test('trivy-check.sh: secrets found make the check fail (Audit)', { skip: !hasJq && 'jq missing' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-trivy-'));
  const check = (name, data) => {
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify(data));
    return spawnSync(SHELL, [path.join(root, '.github/scripts/trivy-check.sh'), f], { encoding: 'utf8' });
  };
  let r = check('secret', { Results: [{ Target: '/app/.env', Class: 'secret', Secrets: [{ RuleID: 'aws-access-key-id', Severity: 'CRITICAL', Title: 'AWS Access Key ID', StartLine: 3 }] }] });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /::error::Secret in image: CRITICAL aws-access-key-id \(AWS Access Key ID\) in \/app\/\.env:3/);
  r = check('vuln', { Results: [{ Target: 'a', Vulnerabilities: [{ Severity: 'HIGH', VulnerabilityID: 'CVE-1', PkgName: 'x', InstalledVersion: '1', FixedVersion: '2' }] }] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /1 fixable vulnerabilities/);
  r = check('none', { Results: [{ Target: 'a' }] });
  assert.equal(r.status, 0, r.stdout);
  r = check('schema', { SchemaVersion: 2 });
  assert.equal(r.status, 0, r.stdout);
});

// --- Re-check of our own changes (second reviewer) ------------------------------------------

test('Rollback: the oldest complete backup of this update is restored, not the newest (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_BACKUP_OLDER: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'sicherung-alt', 'later backups may already be partially migrated');
});

test('Rollback: newest only as .part, older one complete → the complete one is restored (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_BACKUP_OLDER: '1', FAKE_BACKUP_PART: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'sicherung-alt');
});

test('Rollback: new version is stopped before searching for backups (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_NO_BACKUP: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Keine Sicherung .*gefunden/);
  assert.match(r.calls, /compose.* stop /, 'otherwise it could migrate the database during the search');
});

test('Custom registry in docker-compose.yml: new image with a different ID counts as started (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_NEW_IMAGE: 'sha256:spiegel', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /läuft \(1\.2\.0\)/);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'migriert', 'no rollback');
});
