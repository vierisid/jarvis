import { test, expect, describe } from 'bun:test';
import { foldTranscript, newTranscriptAccumulator } from './pebble-realtime.ts';

describe('foldTranscript', () => {
  test('assistant deltas accumulate — fragments are not cumulative text', () => {
    const acc = newTranscriptAccumulator();
    const first = foldTranscript(acc, { role: 'assistant', text: 'Sure,', final: false }, 1000);
    expect(first).toEqual({ state: 'speaking', text: 'Sure,' });
    // Within the throttle window: buffered, not emitted.
    expect(foldTranscript(acc, { role: 'assistant', text: ' here', final: false }, 1100)).toBeNull();
    expect(foldTranscript(acc, { role: 'assistant', text: ' it', final: false }, 1200)).toBeNull();
    // Past the throttle window: the full buffer so far, not just the last fragment.
    const later = foldTranscript(acc, { role: 'assistant', text: ' is.', final: false }, 1500);
    expect(later).toEqual({ state: 'speaking', text: 'Sure, here it is.' });
  });

  test('assistant final always emits the complete utterance', () => {
    const acc = newTranscriptAccumulator();
    foldTranscript(acc, { role: 'assistant', text: 'Sure,', final: false }, 1000);
    foldTranscript(acc, { role: 'assistant', text: ' here', final: false }, 1050);
    // Final arrives inside the throttle window and still emits, with the
    // event's own full text (the .done payload carries the whole transcript).
    const fin = foldTranscript(acc, { role: 'assistant', text: 'Sure, here you go.', final: true }, 1100);
    expect(fin).toEqual({ state: 'speaking', text: 'Sure, here you go.' });
    // Buffer reset: the next utterance starts clean.
    const next = foldTranscript(acc, { role: 'assistant', text: 'Also,', final: false }, 1200);
    expect(next).toEqual({ state: 'speaking', text: 'Also,' });
  });

  test('user final flips to listening and resets the buffer', () => {
    const acc = newTranscriptAccumulator();
    foldTranscript(acc, { role: 'assistant', text: 'Hello', final: false }, 1000);
    const user = foldTranscript(acc, { role: 'user', text: 'stop', final: true }, 1100);
    expect(user).toEqual({ state: 'listening' });
    expect(acc.buffer).toBe('');
  });

  test('user deltas emit nothing', () => {
    const acc = newTranscriptAccumulator();
    expect(foldTranscript(acc, { role: 'user', text: 'he', final: false }, 1000)).toBeNull();
  });
});
