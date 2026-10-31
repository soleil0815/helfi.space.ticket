// Tests für update.sh mit nachgebautem docker (läuft mit /bin/sh bzw. dash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = fs.existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function setup({ composeVersionInImage = 1, customizeCompose = false, envText = 'HELFI_BASE_URL=http://x\nHELFI_VERSION=latest\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-update-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(root, 'test/fixtures/fake-docker.sh'), path.join(bin, 'docker'));
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  fs.copyFileSync(path.join(root, 'update.sh'), path.join(dir, 'update.sh'));
  let compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  if (customizeCompose) compose = compose.replace('./data:/data', '/volume1/docker/helfi:/data');
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  fs.writeFileSync(path.join(dir, '.env'), envText);
  fs.mkdirSync(path.join(dir, 'data/backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/helfi.sqlite'), 'original');
  const imageCompose = path.join(dir, 'image-compose.yml');
  const shipped = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  fs.writeFileSync(imageCompose, shipped.replace(/HELFI_COMPOSE_VERSION: "\d+"/, `HELFI_COMPOSE_VERSION: "${composeVersionInImage}"`));
  const imageHashes = path.join(dir, 'image-hashes.txt');
  fs.writeFileSync(imageHashes, fs.readFileSync(path.join(root, 'docker/compose-hashes.txt'), 'utf8'));
  return { dir, bin, imageCompose, imageHashes, log: path.join(dir, 'docker.log') };
}

function run(ctx, args = [], env = {}) {
  const r = spawnSync(SHELL, [path.join(ctx.dir, 'update.sh'), ...args], {
    cwd: ctx.dir,
    encoding: 'utf8',
    input: '',
    env: {
      PATH: `${ctx.bin}:/usr/bin:/bin`, FAKE_LOG: ctx.log, FAKE_DIR: ctx.dir,
      FAKE_IMAGE_COMPOSE: ctx.imageCompose, FAKE_IMAGE_HASHES: ctx.imageHashes, HELFI_UPDATE_WAIT: '3', ...env,
    },
  });
  const calls = fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8') : '';
  return { ...r, calls };
}
const read = (ctx, f) => fs.readFileSync(path.join(ctx.dir, f), 'utf8');

test('docker-compose.yml der aktuellen Fassung steht in compose-hashes.txt', () => {
  const hashes = fs.readFileSync(path.join(root, 'docker/compose-hashes.txt'), 'utf8');
  assert.ok(hashes.split('\n').includes(sha(fs.readFileSync(path.join(root, 'docker-compose.yml')))), 'Prüfsumme der aktuellen docker-compose.yml fehlt in docker/compose-hashes.txt');
});

test('Update ohne Fehler: vorheriges Image merken, holen, starten', () => {
  const ctx = setup();
  const r = run(ctx, [], { FAKE_NEW_VERSION: '1.1.0' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.calls, /tag sha256:alt ghcr\.io\/soleil0815\/helfi\.space\.ticket:previous/);
  assert.match(r.calls, /compose pull helfi/);
  assert.match(r.calls, /compose up -d helfi/);
  assert.doesNotMatch(r.calls, /--pull never/);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'migriert');
});

test('Version angeben: wird erst nach erfolgreichem Holen in .env festgehalten', () => {
  const ctx = setup();
  const r = run(ctx, ['1.2.0']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /compose pull helfi \[HELFI_VERSION=1\.2\.0\]/);
  assert.match(read(ctx, '.env'), /^HELFI_VERSION=1\.2\.0$/m);
  assert.doesNotMatch(read(ctx, '.env'), /HELFI_VERSION=latest/);
});

test('Herunterladen schlägt fehl: .env bleibt unverändert (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['1.2.0'], { FAKE_PULL_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(read(ctx, '.env'), /^HELFI_VERSION=latest$/m);
});

test('.env ohne Zeilenumbruch am Ende wird nicht beschädigt (Audit)', () => {
  const ctx = setup({ envText: 'HELFI_BASE_URL=http://x\nHELFI_SECRET=geheim-1234567890abc' });
  const r = run(ctx, ['1.2.0']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(ctx, '.env'), 'HELFI_BASE_URL=http://x\nHELFI_SECRET=geheim-1234567890abc\nHELFI_VERSION=1.2.0\n');
});

test('.env mit Windows-Zeilenenden (Audit)', () => {
  const ctx = setup({ envText: 'HELFI_BASE_URL=http://x\r\nHELFI_VERSION=latest\r\n' });
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /HELFI_VERSION=latest\]/);
  assert.doesNotMatch(r.calls, /latest\r/);
});

