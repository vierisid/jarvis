/**
 * Image Compaction -- the local screenshot path's fallback over the image cap (#711).
 *
 * A routed screenshot that `guardImageSize` would replace with a placeholder is
 * retaken by the sidecar downscaled and JPEG-encoded (`routeScreenshotToSidecar`
 * in actions/tools/sidecar-route.ts, `shrinkScreenshotWithGrid` in
 * sidecar/handlers.go). The local branches of `desktop_screenshot` and
 * `capture_screen` had nothing equivalent: they capture through platform tools
 * (screencapture, import/scrot, PowerShell's System.Drawing, the legacy desktop
 * bridge) that all hand back PNG, so a large or high-DPI display reached the
 * model as `[Image too large...]` instead of a picture.
 *
 * The daemon has no image codec of its own (no dependency provides one, and Bun
 * exposes none), so this is a small one: PNG decode, an area-average downscale
 * and a baseline JPEG encoder. Small on purpose -- it only ever reads what a
 * screen capture tool writes, and it only has to produce one format every
 * provider accepts. What it refuses (interlaced PNG, anything not PNG) is
 * reported as "could not be compacted", never sent half-decoded.
 *
 * THE VALUES are not chosen here. `SCREENSHOT_COMPACT` is the daemon's ambient
 * screenshot parameters (`fetchScreenshot` in daemon/index.ts: max width 1600,
 * JPEG quality 80), which the routed fallback already reuses for the reason
 * given there: legible to a vision model, well under the cap. No grid: the
 * sidecar draws one only for the pointing flow, and a coordinate overlay on a
 * general screenshot is noise the model reads as screen content. Quality 80
 * means the same thing it does in Go's image/jpeg: both scale the Annex K
 * tables with the IJG formula.
 */

import { inflateSync } from 'node:zlib';
import { guardImageSize, type ContentBlock } from '../../llm/provider.ts';

/** The compact capture's parameters, shared with the routed fallback. */
export const SCREENSHOT_COMPACT = { maxWidth: 1600, jpegQuality: 80 } as const;

