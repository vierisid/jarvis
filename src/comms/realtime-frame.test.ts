import { describe, expect, test } from 'bun:test';
import { REALTIME_PCM_TAG, tagRealtimePcm, untagRealtimePcm } from './realtime-frame.ts';

const bytes = (u: Uint8Array) => [...u];

describe('realtime PCM wire tag', () => {
  test('a tagged frame round-trips to the original PCM', () => {
    const pcm = new Uint8Array([10, 0, 246, 255, 0, 16]);
    const tagged = tagRealtimePcm(pcm);
    const back = untagRealtimePcm(tagged.slice().buffer);
    expect(back).not.toBeNull();
    expect(bytes(new Uint8Array(back!))).toEqual(bytes(pcm));
  });

  test('encoded TTS is never mistaken for realtime PCM', () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]); // ID3
    const wav = new TextEncoder().encode('RIFF....WAVE');
    const sync = new Uint8Array([0xff, 0xfb, 0x90, 0x64]); // MP3 frame sync
    for (const frame of [mp3, wav, sync]) expect(untagRealtimePcm(frame.slice().buffer)).toBeNull();
  });

  test('a frame shorter than the tag is not realtime PCM', () => {
    expect(untagRealtimePcm(new Uint8Array([0x01, 0x00]).buffer)).toBeNull();
    expect(untagRealtimePcm(new ArrayBuffer(0))).toBeNull();
  });

  test('the tag keeps 16-bit sample alignment and is near-silent as PCM', () => {
    expect(REALTIME_PCM_TAG.length % 2).toBe(0);
    const asSamples = new Int16Array(REALTIME_PCM_TAG.slice().buffer);
    for (const s of asSamples) expect(Math.abs(s)).toBeLessThanOrEqual(1);
  });

  test('a tagged empty frame untags to an empty payload', () => {
    const back = untagRealtimePcm(tagRealtimePcm(new Uint8Array(0)).slice().buffer);
    expect(back?.byteLength).toBe(0);
  });
});
