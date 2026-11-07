// Audit 2026-11b, operations: update.sh (--offline version check, --cleanup mount guard,
// .env writes, HELFI_VERSION for compose up) and the CI shell lint list.
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

function setup({ envText = 'HELFI_BASE_URL=http://x\nHELFI_SECRET=geheim-1234567890abc\nHELFI_VERSION=latest\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-ops-'));
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

// umask: run update.sh under this umask (as an admin shell might have it)
function run(ctx, args = [], env = {}, { umask = '022' } = {}) {
  const r = spawnSync(SHELL, ['-c', `umask ${umask}; exec "$0" "$@"`, SHELL, path.join(ctx.dir, 'update.sh'), ...args], {
    cwd: ctx.dir,
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

// Wrapper for "cat" that records the mode of .env.tmp.* copies and can fail on the N-th copy
function catWrapper(ctx) {
  const w = path.join(ctx.bin, 'cat');
  fs.writeFileSync(w, `#!/bin/sh
case "\${1:-}" in
  .env.tmp.*)
    ls -ln "$1" | cut -c1-10 >> "$FAKE_DIR/.tmp-modes"
    n=$(( $(/bin/cat "$FAKE_DIR/.cat-n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_DIR/.cat-n"
    [ -n "\${FAKE_CAT_FAIL_AT:-}" ] && [ "$n" -ge "$FAKE_CAT_FAIL_AT" ] && { echo "cat: write error: No space left on device" >&2; exit 1; } ;;
esac
exec /bin/cat "$@"
`);
  fs.chmodSync(w, 0o755);
}

// --- O1: --offline <file> <version> must match the image's version label --------------------

test('--offline with a version that differs from the image label: abort, nothing tagged or pinned (Audit O1)', () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.dir, 'img.tar'), 'x');
  const r = run(ctx, ['--offline', path.join(ctx.dir, 'img.tar'), '1.2.0'], { FAKE_LOAD_REF: `${REPO}:1.3.0`, FAKE_LOAD_VERSION: '1.3.0' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Version 1\.3\.0, nicht 1\.2\.0 – nichts geändert/);
  assert.doesNotMatch(r.calls, /^tag \S+ \S+:1\.2\.0/m, 'the wrong image must not be tagged as 1.2.0');
  assert.doesNotMatch(r.calls, /compose up/);
  assert.equal(envVersion(ctx), 'latest');
});

test('--offline version mismatch message is English in an English locale (Audit O1)', () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.dir, 'img.tar'), 'x');
  const r = run(ctx, ['--offline', path.join(ctx.dir, 'img.tar'), '1.2.0'], { LANG: 'en_US.UTF-8', FAKE_LOAD_REF: `${REPO}:1.3.0`, FAKE_LOAD_VERSION: '1.3.0' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /version 1\.3\.0, not 1\.2\.0 – nothing changed/);
});

