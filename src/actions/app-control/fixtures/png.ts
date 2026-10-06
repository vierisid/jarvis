/**
 * PNG fixtures for the screenshot tests (#711): a minimal writer and
 * deterministic noise, so a test can build an over-cap capture without a screen.
 */

import { crc32, deflateSync } from 'node:zlib';

/** A minimal PNG writer for fixtures: one IDAT, every row with the given filter. */
export function encodePng(width: number, height: number, colorType: number, depth: number, rows: Uint8Array[],
  opts: { palette?: number[]; trns?: number[]; filter?: number } = {}): Buffer {
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
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const filter = opts.filter ?? 0;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([filter]), Buffer.from(r)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(opts.palette ? [chunk('PLTE', Uint8Array.from(opts.palette))] : []),
    ...(opts.trns ? [chunk('tRNS', Uint8Array.from(opts.trns))] : []),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
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
