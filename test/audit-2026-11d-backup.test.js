// Audit 2026-11d (operations): the backup download never hands out session ids, aborted downloads
// free their resources, oversized entries stop early, durable packing, vanishing backups, release re-run
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startServer } from './helpers/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let S; let paths; let dbm;
before(async () => {
  S = await startServer('audit-d-backup');
  ({ paths } = await import('../src/config.js'));
  dbm = await import('../src/db.js');
});
after(() => S.stop());

/** Entries of a ZIP (central directory, deflate) → { name: Buffer } */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    out[name] = zlib.inflateRawSync(buf.subarray(start, start + csize));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const leftovers = () => fs.readdirSync(paths.backups).filter((f) => f.startsWith('helfi-download-'));
/** Open file descriptors of this process pointing into the backup folder */
function openBackupFds() {
  const out = [];
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try { const t = fs.readlinkSync(`/proc/self/fd/${fd}`); if (t.startsWith(paths.backups)) out.push(t); } catch { /* closed meanwhile */ }
  }
  return out;
}

test('Backup download contains no session ids (no session takeover from a downloaded ZIP)', async () => {
  const victim = await S.user('victim', 'agent');
  await victim('GET', '/api/me');
  const sids = S.db.prepare('SELECT id FROM sessions').all().map((r) => r.id);
  assert.ok(sids.length >= 2, 'admin and victim are signed in');
  const made = await S.admin('POST', '/api/admin/backup');
  assert.equal(made.status, 200);
  const r = await S.admin.raw(`/api/admin/backups/${encodeURIComponent(made.body.file)}/download`);
  assert.equal(r.status, 200);
  for (const sid of sids) assert.equal(r.bytes.indexOf(Buffer.from(sid)), -1, 'session id nowhere in the download');
  const z = readZip(r.bytes);
  for (const sid of sids) assert.equal(z['helfi.sqlite'].indexOf(Buffer.from(sid)), -1, 'session id nowhere in the database file');
  const tmp = path.join(os.tmpdir(), `helfi-d-${process.pid}.sqlite`);
  fs.writeFileSync(tmp, z['helfi.sqlite']);
  try {
    const d = new Database(tmp, { readonly: true });
    assert.equal(d.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.ok(d.prepare('SELECT COUNT(*) n FROM users').get().n >= 2, 'everything else is there');
    assert.equal(d.pragma('integrity_check', { simple: true }), 'ok');
    d.close();
  } finally { fs.rmSync(tmp, { force: true }); }
  assert.match(z['INFO.txt'].toString(), /Anmeldesitzungen sind entfernt/);
  assert.match(z['INFO.txt'].toString(), /sessions are removed/);
  assert.equal(leftovers().length, 0, 'temporary copy removed');
});

test('Aborted downloads leave no open file handles and no temporary copy behind', async () => {
  const name = 'helfi-manuell-2026-11-08T10-00-00.sqlite';
  const file = path.join(paths.backups, name);
  const d = new Database(file);
  d.exec('CREATE TABLE blob (b BLOB); CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  const ins = d.prepare('INSERT INTO blob VALUES (?)');
  for (let i = 0; i < 24; i++) ins.run(crypto.randomBytes(1024 * 1024)); // incompressible, fills the buffers
  d.close();
  const url = `${S.base}/api/admin/backups/${name}/download`;
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve, reject) => {
      const req = http.get(url, { headers: { cookie: S.admin.cookie() } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
    });
  }
  let fds = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 50));
    fds = openBackupFds();
    if (!fds.length && !leftovers().length) break;
  }
  assert.deepEqual(fds, [], 'no file handle into the backup folder left open');
  assert.deepEqual(leftovers(), [], 'temporary copies removed');
  const r = await S.admin.raw(`/api/admin/backups/${name}/download`);
  assert.equal(r.status, 200, 'download slots are free again');
  fs.rmSync(file, { force: true });
});

test('A file that is not a database is not handed out (it cannot be cleaned)', async () => {
  const name = 'helfi-manuell-2026-11-08T11-00-00.sqlite';
  fs.writeFileSync(path.join(paths.backups, name), 'kein sqlite');
  const r = await S.admin.raw(`/api/admin/backups/${name}/download`);
  assert.notEqual(r.status, 200);
  assert.notEqual(r.headers.get('content-type'), 'application/zip');
  assert.deepEqual(leftovers(), []);
  fs.rmSync(path.join(paths.backups, name), { force: true });
  const ok = await S.admin.raw(`/api/admin/backups/${encodeURIComponent((await S.admin('GET', '/api/admin/system')).body.backups[0].name)}/download`);
  assert.equal(ok.status, 200, 'slot released after the failure');
});

