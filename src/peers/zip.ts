/**
 * A zip archive, read and written.
 *
 * The engine travels as a zip: the one who makes an organisation packs a
 * build for each system, and the one who joins takes the build for theirs
 * out of it (./install.ts, ./host.ts). Both ends are this file, so that no
 * machine needs a zip program of its own for it. A Mac has `unzip`, a
 * Windows machine has not, and a fresh Linux has neither.
 *
 * Only what those archives are: files, stored or deflated, each smaller
 * than four gigabytes. An archive that is anything else is refused.
 *
 * What is read here came over a line and is not trusted: every length is
 * checked against the bytes that are there before it is used, a file is
 * unpacked only up to the size the caller allows, and what comes out is
 * compared with the size and the checksum the archive gave for it.
 */
import { promisify } from 'node:util';
import { deflateRaw, inflateRaw } from 'node:zlib';

const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);

export class ZipBad extends Error {
  constructor(message: string) { super(message); this.name = 'ZipBad'; }
}

export interface ZipEntry {
  name: string;
  /** 0 is stored as it is, 8 is deflated. */
  method: number;
  packed: number;
  size: number;
  crc: number;
  /** Where its own header begins. */
  offset: number;
  /** The file's mode on a Unix system, when the archive says. */
  mode: number | null;
}

const END = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
/** The most entries an archive may list. A build has a few dozen. */
export const ZIP_ENTRIES_MAX = 4096;

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The files an archive lists. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const data = view(bytes);
  // The list's own end is the last thing in the file, before a comment of at most 65,535 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
    if (data.getUint32(at, true) === END) { end = at; break; }
  }
  if (end < 0) throw new ZipBad('not a zip archive');
  const count = data.getUint16(end + 10, true);
  const size = data.getUint32(end + 12, true);
  const start = data.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipBad('an archive of the large kind');
  if (count > ZIP_ENTRIES_MAX) throw new ZipBad('too many files');
  if (start + size > end) throw new ZipBad('its list is not where it says');
  const entries: ZipEntry[] = [];
  const text = new TextDecoder();
  let at = start;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || data.getUint32(at, true) !== CENTRAL) throw new ZipBad('its list is broken');
    const made = data.getUint16(at + 4, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    if (at + 46 + nameLength + extraLength + commentLength > end) throw new ZipBad('its list is broken');
    const packed = data.getUint32(at + 20, true);
    const unpacked = data.getUint32(at + 24, true);
    const offset = data.getUint32(at + 42, true);
    if (packed === 0xffffffff || unpacked === 0xffffffff || offset === 0xffffffff) throw new ZipBad('an archive of the large kind');
    entries.push({
      name: text.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: data.getUint16(at + 10, true),
      packed, size: unpacked, offset,
      crc: data.getUint32(at + 16, true),
      mode: made >> 8 === 3 ? data.getUint32(at + 38, true) >>> 16 : null,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One file out of an archive. Refused when it is larger than `max`, or is not what the archive said it holds. */
export async function zipRead(bytes: Uint8Array, entry: ZipEntry, max: number): Promise<Uint8Array> {
  if (entry.size > max) throw new ZipBad('larger than is taken');
  const data = view(bytes);
  if (entry.offset + 30 > bytes.length || data.getUint32(entry.offset, true) !== LOCAL) throw new ZipBad('a file is not where the list says');
  const from = entry.offset + 30 + data.getUint16(entry.offset + 26, true) + data.getUint16(entry.offset + 28, true);
  if (from + entry.packed > bytes.length) throw new ZipBad('a file is cut short');
  const packed = bytes.subarray(from, from + entry.packed);
  let out: Uint8Array;
  if (entry.method === 0) out = packed;
  else if (entry.method === 8) {
    // Stopped at the size the list gave: what unpacks to more than that is not the file that was listed.
    try { out = await inflate(packed, { maxOutputLength: Math.max(entry.size, 1) }); } catch { throw new ZipBad('a file does not unpack'); }
  } else throw new ZipBad('packed in a way that is not read here');
  if (out.length !== entry.size || (Bun.hash.crc32(out) >>> 0) !== entry.crc) throw new ZipBad('a file is not what the list says');
  return out;
}

export interface ZipFile {
  /** With forward strokes, and no stroke at its beginning. */
  name: string;
  bytes: Uint8Array;
  /** The file's mode. 0o755 for a program, 0o644 otherwise. */
  mode?: number;
}

/** An archive of these files. */
export async function zipWrite(files: ZipFile[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const list: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let at = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const deflated = file.bytes.length ? await deflate(file.bytes) : file.bytes;
    const stored = deflated.length >= file.bytes.length;
    const body = stored ? file.bytes : deflated;
    if (file.bytes.length >= 0xffffffff || at + body.length >= 0xffffffff) throw new ZipBad('too large for an archive of this kind');
    const crc = Bun.hash.crc32(file.bytes) >>> 0;
    const local = new Uint8Array(30 + name.length);
    const head = view(local);
    head.setUint32(0, LOCAL, true);
    head.setUint16(4, 20, true);
    // The name is UTF-8.
    head.setUint16(6, 0x0800, true);
    head.setUint16(8, stored ? 0 : 8, true);
    // No time of its own: 1 January 1980, so that the same files make the same archive.
    head.setUint16(10, 0, true);
    head.setUint16(12, 0x0021, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, body.length, true);
    head.setUint32(22, file.bytes.length, true);
    head.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const row = view(central);
    row.setUint32(0, CENTRAL, true);
    // Made on a Unix system: that is what makes the mode below mean something to whoever unpacks it.
    row.setUint16(4, (3 << 8) | 20, true);
    row.setUint16(6, 20, true);
    row.setUint16(8, 0x0800, true);
    row.setUint16(10, stored ? 0 : 8, true);
    row.setUint16(12, 0, true);
    row.setUint16(14, 0x0021, true);
    row.setUint32(16, crc, true);
    row.setUint32(20, body.length, true);
    row.setUint32(24, file.bytes.length, true);
    row.setUint16(28, name.length, true);
    row.setUint32(38, ((0o100000 | (file.mode ?? 0o644)) << 16) >>> 0, true);
    row.setUint32(42, at, true);
    central.set(name, 46);
    parts.push(local, body);
    list.push(central);
    at += local.length + body.length;
  }
  const listSize = list.reduce((sum, one) => sum + one.length, 0);
  if (files.length >= 0xffff || at + listSize >= 0xffffffff) throw new ZipBad('too large for an archive of this kind');
  const tail = new Uint8Array(22);
  const end = view(tail);
  end.setUint32(0, END, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, listSize, true);
  end.setUint32(16, at, true);
  const out = new Uint8Array(at + listSize + 22);
  let to = 0;
  for (const piece of [...parts, ...list, tail]) { out.set(piece, to); to += piece.length; }
  return out;
}