test('Ungültige Versionen werden abgelehnt (Audit)', () => {
  for (const v of ['1.2;rm -rf /', '1.2..3', '1.2.3.4', 'v1.2.3', '1.2']) {
    const ctx = setup();
    const r = run(ctx, [v]);
    assert.equal(r.status, 2, v);
    assert.equal(r.calls, '', v);
  }
});

test('Neuere docker-compose.yml im Image wird übernommen, alte mit Zeitstempel behalten', () => {
  const ctx = setup({ composeVersionInImage: 2 });
  const before = read(ctx, 'docker-compose.yml');
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  const alt = fs.readdirSync(ctx.dir).find((f) => f.startsWith('docker-compose.yml.alt-'));
  assert.ok(alt);
  assert.equal(read(ctx, alt), before);
  assert.match(read(ctx, 'docker-compose.yml'), /HELFI_COMPOSE_VERSION: "2"/);
});

test('Angepasste docker-compose.yml wird NICHT ersetzt (Audit)', () => {
  const ctx = setup({ composeVersionInImage: 2, customizeCompose: true });
  const before = read(ctx, 'docker-compose.yml');
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(ctx, 'docker-compose.yml'), before, 'eigener Datenpfad bleibt');
  assert.match(read(ctx, 'docker-compose.yml.neu'), /HELFI_COMPOSE_VERSION: "2"/);
  assert.match(r.stdout, /angepasst/);
});

test('Gleiche docker-compose.yml-Version: Datei bleibt unangetastet', () => {
  const ctx = setup({ composeVersionInImage: 1 });
  run(ctx);
  assert.equal(fs.readdirSync(ctx.dir).some((f) => f.startsWith('docker-compose.yml.alt')), false);
});

test('Neue Version startet nicht: mit -y vorherige Version, Sicherung und Version in .env zurück', () => {
  const ctx = setup();
  // Eine ALTE Sicherung derselben Version (früherer Versuch) darf nicht genommen werden
  const old = path.join(ctx.dir, 'data/backups/helfi-vor-1.2.0-2020-01-01T00-00-00.sqlite');
  fs.writeFileSync(old, 'uralt');
  fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.equal(r.status, 1);
  assert.match(r.calls, /tag ghcr\.io\/soleil0815\/helfi\.space\.ticket:previous ghcr\.io\/soleil0815\/helfi\.space\.ticket:1\.1\.0/);
  assert.match(r.calls, /compose up -d --pull never helfi \[HELFI_VERSION=1\.1\.0\]/);
  assert.match(read(ctx, '.env'), /^HELFI_VERSION=1\.1\.0$/m, 'alte Version festgehalten (Watchtower holt die defekte nicht wieder)');
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'sicherung-neu');
  const failed = fs.readdirSync(path.join(ctx.dir, 'data')).filter((f) => f.startsWith('helfi.sqlite.fehlgeschlagen-'));
  assert.equal(failed.length, 2, 'Datenbank und WAL des fehlgeschlagenen Stands bleiben erhalten');
  assert.equal(read(ctx, `data/${failed.find((f) => !f.endsWith('-wal'))}`), 'migriert');
  assert.equal(fs.existsSync(path.join(ctx.dir, 'data/helfi.sqlite-wal')), false);
  assert.match(r.stdout, /Vorherige Version läuft wieder/);
});

test('Rücksprung nutzt den echten Datenordner aus dem Mount (Audit)', () => {
  const ctx = setup();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-volume-'));
  fs.mkdirSync(path.join(other, 'backups'));
  fs.writeFileSync(path.join(other, 'helfi.sqlite'), 'original');
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_DATA_DIR: other });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(other, 'helfi.sqlite'), 'utf8'), 'sicherung-neu');
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'original', './data im Skriptordner bleibt unberührt');
});

test('Neue Version startet nicht, ohne -y und ohne Antwort: nichts zurückdrehen, ehrliche Meldung', () => {
  const ctx = setup();
  const r = run(ctx, [], { FAKE_HEALTH_NEW: 'exited', FAKE_NEW_VERSION: '1.2.0' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.calls, /--pull never/);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'migriert');
  assert.doesNotMatch(r.stdout, /Nichts geändert/);
  assert.match(r.stdout, /bleibt gestartet/);
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

test('Rücksprung stellt auch die alte docker-compose.yml wieder her', () => {
  const ctx = setup({ composeVersionInImage: 2 });
  const before = read(ctx, 'docker-compose.yml');
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0' });
  assert.equal(r.status, 1);
  assert.equal(read(ctx, 'docker-compose.yml'), before);
  assert.match(read(ctx, 'docker-compose.yml.neu'), /HELFI_COMPOSE_VERSION: "2"/);
});