test('ZIP writer stops as soon as a plain entry outgrows its 32-bit header, not after reading all of it', async () => {
  const { zipStream } = await import('../src/zip.js');
  const file = path.join(os.tmpdir(), `helfi-zip-limit-${process.pid}.bin`);
  fs.writeFileSync(file, crypto.randomBytes(64 * 1024)); // small at stat time → plain header
  let yielded = 0;
  try {
    await assert.rejects(async () => {
      for await (const c of zipStream([{ name: 'x', file }], { limit: 256 * 1024 })) {
        yielded += c.length;
        if (yielded < 100) fs.appendFileSync(file, crypto.randomBytes(8 * 1024 * 1024)); // grows after the header
      }
    }, /too large/);
    assert.ok(yielded < 2 * 1024 * 1024, `stopped early (${yielded} bytes)`);
  } finally { fs.rmSync(file, { force: true }); }
});

test('Packing is durable: data flushed before the rename, the original removed only afterwards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-fsync-'));
  const src = path.join(dir, 'helfi-manuell-2026-01-01T00-00-00.sqlite');
  fs.writeFileSync(src, crypto.randomBytes(4096));
  const ops = [];
  const orig = { fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const fsync = mock.method(fs, 'fsyncSync', (fd) => { ops.push('fsync'); return orig.fsyncSync(fd); });
  const rename = mock.method(fs, 'renameSync', (a, b) => { ops.push('rename'); return orig.renameSync(a, b); });
  const rm = mock.method(fs, 'rmSync', (f, o) => { if (f === src) ops.push('rm'); return orig.rmSync(f, o); });
  try {
    const r = await dbm.packPendingBackups(dir);
    assert.equal(r.packed, 1);
  } finally { fsync.mock.restore(); rename.mock.restore(); rm.mock.restore(); }
  const iRename = ops.indexOf('rename');
  assert.ok(iRename > 0 && ops.slice(0, iRename).includes('fsync'), `file flushed before the rename: ${ops}`);
  assert.ok(ops.slice(iRename + 1, ops.indexOf('rm')).includes('fsync'), `directory flushed before removing the original: ${ops}`);
});

test('A backup vanishing between listing and stat is skipped instead of failing the listing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-vanish-'));
  fs.writeFileSync(path.join(dir, 'helfi-manuell-2026-01-01T00-00-00.sqlite'), 'a');
  fs.writeFileSync(path.join(dir, 'helfi-manuell-2026-01-02T00-00-00.sqlite'), 'b');
  const statSync = fs.statSync;
  const stat = mock.method(fs, 'statSync', (f, o) => {
    if (String(f).endsWith('01-01T00-00-00.sqlite')) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
    return statSync(f, o);
  });
  let list;
  try { list = dbm.listBackups(dir); } finally { stat.mock.restore(); }
  assert.deepEqual(list.map((b) => b.name), ['helfi-manuell-2026-01-02T00-00-00.sqlite']);
});

test('Release re-run reuses a tag on the same commit only while it has no GitHub release', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const check0 = yml.slice(yml.indexOf('\n  release-check:'), yml.indexOf('\n  release-build:'));
  assert.match(check0, /releases\/tags\/\$mine/);
  assert.match(check0, /GH_TOKEN/);
  const pub = yml.slice(yml.indexOf('\n  publish:'));
  for (const step of ['Tag must not exist yet', 'Reserve the version (git tag)']) {
    const s = pub.slice(pub.indexOf(step), pub.indexOf('- name:', pub.indexOf(step) + 10));
    assert.match(s, /releases\/tags\/v\$V/, step);
    assert.match(s, /already released/, step);
  }
});

test('download copy of a packed backup stops as soon as the unpacked size passes the limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-dlcopy-'));
  try {
    const file = path.join(dir, 'helfi-manuell-20260101-000000.sqlite.gz');
    fs.writeFileSync(file, zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024))); // 4 MB unpacked, a few KB packed
    await assert.rejects(dbm.backupDownloadCopy({ name: path.basename(file), file }, dir, { maxBytes: 1024 * 1024 }), (e) => e.code === 'ETOOLARGE');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('helfi-download-')), [], 'no partial copy left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
