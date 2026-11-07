// Tests: download a backup as ZIP (database + INFO.txt, never secret.key), admins only
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { startServer } from './helpers/server.js';

let S; let paths;
before(async () => {
  S = await startServer('backup-download');
  ({ paths } = await import('../src/config.js'));
});
after(() => S.stop());

/** Minimal ZIP reader (central directory) – checks signatures, sizes and CRC of every entry. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50, `local header ${name}`);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    assert.equal(method, 8);
    const data = zlib.inflateRawSync(buf.subarray(start, start + csize));
    assert.equal(data.length, size, `size ${name}`);
    assert.equal(zlib.crc32(data), crc, `crc ${name}`);
    assert.equal(buf.readUInt32LE(start + csize), 0x08074b50, `data descriptor ${name}`);
    out[name] = data;
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

test('ZIP writer: several entries, empty and larger data round-trip', async () => {
  const { zipStream } = await import('../src/zip.js');
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
  const file = path.join(os.tmpdir(), `helfi-zip-${process.pid}.bin`);
  fs.writeFileSync(file, big);
  try {
    const chunks = [];
    for await (const c of Readable.from(zipStream([{ name: 'groß.bin', file }, { name: 'leer.txt', data: '' }, { name: 'a.txt', data: 'Hallo' }]))) chunks.push(c);
    const z = readZip(Buffer.concat(chunks));
    assert.deepEqual(Object.keys(z), ['groß.bin', 'leer.txt', 'a.txt']);
    assert.ok(z['groß.bin'].equals(big));
    assert.equal(z['leer.txt'].length, 0);
    assert.equal(z['a.txt'].toString(), 'Hallo');
  } finally { fs.rmSync(file, { force: true }); }
});

test('CRC-32 fallback matches the reference values', async () => {
  const { crc32, crc32Fallback } = await import('../src/zip.js');
  for (const f of [crc32, crc32Fallback]) {
    assert.equal(f(Buffer.from('123456789')), 0xCBF43926);
    const a = Buffer.from('Hallo '); const b = Buffer.from('Welt');
    assert.equal(f(b, f(a)), f(Buffer.concat([a, b])));
    assert.equal(f(Buffer.alloc(0)), 0);
  }
});

test('ZIP writer: a missing file aborts the stream instead of producing a broken archive', async () => {
  const { zipStream } = await import('../src/zip.js');
  await assert.rejects(async () => {
    for await (const _ of zipStream([{ name: 'x', file: path.join(os.tmpdir(), 'helfi-gibt-es-nicht.sqlite') }])) { /* drain */ }
  });
});

test('Download: ZIP with the database and INFO.txt, without secret.key', async () => {
  S.db.prepare("INSERT INTO settings (key, value) VALUES ('test.marker', '\"backup-download\"') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const made = await S.admin('POST', '/api/admin/backup');
  assert.equal(made.status, 200);
  const name = made.body.file;
  const r = await S.admin.raw(`/api/admin/backups/${encodeURIComponent(name)}/download`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="${name.replace(/\.sqlite$/, '.zip')}"`);
  assert.match(r.headers.get('cache-control'), /no-store/);
  const z = readZip(r.bytes);
  assert.deepEqual(Object.keys(z).sort(), ['INFO.txt', 'helfi.sqlite']);
  assert.ok(!Object.keys(z).some((n) => /secret/i.test(n)), 'never the key');
  const original = fs.readFileSync(path.join(paths.backups, name));
  assert.ok(z['helfi.sqlite'].equals(original), 'identical to the backup on the host');
  assert.ok(r.bytes.length < original.length, 'packed');
  const key = fs.existsSync(paths.secretKey) ? fs.readFileSync(paths.secretKey) : null;
  if (key) assert.equal(r.bytes.indexOf(key), -1, 'key bytes nowhere in the download');
  const info = z['INFO.txt'].toString('utf8');
  assert.match(info, /secret\.key/);
  assert.match(info, /Wiederherstellen/);
  assert.match(info, /Restore/);
  assert.ok(info.includes(name));
  // The database inside is usable
  const tmp = path.join(os.tmpdir(), `helfi-restore-${process.pid}.sqlite`);
  fs.writeFileSync(tmp, z['helfi.sqlite']);
  try {
    const d = new Database(tmp, { readonly: true });
    assert.equal(d.pragma('integrity_check', { simple: true }), 'ok');
    assert.ok(d.prepare("SELECT value FROM settings WHERE key = 'test.marker'").get());
    d.close();
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('Download: admins only, only files from the backup folder', async () => {
  const name = (await S.admin('GET', '/api/admin/system')).body.backups[0].name;
  const agent = await S.user('agent1', 'agent');
  let r = await agent.raw(`/api/admin/backups/${name}/download`);
  assert.equal(r.status, 403);
  r = await S.client().raw(`/api/admin/backups/${name}/download`);
  assert.equal(r.status, 401);
  fs.writeFileSync(path.join(paths.backups, '..', 'helfi-geheim.sqlite'), 'x');
  for (const bad of ['..%2Fhelfi-geheim.sqlite', '%2E%2E%2Fhelfi-geheim.sqlite', 'helfi.db', 'fremd.sqlite', '..%2Fsecret.key', 'helfi-manuell-gibts-nicht.sqlite']) {
    r = await S.admin.raw(`/api/admin/backups/${bad}/download`);
    assert.equal(r.status, 404, bad);
    assert.notEqual(r.headers.get('content-type'), 'application/zip');
  }
});
