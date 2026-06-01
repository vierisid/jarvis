import { test, expect, describe } from "bun:test";
import { floatTo16BitPCM, pcm16ToFloat32, resampleFloat32 } from "./pcm.ts";

describe("PCM conversion", () => {
  test("floatTo16BitPCM produces 2 bytes per sample, little-endian", () => {
    const buf = floatTo16BitPCM(new Float32Array([0, 1, -1]));
    expect(buf.byteLength).toBe(6);
    const v = new DataView(buf);
    expect(v.getInt16(0, true)).toBe(0);
    expect(v.getInt16(2, true)).toBe(32767); // +1 → 0x7fff
    expect(v.getInt16(4, true)).toBe(-32768); // -1 → -0x8000
  });

  test("clamps out-of-range samples", () => {
    const buf = floatTo16BitPCM(new Float32Array([2, -2]));
    const v = new DataView(buf);
    expect(v.getInt16(0, true)).toBe(32767);
    expect(v.getInt16(2, true)).toBe(-32768);
  });

  test("round-trips float → pcm16 → float within quantization error", () => {
    const input = new Float32Array([0, 0.5, -0.5, 0.25, -0.999]);
    const back = pcm16ToFloat32(floatTo16BitPCM(input));
    expect(back.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(back[i]! - input[i]!)).toBeLessThan(0.0001);
    }
  });

  test("pcm16ToFloat32 handles odd byte length by truncating", () => {
    const out = pcm16ToFloat32(new ArrayBuffer(5)); // 2 full samples + 1 stray byte
    expect(out.length).toBe(2);
  });

  describe("resampleFloat32", () => {
    test("returns input unchanged when rates match", () => {
      const input = new Float32Array([0.1, 0.2, 0.3]);
      expect(resampleFloat32(input, 24000, 24000)).toBe(input);
    });

    test("downsamples 48k → 24k to ~half the samples", () => {
      const input = new Float32Array(480);
      const out = resampleFloat32(input, 48000, 24000);
      expect(out.length).toBe(240);
    });

    test("upsamples 16k → 24k to ~1.5x samples", () => {
      const input = new Float32Array(160);
      const out = resampleFloat32(input, 16000, 24000);
      expect(out.length).toBe(240);
    });

    test("preserves endpoints", () => {
      const input = new Float32Array([1, 0, 0, 0, 1]);
      const out = resampleFloat32(input, 16000, 24000);
      expect(out[0]).toBeCloseTo(1, 5);
    });
  });
});
