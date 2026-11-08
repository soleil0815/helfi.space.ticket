/**
 * Minimal streaming ZIP writer (deflate, ZIP64 when needed) based on Node's own zlib – no extra dependency.
 * Entries are either in-memory buffers ({ name, data }) or files read as a stream ({ name, file },
 * with gunzip: true for a gzip-packed file whose unpacked content goes into the archive).
 * Sizes and checksums of file entries follow in a data descriptor (general purpose bit 3),
 * so even large files never have to be held in memory.
 *
 * ZIP64: whether an entry needs it is decided before its local header is written – from the file
 * size (stat) for a plain file, always for a gunzip entry (unpacked size unknown). Such an entry has
 * 0xFFFFFFFF in the local header, a ZIP64 extra field and a 64-bit data descriptor. Offsets and the
 * central directory get ZIP64 fields only where they overflow, so small archives keep the plain format.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';

/** 32-bit fields of a plain ZIP: 0xFFFFFFFF itself already means "see the ZIP64 record". */
export const ZIP32_LIMIT = 0xFFFFFFFF;
const U16 = 0xFFFF;

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
const ZIP64_EXTRA = 0x0001;

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Write a 64-bit unsigned size/offset (safe integer) */
function u64(b, v, at) { b.writeBigUInt64LE(BigInt(v), at); }

/** Extra field 0x0001 with the given 64-bit values (in spec order: size, csize, offset) */
function zip64Extra(values) {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(ZIP64_EXTRA, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => u64(b, v, 4 + 8 * i));
  return b;
}

