/**
 * PCM conversion helpers for premium realtime voice (gpt-realtime-2).
 *
 * The realtime path streams raw PCM signed-16 little-endian mono both ways
 * (OpenAI requires >= 24 kHz). These pure functions convert between the
 * Float32 samples Web Audio produces/consumes and the s16 wire format. Kept
 * framework-free so they're unit-testable without a browser.
 *
 * See docs/GPT_REALTIME_2_INTEGRATION.md §4 Phase 4c.
 */

/** Float32 [-1,1] samples → little-endian PCM s16 ArrayBuffer. */
export function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(input.length * 2);
  const view = new DataView(out);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Little-endian PCM s16 ArrayBuffer → Float32 [-1,1] samples. */
export function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(buffer);
  const n = Math.floor(buffer.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

/**
 * Linear-interpolation resample of mono Float32 audio. Used as a fallback when
 * an AudioContext can't be forced to the target rate. No-op when rates match.
 */
export function resampleFloat32(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}
