// Minimal ZIP reader on Node's own zlib – no extra dependency. Reads the central directory of a file on
// disk and opens single entries (stored or deflated, ZIP64 sizes and offsets). Used for imports of
// exported archives (e.g. a Confluence space export). Entries are read one at a time with a size limit,
// so a "zip bomb" cannot fill the memory: inflating stops as soon as the limit is passed.
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const EOCD64_LOC = 0x07064b50;
const EOCD64 = 0x06064b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
export const MAX_ENTRIES = 200000;

export class ZipError extends Error {}

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

/** Name of an entry: never absolute, never outside ("../"), forward slashes */
export function safeName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').some((p) => p === '..')) return null;
  return n;
}

/**
 * Open a ZIP file. Returns { entries: Map<name, entry>, read(name, maxBytes) → Buffer, close() }.
 * Entry: { name, size, csize, method, offset, dir }.
 */
export function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // End of central directory: in the last 64 KiB + 22 bytes (comment up to 65535 bytes)
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { e = i; break; }
    if (e < 0) throw new ZipError('Keine ZIP-Datei (Verzeichnis am Ende fehlt).');
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOffset = tail.readUInt32LE(e + 16);
    // ZIP64: the real values are in the ZIP64 end record
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locPos = size - tailLen + e - 20;
      const loc = locPos >= 0 ? readAt(fd, locPos, 20) : Buffer.alloc(0);
      if (loc.length === 20 && loc.readUInt32LE(0) === EOCD64_LOC) {
        const rec = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
        if (rec.readUInt32LE(0) !== EOCD64) throw new ZipError('ZIP64-Verzeichnis beschädigt.');
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }
    if (count > MAX_ENTRIES) throw new ZipError(`Zu viele Einträge im Archiv (${count}).`);
    if (cdOffset + cdSize > size) throw new ZipError('ZIP-Verzeichnis beschädigt.');
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN) throw new ZipError('ZIP-Verzeichnis beschädigt.');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const rawName = cd.subarray(p + 46, p + 46 + nlen);
      // bit 11: UTF-8 names; otherwise CP437 – latin1 is close enough for file names here
      const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1'));
      // ZIP64 extra field: the values that are 0xffffffff above, in this order
      let x = p + 46 + nlen; const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = cd.readUInt16LE(x); const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      p += 46 + nlen + xlen + clen;
      const n = safeName(name);
      if (!n) continue; // never outside the archive
      entries.set(n, { name: n, size: usize, csize, method, offset, flags, dir: n.endsWith('/') });
    }
    let closed = false;
    return {
      entries,
      /** Content of one entry; throws ZipError when it is larger than maxBytes (also while inflating) */
      read(name, maxBytes = 64 * 1024 * 1024) {
        if (closed) throw new ZipError('Archiv geschlossen.');
        const en = entries.get(name);
        if (!en || en.dir) return null;
        if (en.flags & 0x1) throw new ZipError(`„${name}“ ist verschlüsselt.`);
        if (en.size > maxBytes) throw new ZipError(`„${name}“ ist zu groß.`);
        const lh = readAt(fd, en.offset, 30);
        if (lh.length < 30 || lh.readUInt32LE(0) !== LOC) throw new ZipError(`Eintrag „${name}“ beschädigt.`);
        const start = en.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const data = readAt(fd, start, en.csize);
        if (en.method === 0) return data.subarray(0, Math.min(data.length, maxBytes));
        if (en.method !== 8) throw new ZipError(`„${name}“: Packverfahren ${en.method} wird nicht unterstützt.`);
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) });
        } catch (e) {
          if (e.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength/i.test(e.message)) throw new ZipError(`„${name}“ ist zu groß.`);
          throw new ZipError(`„${name}“ lässt sich nicht entpacken: ${e.message}`);
        }
      },
      close() { if (!closed) { closed = true; fs.closeSync(fd); } },
    };
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    throw e;
  }
}
