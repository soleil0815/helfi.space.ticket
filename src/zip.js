/**
 * Minimal streaming ZIP writer (deflate, no ZIP64) based on Node's own zlib – no extra dependency.
 * Entries are either in-memory buffers ({ name, data }) or files read as a stream ({ name, file },
 * with gunzip: true for a gzip-packed file whose unpacked content goes into the archive).
 * Sizes and checksums of file entries follow in a data descriptor (general purpose bit 3),
 * so even large files never have to be held in memory.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';

/** ZIP without ZIP64 stores sizes and offsets in 32 bits; stay clearly below that. */
export const ZIP_MAX_BYTES = 0xFFFFFFFF - 64 * 1024 * 1024;

// zlib.crc32 exists from Node 22.2; small table-based fallback for older 22.x
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32Fallback(buf, prev = 0) {
  let c = (prev ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : crc32Fallback;

const FLAGS = 0x0808; // bit 3: data descriptor, bit 11: names are UTF-8
const METHOD_DEFLATE = 8;

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function localHeader(name, dt) {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(METHOD_DEFLATE, 8);
  b.writeUInt16LE(dt.time, 10);
  b.writeUInt16LE(dt.date, 12);
  // crc32, sizes: 0 here, they follow in the data descriptor
  b.writeUInt16LE(name.length, 26);
  return Buffer.concat([b, name]);
}

function descriptor(e) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(e.crc >>> 0, 4);
  b.writeUInt32LE(e.csize, 8);
  b.writeUInt32LE(e.size, 12);
  return b;
}

function centralEntry(e) {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(0x0314, 4); // made by: Unix, spec 2.0
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(METHOD_DEFLATE, 10);
  b.writeUInt16LE(e.dt.time, 12);
  b.writeUInt16LE(e.dt.date, 14);
  b.writeUInt32LE(e.crc >>> 0, 16);
  b.writeUInt32LE(e.csize, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(e.name.length, 28);
  b.writeUInt32LE((0o100600 << 16) >>> 0, 38); // regular file, readable by the owner only
  b.writeUInt32LE(e.offset, 42);
  return Buffer.concat([b, e.name]);
}

function endRecord(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12);
  b.writeUInt32LE(cdOffset, 16);
  return b;
}

/** Async generator producing the ZIP bytes. */
export async function* zipStream(entries, { level = 6 } = {}) {
  const done = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), 'utf8');
    const dt = dosDateTime(entry.mtime || new Date());
    const e = { name, dt, offset, crc: 0, size: 0, csize: 0 };
    const head = localHeader(name, dt);
    yield head;
    offset += head.length;
    const deflate = zlib.createDeflateRaw({ level });
    if (entry.file) {
      // gunzip: the file is stored packed (e.g. a backup .sqlite.gz) – the entry holds the unpacked content
      const read = fs.createReadStream(entry.file);
      const src = entry.gunzip ? zlib.createGunzip() : read;
      src.on('data', (chunk) => { e.crc = crc32(chunk, e.crc); e.size += chunk.length; });
      // An error while reading/unpacking destroys the deflate stream, so the loop below throws
      if (entry.gunzip) pipeline(read, src, deflate, () => {});
      else pipeline(src, deflate, () => {});
    } else {
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
      e.crc = crc32(data);
      e.size = data.length;
      deflate.end(data);
    }
    for await (const chunk of deflate) {
      e.csize += chunk.length;
      yield chunk;
    }
    if (e.size > ZIP_MAX_BYTES || e.csize > ZIP_MAX_BYTES) throw new Error('ZIP entry too large');
    offset += e.csize;
    const desc = descriptor(e);
    yield desc;
    offset += desc.length;
    if (offset > ZIP_MAX_BYTES) throw new Error('ZIP too large');
    done.push(e);
  }
  const cd = Buffer.concat(done.map(centralEntry));
  yield cd;
  yield endRecord(done.length, cd.length, offset);
}
