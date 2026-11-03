// Audit 2026-11, Bereich Betrieb und CI: update.sh (Rückweg, Offline, Aufräumen), Sicherungen,
// env.example, Release-Bedingungen der CI, trivy-check.sh.
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
      HELFI_UPDATE_WAIT: '3', ...env,
    },
  });
  const calls = fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8') : '';
  return { ...r, calls };
}
const read = (ctx, f) => fs.readFileSync(path.join(ctx.dir, f), 'utf8');
const envVersion = (ctx) => (read(ctx, '.env').match(/^HELFI_VERSION=(.*)$/m) || [])[1];

// --- Fund 1: „compose up“ schlägt fehl ------------------------------------------------------

test('compose up schlägt fehl: kein „läuft“, Exit ≠ 0, .env wieder auf altem Stand (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['1.2.0'], { FAKE_UP_FAIL: '1', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /läuft \(1\.2\.0\)/, 'der alte Container darf nicht als neue Version gemeldet werden');
  assert.match(r.stderr, /Start der neuen Version fehlgeschlagen/);
  assert.equal(envVersion(ctx), 'latest', 'HELFI_VERSION zurück auf den Stand vor dem Update');
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'original');
});

test('compose up schlägt fehl, mit -y: vorherige Version wieder gestartet, Exit 1 (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y', '1.2.0'], { FAKE_UP_FAIL: '1', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(envVersion(ctx), '1.1.0');
  assert.match(r.stdout, /Vorherige Version läuft wieder/);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'original', 'ohne Sicherung aus diesem Update wird nichts zurückgespielt');
  assert.match(r.stdout, /Keine Sicherung .*gefunden/);
});

// --- Fund 2: Sicherung unvollständig / Start dauert -----------------------------------------

test('Halbfertige Sicherung (-journal daneben) wird nicht zurückgespielt (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_BACKUP_JOURNAL: '1' });
  assert.equal(r.status, 1);
  assert.notEqual(read(ctx, 'data/helfi.sqlite'), 'sicherung-neu');
  assert.match(r.stderr, /unvollständig/);
});

test('Sicherung nur als .part vorhanden: klare Meldung, nichts zurückgespielt (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_BACKUP_PART: '1' });
  assert.equal(r.status, 1);
  assert.notEqual(read(ctx, 'data/helfi.sqlite'), 'sicherung-neu');
  assert.match(r.stderr, /unvollständig/);
});

test('Neue Version noch „starting“: mit -y einmal zusätzlich warten statt abbrechen (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'starting', FAKE_HEALTHY_AFTER: '2', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Warte noch einmal/);
  assert.match(r.stdout, /läuft \(1\.2\.0\)/);
  assert.doesNotMatch(r.calls, /--pull never/);
});

test('backupDatabase schreibt erst unter .part und benennt dann um; .part zählt nicht als Sicherung (Audit)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-bk-'));
  process.env.HELFI_DATA_DIR ||= dataDir;
  const { backupDatabase, listBackups, backupKind, pruneBackups } = await import('../src/db.js');
  const dir = path.join(dataDir, 'backups');
  const seen = [];
  const fake = { backup: async (dest) => { seen.push(dest); fs.writeFileSync(dest, 'inhalt'); } };
  const file = await backupDatabase(fake, 'vor-9.9.9', dir);
  assert.ok(seen[0].endsWith('.sqlite.part'), `Ziel der Sicherung: ${seen[0]}`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'inhalt');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)], 'kein .part bleibt liegen');

  // Abbruch mittendrin: nichts unter dem endgültigen Namen, Zwischendatei entfernt
  const broken = { backup: async (dest) => { fs.writeFileSync(dest, 'halb'); fs.writeFileSync(`${dest}-journal`, 'j'); throw new Error('abgebrochen'); } };
  await assert.rejects(backupDatabase(broken, 'vor-9.9.8', dir), /abgebrochen/);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);

  // Liegengebliebene .part-Dateien (z. B. nach Stromausfall) werden nie angezeigt oder aufgeräumt
  fs.writeFileSync(path.join(dir, 'helfi-vor-9.9.7-2026-11-01T00-00-00.sqlite.part'), 'halb');
  assert.equal(backupKind('helfi-vor-9.9.7-2026-11-01T00-00-00.sqlite.part'), null);
  assert.deepEqual(listBackups(dir).map((b) => b.name), [path.basename(file)]);
  pruneBackups(1, dir);
  assert.ok(fs.existsSync(path.join(dir, 'helfi-vor-9.9.7-2026-11-01T00-00-00.sqlite.part')));
});

// --- Fund 3: --offline ohne Versionsangabe --------------------------------------------------

