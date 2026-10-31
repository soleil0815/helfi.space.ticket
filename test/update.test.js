// Tests für update.sh mit nachgebautem docker (läuft mit /bin/sh bzw. dash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = fs.existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh';

function setup({ composeVersionInImage = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-update-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(root, 'test/fixtures/fake-docker.sh'), path.join(bin, 'docker'));
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  fs.copyFileSync(path.join(root, 'update.sh'), path.join(dir, 'update.sh'));
  fs.copyFileSync(path.join(root, 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
  fs.writeFileSync(path.join(dir, '.env'), 'HELFI_BASE_URL=http://x\nHELFI_VERSION=latest\n');
  fs.mkdirSync(path.join(dir, 'data/backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/helfi.sqlite'), 'original');
  const imageCompose = path.join(dir, 'image-compose.yml');
  fs.writeFileSync(imageCompose, fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
    .replace(/HELFI_COMPOSE_VERSION: "\d+"/, `HELFI_COMPOSE_VERSION: "${composeVersionInImage}"`));
  return { dir, bin, imageCompose, log: path.join(dir, 'docker.log') };
}

function run(ctx, args = [], env = {}) {
  const r = spawnSync(SHELL, [path.join(ctx.dir, 'update.sh'), ...args], {
    cwd: ctx.dir,
    encoding: 'utf8',
    input: '',
    env: {
      PATH: `${ctx.bin}:/usr/bin:/bin`, FAKE_LOG: ctx.log, FAKE_DIR: ctx.dir,
      FAKE_IMAGE_COMPOSE: ctx.imageCompose, HELFI_UPDATE_WAIT: '3', ...env,
    },
  });
  const calls = fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8') : '';
  return { ...r, calls };
}

test('Update ohne Fehler: vorheriges Image merken, holen, starten', () => {
  const ctx = setup();
  const r = run(ctx, [], { FAKE_NEW_VERSION: '1.1.0' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.calls, /tag sha256:alt ghcr\.io\/soleil0815\/helfi\.space\.ticket:previous/);
  assert.match(r.calls, /compose pull helfi/);
  assert.match(r.calls, /compose up -d helfi/);
  assert.doesNotMatch(r.calls, /--pull never/);
  assert.equal(fs.readFileSync(path.join(ctx.dir, 'data/helfi.sqlite'), 'utf8'), 'migriert');
});

test('Version angeben: wird in .env festgehalten', () => {
  const ctx = setup();
  const r = run(ctx, ['1.2.0']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(ctx.dir, '.env'), 'utf8'), /^HELFI_VERSION=1\.2\.0$/m);
  assert.doesNotMatch(fs.readFileSync(path.join(ctx.dir, '.env'), 'utf8'), /HELFI_VERSION=latest/);
});

test('Ungültige Version wird abgelehnt', () => {
  const ctx = setup();
  const r = run(ctx, ['1.2;rm -rf /']);
  assert.equal(r.status, 2);
  assert.equal(r.calls, '');
});

test('Neuere docker-compose.yml im Image wird übernommen, alte als .alt behalten', () => {
  const ctx = setup({ composeVersionInImage: 2 });
  const before = fs.readFileSync(path.join(ctx.dir, 'docker-compose.yml'), 'utf8');
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(ctx.dir, 'docker-compose.yml.alt'), 'utf8'), before);
  assert.match(fs.readFileSync(path.join(ctx.dir, 'docker-compose.yml'), 'utf8'), /HELFI_COMPOSE_VERSION: "2"/);
});

test('Gleiche docker-compose.yml-Version: Datei bleibt unangetastet', () => {
  const ctx = setup({ composeVersionInImage: 1 });
  run(ctx);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'docker-compose.yml.alt')), false);
});

test('Neue Version startet nicht: mit -y vorherige Version + Sicherung zurück', () => {
  const ctx = setup();
  // Eine ALTE Sicherung derselben Version (früherer Versuch) darf nicht genommen werden
  const old = path.join(ctx.dir, 'data/backups/helfi-vor-1.2.0-2020-01-01T00-00-00.sqlite');
  fs.writeFileSync(old, 'uralt');
  fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0' });
  assert.equal(r.status, 1);
  assert.match(r.calls, /tag ghcr\.io\/soleil0815\/helfi\.space\.ticket:previous ghcr\.io\/soleil0815\/helfi\.space\.ticket:latest/);
  assert.match(r.calls, /compose up -d --pull never helfi/);
  assert.equal(fs.readFileSync(path.join(ctx.dir, 'data/helfi.sqlite'), 'utf8'), 'sicherung-neu');
  const failed = fs.readdirSync(path.join(ctx.dir, 'data')).find((f) => f.startsWith('helfi.sqlite.fehlgeschlagen-'));
  assert.ok(failed, 'fehlgeschlagener Stand bleibt erhalten');
  assert.equal(fs.readFileSync(path.join(ctx.dir, 'data', failed), 'utf8'), 'migriert');
  assert.match(r.stdout, /Vorherige Version läuft wieder/);
});

test('Neue Version startet nicht, ohne -y und ohne Antwort: nichts zurückdrehen', () => {
  const ctx = setup();
  const r = run(ctx, [], { FAKE_HEALTH_NEW: 'exited', FAKE_NEW_VERSION: '1.2.0' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.calls, /--pull never/);
  assert.equal(fs.readFileSync(path.join(ctx.dir, 'data/helfi.sqlite'), 'utf8'), 'migriert');
});

test('Ohne Internet: Image-Datei laden', () => {
  const ctx = setup();
  const tar = path.join(ctx.dir, 'helfi-9.9.9.tar');
  fs.writeFileSync(tar, 'x');
  const r = run(ctx, ['--offline', tar, '9.9.9']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^load -i /m);
  assert.doesNotMatch(r.calls, /compose pull/);
});

test('Ohne .env bricht update.sh mit Hinweis ab', () => {
  const ctx = setup();
  fs.rmSync(path.join(ctx.dir, '.env'));
  const r = run(ctx);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.env fehlt/);
});

test('Rücksprung stellt auch die alte docker-compose.yml wieder her (Regression)', () => {
  const ctx = setup({ composeVersionInImage: 2 });
  const before = fs.readFileSync(path.join(ctx.dir, 'docker-compose.yml'), 'utf8');
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0' });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(ctx.dir, 'docker-compose.yml'), 'utf8'), before);
  assert.match(fs.readFileSync(path.join(ctx.dir, 'docker-compose.yml.neu'), 'utf8'), /HELFI_COMPOSE_VERSION: "2"/);
});
