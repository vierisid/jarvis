import { describe, expect, test } from 'bun:test';
import { NOTCH_TALK_EVENT, attachNotchTalk, pcmToWav, notchTalkSignOff } from './talk.ts';
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
    words: (id, text, more) => { calls.push(`words ${id} "${text}"${more?.cut ? ' cut' : ''}`); },
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
  test('after stop nothing the desktop app says of the keys is heard, and a recording that was open is not dropped by its limit', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.talk.stop();
    expect(h.talk.open('pc')).toBe(false);
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900, duration_ms: 1500 }, true);
    h.event({ phase: 'start', talk_id: 'a2' });
    h.event({ phase: 'refused', reason: 'muted' });
    h.disconnect();
    // Past the open recording's limit (40 ms here).
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    expect(h.calls).toEqual(['listen pc:a1']);
  });

  test('a recording still being made into words when the notch stops reaches nothing, words or failure', async () => {
    for (const ends of ['words', 'failure'] as const) {
      let answer: (words: string) => void = () => {};
      let fail: (error: Error) => void = () => {};
      const h = harness(() => ({ transcribe: () => new Promise<string>((resolve, reject) => { answer = resolve; fail = reject; }) }));
      h.event({ phase: 'start', talk_id: 'a1' });
      h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900, duration_ms: 1500, sample_rate: 16000 }, true);
      await settle();
      h.talk.stop();
      if (ends === 'words') answer('send Leo the numbers'); else fail(new Error('the service went away'));
      await settle();
      expect([ends, h.calls]).toEqual([ends, ['listen pc:a1', 'released pc:a1']]);
    }
  });

  test('stopped while the look of the same hold is being fetched: the dropped files are not claimed, and nothing is asked', async () => {
    const calls: string[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void = () => {};
    let files: (found: null) => void = () => {};
    const talk = attachNotchTalk({ onEvent: (listener) => { onEvent = listener; } }, {
      asks: {
        listen: (id) => { calls.push(`listen ${id}`); return id; }, released: () => true,
        words: (id) => { calls.push(`words ${id}`); }, nothing: (id) => { calls.push(`nothing ${id}`); }, dropped: () => {}, tell: () => {},
      },
      stt: () => ({ transcribe: async () => 'what is this' }),
      look: { during: () => true, alone: () => {}, files: () => new Promise((resolve) => { files = resolve; }) },
      held: () => { calls.push('held claimed'); return []; },
      log: () => {},
    });
    const pcm = Buffer.alloc(16_000 * 2, 1).toString('base64');
    onEvent('pc', { event_type: NOTCH_TALK_EVENT, payload: { phase: 'start', talk_id: 'a1' } });
    onEvent('pc', { event_type: NOTCH_TALK_EVENT, payload: { phase: 'end', talk_id: 'a1', voiced_ms: 900, duration_ms: 1500 }, binary: { type: 'inline', data: pcm } });
    await settle();
    talk.stop();
    files(null);
    await settle();
    expect(calls).toEqual(['listen pc:a1']);
  });

  test('what is pretended stops with the notch: neither its release nor its words come after stop', async () => {
    const h = harness();
    h.talk.pretend('send Leo the numbers');
    h.talk.stop();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(h.calls.filter((call) => !call.startsWith('listen '))).toEqual([]);
    h.talk.pretend('again');
    expect(h.calls).toHaveLength(1);
  });

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

  test('a recording that ran into the limit is made into words, marked as cut short', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 50_000, reason: 'cap' }, true);
    await settle();
    // The minute is not thrown away, and is not taken as a whole instruction either.
    expect(h.calls.at(-1)).toBe('words pc:a1 "send Leo the numbers" cut');
  });

  test('from a desktop app that sends no sound at the limit, it is said to have been too long', async () => {
    const h = harness();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 50_000, reason: 'cap' });
    await settle();
    expect(h.calls.at(-1)).toBe('nothing pc:a1 too_long');
  });

  test('a video sign-off or a subtitle credit is never an instruction, in any language or at any length', async () => {
    for (const line of [
      'Kiitos kun katsoit videon ja olkaa hyvää iltapäivää!', 'Thanks for watching!', 'Thank you so much for watching, see you next time.',
      'Sottotitoli creati dalla comunità Amara.org', 'Subtitles by the Amara.org community', "Merci d'avoir regardé cette vidéo !",
      'Gracias por ver el video.', 'Vielen Dank fürs Zuschauen!', 'Спасибо за просмотр!', 'ご視聴ありがとうございました', '시청해주셔서 감사합니다.', 'Please subscribe to my channel.',
    ]) {
      const h = harness(() => ({ transcribe: async () => line }));
      h.event({ phase: 'start', talk_id: 'a1' });
      // Plenty of voice: the short-recording rule does not apply here.
      h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 2400, duration_ms: 3000 }, true);
      await settle();
      expect([line, h.calls.at(-1)]).toEqual([line, 'nothing pc:a1 silence']);
    }
    // What a person asks is not one of them, also when it holds the same words.
    for (const line of ['Open Steam.', 'Thanks, now close Notepad.', 'Write a subtitle for this video.', 'Kiitos, avaa Notepad.', 'Parli italiano?']) {
      expect([line, notchTalkSignOff(line)]).toEqual([line, false]);
    }
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

