/**
 * PNG fixtures for the screenshot tests (#711): a minimal writer and
 * deterministic noise, so a test can build an over-cap capture without a screen.
 */

import { crc32, deflateSync } from 'node:zlib';

/**
 * A minimal PNG writer for fixtures: every row with the given filter, in one
 * IDAT unless `idatSplit` cuts the stream into IDATs of that many bytes or
 * `idats` gives the IDATs' data outright.
 */
export function encodePng(width: number, height: number, colorType: number, depth: number, rows: Uint8Array[],
  opts: { palette?: number[]; trns?: number[]; filter?: number; interlace?: number; idat?: Uint8Array; idatSplit?: number; idats?: Uint8Array[] } = {}): Buffer {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = opts.interlace ?? 0;
  const filter = opts.filter ?? 0;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([filter]), Buffer.from(r)])));
  // `idat` replaces the image data with already-compressed bytes, so a test
  // can pair any declared geometry with any stream, CRCs still correct.
  const stream = opts.idat ?? deflateSync(raw, { level: 1 });
  let idats: Uint8Array[] = opts.idats ?? [stream];
  if (!opts.idats && opts.idatSplit) {
    idats = [];
    for (let i = 0; i < stream.length; i += opts.idatSplit) idats.push(stream.subarray(i, i + opts.idatSplit));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(opts.palette ? [chunk('PLTE', Uint8Array.from(opts.palette))] : []),
    ...(opts.trns ? [chunk('tRNS', Uint8Array.from(opts.trns))] : []),
    ...idats.map((d) => chunk('IDAT', d)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Deterministic noise: the worst case for every codec, so the sizes below are an upper bound. */
export function noiseRgbRows(width: number, height: number, seed = 1): Uint8Array[] {
  let s = seed >>> 0;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const r = new Uint8Array(width * 3);
    for (let i = 0; i < r.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; r[i] = s >>> 24; }
    rows.push(r);
  }
  return rows;
}

/**
 * A zlib stream of `bytes` zeros: about 1000:1, so 256 MiB is ~260 KB. Built
 * once per size and process (deflating 256 MiB took 241 ms here).
 */
const bombs = new Map<number, Buffer>();
export function zeroBomb(bytes: number): Buffer {
  let b = bombs.get(bytes);
  if (!b) {
    b = deflateSync(Buffer.alloc(bytes), { level: 9 });
    bombs.set(bytes, b);
  }
  return b;
}

/** Flip one byte of the named chunk's CRC, leaving everything else intact. */
export function corruptCrc(png: Buffer, type: string): Buffer {
  const out = Buffer.from(png);
  let off = 8;
  while (off + 8 <= out.length) {
    const len = out.readUInt32BE(off);
    if (out.toString('ascii', off + 4, off + 8) === type) {
      out[off + 8 + len] = out[off + 8 + len]! ^ 0xff;
      return out;
    }
    off += 12 + len;
  }
  throw new Error(`no ${type} chunk`);
}
