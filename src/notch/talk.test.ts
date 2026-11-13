import { describe, expect, test } from 'bun:test';
import { NOTCH_TALK_EVENT, attachNotchTalk, pcmToWav } from './talk.ts';
import type { NotchTalkDeps } from './talk.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(stt: NotchTalkDeps['stt'] = () => ({ transcribe: async () => 'send Leo the numbers' }), sttTimeoutMs?: number) {
  const calls: string[] = [];
  const logs: string[] = [];
  const turnedAway = new Set<string>();
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void = () => {};
  const asks: NotchTalkDeps['asks'] = {
    listen: (id) => { calls.push(`listen ${id}`); return id; },
    released: (id) => { calls.push(`released ${id}`); return !turnedAway.has(id); },
    words: (id, text) => { calls.push(`words ${id} "${text}"`); },
    nothing: (id, why) => { calls.push(`nothing ${id} ${why}`); },
    dropped: (id) => { calls.push(`dropped ${id}`); },
    tell: (parts) => { calls.push(`tell ${parts.join('')}`); },
  };
  let gone: (sidecarId: string) => void = () => {};
  const talk = attachNotchTalk(
    { onEvent: (listener) => { onEvent = listener; }, onSidecarDisconnected: (listener) => { gone = listener; } },
    { asks, stt, sttTimeoutMs, openMs: 40, log: (line) => logs.push(line) });
  const pcm = Buffer.alloc(16_000 * 2, 1).toString('base64');
  return {
    calls, logs, talk, turnedAway, disconnect: (sidecarId = 'pc') => gone(sidecarId),
    event: (payload: Record<string, unknown>, audio = false, sidecarId = 'pc'): void =>
      onEvent(sidecarId, { event_type: NOTCH_TALK_EVENT, payload, ...(audio ? { binary: { type: 'inline', mime_type: 'audio/pcm', data: pcm } } : {}) }),
  };
}

describe('a recording from the desktop app', () => {
  test('start, then end with enough speech: the words reach the instruction with that id', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900, duration_ms: 1500, sample_rate: 16000, reason: 'released' }, true);
    await settle();
    expect(h.calls).toEqual(['listen pc:a1', 'released pc:a1', 'words pc:a1 "send Leo the numbers"']);
    // The words are never in the log.
    expect(h.logs.join('\n')).not.toContain('Leo');
  });

  test('silence and too little are never sent to be transcribed', async () => {
    let transcribed = 0;
    const h = harness(() => ({ transcribe: async () => { transcribed++; return 'x'; } }));
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 0, duration_ms: 3000 }, true);
    h.event({ phase: 'start', talk_id: 'a2' });
    h.event({ phase: 'end', talk_id: 'a2', voiced_ms: 120, duration_ms: 300 }, true);
    h.event({ phase: 'start', talk_id: 'a3' });
    h.event({ phase: 'end', talk_id: 'a3', voiced_ms: 900, duration_ms: 1500 });
    await settle();
    expect(transcribed).toBe(0);
    expect(h.calls.filter((call) => call.startsWith('nothing'))).toEqual(['nothing pc:a1 silence', 'nothing pc:a2 too_little', 'nothing pc:a3 too_little']);
  });

  test('an end for a recording that is not the open one is dropped unread', async () => {
    let transcribed = 0;
    const h = harness(() => ({ transcribe: async () => { transcribed++; return 'delete everything'; } }));
    // Never started.
    h.event({ phase: 'end', talk_id: 'ghost', voiced_ms: 900 }, true);
    // Started, replaced by a newer one, and then its audio arrives.
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'start', talk_id: 'a2' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900 }, true);
    // Ended once already.
    h.event({ phase: 'end', talk_id: 'a2', voiced_ms: 900 }, true);
    h.event({ phase: 'end', talk_id: 'a2', voiced_ms: 900 }, true);
    await settle();
    expect(transcribed).toBe(1);
    expect(h.calls).toEqual(['listen pc:a1', 'dropped pc:a1', 'listen pc:a2', 'released pc:a2', 'words pc:a2 "delete everything"']);
  });

  test('turned away on the notch while the keys were still held: its sound is never transcribed', async () => {
    let transcribed = 0;
    const h = harness(() => ({ transcribe: async () => { transcribed++; return 'delete everything'; } }));
    h.event({ phase: 'start', talk_id: 'a1' });
    h.turnedAway.add('pc:a1');
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900 }, true);
    await settle();
    expect(transcribed).toBe(0);
    expect(h.calls).toEqual(['listen pc:a1', 'released pc:a1']);
  });

  test('cancelled where it was made: dropped, nothing transcribed', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'cancelled', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900 }, true);
    await settle();
    expect(h.calls).toEqual(['listen pc:a1', 'dropped pc:a1']);
  });

  test('no speech-to-text, a failure, a timeout and words that are only punctuation all end as nothing caught', async () => {
    const cases: [NotchTalkDeps['stt'], string, number?][] = [
      [() => null, 'no_stt'],
      [() => ({ transcribe: async () => { throw new Error('401'); } }), 'failed'],
      [() => ({ transcribe: () => new Promise<string>(() => {}) }), 'failed', 20],
      [() => ({ transcribe: async () => ' ... ' }), 'silence'],
    ];
    for (const [stt, why, timeout] of cases) {
      const h = harness(stt, timeout);
      h.event({ phase: 'start', talk_id: 'a1' });
      h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900 }, true);
      await new Promise((resolve) => setTimeout(resolve, timeout ? 60 : 0));
      await settle();
      expect(h.calls.at(-1)).toBe(`nothing pc:a1 ${why}`);
    }
  });

  test('a recording that ran into the limit is not acted on', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 50_000, reason: 'cap' }, true);
    await settle();
    expect(h.calls.at(-1)).toBe('nothing pc:a1 too_long');
  });

  test('a refused microphone says why', () => {
    const h = harness();
    h.event({ phase: 'refused', reason: 'muted' });
    h.event({ phase: 'refused', reason: 'something new' });
    expect(h.calls).toEqual([
      'tell The microphone is muted. Unmute it from the tray icon, then hold the keys again.',
      'tell I could not open the microphone.',
    ]);
  });

  test('two desktop apps keep their recordings apart', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' }, false, 'pc');
    h.event({ phase: 'start', talk_id: 'a1' }, false, 'mac');
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900 }, true, 'mac');
    await settle();
    expect(h.calls).toEqual(['listen pc:a1', 'listen mac:a1', 'released mac:a1', 'words mac:a1 "send Leo the numbers"']);
  });

  test('a bad id is not an id', () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: '../../x' });
    h.event({ phase: 'start' });
    expect(h.calls).toEqual([]);
  });
});

test('the WAV header says what the audio is', () => {
  const wav = pcmToWav(Buffer.alloc(100), 16_000);
  expect(wav.length).toBe(144);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav.readUInt32LE(40)).toBe(100);
});

describe('a recording whose microphone goes away', () => {
  test('the desktop app disconnects while the keys are held: the recording is dropped and the line leaves', () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.disconnect();
    expect(h.calls).toEqual(['listen pc:a1', 'dropped pc:a1']);
    // Its end, arriving after a reconnect, is nothing.
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900 }, true);
    expect(h.calls).toHaveLength(2);
  });

  test('no end ever arrives: it does not stay listening for ever', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(h.calls).toEqual(['listen pc:a1', 'dropped pc:a1']);
  });

  test('a recording that ended in time is not dropped afterwards', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900 }, true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(h.calls.filter((call) => call.startsWith('dropped'))).toEqual([]);
  });
});
