import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInflate, deflateSync } from 'node:zlib';
import { decodePng, decodeShrunkPng, downscaleToWidth, encodeJpeg, MAX_DECODE_BYTES, MAX_DECODE_PIXELS, MAX_IMAGE_SIDE, scaledQuantTable, screenshotCaption, screenshotForModel, SCREENSHOT_COMPACT, resetStreamingInflateCheck, streamingInflateWorks, tooBigToSend } from './image-compact.ts';
import { corruptCrc, encodePng, noiseRgbRows, zeroBomb } from './fixtures/png.ts';

describe('decodePng', () => {
  test('reads every colour type the capture tools write, to RGBA', () => {
    // 2x1 images, one per colour type, with known pixels.
    const rgb = decodePng(encodePng(2, 1, 2, 8, [Uint8Array.from([10, 20, 30, 40, 50, 60])]));
    expect([...rgb.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    const rgba = decodePng(encodePng(2, 1, 6, 8, [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])]));
    expect([...rgba.rgba]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const grey = decodePng(encodePng(2, 1, 0, 8, [Uint8Array.from([0, 200])]));
    expect([...grey.rgba]).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);
    const greyA = decodePng(encodePng(2, 1, 4, 8, [Uint8Array.from([9, 100, 7, 50])]));
    expect([...greyA.rgba]).toEqual([9, 9, 9, 100, 7, 7, 7, 50]);
    const pal = decodePng(encodePng(2, 1, 3, 8, [Uint8Array.from([1, 0])], { palette: [1, 2, 3, 4, 5, 6], trns: [128] }));
    expect([...pal.rgba]).toEqual([4, 5, 6, 255, 1, 2, 3, 128]);
    // 16-bit samples keep their high byte.
    const deep = decodePng(encodePng(1, 1, 2, 16, [Uint8Array.from([0xab, 0xcd, 0x12, 0x34, 0xfe, 0xdc])]));
    expect([...deep.rgba]).toEqual([0xab, 0x12, 0xfe, 255]);
    // 1-bit grey scales to 0/255.
    const bit = decodePng(encodePng(3, 1, 0, 1, [Uint8Array.from([0b10100000])]));
    expect([...bit.rgba]).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  });

  test('undoes all five row filters', () => {
    // The same 3x3 RGB image, filtered five ways by hand, must decode identically.
    const pixels = [
      Uint8Array.from([10, 20, 30, 200, 100, 50, 0, 255, 128]),
      Uint8Array.from([11, 22, 33, 199, 99, 49, 1, 254, 127]),
      Uint8Array.from([250, 5, 60, 70, 80, 90, 3, 3, 3]),
    ];
    const bpp = 3;
    const filtered = (type: number) => pixels.map((row, y) => row.map((x, i) => {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = y > 0 ? pixels[y - 1]![i]! : 0;
      const c = y > 0 && i >= bpp ? pixels[y - 1]![i - bpp]! : 0;
      const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : (() => {
        const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      })();
      return (x - pred) & 0xff;
    }));
    const want = [...decodePng(encodePng(3, 3, 2, 8, pixels)).rgba];
    for (const f of [1, 2, 3, 4]) expect([...decodePng(encodePng(3, 3, 2, 8, filtered(f), { filter: f })).rgba]).toEqual(want);
  });

  test('reads sub-byte palettes and 16-bit grey', () => {
    const pal = [0, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    // 2-bit: indices 3,2,1,0 in one byte.
    expect([...decodePng(encodePng(4, 1, 3, 2, [Uint8Array.from([0b11100100])], { palette: pal })).rgba])
      .toEqual([70, 80, 90, 255, 40, 50, 60, 255, 10, 20, 30, 255, 0, 0, 0, 255]);
    // 4-bit: indices 2 then 1; a 4-bit grey 0xf3 reads as 255 then 51.
    expect([...decodePng(encodePng(2, 1, 3, 4, [Uint8Array.from([0x21])], { palette: pal })).rgba])
      .toEqual([40, 50, 60, 255, 10, 20, 30, 255]);
    expect([...decodePng(encodePng(2, 1, 0, 4, [Uint8Array.from([0xf3])])).rgba]).toEqual([255, 255, 255, 255, 51, 51, 51, 255]);
    // 16-bit grey and grey+alpha keep the high bytes.
    expect([...decodePng(encodePng(1, 1, 0, 16, [Uint8Array.from([0x9a, 0x01])])).rgba]).toEqual([0x9a, 0x9a, 0x9a, 255]);
    expect([...decodePng(encodePng(1, 1, 4, 16, [Uint8Array.from([0x10, 0xff, 0x80, 0x00])])).rgba]).toEqual([0x10, 0x10, 0x10, 0x80]);
  });

  test('undoes filters at one byte per pixel and at six', () => {
    // Sub (1) on 8-bit grey (bpp 1) and Paeth (4) on 16-bit RGB (bpp 6).
    const grey = [Uint8Array.from([5, 10, 250])];
    const greySub = [Uint8Array.from([5, 5, 240])];
    expect([...decodePng(encodePng(3, 1, 0, 8, greySub, { filter: 1 })).rgba]).toEqual([...decodePng(encodePng(3, 1, 0, 8, grey)).rgba]);
    const deep = [Uint8Array.from([1, 0, 2, 0, 3, 0, 9, 0, 8, 0, 7, 0]), Uint8Array.from([4, 0, 5, 0, 6, 0, 2, 0, 2, 0, 2, 0])];
    // Paeth on row 0 is Sub; on row 1 the predictor of each byte is worked out below.
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const filtered = deep.map((row, y) => row.map((x, i) => (x - paeth(i >= 6 ? row[i - 6]! : 0, y > 0 ? deep[y - 1]![i]! : 0,
      y > 0 && i >= 6 ? deep[y - 1]![i - 6]! : 0)) & 0xff));
    expect([...decodePng(encodePng(2, 2, 2, 16, filtered, { filter: 4 })).rgba]).toEqual([...decodePng(encodePng(2, 2, 2, 16, deep)).rgba]);
  });

  test('refuses what it does not read rather than guessing', () => {
    expect(() => decodePng(Buffer.from('GIF89a'))).toThrow('not a PNG');
    const interlaced = encodePng(1, 1, 2, 8, [Uint8Array.from([1, 2, 3])], { interlace: 1 });
    expect(() => decodePng(interlaced)).toThrow('interlaced');
    const ok = encodePng(1, 1, 2, 8, [Uint8Array.from([1, 2, 3])]);
    expect(() => decodePng(ok.subarray(0, ok.length - 20))).toThrow('truncated');
    // No IHDR at all: the signature followed straight by IEND.
    expect(() => decodePng(Buffer.concat([ok.subarray(0, 8), ok.subarray(ok.length - 12)]))).toThrow('no usable header');
    expect(() => decodePng(encodePng(1, 1, 3, 8, [Uint8Array.from([0])]))).toThrow('no palette');
    expect(() => decodePng(encodePng(1, 1, 2, 8, [Uint8Array.from([1, 2, 3])], { filter: 9 }))).toThrow('unknown PNG filter 9');
  });

  // A zlib stream of 256 MiB of zeros in ~260 KB: inflating it would allocate
  // the lot. Each refusal below must happen before that, and the message
  // proves it -- had the inflate run, it would have ended in a different error
  // (the stream is far shorter than these headers declare).
  const BOMB = 256 * 1024 * 1024;

  test('a header claiming more pixels than any screen is refused before anything is inflated', () => {
    // 12000x12000 is what took 14.5 s and 2.3 GB when only the header bounded it.
    expect(12000 * 12000).toBeGreaterThan(MAX_DECODE_PIXELS);
    const lying = encodePng(12000, 12000, 2, 8, [], { idat: zeroBomb(BOMB) });
    const started = performance.now();
    expect(() => decodePng(lying)).toThrow('larger than any screen');
    // Inflating the bomb alone measured 182 ms here.
    expect(performance.now() - started).toBeLessThan(50);
    // 8-bit grey is one byte a pixel: 9000x9000 is 81 MB of rows, inside the
    // byte cap, but 81 MP, so the pixel cap (the RGBA buffer would be 324 MB)
    // is the one that refuses it.
    expect(9000 * 9000).toBeGreaterThan(MAX_DECODE_PIXELS);
    expect(9000 * 9000).toBeLessThanOrEqual(MAX_DECODE_BYTES);
    expect(() => decodePng(encodePng(9000, 9000, 0, 8, [], { idat: zeroBomb(BOMB) }))).toThrow('larger than any screen');
  });

  test('a 16-bit header within the pixel cap but over the byte cap is refused before anything is inflated (IMG-001)', () => {
    // 8000x8000 is exactly the pixel cap, but at 8 bytes a pixel its rows are
    // 512 MB: the 3.9 s / 1.25 GB case the pixel cap let through.
    expect(8000 * 8000).toBeLessThanOrEqual(MAX_DECODE_PIXELS);
    expect(8000 * 8 * 8000).toBeGreaterThan(MAX_DECODE_BYTES);
    const deep = encodePng(8000, 8000, 6, 16, [], { idat: zeroBomb(BOMB) });
    const started = performance.now();
    expect(() => decodePng(deep)).toThrow('larger than any screen');
    expect(performance.now() - started).toBeLessThan(50);
    // The same geometry at 8 bits is within both caps: the cap is on bytes, not a ban on size.
    expect(8000 * 4 * 8000).toBeLessThanOrEqual(MAX_DECODE_BYTES);
  });

  test('image data that inflates past what the header declares is refused, not allocated (zip bomb)', () => {
    // 100x100 RGB declares 30 100 bytes of rows; the stream holds 256 MiB.
    const bomb = encodePng(100, 100, 2, 8, [], { idat: zeroBomb(BOMB) });
    expect(() => decodePng(bomb)).toThrow('PNG image data is longer than its header says');
  });

  test('a chunk whose CRC does not match is refused, not read (IMG-002)', () => {
    const ok = encodePng(2, 1, 3, 8, [Uint8Array.from([1, 0])], { palette: [1, 2, 3, 4, 5, 6], trns: [128] });
    expect(() => decodePng(ok)).not.toThrow();
    for (const type of ['IHDR', 'PLTE', 'tRNS', 'IDAT']) {
      expect(() => decodePng(corruptCrc(ok, type))).toThrow(`PNG chunk ${type} is corrupt (CRC mismatch)`);
    }
  });

  test('a palette index past the palette, or a malformed palette, is refused rather than drawn black (IMG-003)', () => {
    // Two entries, pixel index 200.
    expect(() => decodePng(encodePng(1, 1, 3, 8, [Uint8Array.from([200])], { palette: [1, 2, 3, 4, 5, 6] })))
      .toThrow('palette index 200 is past the 2-entry palette');
    // A 4-byte PLTE is not whole entries.
    expect(() => decodePng(encodePng(1, 1, 3, 8, [Uint8Array.from([1])], { palette: [1, 2, 3, 4] })))
      .toThrow('PLTE');
    // More than 256 entries.
    expect(() => decodePng(encodePng(1, 1, 3, 8, [Uint8Array.from([0])], { palette: Array.from({ length: 257 * 3 }, () => 0) })))
      .toThrow('PLTE');
  });
});

describe('downscaleToWidth', () => {
  test('averages what each target pixel covers and keeps the sidecar aspect arithmetic', () => {
    // 4x2 -> 2x1: each target pixel is the mean of a 2x2 square.
    const img = { width: 4, height: 2, rgba: Uint8Array.from([
      0, 0, 0, 255, 100, 100, 100, 255, 200, 0, 0, 255, 200, 0, 0, 255,
      100, 100, 100, 255, 200, 200, 200, 255, 0, 0, 200, 255, 0, 0, 200, 255,
    ]) };
    const out = downscaleToWidth(img, 2);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect([...out.rgba]).toEqual([100, 100, 100, 255, 100, 0, 100, 255]);
    // 3840x2160 -> 1600x900, the integer height handlers.go computes.
    expect(Math.floor((2160 * 1600) / 3840)).toBe(900);
    // Narrow enough already: the same object back, never upscaled.
    expect(downscaleToWidth(img, 4)).toBe(img);
  });
});

/** 37x23: seeded noise above (every AC code, runs, 0xFF stuffing), a gradient below, edge MCUs both ways. */
function goldenImage() {
  const W = 37, H = 23;
  const rgba = new Uint8Array(W * H * 4);
  let seed = 7;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (y < 12) for (let c = 0; c < 3; c++) { seed = (seed * 1664525 + 1013904223) >>> 0; rgba[o + c] = seed >>> 24; }
    else { rgba[o] = x * 7; rgba[o + 1] = y * 11; rgba[o + 2] = 255 - x * 6; }
    rgba[o + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

describe('encodeJpeg', () => {
  test('refuses an image whose buffer does not match its size, a non-integer size, or a non-finite quality', () => {
    const px = (w: number, h: number) => new Uint8Array(w * h * 4);
    expect(() => encodeJpeg({ width: 4, height: 4, rgba: px(4, 3) }, 80)).toThrow('RGBA buffer');
    expect(() => encodeJpeg({ width: 2.5, height: 4, rgba: px(2, 4) }, 80)).toThrow('cannot encode');
    for (const q of [NaN, Infinity]) expect(() => encodeJpeg({ width: 2, height: 2, rgba: px(2, 2) }, q)).toThrow('quality');
    expect(() => scaledQuantTable([16], NaN)).toThrow('quality');
  });

  test('is byte-for-byte the output libjpeg was checked against', () => {
    // These bytes were decoded by libjpeg's djpeg to a 37x23 image whose PSNR
    // against the source equals cjpeg's own at the same settings (15.05 dB at
    // q80, 15.29 dB at q100). Any change to the encoder changes the hash, and
    // has to be checked against a real decoder again.
    const sha = (q: number) => createHash('sha256').update(encodeJpeg(goldenImage(), q)).digest('hex');
    expect(sha(80)).toBe('5ef74442e5d2107ea5853eddf405071ed93baad66994c94d3e22ff0c56c21f2d');
    expect(sha(100)).toBe('1d344f3282baf820b4202828e4d7d1a6089fcd7fdb4afbdf232538a65d14138e');
  });

  test('stuffs every 0xFF in the entropy-coded data', () => {
    const jpeg = encodeJpeg(goldenImage(), 100);
    let sos = 2;
    while (!(jpeg[sos] === 0xff && jpeg[sos + 1] === 0xda)) sos += 2 + ((jpeg[sos + 2]! << 8) | jpeg[sos + 3]!);
    const data = jpeg.subarray(sos + 2 + ((jpeg[sos + 2]! << 8) | jpeg[sos + 3]!), jpeg.length - 2);
    let ffs = 0;
    for (let i = 0; i < data.length - 1; i++) if (data[i] === 0xff) { ffs++; expect(data[i + 1]).toBe(0); }
    expect(ffs).toBeGreaterThan(0); // the noise half does produce some
    expect(data[data.length - 1]).not.toBe(0xff);
  });

  test.skipIf(!Bun.which('djpeg'))('decodes with libjpeg to the right size and fidelity', () => {
    const img = goldenImage();
    const out = Bun.spawnSync(['djpeg', '-pnm'], { stdin: encodeJpeg(img, 80) });
    expect(out.exitCode).toBe(0);
    const ppm = out.stdout;
    const head = Buffer.from(ppm.subarray(0, 20)).toString('latin1').match(/^P6\s+(\d+)\s+(\d+)\s+255\s/)!;
    expect([Number(head[1]), Number(head[2])]).toEqual([37, 23]);
    let se = 0;
    for (let i = 0; i < 37 * 23; i++) for (let c = 0; c < 3; c++) { const d = ppm[head[0].length + i * 3 + c]! - img.rgba[i * 4 + c]!; se += d * d; }
    expect(10 * Math.log10((255 * 255) / (se / (37 * 23 * 3)))).toBeCloseTo(15.05, 1);
  });

  test('writes a baseline 4:2:0 JPEG with IJG-scaled tables', () => {
    const jpeg = encodeJpeg({ width: 33, height: 17, rgba: new Uint8Array(33 * 17 * 4).fill(128) }, 80);
    expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
    // Walk the marker segments to SOF0 rather than searching for a byte.
    let sof = 2;
    while (!(jpeg[sof] === 0xff && jpeg[sof + 1] === 0xc0)) sof += 2 + ((jpeg[sof + 2]! << 8) | jpeg[sof + 3]!);
    sof += 1;
    const view = new DataView(jpeg.buffer, jpeg.byteOffset);
    expect(view.getUint16(sof + 4)).toBe(17); // height
    expect(view.getUint16(sof + 6)).toBe(33); // width
    expect(jpeg[sof + 10]).toBe(0x22); // component 1 (Y) sampled 2x2
    // Quality 80 halves the Annex K tables (scale 40%): 16 -> 6, 99 -> 40.
    expect(scaledQuantTable([16, 99], 80)).toEqual([6, 40]);
  });
});

describe('screenshotForModel (#711)', () => {
  test('a capture that fits is sent untouched, at full resolution', () => {
    const png = encodePng(2, 1, 2, 8, [Uint8Array.from([1, 2, 3, 4, 5, 6])]);
    const shot = screenshotForModel(png.toString('base64'), 'image/png');
    expect(shot).toMatchObject({ ok: true, compacted: false, block: { source: { media_type: 'image/png', data: png.toString('base64') } } });
    if (shot.ok) expect(screenshotCaption('Desktop screenshot captured', shot)).toBe('Desktop screenshot captured.');
  });

  test('a capture over the cap is compacted with the shared values instead of becoming a placeholder', () => {
    // 2000x1000 of noise: 6 MB raw, which deflate cannot shrink, so the PNG's
    // base64 is over the 5 MB cap -- measured below rather than assumed.
    const png = encodePng(2000, 1000, 2, 8, noiseRgbRows(2000, 1000));
    const base64 = png.toString('base64');
    const raw = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: base64 } };
    expect(tooBigToSend(raw)).toBe(true);

    const shot = screenshotForModel(base64, 'image/png');
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    expect(shot.compacted).toBe(true);
    expect(shot.block.type === 'image' && shot.block.source.media_type).toBe('image/jpeg');
    expect(tooBigToSend(shot.block)).toBe(false);
    expect([shot.width, shot.height, shot.origWidth, shot.origHeight]).toEqual([SCREENSHOT_COMPACT.maxWidth, 800, 2000, 1000]);
    expect(screenshotCaption('Screenshot captured', shot)).toBe('Screenshot captured (1600x800, downscaled from 2000x1000 to fit).');
  });

  test('a capture still over the cap after compacting is refused, not sent', () => {
    // 1600 wide, so nothing is downscaled: noise at q80 measured 0.67 bytes a
    // pixel, so 1600x4000 (6.4 MP) encodes to about 4.3 MB -- 5.7 MB of base64,
    // over the 5 MiB cap. (1600x3600 measured just under it.)
    const png = encodePng(1600, 4000, 2, 8, noiseRgbRows(1600, 4000, 3));
    expect(screenshotForModel(png.toString('base64'), 'image/png')).toEqual({ ok: false, reason: 'it is too large to send even after compacting it' });
  });

  test('a capture longer than a provider takes on one side is compacted to fit, even under the byte cap', () => {
    // 400x9000 grey is a few KB as PNG, so the 5 MB cap never fires; but no
    // side may exceed MAX_IMAGE_SIDE, or the provider rejects the request
    // after the tool has reported success.
    const rows = Array.from({ length: 9000 }, (_, y) => new Uint8Array(400 * 3).fill(y & 255));
    const png = encodePng(400, 9000, 2, 8, rows);
    expect(png.toString('base64').length).toBeLessThan(5 * 1024 * 1024);
    const shot = screenshotForModel(png.toString('base64'), 'image/png');
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    expect(shot.compacted).toBe(true);
    expect(Math.max(shot.width!, shot.height!)).toBeLessThanOrEqual(MAX_IMAGE_SIDE);
    expect(shot.height).toBe(MAX_IMAGE_SIDE);
  });

  test('what cannot be compacted is said, not sent', () => {
    const big = 'A'.repeat(5 * 1024 * 1024 + 4);
    expect(screenshotForModel(big, 'image/bmp')).toMatchObject({ ok: false, reason: expect.stringContaining('image/bmp') });
    expect(screenshotForModel(big, 'image/png')).toMatchObject({ ok: false, reason: expect.stringContaining('could not be compacted') });
  });
});

// --- #748: decode and shrink row by row, never holding the full-size image ---

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * A w x h PNG of seeded random filtered bytes, each row with filter y % 5, so
 * every filter runs on every depth. Any bytes are valid filtered data; a
 * palette image gets a full 2^depth-entry palette (every index in range) and
 * a partial tRNS (some pixels opaque, some not).
 */
function mixedPng(w: number, h: number, colorType: number, depth: number, seed: number, opts: { idatSplit?: number } = {}): Buffer {
  let s = seed >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s >>> 24; };
  const rowBytes = Math.ceil((w * CHANNELS[colorType]! * depth) / 8);
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (rowBytes + 1)] = y % 5;
    for (let i = 1; i <= rowBytes; i++) raw[y * (rowBytes + 1) + i] = next();
  }
  const entries = 1 << Math.min(depth, 8);
  const palette = colorType === 3 ? Array.from({ length: entries * 3 }, next) : undefined;
  const trns = colorType === 3 ? Array.from({ length: entries >> 1 || 1 }, next) : undefined;
  return encodePng(w, h, colorType, depth, [], { palette, trns, idat: deflateSync(raw), idatSplit: opts.idatSplit });
}