test('--offline ohne Version: Version aus dem geladenen Image, nicht die alte aus .env (Audit)', () => {
  const ctx = setup({ envText: 'HELFI_BASE_URL=http://x\nHELFI_VERSION=1.1.0\n' });
  fs.writeFileSync(path.join(ctx.dir, 'helfi-9.9.9.tar.gz'), 'x');
  const r = run(ctx, ['--offline', path.join(ctx.dir, 'helfi-9.9.9.tar.gz')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.calls, /^tag \S+:9\.9\.9 \S+:1\.1\.0/m, 'neues Image darf nicht als alte Version getaggt werden');
  assert.equal(envVersion(ctx), '9.9.9');
});

test('--offline ohne Version: Versions-Label hat Vorrang, ohne erkennbare Version Abbruch (Audit)', () => {
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

// --- Fund 4: Rückweg ohne Versions-Label im alten Image -------------------------------------

test('Rückweg, altes Image ohne Versions-Label: .env zurück auf den alten Wert, Warnung (Audit)', () => {
  const ctx = setup({ envText: 'HELFI_BASE_URL=http://x\nHELFI_VERSION=1.0.5\n' });
  const r = run(ctx, ['-y', '1.2.0'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0' });
  assert.equal(r.status, 1);
  assert.equal(envVersion(ctx), '1.0.5', 'nicht auf der defekten 1.2.0 stehen lassen');
  assert.match(r.calls, new RegExp(`^tag ${REPO}:previous ${REPO}:1\\.0\\.5`, 'm'));
  assert.doesNotMatch(r.calls, new RegExp(`^tag ${REPO}:previous ${REPO}:1\\.2\\.0`, 'm'));
  assert.match(r.calls, /compose up -d --pull never helfi \[HELFI_VERSION=1\.0\.5\]/);
  assert.match(r.stdout, /WARNUNG/);
});

// --- Fund 5: Sicherungen nicht lesbar -------------------------------------------------------

test('Sicherungsordner nicht lesbar: klare Meldung mit sudo-Hinweis statt Schweigen (Audit)', (t) => {
  const ctx = setup();
  let prefix = [];
  if (process.getuid && process.getuid() === 0) {
    if (!fs.existsSync('/usr/bin/setpriv')) { t.skip('als root ohne setpriv nicht prüfbar'); return; }
    // Als Benutzer „nobody“ ausführen: alles beschreibbar, nur der Sicherungsordner nicht lesbar
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

// --- Fund 6: --cleanup und Dateinamen mit Zeilenumbruch -------------------------------------

test('--cleanup: Dateiname mit Zeilenumbruch löscht nie eine andere Datei (Audit)', () => {
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
    assert.ok(fs.existsSync(path.join(ctx.dir, kept)), `${JSON.stringify(kept)} darf nicht gelöscht werden`);
  }
  assert.doesNotMatch(r.stdout, /Gelöscht: (secret\.key|kunden-export\.csv|zz-wichtig)$/m);
  assert.ok(!fs.existsSync(path.join(ctx.dir, '.env.tmp.4711')), 'gewöhnliche alte Zwischendatei wird weiter aufgeräumt');
});

// --- Fund 7: --offline mit relativem Pfad ---------------------------------------------------

test('--offline mit relativem Pfad gilt ab dem Aufrufordner (Audit)', () => {
  const ctx = setup();
  const dl = path.join(ctx.dir, 'downloads');
  fs.mkdirSync(dl);
  fs.writeFileSync(path.join(dl, 'helfi-9.9.9.tar'), 'x');
  const r = run(ctx, ['--offline', 'helfi-9.9.9.tar', '9.9.9'], {}, { cwd: dl });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.calls, /^load -i \S*\/downloads\/helfi-9\.9\.9\.tar/m);
});

// --- Fund 8: env.example --------------------------------------------------------------------

test('env.example: auskommentierte Einstellungen haben keinen Erklärtext im Wert (Audit)', () => {
  const lines = fs.readFileSync(path.join(root, 'env.example'), 'utf8').split('\n');
  for (const l of lines) {
    const m = l.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)$/) || l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    assert.doesNotMatch(m[2], /\s/, `Beim Einkommentieren würde der Text Teil des Werts: ${l}`);
  }
});

// --- Fund 9: Release-Bedingungen der CI -----------------------------------------------------

test('CI: Release nur per Knopf von main – nicht „Run workflow“ von einem Tag, kein Tag-Push (Audit)', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const m = yml.match(/\n {2}release-check:\n(?: {4}#.*\n)* {4}if: >-\n((?: {6}.*\n)+)/);
  assert.ok(m, 'Bedingung von release-check nicht gefunden');
  const expr = m[1].replace(/\s+/g, ' ').trim()
    .replace(/github\.event_name/g, 'c.event').replace(/github\.ref/g, 'c.ref').replace(/inputs\.release/g, 'c.release')
    .replace(/startsWith\(/g, 'sw(').replace(/ == /g, ' === ').replace(/ != /g, ' !== ');
  assert.match(expr, /^[\s\w.,()'"|&=!/*-]+$/, `unerwarteter Ausdruck: ${expr}`);
  // eslint-disable-next-line no-new-func
  const cond = new Function('c', 'sw', `return ${expr};`);
  const sw = (a, b) => String(a).startsWith(b);
  const on = (event, ref, release) => cond({ event, ref, release: release ?? '' }, sw);
  assert.equal(on('workflow_dispatch', 'refs/tags/v1.0.0', 'patch'), false, 'Knopf von einem Tag aus');
  assert.equal(on('workflow_dispatch', 'refs/tags/v1.0.0', 'nein'), false);
  assert.equal(on('workflow_dispatch', 'refs/heads/feature', 'patch'), false);
  assert.equal(on('workflow_dispatch', 'refs/heads/main', 'nein'), false);
  assert.equal(on('workflow_dispatch', 'refs/heads/main', 'patch'), true);
  assert.equal(on('push', 'refs/tags/v1.2.3'), false, 'ein gepushter Tag veröffentlicht nichts');
  assert.equal(on('push', 'refs/heads/main'), false);
  assert.equal(on('pull_request', 'refs/tags/v1.2.3'), false);
  // Im Job: per Knopf nur der aktuelle Stand von main
  const job = yml.slice(yml.indexOf('\n  release-check:'), yml.indexOf('\n  release-build:'));
  assert.match(job, /"\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/);  // Tag-Push startet den Workflow gar nicht erst
  const on_ = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.doesNotMatch(on_, /tags:/, 'kein Tag-Auslöser');
  // Veröffentlichen: eindeutiger Kandidat je Lauf, Freigabe per Digest, Environment, Herkunftsnachweis
  const pub = yml.slice(yml.indexOf('\n  publish:'));
  assert.match(pub, /environment: release/);
  assert.match(pub, /attest-build-provenance@[0-9a-f]{40}/);
  assert.match(pub, /imagetools create \$tags "\$IMAGE@\$DIGEST"/);
  assert.match(yml, /kandidat-\$\{\{ github\.run_id \}\}/);
  assert.match(yml, /\nconcurrency:\n {2}group: \$\{\{ github\.event_name == 'workflow_dispatch' && 'release'/);
});

test('Dockerfile: Basis-Image per Digest festgelegt (Audit)', () => {
  const df = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const froms = df.match(/^FROM .*$/gm);
  assert.ok(froms.length >= 2);
  for (const f of froms) assert.match(f, /^FROM node:\d+-alpine@sha256:[0-9a-f]{64}( AS \w+)?$/, f);
});

// --- Fund 11: trivy-check.sh zählt auch Geheimnisse -----------------------------------------

const hasJq = spawnSync('jq', ['--version']).status === 0;
test('trivy-check.sh: gefundene Geheimnisse lassen die Prüfung scheitern (Audit)', { skip: !hasJq && 'jq fehlt' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-trivy-'));
  const check = (name, data) => {
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify(data));
    return spawnSync(SHELL, [path.join(root, '.github/scripts/trivy-check.sh'), f], { encoding: 'utf8' });
  };
  let r = check('secret', { Results: [{ Target: '/app/.env', Class: 'secret', Secrets: [{ RuleID: 'aws-access-key-id', Severity: 'CRITICAL', Title: 'AWS Access Key ID', StartLine: 3 }] }] });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /::error::Geheimnis im Image: CRITICAL aws-access-key-id \(AWS Access Key ID\) in \/app\/\.env:3/);
  r = check('vuln', { Results: [{ Target: 'a', Vulnerabilities: [{ Severity: 'HIGH', VulnerabilityID: 'CVE-1', PkgName: 'x', InstalledVersion: '1', FixedVersion: '2' }] }] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /1 behebbare Schwachstellen/);
  r = check('none', { Results: [{ Target: 'a' }] });
  assert.equal(r.status, 0, r.stdout);
  r = check('schema', { SchemaVersion: 2 });
  assert.equal(r.status, 0, r.stdout);
});

// --- Nachprüfung der eigenen Änderungen (zweiter Prüfer) ------------------------------------

test('Rückweg: die älteste vollständige Sicherung dieses Updates wird zurückgespielt, nicht die neueste (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_BACKUP_OLDER: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'sicherung-alt', 'spätere Sicherungen können schon teilweise umgestellt sein');
});

test('Rückweg: neueste nur als .part, ältere vollständig → die vollständige wird zurückgespielt (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_BACKUP_OLDER: '1', FAKE_BACKUP_PART: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'sicherung-alt');
});

test('Rückweg: neue Version wird angehalten, bevor nach Sicherungen gesucht wird (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_HEALTH_NEW: 'unhealthy', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0', FAKE_NO_BACKUP: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Keine Sicherung .*gefunden/);
  assert.match(r.calls, /compose.* stop /, 'sonst könnte sie während der Suche die Datenbank umstellen');
});

test('Eigene Registry in docker-compose.yml: neues Image mit anderer ID gilt als gestartet (Audit)', () => {
  const ctx = setup();
  const r = run(ctx, ['-y'], { FAKE_NEW_IMAGE: 'sha256:spiegel', FAKE_NEW_VERSION: '1.2.0', FAKE_PREV_VERSION: '1.1.0' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /läuft \(1\.2\.0\)/);
  assert.equal(read(ctx, 'data/helfi.sqlite'), 'migriert', 'kein Rückweg');
});
