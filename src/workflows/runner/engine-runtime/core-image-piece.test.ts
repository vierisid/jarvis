/**
 * The vendored Image Helper piece as the engine runs it (its compiled `dist/`):
 * Compress works with its own dropdown values, and a crop outside the image
 * fails in plain words. Skips without a compiled piece; CI builds it because
 * its bun test run sets `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';

const pieceDir = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core/image-helper');
const bundle = resolve(pieceDir, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !existsSync(bundle);
const require = createRequire(import.meta.url);

type Run = (context: unknown) => Promise<unknown>;
type Piece = { getAction(name: string): { run: Run } | undefined };
let piece: Piece;
/** A solid-colour PNG, built by hand so the test does not depend on the piece's bundled image library. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe.skipIf(skip)('the compiled core Image Helper piece', () => {
  beforeAll(async () => {
    if (buildOptIn) await buildPiece(pieceDir);
    piece = (require(bundle) as { imageHelper: Piece }).imageHelper;
  });
  const written: Array<{ fileName: string; data: Buffer }> = [];
  const files = { write: async (f: { fileName: string; data: Buffer }) => { written.push(f); return `file://${f.fileName}`; } };
  const compress = async (quality: unknown) => piece.getAction('compress_image')!.run({
    propsValue: { image: { data: png(40, 30), filename: 'in.png', extension: 'png' }, quality, format: 'jpg' }, files });
  const crop = async (area: Record<string, number>) => piece.getAction('crop_image')!.run({
    propsValue: { image: { data: png(40, 30), filename: 'in.png', extension: 'png' }, ...area }, files });

  test.each(['60', '90', 60, 90])('compress accepts the dropdown value %p', async (quality) => {
    written.length = 0;
    expect(await compress(quality)).toBe('file://image.jpg');
    expect(written).toHaveLength(1);
    expect(written[0]!.data.length).toBeGreaterThan(0);
  });

  test.each(['abc', '', undefined, 'NaN', '150', -1])('compress refuses the quality %p in plain words', async (quality) => {
    await expect(compress(quality)).rejects.toThrow('Quality must be a number from 0 to 100');
  });

  test('a crop inside the image works', async () => {
    expect(await crop({ left: 5, top: 5, width: 10, height: 10 })).toBe('file://image.png');
  });

  test.each([
    { left: 0, top: 0, width: 100, height: 10 },
    { left: 35, top: 0, width: 10, height: 10 },
    { left: -1, top: 0, width: 10, height: 10 },
    { left: 0, top: 0, width: 0, height: 10 },
    // A full-width crop takes the library's shortcut, which silently returns a short image.
    { left: 0, top: 25, width: 40, height: 10 },
    // The library rounds 34.5 and 5.5 up to 35 and 6, past the right edge.
    { left: 34.5, top: 0, width: 5.5, height: 10 },
    { left: 0, top: 0, width: 0.4, height: 10 },
  ])('a crop outside the image fails in plain words %p', async (area) => {
    const error = await crop(area).then(() => null, (e: Error) => e);
    expect(error?.message).toContain('The crop area does not fit inside the image. The image is 40 by 30 pixels');
    expect(error).not.toBeInstanceOf(RangeError);
  });
});