function localHeader(name, dt, zip64) {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(zip64 ? 45 : 20, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(METHOD_DEFLATE, 8);
  b.writeUInt16LE(dt.time, 10);
  b.writeUInt16LE(dt.date, 12);
  // crc32, sizes: 0 here, they follow in the data descriptor (ZIP64: 0xFFFFFFFF + zero extra field)
  if (zip64) { b.writeUInt32LE(ZIP32_LIMIT, 18); b.writeUInt32LE(ZIP32_LIMIT, 22); }
  b.writeUInt16LE(name.length, 26);
  const extra = zip64 ? zip64Extra([0, 0]) : Buffer.alloc(0);
  b.writeUInt16LE(extra.length, 28);
  return Buffer.concat([b, name, extra]);
}

function descriptor(e) {
  if (e.zip64) {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(0x08074b50, 0);
    b.writeUInt32LE(e.crc >>> 0, 4);
    u64(b, e.csize, 8);
    u64(b, e.size, 16);
    return b;
  }
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(e.crc >>> 0, 4);
  b.writeUInt32LE(e.csize, 8);
  b.writeUInt32LE(e.size, 12);
  return b;
}

function centralEntry(e, limit) {
  // A ZIP64 entry always carries both sizes in the extra field (its local header announced them);
  // the offset only when it overflows
  const sizes64 = e.zip64 || e.size >= limit || e.csize >= limit;
  const offset64 = e.offset >= limit;
  const values = [...(sizes64 ? [e.size, e.csize] : []), ...(offset64 ? [e.offset] : [])];
  const extra = values.length ? zip64Extra(values) : Buffer.alloc(0);
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(values.length ? 0x032d : 0x0314, 4); // made by: Unix, spec 4.5 / 2.0
  b.writeUInt16LE(values.length ? 45 : 20, 6);
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(METHOD_DEFLATE, 10);
  b.writeUInt16LE(e.dt.time, 12);
  b.writeUInt16LE(e.dt.date, 14);
  b.writeUInt32LE(e.crc >>> 0, 16);
  b.writeUInt32LE(sizes64 ? ZIP32_LIMIT : e.csize, 20);
  b.writeUInt32LE(sizes64 ? ZIP32_LIMIT : e.size, 24);
  b.writeUInt16LE(e.name.length, 28);
  b.writeUInt16LE(extra.length, 30);
  b.writeUInt32LE((0o100600 << 16) >>> 0, 38); // regular file, readable by the owner only
  b.writeUInt32LE(offset64 ? ZIP32_LIMIT : e.offset, 42);
  return Buffer.concat([b, e.name, extra]);
}

function endRecords(count, cdSize, cdOffset, limit) {
  const out = [];
  const need64 = count >= U16 || cdSize >= limit || cdOffset >= limit;
  if (need64) {
    const z = Buffer.alloc(56); // ZIP64 end of central directory record
    z.writeUInt32LE(0x06064b50, 0);
    u64(z, 44, 4); // size of the rest of this record
    z.writeUInt16LE(0x032d, 12);
    z.writeUInt16LE(45, 14);
    u64(z, count, 24);
    u64(z, count, 32);
    u64(z, cdSize, 40);
    u64(z, cdOffset, 48);
    const loc = Buffer.alloc(20); // ZIP64 end of central directory locator
    loc.writeUInt32LE(0x07064b50, 0);
    u64(loc, cdOffset + cdSize, 8);
    loc.writeUInt32LE(1, 16); // total number of disks
    out.push(z, loc);
  }
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(need64 ? U16 : count, 8);
  b.writeUInt16LE(need64 ? U16 : count, 10);
  b.writeUInt32LE(need64 ? ZIP32_LIMIT : cdSize, 12);
  b.writeUInt32LE(need64 ? ZIP32_LIMIT : cdOffset, 16);
  out.push(b);
  return out;
}

/** Deflate output can be a little larger than its input (incompressible data): leave room for that */
const withOverhead = (n) => n + Math.ceil(n / 16384) * 5 + 1024;

/**
 * Async generator producing the ZIP bytes.
 * limit: the 32-bit boundary (only lowered by tests, to exercise ZIP64 with small data).
 */
export async function* zipStream(entries, { level = 6, limit = ZIP32_LIMIT } = {}) {
  const done = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), 'utf8');
    const dt = dosDateTime(entry.mtime || new Date());
    const data = entry.file ? null : (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8'));
    // Decide ZIP64 before the local header (throws ENOENT for a missing file – no broken archive)
    const known = entry.file ? (entry.gunzip ? null : fs.statSync(entry.file).size) : data.length;
    const zip64 = known === null || withOverhead(known) >= limit;
    const e = { name, dt, offset, crc: 0, size: 0, csize: 0, zip64 };
    const head = localHeader(name, dt, zip64);
    yield head;
    offset += head.length;
    const deflate = zlib.createDeflateRaw({ level });
    if (entry.file) {
      // gunzip: the file is stored packed (e.g. a backup .sqlite.gz) – the entry holds the unpacked content
      const read = fs.createReadStream(entry.file);
      const src = entry.gunzip ? zlib.createGunzip() : read;
      src.on('data', (chunk) => {
        e.crc = crc32(chunk, e.crc); e.size += chunk.length;
        // File grew beyond what its plain header can describe (stat was smaller): stop at once
        if (!zip64 && e.size >= limit) deflate.destroy(new Error('ZIP entry too large'));
      });
      // An error while reading/unpacking destroys the deflate stream, so the loop below throws
      if (entry.gunzip) pipeline(read, src, deflate, () => {});
      else pipeline(src, deflate, () => {});
    } else {
      e.crc = crc32(data);
      e.size = data.length;
      deflate.end(data);
    }
    for await (const chunk of deflate) {
      e.csize += chunk.length;
      if (!zip64 && e.csize >= limit) throw new Error('ZIP entry too large');
      yield chunk;
    }
    if (!zip64 && (e.size >= limit || e.csize >= limit)) throw new Error('ZIP entry too large');
    offset += e.csize;
    const desc = descriptor(e);
    yield desc;
    offset += desc.length;
    done.push(e);
  }
  const cd = Buffer.concat(done.map((e) => centralEntry(e, limit)));
  yield cd;
  for (const b of endRecords(done.length, cd.length, offset, limit)) yield b;
}
