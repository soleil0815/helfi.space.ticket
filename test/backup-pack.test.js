// Backups are stored packed (helfi-….sqlite.gz); the one before a version change stays unpacked for a day
// (update.sh restores it), older unpacked backups are packed in the background without losing anything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { startServer } from './helpers/server.js';

let S; let db;
before(async () => {
  S = await startServer('backup-pack');
  db = await import('../src/db.js');
});
after(() => S.stop());

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-pack-'));
const DAY = 24 * 3600 * 1000;
function plain(dir, name, content, ageMs) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content, { mode: 0o600 });
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
}

test('New backups are stored packed, readable by the owner only, and unpack to a working database', async () => {
  const dir = tmp();
  const file = await db.backupDatabase(S.db, 'manuell', dir);
  assert.match(path.basename(file), /^helfi-manuell-.*\.sqlite\.gz$/);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)], 'no .part left behind');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  assert.ok(fs.statSync(file).size < raw.length / 2, 'clearly smaller');
  const out = path.join(dir, 'check.sqlite');
  fs.writeFileSync(out, raw);
  const d = new Database(out, { readonly: true });
  assert.equal(d.pragma('integrity_check', { simple: true }), 'ok');
  assert.ok(d.prepare('SELECT COUNT(*) n FROM users').get().n >= 1);
  d.close();
  assert.equal(db.backupKind(path.basename(file)), 'manual');
  assert.equal(db.listBackups(dir)[0].name, path.basename(file));
});

test('The backup before a version change stays unpacked (update.sh restores exactly this file)', async () => {
  const dir = tmp();
  const file = await db.backupDatabase(S.db, 'vor-9.9.9', dir);
  assert.match(path.basename(file), /^helfi-vor-9\.9\.9-.*\.sqlite$/);
  // a fresh one is not packed yet …
  let r = await db.packPendingBackups(dir);
  assert.equal(r.packed, 0);
  assert.ok(fs.existsSync(file));
  // … but one day later
  r = await db.packPendingBackups(dir, { now: Date.now() + DAY + 60_000 });
  assert.equal(r.packed, 1);
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(`${file}.gz`));
});

test('Packing old unpacked backups: content identical, time stamp kept, cleanup counts them', async () => {
  const dir = tmp();
  const content = Buffer.from('SQLite format 3\0'.repeat(5000));
  const a = plain(dir, 'helfi-taeglich-2026-10-01T02-00-00.sqlite', content, 5 * DAY);
  const b = plain(dir, 'helfi-manuell-2026-10-02T10-00-00.sqlite', content, 4 * DAY);
  const busy = plain(dir, 'helfi-taeglich-2026-10-03T02-00-00.sqlite', content, 3 * DAY);
  fs.writeFileSync(`${busy}-journal`, 'j'); // still being written
  const before = fs.statSync(a).mtimeMs;
  const r = await db.packPendingBackups(dir);
  assert.equal(r.packed, 2);
  assert.ok(r.saved > 0);
  for (const f of [a, b]) {
    assert.equal(fs.existsSync(f), false, 'original removed');
    assert.ok(zlib.gunzipSync(fs.readFileSync(`${f}.gz`)).equals(content), 'identical');
    assert.equal(fs.statSync(`${f}.gz`).mode & 0o777, 0o600);
  }
  assert.equal(Math.round(fs.statSync(`${a}.gz`).mtimeMs / 1000), Math.round(before / 1000), 'time stamp kept');
  assert.ok(fs.existsSync(busy), 'backup with a journal is left alone');
  // Order and kinds as before
  assert.deepEqual(db.listBackups(dir).map((x) => x.name), [
    'helfi-taeglich-2026-10-03T02-00-00.sqlite', 'helfi-manuell-2026-10-02T10-00-00.sqlite.gz', 'helfi-taeglich-2026-10-01T02-00-00.sqlite.gz',
  ]);
  // Packed and unpacked count together per kind
  db.pruneBackups(1, dir);
  assert.deepEqual(db.listBackups(dir).map((x) => x.name), ['helfi-taeglich-2026-10-03T02-00-00.sqlite', 'helfi-manuell-2026-10-02T10-00-00.sqlite.gz']);
});

test('A failure while packing leaves the original in place; leftovers are cleaned up', async () => {
  const dir = tmp();
  const f = plain(dir, 'helfi-manuell-2026-10-05T10-00-00.sqlite', 'inhalt', DAY);
  // Packed file already there (e.g. an earlier run): the original is not touched
  fs.writeFileSync(`${f}.gz`, zlib.gzipSync('inhalt'));
  let r = await db.packPendingBackups(dir);
  assert.equal(r.packed, 0);
  assert.ok(fs.existsSync(f));
  fs.rmSync(`${f}.gz`);
  // Unreadable original (e.g. permissions): warning, nothing lost, no half file
  if (process.getuid?.() !== 0) {
    fs.chmodSync(f, 0o000);
    r = await db.packPendingBackups(dir);
    assert.equal(r.packed, 0);
    fs.chmodSync(f, 0o600);
    assert.ok(fs.existsSync(f));
    assert.deepEqual(fs.readdirSync(dir), [path.basename(f)], 'no .gz or .part left');
  }
  // Leftover .gz.part from a crash: never listed, removed after an hour
  const part = path.join(dir, 'helfi-manuell-2026-10-06T10-00-00.sqlite.gz.part');
  fs.writeFileSync(part, 'halb');
  const old = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(part, old, old);
  assert.equal(db.backupKind(path.basename(part)), null);
  db.pruneBackups(10, dir);
  assert.equal(fs.existsSync(part), false);
});

test('Two runs at the same time do not pack twice', async () => {
  const dir = tmp();
  for (let i = 1; i <= 3; i++) plain(dir, `helfi-manuell-2026-10-0${i}T10-00-00.sqlite`, 'x'.repeat(100000), (10 - i) * DAY);
  const [a, b] = await Promise.all([db.packPendingBackups(dir), db.packPendingBackups(dir)]);
  assert.equal(a.packed + b.packed, 3);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.gz')).length, 3);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.sqlite')).length, 0);
});

test('Admin: manual backup is packed, download still delivers the unpacked database in the ZIP', async () => {
  const made = await S.admin('POST', '/api/admin/backup');
  assert.match(made.body.file, /\.sqlite\.gz$/);
  const sys = await S.admin('GET', '/api/admin/system');
  const b = sys.body.backups.find((x) => x.name === made.body.file);
  assert.equal(b.kind, 'manual');
  const r = await S.admin.raw(`/api/admin/backups/${encodeURIComponent(made.body.file)}/download`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /filename="helfi-manuell-[^"]+\.zip"/);
  assert.doesNotMatch(r.headers.get('content-disposition'), /\.gz|\.sqlite/);
  const del = await S.admin('DELETE', `/api/admin/backups/${encodeURIComponent(made.body.file)}`);
  assert.equal(del.status, 200);
});