test('--offline with the matching version (or an image without label) still works (Audit O1)', () => {
  let ctx = setup();
  fs.writeFileSync(path.join(ctx.dir, 'img.tar'), 'x');
  let r = run(ctx, ['--offline', path.join(ctx.dir, 'img.tar'), '1.3.0'], { FAKE_LOAD_REF: `${REPO}:1.3.0`, FAKE_LOAD_VERSION: '1.3.0' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envVersion(ctx), '1.3.0');
  ctx = setup();
  fs.writeFileSync(path.join(ctx.dir, 'img.tar'), 'x');
  r = run(ctx, ['--offline', path.join(ctx.dir, 'img.tar'), '1.2.0'], { FAKE_LOAD_REF: 'helfi-local:dev' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^tag helfi-local:dev \S+:1\.2\.0/m);
  assert.equal(envVersion(ctx), '1.2.0');
});

// --- O2: --cleanup must not delete when a docker inspect fails ------------------------------

test('--cleanup: failing docker inspect of the mounts → nothing deleted (Audit O2)', () => {
  const ctx = setup();
  const tar = path.join(ctx.dir, 'helfi-1.0.0.tar');
  fs.writeFileSync(tar, 'x');
  const r = run(ctx, ['--cleanup', '-y'], { FAKE_INSPECT_MOUNTS_FAIL: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Mounts der Container nicht lesbar – nichts gelöscht/);
  assert.ok(fs.existsSync(tar), 'nothing may be deleted without knowing the mounts');
  // Control: with a working inspect the file is a cleanup candidate
  const ok = run(ctx, ['--cleanup', '-y']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.existsSync(tar), false);
});

// --- O3: env_set temp file and return value -------------------------------------------------

test('.env temp copy is owner-only even with umask 000, .env keeps its mode (Audit O3)', () => {
  const ctx = setup();
  catWrapper(ctx);
  fs.chmodSync(path.join(ctx.dir, '.env'), 0o600);
  const r = run(ctx, ['1.2.0'], {}, { umask: '000' });
  assert.equal(r.status, 0, r.stderr);
  const modes = read(ctx, '.tmp-modes').trim().split('\n');
  assert.ok(modes.length >= 1);
  for (const m of modes) assert.equal(m, '-rw-------', `temporary copy of .env (contains HELFI_SECRET) was ${m}`);
  assert.equal(fs.statSync(path.join(ctx.dir, '.env')).mode & 0o777, 0o600);
  assert.equal(envVersion(ctx), '1.2.0');
  assert.equal(fs.readdirSync(ctx.dir).some((f) => f.startsWith('.env.tmp.')), false, 'no temp copy left behind');
});

test('.env cannot be written when recording the version: abort, not reported as recorded (Audit O3)', () => {
  const ctx = setup();
  catWrapper(ctx);
  const r = run(ctx, ['1.2.0'], { FAKE_CAT_FAIL_AT: '1' });
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /in \.env festgehalten/);
  assert.match(r.stderr, /HELFI_VERSION konnte nicht in \.env geschrieben werden/);
  assert.doesNotMatch(r.calls, /compose up/);
  // .env may be incomplete after a failed write: the complete owner-only copy is kept and named
  const kept = fs.readdirSync(ctx.dir).find((f) => f.startsWith('.env.tmp.'));
  assert.ok(kept, 'complete copy of .env kept');
  assert.match(r.stderr, /Vollständige Kopie der \.env/);
  assert.ok(r.stderr.includes(kept), 'the kept copy is named');
  assert.equal(fs.statSync(path.join(ctx.dir, kept)).mode & 0o777, 0o600);
  assert.match(read(ctx, kept), /^HELFI_VERSION=1\.2\.0$/m);
});

test('.env cannot be set back after a failed start: error instead of "set back" (Audit O3)', () => {
  const ctx = setup();
  catWrapper(ctx);
  const r = run(ctx, ['1.2.0'], { FAKE_UP_FAIL: '1', FAKE_NO_CONTAINER: '1', FAKE_CAT_FAIL_AT: '2' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /Version in \.env wieder auf latest/);
  assert.match(r.stderr, /bitte von Hand auf latest setzen/);
});

// --- O4: compose up uses the same version as the pull --------------------------------------

test('Exported HELFI_VERSION of the caller does not change the started version (Audit O4)', () => {
  const ctx = setup();
  const r = run(ctx, ['1.2.0'], { HELFI_VERSION: '9.9.9' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /compose pull helfi \[HELFI_VERSION=1\.2\.0\]/);
  assert.match(r.calls, /compose up -d helfi \[HELFI_VERSION=1\.2\.0\]/);
  assert.doesNotMatch(r.calls, /compose up.*HELFI_VERSION=9\.9\.9/);
  // Without a version argument the version from .env counts
  const ctx2 = setup();
  const r2 = run(ctx2, [], { HELFI_VERSION: '9.9.9' });
  assert.match(r2.calls, /compose up -d helfi \[HELFI_VERSION=latest\]/);
});

test('Rollback with exported HELFI_VERSION starts the previous version (Audit O4)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y', '1.2.0'], { HELFI_VERSION: '9.9.9', FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.equal(r.status, 1);
  assert.match(r.calls, /compose up -d helfi \[HELFI_VERSION=1\.2\.0\]/);
  assert.match(r.calls, /compose up -d --pull never helfi \[HELFI_VERSION=1\.1\.0\]/);
  assert.doesNotMatch(r.calls, /compose up.*HELFI_VERSION=9\.9\.9/);
});

// --- O5: CI lints every shell script of the image -------------------------------------------

test('CI shellcheck covers update.sh and every docker/*.sh (Audit O5)', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const line = ci.split('\n').find((l) => /^\s*shellcheck -s sh /.test(l));
  assert.ok(line, 'shellcheck step missing');
  const listed = line.trim().split(/\s+/);
  for (const f of ['update.sh', ...fs.readdirSync(path.join(root, 'docker')).filter((f) => f.endsWith('.sh')).map((f) => `docker/${f}`)]) {
    assert.ok(listed.includes(f), `${f} is not linted in CI`);
  }
});