/** Every colour type at every bit depth the spec allows for it. */
const DEPTHS: Array<[number, number]> = [[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]];
/** Shrink targets: a large ratio, nothing to do, the height deciding, a ratio near 1, one column. */
const TARGETS: Array<[number, number]> = [[13, Infinity], [100, Infinity], [50, 7], [66, Infinity], [1, Infinity]];

const digest = (img: { width: number; height: number; rgba: Uint8Array }) =>
  `${img.width}x${img.height}:${createHash('sha256').update(img.rgba).digest('hex')}`;

/**
 * The digest of every DEPTHS x TARGETS case through `shrink`. MATRIX_GOLDEN is
 * what the batch pipeline -- full-size decodePng, then downscaleToWidth --
 * produced at a0b56684, before #748 streamed it; the streamed path has to
 * reproduce it byte for byte.
 */
function matrixDigest(shrink: (png: Uint8Array, mw: number, mh: number) => { width: number; height: number; rgba: Uint8Array }): string {
  const lines: string[] = [];
  for (const [ct, depth] of DEPTHS) {
    const png = mixedPng(67, 29, ct, depth, ct * 31 + depth);
    for (const [mw, mh] of TARGETS) lines.push(`${ct}/${depth}/${mw}x${mh}=${digest(shrink(png, mw, mh))}`);
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
const MATRIX_GOLDEN = '8dfc5a89fe6123f00d58421e58e820765040e75a894d89aa446d16526effe184';

const BOMB_748 = 256 * 1024 * 1024;

describe('streamed decode and shrink (#748)', () => {
  test('produces the same pixels as the batch pipeline did, for every depth, filter and shrink path', () => {
    expect(matrixDigest((png, mw, mh) => decodeShrunkPng(png, mw, mh))).toBe(MATRIX_GOLDEN);
    // And the whole-image decoder and the standalone downscale still agree with it.
    expect(matrixDigest((png, mw, mh) => downscaleToWidth(decodePng(png), mw, mh))).toBe(MATRIX_GOLDEN);
  });

  test('a compacted capture is byte-for-byte the JPEG the batch pipeline sent', () => {
    // The two compaction paths screenshotForModel has: over the byte cap
    // (2000x1000 noise -> 1600x800) and over the side bound (400x9000).
    const sha = (png: Buffer) => {
      const shot = screenshotForModel(png.toString('base64'), 'image/png');
      if (!shot.ok || shot.block.type !== 'image') throw new Error('not compacted');
      return `${shot.width}x${shot.height}:${createHash('sha256').update(shot.block.source.data).digest('hex')}`;
    };
    expect(sha(encodePng(2000, 1000, 2, 8, noiseRgbRows(2000, 1000)))).toBe('1600x800:97971980f4e5bd6dfed47a8ab58a57ea61f829240c6ee6b0eea077472592279e');
    const tall = Array.from({ length: 9000 }, (_, y) => Uint8Array.from({ length: 400 * 3 }, (_, i) => (y * 7 + i * 13) & 255));
    expect(sha(encodePng(400, 9000, 2, 8, tall))).toBe('355x8000:ef88b4c18340c7b2561c4ffae7c1c99243a61a09dc00ba35911705cc825785ea');
  });

  test('image data split across many IDATs, or with empty ones, decodes as if it were one', () => {
    for (const [ct, depth] of [[6, 8], [2, 16], [3, 2]] as Array<[number, number]>) {
      const whole = digest(decodePng(mixedPng(67, 29, ct, depth, 5)));
      for (const split of [1, 7, 4096]) expect(digest(decodePng(mixedPng(67, 29, ct, depth, 5, { idatSplit: split })))).toBe(whole);
    }
    const stream = deflateSync(Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]));
    const empty = new Uint8Array(0);
    const png = encodePng(1, 2, 2, 8, [], { idats: [empty, stream.subarray(0, 3), empty, stream.subarray(3), empty] });
    expect([...decodePng(png).rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  test('the zlib stream is held to what the header declares, whatever its shape', () => {
    // 2x2 RGB: 2 rows of 1 + 6 bytes.
    const rows = Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
    const png = (stream: Uint8Array, split?: number) => encodePng(2, 2, 2, 8, [], { idat: stream, idatSplit: split });
    const want = [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255];
    expect([...decodePng(png(deflateSync(rows))).rgba]).toEqual(want);
    // Up to 64 bytes past the rows are tolerated, as libpng does; 65 are not.
    expect([...decodePng(png(deflateSync(Buffer.concat([rows, Buffer.alloc(64)])))).rgba]).toEqual(want);
    expect(() => decodePng(png(deflateSync(Buffer.concat([rows, Buffer.alloc(65)]))))).toThrow('PNG image data is longer than its header says');
    expect(() => decodePng(png(deflateSync(Buffer.concat([rows, Buffer.alloc(65)])), 1))).toThrow('PNG image data is longer than its header says');
    // One byte short of the rows.
    expect(() => decodePng(png(deflateSync(rows.subarray(0, rows.length - 1))))).toThrow('PNG image data is shorter than its header says');
    // Every row present but the stream cut before its end, or its checksum wrong.
    const z = deflateSync(rows);
    expect(() => decodePng(png(z.subarray(0, z.length - 4)))).toThrow('PNG image data is not a valid zlib stream');
    const badSum = Buffer.from(z);
    badSum[badSum.length - 1] = badSum[badSum.length - 1]! ^ 1;
    expect(() => decodePng(png(badSum))).toThrow('PNG image data is not a valid zlib stream');
    expect(() => decodePng(png(Buffer.from('not a zlib stream at all')))).toThrow('PNG image data is not a valid zlib stream');
    // No image data at all.
    expect(() => decodePng(encodePng(2, 2, 2, 8, [], { idats: [] }))).toThrow('PNG image data is not a valid zlib stream');
    // Bytes after the end of the stream are not image data, and are ignored.
    expect([...decodePng(png(Buffer.concat([z, Buffer.from('trailing')]))).rgba]).toEqual(want);
    expect([...decodePng(encodePng(2, 2, 2, 8, [], { idats: [z, Buffer.from('trailing')] })).rgba]).toEqual(want);
  });

  test('the zip bomb is refused split across IDATs as it is in one', () => {
    const bomb = zeroBomb(BOMB_748);
    expect(() => decodePng(encodePng(100, 100, 2, 8, [], { idat: bomb, idatSplit: 8192 }))).toThrow('PNG image data is longer than its header says');
  });

  // Linux only: VmHWM is the kernel's own peak for this process image. Not
  // getrusage's ru_maxrss, which Linux carries across exec from the spawning
  // process -- under bun test that is the runner's peak, so a child measured
  // that way reported 0 KB of growth however much it allocated.
  test.skipIf(process.platform !== 'linux')('compacting a capture never holds a full-size copy of it (peak RSS, measured in a child process)', () => {
    // 8100x2000 RGBA of zeros: 64.8 MB of rows and 64.8 MB of RGBA, but a
    // PNG of ~63 KB, so the child holds next to nothing before the decode.
    // The side is over MAX_IMAGE_SIDE, so screenshotForModel compacts it.
    const W = 8100, H = 2000;
    expect(W).toBeGreaterThan(MAX_IMAGE_SIDE);
    const png = encodePng(W, H, 6, 8, [], { idat: zeroBomb((W * 4 + 1) * H) });
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-748-'));
    try {
      const file = join(dir, 'capture.png');
      writeFileSync(file, png);
      const script = `
        import { readFileSync } from 'node:fs';
        import { screenshotForModel } from ${JSON.stringify(join(import.meta.dir, 'image-compact.ts'))};
        const hwm = () => Number(/VmHWM:\\s+(\\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]);
        const base64 = readFileSync(${JSON.stringify(file)}).toString('base64');
        const before = hwm();
        const shot = screenshotForModel(base64, 'image/png');
        console.log(JSON.stringify({ ok: shot.ok, width: shot.ok ? shot.width : 0, grewKb: hwm() - before }));`;
      const out = Bun.spawnSync([process.execPath, '-e', script], { cwd: dir });
      expect(out.exitCode).toBe(0);
      const result = JSON.parse(out.stdout.toString().trim()) as { ok: boolean; width: number; grewKb: number };
      expect(result).toMatchObject({ ok: true, width: SCREENSHOT_COMPACT.maxWidth });
      // Less than one full-size copy of the image: the batch pipeline held
      // three at once (the inflated rows, inflateSync's concatenation of
      // them, the RGBA image) and measured +222 MB here; streamed, +22 to 27
      // MB, of which ~15 MB is what compacting even an 8001x4 capture costs
      // (most of it JSC's optimising compilers: +5 MB with them off).
      const oneCopyKb = (W * H * 4) / 1024;
      expect(result.grewKb).toBeLessThan(oneCopyKb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a refused stream leaves no zlib error behind to crash the process later', async () => {
    // Bun reports a zlib error from the incremental write by emitting 'error'
    // on the stream after the call; with no listener that is an uncaught
    // exception -- in the daemon, the end of the process. In a child, because
    // inside a bun test callback Bun emits it during the call instead, which
    // hides both that and a missed failure (the message below would read
    // "longer than its header says" had the untouched write state been taken
    // for a full buffer).
    const script = `
      import { decodePng } from ${JSON.stringify(join(import.meta.dir, 'image-compact.ts'))};
      import { encodePng } from ${JSON.stringify(join(import.meta.dir, 'fixtures', 'png.ts'))};
      import { deflateSync } from 'node:zlib';
      process.on('uncaughtException', (err) => { console.log('uncaught: ' + err.message); process.exit(3); });
      const z = deflateSync(Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]));
      const badSum = Buffer.from(z);
      badSum[badSum.length - 1] ^= 1;
      // A bad header, a stream cut short, a bad checksum: zlib's three ways to fail.
      for (const idat of [Buffer.from('not zlib'), z.subarray(0, z.length - 4), badSum]) {
        try { decodePng(encodePng(1, 2, 2, 8, [], { idat })); } catch (err) { console.log('refused: ' + err.message); }
      }
      await Bun.sleep(100);
      console.log('alive');`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(stdout.trim().split('\n')).toEqual([
      'refused: PNG image data is not a valid zlib stream',
      'refused: PNG image data is not a valid zlib stream',
      'refused: PNG image data is not a valid zlib stream',
      'alive',
    ]);
    expect(code).toBe(0);
  });

  test('a runtime whose zlib lacks the incremental primitive, or mishandles it, is detected', () => {
    // This runtime has it, so the streamed inflate is what the tests above ran.
    expect(streamingInflateWorks()).toBe(true);
    const probe = createInflate() as unknown as { _handle: object; close(): void };
    const handleProto = Object.getPrototypeOf(probe._handle) as { writeSync: unknown };
    probe.close();
    const real = handleProto.writeSync;
    try {
      // Missing, and present but never reporting progress.
      for (const stub of [undefined, () => {}]) {
        handleProto.writeSync = stub;
        resetStreamingInflateCheck();
        expect(streamingInflateWorks()).toBe(false);
      }
    } finally {
      handleProto.writeSync = real;
      resetStreamingInflateCheck();
    }
    expect(streamingInflateWorks()).toBe(true);
  });

  test('without the primitive, the inflateSync fallback gives the same pixels and the same refusals', () => {
    resetStreamingInflateCheck(false);
    try {
      expect(matrixDigest((png, mw, mh) => decodeShrunkPng(png, mw, mh))).toBe(MATRIX_GOLDEN);
      expect(() => decodePng(encodePng(100, 100, 2, 8, [], { idat: zeroBomb(BOMB_748) }))).toThrow('PNG image data is longer than its header says');
      const z = deflateSync(Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]));
      expect([...decodePng(encodePng(1, 2, 2, 8, [], { idats: [z.subarray(0, 3), z.subarray(3)] })).rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
      expect(() => decodePng(encodePng(1, 2, 2, 8, [], { idat: z.subarray(0, z.length - 4) }))).toThrow('PNG image data is not a valid zlib stream');
      expect(() => decodePng(encodePng(1, 2, 2, 8, [], { idat: deflateSync(Buffer.from([0, 1, 2, 3])) }))).toThrow('PNG image data is shorter than its header says');
    } finally {
      resetStreamingInflateCheck();
    }
  });
});