describe('what speech-to-text writes when there were no words', () => {
  test('a stock line from a one-word recording is not an instruction; from a longer one it is what was said', async () => {
    const h = harness(() => ({ transcribe: async () => 'Thank you.' }));
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 300 }, true);
    await settle();
    expect(h.calls.at(-1)).toBe('nothing pc:a1 silence');
    h.event({ phase: 'start', talk_id: 'a2' });
    h.event({ phase: 'end', talk_id: 'a2', voiced_ms: 1500 }, true);
    await settle();
    expect(h.calls.at(-1)).toBe('words pc:a2 "Thank you."');
  });

  test('a real short word is kept', async () => {
    const h = harness(() => ({ transcribe: async () => 'Stop.' }));
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 200 }, true);
    await settle();
    expect(h.calls.at(-1)).toBe('words pc:a1 "Stop."');
  });
});

// Pass 9: a thing is circled with the same keys held that open the microphone.
describe('a hold of the keys in which something was looked at', () => {
  function withLook(stt: NotchTalkDeps['stt'] = () => ({ transcribe: async () => 'is this one late' }), looking = true) {
    const calls: string[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void = () => {};
    let gone: (sidecarId: string) => void = () => {};
    const asks: NotchTalkDeps['asks'] = {
      listen: (id) => { calls.push(`listen ${id}`); return id; },
      released: (id) => { calls.push(`released ${id}`); return true; },
      words: (id, text, more) => { calls.push(`words ${id} "${text}"${more?.cut ? ' cut' : ''} with ${(more?.files ?? []).map((file) => file.name).join('+') || 'nothing'}`); },
      nothing: (id, why) => { calls.push(`nothing ${id} ${why}`); },
      dropped: (id) => { calls.push(`dropped ${id}`); },
      tell: () => {},
    };
    const sinces: number[] = [];
    let at = 10_000;
    const talk = attachNotchTalk(
      { onEvent: (listener) => { onEvent = listener; }, onSidecarDisconnected: (listener) => { gone = listener; } },
      {
        asks, stt, openMs: 40, now: () => at, log: () => {},
        look: {
          during: (sidecarId, since) => { sinces.push(since); return looking && sidecarId === 'pc'; },
          alone: (sidecarId) => { calls.push(`look alone ${sidecarId}`); },
          files: async (sidecarId) => { calls.push(`look files ${sidecarId}`); return [{ kind: 'document', name: 'circled-on-screen.txt', mediaType: 'text/plain', bytes: new Uint8Array([1]) }]; },
        },
      });
    const pcm = Buffer.alloc(16_000 * 2, 1).toString('base64');
    return {
      calls, talk, sinces, later: (ms: number) => { at += ms; }, disconnect: () => gone('pc'),
      event: (payload: Record<string, unknown>, audio = false, sidecarId = 'pc'): void =>
        onEvent(sidecarId, { event_type: NOTCH_TALK_EVENT, payload, ...(audio ? { binary: { type: 'inline', mime_type: 'audio/pcm', data: pcm } } : {}) }),
    };
  }

  test('and nothing was said: it is not "I did not catch that". The line leaves and the look answers', async () => {
    const h = withLook();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.later(2000);
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 0, duration_ms: 2000 }, true);
    h.event({ phase: 'start', talk_id: 'a2' });
    h.event({ phase: 'end', talk_id: 'a2', voiced_ms: 90, duration_ms: 900 }, true);
    await settle();
    expect(h.calls).toEqual([
      'listen pc:a1', 'released pc:a1', 'dropped pc:a1', 'look alone pc',
      'listen pc:a2', 'released pc:a2', 'dropped pc:a2', 'look alone pc',
    ]);
    // A click is quicker than the keys become talking: a look begun a moment before the recording opened is that hold's too.
    expect(h.sinces[0]).toBe(10_000 - 1500);
  });

  test('and something was said: the words carry what was circled', async () => {
    const h = withLook();
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900, duration_ms: 1500, sample_rate: 16000 }, true);
    await settle();
    expect(h.calls).toEqual(['listen pc:a1', 'released pc:a1', 'look files pc', 'words pc:a1 "is this one late" with circled-on-screen.txt']);
  });

  // The owner, 16 November 2026: "I circle the installs number and ask, how many of these were in the last
  // two days? It disregards my question and still asks what the number means." What he circled reached the
  // brain while his words were still with speech-to-text: no recording was open, so the look answered alone.
  test('the keys are up and the words are not in yet: the recording still counts as open, so a look told now waits for them', async () => {
    let write: (words: string) => void = () => {};
    const h = withLook(() => ({ transcribe: () => new Promise<string>((resolve) => { write = resolve; }) }));
    expect(h.talk.open('pc')).toBe(false);
    h.event({ phase: 'start', talk_id: 'a1' });
    expect(h.talk.open('pc')).toBe(true);
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 1900, duration_ms: 5600, sample_rate: 16000 }, true);
    await settle();
    // With speech-to-text. Nothing has been decided about the look.
    expect(h.talk.open('pc')).toBe(true);
    expect(h.talk.open('other')).toBe(false);
    expect(h.calls).toEqual(['listen pc:a1', 'released pc:a1']);
    write('how many of these were in the last two days');
    await settle();
    expect(h.calls).toEqual(['listen pc:a1', 'released pc:a1', 'look files pc', 'words pc:a1 "how many of these were in the last two days" with circled-on-screen.txt']);
    expect(h.talk.open('pc')).toBe(false);
  });

  test('speech-to-text that fails or says nothing does not leave the recording open', async () => {
    const down = withLook(() => ({ transcribe: async () => { throw new Error('down'); } }));
    down.event({ phase: 'start', talk_id: 'a1' });
    down.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900, duration_ms: 1500 }, true);
    await settle();
    expect(down.talk.open('pc')).toBe(false);
    const quiet = withLook(() => ({ transcribe: async () => '' }));
    quiet.event({ phase: 'start', talk_id: 'a1' });
    quiet.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900, duration_ms: 1500 }, true);
    await settle();
    expect(quiet.talk.open('pc')).toBe(false);
  });

  test('speech-to-text wrote only a stock line: that is nothing said, and the look answers', async () => {
    const h = withLook(() => ({ transcribe: async () => 'Thank you.' }));
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 300, duration_ms: 900 }, true);
    await settle();
    expect(h.calls).toEqual(['listen pc:a1', 'released pc:a1', 'dropped pc:a1', 'look alone pc']);
  });

  test('the words were lost, not absent: that is said, and the look still has its line', async () => {
    const h = withLook(() => ({ transcribe: async () => { throw new Error('down'); } }));
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 900, duration_ms: 1500 }, true);
    await settle();
    expect(h.calls).toEqual(['listen pc:a1', 'released pc:a1', 'nothing pc:a1 failed', 'look alone pc']);
  });

  test('a slip of the keys after the circle, or a desktop app that goes away: the recording is dropped and the look is not left waiting', () => {
    const slip = withLook();
    slip.event({ phase: 'start', talk_id: 'a1' });
    slip.event({ phase: 'cancelled', talk_id: 'a1' });
    expect(slip.calls).toEqual(['listen pc:a1', 'dropped pc:a1', 'look alone pc']);
    const away = withLook();
    away.event({ phase: 'start', talk_id: 'a1' });
    away.disconnect();
    expect(away.calls).toEqual(['listen pc:a1', 'dropped pc:a1', 'look alone pc']);
  });

  test('with no look in that hold everything is as it was', async () => {
    const h = withLook(undefined, false);
    h.event({ phase: 'start', talk_id: 'a1' });
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 0, duration_ms: 2000 }, true);
    h.event({ phase: 'start', talk_id: 'a2' });
    h.event({ phase: 'end', talk_id: 'a2', voiced_ms: 900, duration_ms: 1500 }, true);
    await settle();
    expect(h.calls).toEqual(['listen pc:a1', 'released pc:a1', 'nothing pc:a1 silence', 'listen pc:a2', 'released pc:a2', 'words pc:a2 "is this one late" with nothing']);
  });

  test('says whether a recording is open on a desktop app', () => {
    const h = withLook();
    expect(h.talk.open('pc')).toBe(false);
    h.event({ phase: 'start', talk_id: 'a1' });
    expect(h.talk.open('pc')).toBe(true);
    expect(h.talk.open('laptop')).toBe(false);
    h.event({ phase: 'end', talk_id: 'a1', voiced_ms: 0 }, true);
    expect(h.talk.open('pc')).toBe(false);
  });
});