export type DecodedImage = { width: number; height: number; rgba: Uint8Array };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel for each PNG colour type. */
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * The most pixels a capture may declare before it is refused undecoded.
 *
 * The size check is the header's own claim, so without a bound a 560 KB IDAT
 * declaring 12000x12000 decoded for 14.5 s and 2.3 GB (#711 review). Measured
 * here, decode + downscale + encode run at 8-12 ms per megapixel (5120x2880 in
 * 180 ms, 11520x2160 in 270 ms, 18048x3384 in 490 ms), so the bound keeps one
 * compaction under about a second, and its memory at the inflated rows plus
 * one RGBA buffer (the unfilter below is in place). It sits above the largest
 * real desktop a root-window capture spans -- three 6K displays side by side,
 * 18048x3384, are 61 MP -- so no actual screen is refused by it.
 */
export const MAX_DECODE_PIXELS = 64_000_000;

/**
 * Decode a non-interlaced PNG to 8-bit RGBA.
 *
 * Every colour type, bit depths 1/2/4/8 for grey and palette and 8/16 for the
 * rest (16-bit samples keep their high byte). A palette image's tRNS alpha is
 * applied; a grey or RGB image's tRNS (one colour key) is not, so those decode
 * opaque -- a screen capture never sets one. The inflate is bounded by the
 * size the header declares, and that by MAX_DECODE_PIXELS.
 */
export function decodePng(png: Uint8Array): DecodedImage {
  if (png.length < 8 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) throw new Error('not a PNG image');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0, depth = 0, colorType = -1, interlace = 0;
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let off = 8;
  while (off + 8 <= png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(png[off + 4]!, png[off + 5]!, png[off + 6]!, png[off + 7]!);
    const start = off + 8;
    const end = start + len;
    if (end + 4 > png.length) throw new Error(`truncated PNG chunk ${type}`);
    const data = png.subarray(start, end);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('truncated PNG header');
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      depth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      paletteAlpha = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off = end + 4;
  }
  const channels = PNG_CHANNELS[colorType];
  if (!width || !height || channels === undefined) throw new Error('PNG has no usable header');
  if (width * height > MAX_DECODE_PIXELS) throw new Error(`a ${width}x${height} image is larger than any screen this decodes`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const depthOk = colorType === 0 || colorType === 3 ? [1, 2, 4, 8, 16].includes(depth) && !(colorType === 3 && depth === 16) : depth === 8 || depth === 16;
  if (!depthOk) throw new Error(`PNG bit depth ${depth} is not valid for colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('palette PNG has no palette');

  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const stride = rowBytes + 1;
  const expected = stride * height;
  const compressed = idat.length === 1 ? idat[0]! : Buffer.concat(idat);
  const raw = inflateSync(compressed, { maxOutputLength: expected });
  if (raw.length < expected) throw new Error('PNG image data is shorter than its header says');

  // Undo the per-row filters in place: each row's bytes follow its filter
  // byte, and every predictor reads only bytes already unfiltered (earlier in
  // this row, or the previous row).
  const bpp = Math.max(1, (channels * depth) >> 3);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride]!;
    const row = y * stride + 1;
    const prev = row - stride;
    if (filter === 0) continue;
    if (filter > 4) throw new Error(`unknown PNG filter ${filter}`);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? raw[row + i - bpp]! : 0;
      const b = y > 0 ? raw[prev + i]! : 0;
      let pred: number;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else {
        const c = y > 0 && i >= bpp ? raw[prev + i - bpp]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[row + i] = (raw[row + i]! + pred) & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const sample = (row: number, index: number): number => {
    // index counts samples within the row, at the image's bit depth.
    if (depth === 8) return raw[row + index]!;
    if (depth === 16) return raw[row + index * 2]!;
    const perByte = 8 / depth;
    const byte = raw[row + Math.floor(index / perByte)]!;
    const shift = 8 - depth * ((index % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < height; y++) {
    const row = y * stride + 1;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(row, x);
        rgba[o] = palette![idx * 3] ?? 0;
        rgba[o + 1] = palette![idx * 3 + 1] ?? 0;
        rgba[o + 2] = palette![idx * 3 + 2] ?? 0;
        rgba[o + 3] = paletteAlpha && idx < paletteAlpha.length ? paletteAlpha[idx]! : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = Math.round(sample(row, x * channels) * scale);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = colorType === 4 ? sample(row, x * channels + 1) : 255;
      } else {
        rgba[o] = sample(row, x * channels);
        rgba[o + 1] = sample(row, x * channels + 1);
        rgba[o + 2] = sample(row, x * channels + 2);
        rgba[o + 3] = colorType === 6 ? sample(row, x * channels + 3) : 255;
      }
    }
  }
  return { width, height, rgba };
}

/**
 * Downscale to at most `maxWidth` wide, keeping the aspect ratio the way the
 * sidecar computes it (integer height), averaging every source pixel a target
 * pixel covers. Alpha is composited over black, which is what Go's JPEG encoder
 * does with the sidecar's RGBA canvas. Never upscales.
 */
export function downscaleToWidth(img: DecodedImage, maxWidth: number): DecodedImage {
  const { width: sw, height: sh, rgba } = img;
  if (sw <= maxWidth) return img;
  const dw = maxWidth;
  const dh = Math.max(1, Math.floor((sh * maxWidth) / sw));
  const out = new Uint8Array(dw * dh * 4);
  const x0 = new Int32Array(dw + 1);
  for (let dx = 0; dx <= dw; dx++) x0[dx] = Math.floor((dx * sw) / dw);
  const acc = new Float64Array(dw * 3);
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor((dy * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / dh));
    acc.fill(0);
    for (let sy = sy0; sy < sy1; sy++) {
      const rowOff = sy * sw * 4;
      for (let dx = 0; dx < dw; dx++) {
        const end = Math.max(x0[dx]! + 1, x0[dx + 1]!);
        let r = 0, g = 0, b = 0;
        for (let sx = x0[dx]!; sx < end; sx++) {
          const p = rowOff + sx * 4;
          const a = rgba[p + 3]!;
          if (a === 255) { r += rgba[p]!; g += rgba[p + 1]!; b += rgba[p + 2]!; }
          else { r += (rgba[p]! * a) / 255; g += (rgba[p + 1]! * a) / 255; b += (rgba[p + 2]! * a) / 255; }
        }
        acc[dx * 3] = acc[dx * 3]! + r;
        acc[dx * 3 + 1] = acc[dx * 3 + 1]! + g;
        acc[dx * 3 + 2] = acc[dx * 3 + 2]! + b;
      }
    }
    for (let dx = 0; dx < dw; dx++) {
      const n = (Math.max(x0[dx]! + 1, x0[dx + 1]!) - x0[dx]!) * (sy1 - sy0);
      const o = (dy * dw + dx) * 4;
      out[o] = Math.round(acc[dx * 3]! / n);
      out[o + 1] = Math.round(acc[dx * 3 + 1]! / n);
      out[o + 2] = Math.round(acc[dx * 3 + 2]! / n);
      out[o + 3] = 255;
    }
  }
  return { width: dw, height: dh, rgba: out };
}

// --- Baseline JPEG encoder (ITU T.81), 4:2:0 like Go's image/jpeg ---

/** Natural-order index of each zig-zag position. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** Annex K.1 quantisation tables, natural order. */
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** Annex K.3 Huffman tables: code counts per length 1..16, then the symbols. */
const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

type HuffTable = { code: Uint16Array; size: Uint8Array };

/** Canonical codes for a bits/vals table (T.81 Annex C). */
function buildHuffman(spec: { bits: number[]; vals: number[] }): HuffTable {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let k = 0, c = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < spec.bits[len - 1]!; i++) {
      const sym = spec.vals[k++]!;
      code[sym] = c++;
      size[sym] = len;
    }
    c <<= 1;
  }
  return { code, size };
}

/** IJG quality scaling, as Go's image/jpeg and libjpeg apply it. */
export function scaledQuantTable(base: number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const s = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
}

class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private nbits = 0;
  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number): void { this.ensure(1); this.buf[this.len++] = b; }
  bytes(bs: ArrayLike<number>): void { this.ensure(bs.length); for (let i = 0; i < bs.length; i++) this.buf[this.len++] = bs[i]!; }
  u16(v: number): void { this.byte((v >> 8) & 0xff); this.byte(v & 0xff); }
  /** Entropy-coded bits, with 0xFF byte stuffing. */
  bits(value: number, count: number): void {
    this.acc = (this.acc << count) | (value & ((1 << count) - 1));
    this.nbits += count;
    while (this.nbits >= 8) {
      const b = (this.acc >> (this.nbits - 8)) & 0xff;
      this.byte(b);
      if (b === 0xff) this.byte(0);
      this.nbits -= 8;
      this.acc &= (1 << this.nbits) - 1;
    }
  }
  /** Pad the last byte with 1-bits, as T.81 F.1.2.3 requires. */
  flushBits(): void { if (this.nbits > 0) this.bits((1 << (8 - this.nbits)) - 1, 8 - this.nbits); }
  result(): Uint8Array { return this.buf.slice(0, this.len); }
}

const COS = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();
const C0 = Math.SQRT1_2;

/** Scratch for fdctQuantize: one row pass, reused for every block. */
const DCT_TMP = new Float64Array(64);

/** Forward DCT of one level-shifted 8x8 block, quantised into natural order. */
function fdctQuantize(block: Float64Array, quant: number[], out: Int32Array): void {
  const tmp = DCT_TMP;
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x]! * COS[x * 8 + u]!;
      tmp[y * 8 + u] = s * (u === 0 ? C0 : 1) / 2;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u]! * COS[y * 8 + v]!;
      const coeff = s * (v === 0 ? C0 : 1) / 2;
      const natural = v * 8 + u;
      out[natural] = Math.round(coeff / quant[natural]!);
    }
  }
}

function magnitudeCategory(v: number): number {
  let a = v < 0 ? -v : v;
  let n = 0;
  while (a) { n++; a >>= 1; }
  return n;
}

function encodeBlock(w: BitWriter, coeffs: Int32Array, prevDc: number, dc: HuffTable, ac: HuffTable): number {
  const diff = coeffs[0]! - prevDc;
  const cat = magnitudeCategory(diff);
  w.bits(dc.code[cat]!, dc.size[cat]!);
  if (cat) w.bits(diff < 0 ? diff - 1 : diff, cat);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = coeffs[ZIGZAG[k]!]!;
    if (v === 0) { run++; continue; }
    while (run > 15) { w.bits(ac.code[0xf0]!, ac.size[0xf0]!); run -= 16; }
    const c = magnitudeCategory(v);
    const sym = (run << 4) | c;
    w.bits(ac.code[sym]!, ac.size[sym]!);
    w.bits(v < 0 ? v - 1 : v, c);
    run = 0;
  }
  if (run > 0) w.bits(ac.code[0]!, ac.size[0]!);
  return coeffs[0]!;
}

/**
 * Encode RGBA pixels as a baseline 4:2:0 JPEG. Alpha is composited over black,
 * as downscaleToWidth does and as Go's encoder does with the sidecar's RGBA
 * canvas, so an image that only needs re-encoding is treated the same as one
 * that was shrunk.
 */
export function encodeJpeg(img: DecodedImage, quality: number): Uint8Array {
  const { width, height, rgba } = img;
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error(`cannot encode a ${width}x${height} JPEG`);
  const lq = scaledQuantTable(LUMA_Q, quality);
  const cq = scaledQuantTable(CHROMA_Q, quality);
  const tables = [DC_LUMA, AC_LUMA, DC_CHROMA, AC_CHROMA];
  const [dcL, acL, dcC, acC] = tables.map(buildHuffman) as [HuffTable, HuffTable, HuffTable, HuffTable];

  const w = new BitWriter();
  w.bytes([0xff, 0xd8]);
  // APP0 JFIF 1.01, no thumbnail.
  w.bytes([0xff, 0xe0]); w.u16(16); w.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]); w.u16(1); w.u16(1); w.bytes([0, 0]);
  // DQT, both tables, zig-zag order.
  w.bytes([0xff, 0xdb]); w.u16(2 + 2 * 65);
  w.byte(0); for (let k = 0; k < 64; k++) w.byte(lq[ZIGZAG[k]!]!);
  w.byte(1); for (let k = 0; k < 64; k++) w.byte(cq[ZIGZAG[k]!]!);
  // SOF0: 8-bit, Y at 2x2, Cb and Cr at 1x1.
  w.bytes([0xff, 0xc0]); w.u16(17); w.byte(8); w.u16(height); w.u16(width); w.byte(3);
  w.bytes([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  // DHT.
  const classIds = [0x00, 0x10, 0x01, 0x11];
  w.bytes([0xff, 0xc4]); w.u16(2 + tables.reduce((n, t) => n + 17 + t.vals.length, 0));
  tables.forEach((t, i) => { w.byte(classIds[i]!); w.bytes(t.bits); w.bytes(t.vals); });
  // SOS.
  w.bytes([0xff, 0xda]); w.u16(12); w.byte(3); w.bytes([1, 0x00, 2, 0x11, 3, 0x11]); w.bytes([0, 63, 0]);

  const yBlk = new Float64Array(64), cbBlk = new Float64Array(64), crBlk = new Float64Array(64);
  const coeffs = new Int32Array(64);
  // Y for one 16x16 macroblock, and the 2x2-averaged chroma.
  const yMb = new Float64Array(256);
  let dcY = 0, dcCb = 0, dcCr = 0;
  for (let my = 0; my < height; my += 16) {
    for (let mx = 0; mx < width; mx += 16) {
      cbBlk.fill(0); crBlk.fill(0);
      for (let j = 0; j < 16; j++) {
        const py = Math.min(height - 1, my + j);
        for (let i = 0; i < 16; i++) {
          const px = Math.min(width - 1, mx + i);
          const o = (py * width + px) * 4;
          const alpha = rgba[o + 3]!;
          const r = alpha === 255 ? rgba[o]! : (rgba[o]! * alpha) / 255;
          const g = alpha === 255 ? rgba[o + 1]! : (rgba[o + 1]! * alpha) / 255;
          const b = alpha === 255 ? rgba[o + 2]! : (rgba[o + 2]! * alpha) / 255;
          yMb[j * 16 + i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          const ci = (j >> 1) * 8 + (i >> 1);
          cbBlk[ci] = cbBlk[ci]! + (-0.168736 * r - 0.331264 * g + 0.5 * b) / 4;
          crBlk[ci] = crBlk[ci]! + (0.5 * r - 0.418688 * g - 0.081312 * b) / 4;
        }
      }
      for (let by = 0; by < 2; by++) {
        for (let bx = 0; bx < 2; bx++) {
          for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) yBlk[j * 8 + i] = yMb[(by * 8 + j) * 16 + bx * 8 + i]!;
          fdctQuantize(yBlk, lq, coeffs);
          dcY = encodeBlock(w, coeffs, dcY, dcL, acL);
        }
      }
      fdctQuantize(cbBlk, cq, coeffs);
      dcCb = encodeBlock(w, coeffs, dcCb, dcC, acC);
      fdctQuantize(crBlk, cq, coeffs);
      dcCr = encodeBlock(w, coeffs, dcCr, dcC, acC);
    }
  }
  w.flushBits();
  w.bytes([0xff, 0xd9]);
  return w.result();
}

export type ScreenshotForModel =
  | { ok: true; block: ContentBlock; width?: number; height?: number; origWidth?: number; origHeight?: number; compacted: boolean }
  | { ok: false; reason: string };

/** Whether the orchestrator would swap this image block for a placeholder. */
export function tooBigToSend(block: ContentBlock): boolean {
  return guardImageSize(block).type !== 'image';
}

/**
 * The image block a local screenshot should reach the model as.
 *
 * Full resolution whenever it fits, exactly as before; only a capture
 * `guardImageSize` would replace with a placeholder is compacted, once, with
 * the shared values. Unlike the routed path this does not take a second
 * capture: the compaction happens here, on the bytes already in hand, so the
 * picture is of the same moment.
 */
export function screenshotForModel(base64: string, mediaType: string): ScreenshotForModel {
  const block: ContentBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
  if (!tooBigToSend(block)) return { ok: true, block, compacted: false };
  if (mediaType !== 'image/png') return { ok: false, reason: `the capture is ${mediaType}, which cannot be compacted here` };
  const bytes = Buffer.from(base64, 'base64');
  let jpeg: Uint8Array;
  let decoded: DecodedImage;
  let small: DecodedImage;
  try {
    decoded = decodePng(bytes);
    small = downscaleToWidth(decoded, SCREENSHOT_COMPACT.maxWidth);
    jpeg = encodeJpeg(small, SCREENSHOT_COMPACT.jpegQuality);
  } catch (err) {
    return { ok: false, reason: `it could not be compacted (${err instanceof Error ? err.message : String(err)})` };
  }
  const compact: ContentBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') } };
  if (tooBigToSend(compact)) return { ok: false, reason: 'it is too large to send even after compacting it' };
  return { ok: true, block: compact, compacted: true, width: small.width, height: small.height, origWidth: decoded.width, origHeight: decoded.height };
}

/**
 * The one line of our own that goes with a screenshot: what was captured and,
 * when it was compacted, that the picture is smaller than the screen, so a size
 * read off it is not taken for the display's own. Same wording as the routed
 * reply (`routeScreenshotToSidecar`).
 */
export function screenshotCaption(label: string, shot: Extract<ScreenshotForModel, { ok: true }>): string {
  const shrunk = shot.compacted && shot.origWidth && shot.origHeight
    && (shot.origWidth !== shot.width || shot.origHeight !== shot.height)
    ? `, downscaled from ${shot.origWidth}x${shot.origHeight} to fit` : '';
  return shot.compacted && shot.width && shot.height ? `${label} (${shot.width}x${shot.height}${shrunk}).` : `${label}.`;
}
