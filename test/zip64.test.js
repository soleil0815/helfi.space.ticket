// ZIP64 in the streaming ZIP writer: backups over 4 GB can be downloaded. The 32-bit boundary is
// lowered in most tests so ZIP64 is exercised with small data; archives are checked with Python's
// zipfile (and unzip -t when available).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipStream } from '../src/zip.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-zip64-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

async function write(entries, opts) {
  const chunks = [];
  for await (const c of zipStream(entries, opts)) chunks.push(c);
  const file = path.join(tmp, `${crypto.randomBytes(6).toString('hex')}.zip`);
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

const PY = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename: [i.file_size, i.compress_size, i.header_offset, z.read(i).hex()[:64]] for i in z.infolist()}))
`;
const py = (file) => JSON.parse(execFileSync('python3', ['-I', '-c', PY, file]).toString());
const hasUnzip = (() => { try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const unzipT = (file) => { if (hasUnzip) execFileSync('unzip', ['-tq', file], { stdio: 'pipe' }); };

const big = crypto.randomBytes(300 * 1024); // incompressible: compressed size ≥ the 256 KB boundary

test('ZIP64: an entry over the 32-bit boundary gets ZIP64 headers and is readable', async () => {
  const f = path.join(tmp, 'big.bin'); fs.writeFileSync(f, big);
  const file = await write([{ name: 'helfi.sqlite', file: f }, { name: 'INFO.txt', data: 'Hallo' }], { limit: 256 * 1024 });
  const z = py(file);
  assert.equal(z['helfi.sqlite'][0], big.length);
  assert.equal(z['helfi.sqlite'][3], big.subarray(0, 32).toString('hex'));
  assert.ok(z['INFO.txt'][2] >= 256 * 1024, 'offset of the second entry is past the boundary (ZIP64 offset)');
  assert.equal(z['INFO.txt'][3], Buffer.from('Hallo').toString('hex'));
  const buf = fs.readFileSync(file);
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'ZIP64 end of central directory record');
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), 'ZIP64 locator');
  unzipT(file);
});

test('ZIP64: a central directory past the 32-bit boundary still lists every entry', async () => {
  const entries = Array.from({ length: 70 }, (_, i) => ({ name: `f${i}.txt`, data: `n${i}` }));
  // With a tiny boundary the later offsets and the central directory offset overflow
  const file = await write(entries, { limit: 1024 });
  const z = py(file);
  assert.equal(Object.keys(z).length, 70);
  assert.equal(z['f69.txt'][3], Buffer.from('n69').toString('hex'));
  assert.ok(fs.readFileSync(file).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'ZIP64 end of central directory record');
  unzipT(file);
});

test('ZIP64: a gunzip entry (unpacked size unknown) is always written as ZIP64 and readable', async () => {
  const zlib = await import('node:zlib');
  const gz = path.join(tmp, 'x.sqlite.gz'); fs.writeFileSync(gz, zlib.gzipSync(big));
  const file = await write([{ name: 'helfi.sqlite', file: gz, gunzip: true }]);
  assert.equal(py(file)['helfi.sqlite'][0], big.length);
  assert.equal(fs.readFileSync(file).readUInt16LE(4), 45, 'local header announces ZIP64');
  unzipT(file);
});

test('Small archives keep the plain format (no ZIP64 records)', async () => {
  const f = path.join(tmp, 'small.bin'); fs.writeFileSync(f, big);
  const file = await write([{ name: 'helfi.sqlite', file: f }, { name: 'INFO.txt', data: 'Hallo' }]);
  const buf = fs.readFileSync(file);
  assert.ok(!buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'no ZIP64 end record');
  assert.equal(buf.readUInt16LE(4), 20, 'version needed 2.0');
  assert.equal(buf.readUInt16LE(28), 0, 'no extra field in the local header');
  assert.equal(py(file)['helfi.sqlite'][0], big.length);
  unzipT(file);
});
