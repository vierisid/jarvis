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

import { constants as zlibConstants, createInflate, crc32, deflateSync, inflateSync } from 'node:zlib';
import { guardImageSize, type ContentBlock } from '../../llm/provider.ts';

/** The compact capture's parameters, shared with the routed fallback. */
export const SCREENSHOT_COMPACT = { maxWidth: 1600, jpegQuality: 80 } as const;

export type DecodedImage = { width: number; height: number; rgba: Uint8Array };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel for each PNG colour type. */
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * What a capture may declare before it is refused undecoded: at most
 * MAX_DECODE_PIXELS pixels, and at most MAX_DECODE_BYTES bytes of raw rows.
 *
 * Both bounds are on the header's own claim, checked before anything is
 * inflated. Without one, a 560 KB IDAT declaring 12000x12000 decoded for 14.5 s
 * and 2.3 GB (#711 review). The pixel bound alone was not enough (IMG-001):
 * bytes per pixel vary 8x across the colour types read here, and a 4.6 MB PNG
 * declaring 1600x40000 RGBA at 16 bits -- 64 MP, inside the pixel bound --
 * decoded for 3.6 s and +1.25 GB here. Two bounds because the two costs scale
 * differently: inflating and unfiltering are per byte of raw rows
 * (width*height*bytes-per-pixel), converting and averaging per pixel.
 *
 * 64 MP sits above the largest real desktop a root-window capture spans --
 * three 6K displays side by side, 18048x3384, are 61 MP -- and 256 MB is that
 * many pixels of 8-bit RGBA, so no actual screen is refused.
 *
 * WHAT THE BOUNDS ADMIT is now time, not memory. The decode streams (#748):
 * rows are inflated, unfiltered and averaged into the shrunk image as they
 * arrive, so neither the inflated rows nor a full-size RGBA image ever exists.
 * Measured here, peak RSS over the process before the compaction, then time
 * (decode, shrink and encode; the batch pipeline it replaced in brackets):
 * 8000x8000 8-bit RGBA seeded noise with Paeth on every row, the most
 * expensive input inside the bounds, +41 MB in 1.7 s [+1023 MB, 2.3 s];
 * 8000x4000 16-bit, +35 MB in 1.5 s [+901 MB, 2.0 s]; a three-display
 * 18048x3384 desktop, +27 MB in 0.38 s [+742 MB, 0.82 s]; 5120x2880, +32 MB in
 * 0.15 s [+207 MB, 0.27 s]; 1x64000000, the most rows, +17 MB in 0.74 to
 * 0.91 s [+514 MB, 0.71 to 0.76 s]. About 15 MB of each is what compacting
 * even an 8001x4 capture costs, most of it JSC's optimising compilers. The
 * time is synchronous on the daemon's thread; the bounds keep a hostile or
 * broken file from costing more of it. The one shape memory still follows is
 * width, since a row is held whole, and MAX_DECODE_WIDTH bounds that.
 */
export const MAX_DECODE_PIXELS = 64_000_000;
export const MAX_DECODE_BYTES = 256_000_000;

/**
 * The widest image decoded at all (#768). The decode holds a row at a time
 * (see decodeRows), so its memory follows width, and the two caps above still
 * admitted 64000000x1 RGBA -- a 256 MB row, +505 MB peak for a ~250 KB PNG,
 * measured. No display is anywhere near: three 6K panels side by side are
 * 18048 px, and JPEG, what a compacted capture becomes, cannot pass 65535
 * either. At this bound a row is at most 512 KB (16-bit RGBA), so a decode's
 * rows stay around 1.5 MB; 65535x900 RGBA compacted for +18.6 MB, the same as
 * 65536x900 did before the bound, and 64000000x1 is now refused for +1.4 MB.
 *
 * This is a refusal, where the policy for real captures is to shrink rather
 * than refuse; it only reaches a geometry no screen produces, so what it
 * catches is a capture tool writing nonsense, and the message says so. Height
 * is not bounded here: rows are streamed, so a tall image costs time, which
 * the caps above already bound, not memory.
 */
export const MAX_DECODE_WIDTH = 65_535;

/**
 * The longest side an image block may have. Anthropic's API rejects an image
 * over 8000 px on a side, and the request then fails after this tool has
 * reported success; a compacted capture is shrunk to fit inside it.
 */
export const MAX_IMAGE_SIDE = 8000;

/** A PNG's header, checked, and its image data still compressed. */
type PngLayout = {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  channels: number;
  rowBytes: number;
  palette: Uint8Array | null;
  paletteAlpha: Uint8Array | null;
  /** The IDAT chunks' data, in order: one zlib stream split across them. */
  idat: Uint8Array[];
};

/** Read and check a PNG's chunks; nothing is inflated here. */
function readPng(png: Uint8Array): PngLayout {
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
    // Every chunk's CRC, over its type and data. zlib's own checksum catches a
    // corrupt IDAT stream, but nothing else covers IHDR, PLTE or tRNS -- the
    // chunks that decide geometry and colour, where one flipped bit silently
    // reinterprets the whole image (IMG-002).
    if ((crc32(png.subarray(off + 4, end)) >>> 0) !== view.getUint32(end)) throw new Error(`PNG chunk ${type} is corrupt (CRC mismatch)`);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('truncated PNG header');
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      depth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') {
      // Whole RGB entries, at most 256 (the spec's own limits) (IMG-003).
      if (data.length === 0 || data.length % 3 !== 0 || data.length > 768) throw new Error(`PNG PLTE of ${data.length} bytes is not 1 to 256 RGB entries`);
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
  if (width > MAX_DECODE_WIDTH) {
    throw new Error(`a ${width}x${height} image is ${width} px wide, a geometry no screen produces (at most ${MAX_DECODE_WIDTH}), so the capture tool that wrote it is misbehaving`);
  }
  if (width * height > MAX_DECODE_PIXELS) throw new Error(`a ${width}x${height} image is larger than any screen this decodes`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const depthOk = colorType === 0 || colorType === 3 ? [1, 2, 4, 8, 16].includes(depth) && !(colorType === 3 && depth === 16) : depth === 8 || depth === 16;
  if (!depthOk) throw new Error(`PNG bit depth ${depth} is not valid for colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('palette PNG has no palette');

  const rowBytes = Math.ceil((width * channels * depth) / 8);
  if (rowBytes * height > MAX_DECODE_BYTES) throw new Error(`a ${width}x${height} image is larger than any screen this decodes`);
  return { width, height, depth, colorType, channels, rowBytes, palette, paletteAlpha, idat };
}

/** How much inflated data is handed on at a time: the one inflate buffer. */
const INFLATE_CHUNK = 64 * 1024;

/**
 * The incremental, synchronous zlib primitive under node:zlib: the native
 * handle's `writeSync(flush, in, inOff, inLen, out, outOff, outLen)`, which
 * leaves [availOut, availIn] in the stream's `_writeState`. It is what
 * `inflateSync` itself runs on (zlibBufferSync -> processChunkSync, in Node's
 * lib/zlib.js, which Bun ports), but `inflateSync` gathers the whole output
 * and then concatenates it -- twice the image, briefly -- and the one public
 * incremental API, `createInflate`, is asynchronous. Neither underscored name
 * is documented, so `streamingInflateWorks` checks the pair before use.
 */
type InflateInternals = {
  _handle?: { writeSync?: (flush: number, input: Uint8Array, inOff: number, inLen: number, out: Uint8Array, outOff: number, outLen: number) => void };
  _writeState?: unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  close(): void;
};

/**
 * Inflate one zlib stream given in `parts`, handing the output to `sink` in
 * pieces of at most INFLATE_CHUNK bytes as it is produced, and refusing the
 * stream as soon as it has produced more than `limit` bytes -- the bound that
 * keeps a zip bomb from expanding past what the header declares. Returns how
 * many bytes it produced. Bytes after the end of the stream are ignored, as
 * `inflateSync` ignores them.
 *
 * Errors are not thrown by `writeSync`: Bun records them on the stream,
 * leaves `_writeState` untouched, and emits 'error' -- in a script after the
 * call returns, inside a bun test callback during it -- and an 'error' with no
 * listener is an uncaught exception that ends the process (measured, Bun
 * 1.3.8). So the state is set to an impossible value before each call, an
 * untouched state is the failure, and an 'error' listener is always attached.
 */
function inflateStreaming(parts: Uint8Array[], limit: number, sink: (bytes: Uint8Array) => void): number {
  const inflater = createInflate() as unknown as InflateInternals;
  let failed = false;
  inflater.on('error', () => { failed = true; });
  // No IDAT at all still runs one (empty) Z_FINISH write, so it is refused
  // the way inflateSync refuses an empty buffer.
  const inputs = parts.length > 0 ? parts : [new Uint8Array(0)];
  let total = 0;
  try {
    const write = inflater._handle!.writeSync!.bind(inflater._handle);
    const state = inflater._writeState as Uint32Array;
    // Zeroed, not allocUnsafe: were a runtime ever to under-report availOut,
    // the bytes it counted would be zeros, never stale heap.
    const out = Buffer.alloc(INFLATE_CHUNK);
    for (let k = 0; k < inputs.length; k++) {
      const input = inputs[k]!;
      // Z_FINISH on the last input is what turns a stream cut short into an
      // error ("unexpected end of file"), exactly as in inflateSync.
      const flush = k === inputs.length - 1 ? zlibConstants.Z_FINISH : zlibConstants.Z_NO_FLUSH;
      let inOff = 0, availIn = input.length;
      for (;;) {
        state[0] = state[1] = 0xffffffff;
        write(flush, input, inOff, availIn, out, 0, INFLATE_CHUNK);
        const availOut = state[0]!, availInAfter = state[1]!;
        if (failed || availOut > INFLATE_CHUNK || availInAfter > availIn) throw new Error('PNG image data is not a valid zlib stream');
        const produced = INFLATE_CHUNK - availOut;
        total += produced;
        // Checked per INFLATE_CHUNK, before the piece is used: the stream is
        // stopped within 64 KB of the bound, never inflated to its end.
        if (total > limit) throw new Error('PNG image data is longer than its header says');
        if (produced > 0) sink(out.subarray(0, produced));
        inOff += availIn - availInAfter;
        availIn = availInAfter;
        // A full buffer means there may be more; anything else means this
        // input is used up, or the stream has ended.
        if (availOut !== 0) break;
      }
    }
  } finally {
    inflater.close();
  }
  return total;
}

/** The same contract by `inflateSync`, all at once: what a runtime without the primitive gets. */
function inflateBatch(parts: Uint8Array[], limit: number, sink: (bytes: Uint8Array) => void): number {
  let raw: Buffer;
  try {
    raw = inflateSync(parts.length === 1 ? parts[0]! : Buffer.concat(parts), { maxOutputLength: limit });
  } catch (err) {
    const tooLong = err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
    throw new Error(tooLong ? 'PNG image data is longer than its header says' : 'PNG image data is not a valid zlib stream');
  }
  sink(raw);
  return raw.length;
}

let streamingChecked: boolean | undefined;

/**
 * Whether this runtime's zlib has the incremental primitive and it behaves:
 * the names exist, a known stream split in two inflates to exactly its data,
 * and both kinds of broken stream are refused -- one cut short (an error at
 * Z_FINISH) and one with a wrong checksum (a data error mid-call). Checked
 * once per process. A runtime that fails it falls back to `inflateBatch` --
 * correct, at the old memory cost -- rather than refusing every capture.
 */
export function streamingInflateWorks(): boolean {
  if (streamingChecked !== undefined) return streamingChecked;
  try {
    const probe = createInflate() as unknown as InflateInternals;
    let usable = false;
    try {
      usable = typeof probe._handle?.writeSync === 'function' && probe._writeState instanceof Uint32Array && probe._writeState.length >= 2;
    } finally {
      probe.close();
    }
    if (!usable) return (streamingChecked = false);
    // Known data, 3 * INFLATE_CHUNK + 5 patterned bytes so that inflating it
    // fills the output buffer and continues more than once, as every real
    // capture does; deflated by the batch API.
    const PROBE_DATA = Buffer.alloc(3 * INFLATE_CHUNK + 5);
    for (let i = 0; i < PROBE_DATA.length; i++) PROBE_DATA[i] = (i * 7 + (i >> 9)) & 0xff;
    const PROBE_STREAM = deflateSync(PROBE_DATA);
    const got = Buffer.alloc(PROBE_DATA.length);
    let at = 0;
    const half = PROBE_STREAM.length >> 1;
    const length = inflateStreaming([PROBE_STREAM.subarray(0, half), PROBE_STREAM.subarray(half)], PROBE_DATA.length, (b) => {
      if (at + b.length <= got.length) got.set(b, at);
      at += b.length;
    });
    const refuses = (stream: Uint8Array) => {
      try { inflateStreaming([stream], PROBE_DATA.length, () => {}); } catch { return true; }
      return false;
    };
    const badSum = Buffer.from(PROBE_STREAM);
    badSum[badSum.length - 1] = badSum[badSum.length - 1]! ^ 1;
    streamingChecked = length === PROBE_DATA.length && at === length && got.equals(PROBE_DATA)
      && refuses(PROBE_STREAM.subarray(0, PROBE_STREAM.length - 2)) && refuses(badSum);
  } catch {
    streamingChecked = false;
  }
  return streamingChecked;
}

/**
 * @internal Test only. Forget the check above so it runs again, or pin its
 * answer so a test can drive the fallback (the batch API shares the native
 * handle, so breaking the primitive breaks the fallback too).
 */
export function resetStreamingInflateCheck(pinned?: boolean): void {
  streamingChecked = pinned;
}

/**
 * Decode a checked PNG one row at a time: inflate, unfilter and convert
 * each row to 8-bit RGBA, and hand it to `onRow` (the buffer is reused: copy
 * what is kept). The whole image never exists at once, inflated or decoded --
 * two rows of filtered bytes, one of RGBA and the 64 KB inflate buffer do.
 * Those rows are small for any screen (18048 px of RGBA is 72 KB), but they
 * are a row, so they follow width: 64000000x1, inside the area caps, made
 * them the whole image again (+505 MB measured, against +760 MB batch) until
 * MAX_DECODE_WIDTH refused it (#768). At that bound a row is at most 512 KB.
 *
 * Every colour type, bit depths 1/2/4/8 for grey and palette and 8/16 for the
 * rest (16-bit samples keep their high byte). A palette image's tRNS alpha is
 * applied; a grey or RGB image's tRNS (one colour key) is not, so those decode
 * opaque -- a screen capture never sets one. The inflate is bounded by the
 * size the header declares, and that by MAX_DECODE_PIXELS and MAX_DECODE_BYTES.
 *
 * Rows are checked as they arrive, so of an image with several faults the
 * first to surface is reported -- an unknown filter or a palette index can now
 * come before a broken zlib stream that the batch decode named first. Either
 * way the image is refused, never sent half-decoded.
 */
function decodeRows(layout: PngLayout, onRow: (rgba: Uint8Array, y: number) => void): void {
  const { width, height, depth, colorType, channels, rowBytes, palette, paletteAlpha } = layout;
  const stride = rowBytes + 1;
  const expected = stride * height;
  const bpp = Math.max(1, (channels * depth) >> 3);
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  // The previous row starts as zeros: what every predictor reads above row 0.
  let prev = new Uint8Array(rowBytes);
  let cur = new Uint8Array(rowBytes);
  const rgba = new Uint8Array(width * 4);

  const sample = (row: Uint8Array, index: number): number => {
    // index counts samples within the row, at the image's bit depth.
    if (depth === 8) return row[index]!;
    if (depth === 16) return row[index * 2]!;
    const perByte = 8 / depth;
    const byte = row[Math.floor(index / perByte)]!;
    const shift = 8 - depth * ((index % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };

  const finishRow = (filter: number, y: number): void => {
    // Undo the row's filter in place: every predictor reads only bytes already
    // unfiltered (earlier in this row, or the previous row).
    if (filter > 4) throw new Error(`unknown PNG filter ${filter}`);
    if (filter !== 0) {
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp]! : 0;
        const b = prev[i]!;
        let pred: number;
        if (filter === 1) pred = a;
        else if (filter === 2) pred = b;
        else if (filter === 3) pred = (a + b) >> 1;
        else {
          const c = i >= bpp ? prev[i - bpp]! : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[i] = (cur[i]! + pred) & 0xff;
      }
    }
    for (let x = 0; x < width; x++) {
      const o = x * 4;
      if (colorType === 3) {
        const idx = sample(cur, x);
        // An index past the palette is an error in the spec, not black (IMG-003).
        if (idx * 3 >= palette!.length) throw new Error(`palette index ${idx} is past the ${palette!.length / 3}-entry palette`);
        rgba[o] = palette![idx * 3]!;
        rgba[o + 1] = palette![idx * 3 + 1]!;
        rgba[o + 2] = palette![idx * 3 + 2]!;
        rgba[o + 3] = paletteAlpha && idx < paletteAlpha.length ? paletteAlpha[idx]! : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = Math.round(sample(cur, x * channels) * scale);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = colorType === 4 ? sample(cur, x * channels + 1) : 255;
      } else {
        rgba[o] = sample(cur, x * channels);
        rgba[o + 1] = sample(cur, x * channels + 1);
        rgba[o + 2] = sample(cur, x * channels + 2);
        rgba[o + 3] = colorType === 6 ? sample(cur, x * channels + 3) : 255;
      }
    }
    onRow(rgba, y);
    const done = prev;
    prev = cur;
    cur = done;
  };

  // Each row is its filter byte then rowBytes of data; the inflate hands them
  // over in pieces that ignore row boundaries.
  let y = 0;
  let filter = -1; // -1 while the next byte is a row's filter byte
  let filled = 0;
  const take = (bytes: Uint8Array): void => {
    let i = 0;
    while (i < bytes.length && y < height) {
      if (filter < 0) {
        filter = bytes[i++]!;
        filled = 0;
        continue;
      }
      const n = Math.min(rowBytes - filled, bytes.length - i);
      // A short copy by hand: a subarray per row is an allocation per row,
      // which made a 1x64000000 image 5x slower than the batch decode.
      if (n < 64) for (let k = 0; k < n; k++) cur[filled + k] = bytes[i + k]!;
      else cur.set(bytes.subarray(i, i + n), filled);
      filled += n;
      i += n;
      if (filled === rowBytes) {
        finishRow(filter, y++);
        filter = -1;
      }
    }
    // Anything past the last row is an encoder's trailing bytes: up to 64 are
    // tolerated and ignored, as libpng does with a warning; the inflate's
    // bound refuses more.
  };
  const inflate = streamingInflateWorks() ? inflateStreaming : inflateBatch;
  // Bounded by what the header declares, plus that slack.
  const produced = inflate(layout.idat, expected + 64, take);
  if (produced < expected) throw new Error('PNG image data is shorter than its header says');
}

/**
 * Decode a non-interlaced PNG to 8-bit RGBA, whole: the decoder's reference
 * form. A capture on its way to the model goes through `decodeShrunkPng`,
 * which never holds the full-size image.
 */
export function decodePng(png: Uint8Array): DecodedImage {
  const layout = readPng(png);
  const whole = new AreaAverage(layout.width, layout.height, Infinity, Infinity);
  decodeRows(layout, (row, y) => whole.addRow(row, y));
  return whole.result();
}

/**
 * Decode a PNG straight to its downscaled form -- `downscaleToWidth`'s sizes
 * and arithmetic, byte for byte -- feeding each row into the average as it is
 * decoded. Peak memory is the output plus a few rows (see decodeRows), so a
 * three-display 18048x3384 capture no longer costs two full-size copies of
 * itself on the way to a 1600x300 picture (#748). With nothing to shrink
 * (within maxWidth and maxHeight) the output is the full-size image, as it
 * always was: for a screenshot, up to 1600x8000, 51 MB.
 */
export function decodeShrunkPng(png: Uint8Array, maxWidth: number, maxHeight = Infinity): DecodedImage & { origWidth: number; origHeight: number } {
  const layout = readPng(png);
  const avg = new AreaAverage(layout.width, layout.height, maxWidth, maxHeight);
  decodeRows(layout, (row, y) => avg.addRow(row, y));
  return { ...avg.result(), origWidth: layout.width, origHeight: layout.height };
}

/**
 * The area-average downscale, fed one source row at a time in order: each
 * target row is the band of source rows sy0..sy1 it covers, so only that
 * band's running sums are held -- `acc`, three per target column -- never the
 * source image. With nothing to shrink it keeps the rows as they come.
 *
 * `acc` is a Float64Array, as the batch version's was, and must stay one:
 * the sums are fractional wherever alpha is not 255 (r * a / 255), and the
 * output has to round exactly as before. It cannot overflow or lose an
 * integer: a cell's sum is at most 255 per source pixel, and a cell is at
 * most the whole image, MAX_DECODE_PIXELS -- 1.6e10, far below 2^53. (An
 * Int32 sum would wrap at 8.4 million pixels a cell.)
 */
class AreaAverage {
  readonly width: number;
  readonly height: number;
  private readonly out: Uint8Array;
  private readonly copy: boolean;
  private readonly x0: Int32Array;
  private readonly acc: Float64Array;
  private dy = 0;
  private sy0 = 0;
  private sy1 = 0;

  constructor(private readonly sw: number, private readonly sh: number, maxWidth: number, maxHeight: number) {
    this.copy = sw <= maxWidth && sh <= maxHeight;
    // Width first, the way the sidecar computes it; then, for an image still
    // taller than maxHeight, the height decides.
    let dw = Math.min(sw, maxWidth);
    let dh = Math.max(1, Math.floor((sh * dw) / sw));
    if (dh > maxHeight) {
      dh = maxHeight;
      dw = Math.max(1, Math.floor((sw * maxHeight) / sh));
    }
    // (Nothing to shrink gives dw = sw and dh = sh already.)
    this.width = dw;
    this.height = dh;
    this.out = new Uint8Array(dw * dh * 4);
    this.x0 = new Int32Array(this.copy ? 0 : dw + 1);
    this.acc = new Float64Array(this.copy ? 0 : dw * 3);
    if (this.copy) return;
    for (let dx = 0; dx <= dw; dx++) this.x0[dx] = Math.floor((dx * sw) / dw);
    this.band();
  }

  /**
   * The source rows target row `dy` covers. dh <= sh (dw <= sw, and the
   * height only shrinks after that), so each band is at least one row and the
   * bands tile 0..sh in order with no gap or overlap: floor((dy+1)*sh/dh) is
   * always past floor(dy*sh/dh).
   */
  private band(): void {
    this.sy0 = Math.floor((this.dy * this.sh) / this.height);
    this.sy1 = Math.max(this.sy0 + 1, Math.floor(((this.dy + 1) * this.sh) / this.height));
  }

  /** Source row `sy` (RGBA, sw pixels); rows must come in order, each once. */
  addRow(row: Uint8Array, sy: number): void {
    if (this.copy) { this.out.set(row, sy * this.sw * 4); return; }
    while (this.dy < this.height && sy >= this.sy1) this.emit();
    if (this.dy >= this.height) return;
    const { x0, acc } = this;
    for (let dx = 0; dx < this.width; dx++) {
      const end = Math.max(x0[dx]! + 1, x0[dx + 1]!);
      let r = 0, g = 0, b = 0;
      for (let sx = x0[dx]!; sx < end; sx++) {
        const p = sx * 4;
        const a = row[p + 3]!;
        if (a === 255) { r += row[p]!; g += row[p + 1]!; b += row[p + 2]!; }
        else { r += (row[p]! * a) / 255; g += (row[p + 1]! * a) / 255; b += (row[p + 2]! * a) / 255; }
      }
      acc[dx * 3] = acc[dx * 3]! + r;
      acc[dx * 3 + 1] = acc[dx * 3 + 1]! + g;
      acc[dx * 3 + 2] = acc[dx * 3 + 2]! + b;
    }
  }

  /** Write target row dy from its band's sums, and start the next band. */
  private emit(): void {
    const { x0, acc, out, dy } = this;
    for (let dx = 0; dx < this.width; dx++) {
      const n = (Math.max(x0[dx]! + 1, x0[dx + 1]!) - x0[dx]!) * (this.sy1 - this.sy0);
      const o = (dy * this.width + dx) * 4;
      out[o] = Math.round(acc[dx * 3]! / n);
      out[o + 1] = Math.round(acc[dx * 3 + 1]! / n);
      out[o + 2] = Math.round(acc[dx * 3 + 2]! / n);
      out[o + 3] = 255;
    }
    acc.fill(0);
    this.dy++;
    if (this.dy < this.height) this.band();
  }

  /** The finished image, once every source row has been added. */
  result(): DecodedImage {
    if (!this.copy) while (this.dy < this.height) this.emit();
    return { width: this.width, height: this.height, rgba: this.out };
  }
}

/**
 * Downscale to at most `maxWidth` wide, keeping the aspect ratio the way the
 * sidecar computes it (integer height), averaging every source pixel a target
 * pixel covers. Alpha is composited over black, which is what Go's JPEG encoder
 * does with the sidecar's RGBA canvas. Never upscales.
 */
export function downscaleToWidth(img: DecodedImage, maxWidth: number, maxHeight = Infinity): DecodedImage {
  const { width: sw, height: sh, rgba } = img;
  if (sw <= maxWidth && sh <= maxHeight) return img;
  const avg = new AreaAverage(sw, sh, maxWidth, maxHeight);
  for (let sy = 0; sy < sh; sy++) avg.addRow(rgba.subarray(sy * sw * 4, (sy + 1) * sw * 4), sy);
  return avg.result();
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
  if (!Number.isFinite(quality)) throw new Error(`JPEG quality ${quality} is not a number`);
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

/**
 * Forward DCT of one level-shifted 8x8 block, quantised into natural order.
 * `tmp` is the row pass's scratch, owned by the caller (one per encode), so no
 * state is shared between encodes whatever runs between them.
 */
function fdctQuantize(block: Float64Array, quant: number[], out: Int32Array, tmp: Float64Array): void {
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
  // A category outside the table would be written as raw, unprefixed bits:
  // a corrupt stream rather than an error. Unreachable for 8-bit samples.
  if (!dc.size[cat]) throw new Error(`DC difference ${diff} is outside the baseline JPEG range`);
  w.bits(dc.code[cat]!, dc.size[cat]!);
  if (cat) w.bits(diff < 0 ? diff - 1 : diff, cat);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = coeffs[ZIGZAG[k]!]!;
    if (v === 0) { run++; continue; }
    while (run > 15) { w.bits(ac.code[0xf0]!, ac.size[0xf0]!); run -= 16; }
    const c = magnitudeCategory(v);
    const sym = (run << 4) | c;
    if (!ac.size[sym]) throw new Error(`AC coefficient ${v} is outside the baseline JPEG range`);
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
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new Error(`cannot encode a ${width}x${height} JPEG`);
  }
  if (rgba.length !== width * height * 4) throw new Error(`the RGBA buffer holds ${rgba.length} bytes, not ${width}x${height}x4`);
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
  const dctTmp = new Float64Array(64);
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
          fdctQuantize(yBlk, lq, coeffs, dctTmp);
          dcY = encodeBlock(w, coeffs, dcY, dcL, acL);
        }
      }
      fdctQuantize(cbBlk, cq, coeffs, dctTmp);
      dcCb = encodeBlock(w, coeffs, dcCb, dcC, acC);
      fdctQuantize(crBlk, cq, coeffs, dctTmp);
      dcCr = encodeBlock(w, coeffs, dcCr, dcC, acC);
    }
  }
  w.flushBits();
  w.bytes([0xff, 0xd9]);
  return w.result();
}

/**
 * Whether a PNG's header declares a side longer than MAX_IMAGE_SIDE. Reads
 * only the IHDR (decoded from the first 32 base64 characters); anything that
 * is not a readable PNG header is left to the decoder to refuse.
 */
function sideTooLong(base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 32), 'base64');
  if (head.length < 24 || PNG_SIGNATURE.some((b, i) => head[i] !== b)) return false;
  return Math.max(head.readUInt32BE(16), head.readUInt32BE(20)) > MAX_IMAGE_SIDE;
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
  if (!tooBigToSend(block) && !(mediaType === 'image/png' && sideTooLong(base64))) return { ok: true, block, compacted: false };
  if (mediaType !== 'image/png') return { ok: false, reason: `the capture is ${mediaType}, which cannot be compacted here` };
  const bytes = Buffer.from(base64, 'base64');
  let jpeg: Uint8Array;
  let small: ReturnType<typeof decodeShrunkPng>;
  try {
    // Straight to the shrunk size, never the full-size image (#748).
    small = decodeShrunkPng(bytes, SCREENSHOT_COMPACT.maxWidth, MAX_IMAGE_SIDE);
    jpeg = encodeJpeg(small, SCREENSHOT_COMPACT.jpegQuality);
  } catch (err) {
    return { ok: false, reason: `it could not be compacted (${err instanceof Error ? err.message : String(err)})` };
  }
  const compact: ContentBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') } };
  if (tooBigToSend(compact)) return { ok: false, reason: 'it is too large to send even after compacting it' };
  return { ok: true, block: compact, compacted: true, width: small.width, height: small.height, origWidth: small.origWidth, origHeight: small.origHeight };
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
