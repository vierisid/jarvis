/**
 * Speaking to the notch: the desktop app's recordings, made into words.
 *
 * The desktop app owns the microphone. It opens it when the talk keys go down
 * and closes it when they come up, and tells the brain with one event type,
 * `notch.talk`, in four phases:
 *
 *   start      the keys are down and the microphone is open        {talk_id}
 *   end        the keys came up: here is the recording             {talk_id, voiced_ms, duration_ms, sample_rate, reason} + audio
 *   cancelled  the recording was thrown away where it was made     {talk_id}
 *   refused    the microphone could not be opened                  {reason}
 *
 * Every recording has an id made where the microphone was opened, and that id
 * is all that ties its audio to an instruction (./asks.ts). An `end` whose id
 * is not the recording that is open is dropped unread. That, with the ledger,
 * is why a recording that was turned away can never run: nothing here looks
 * up "the latest" anything.
 *
 * Too little speech (the desktop app counts the voiced milliseconds) is never
 * sent to be transcribed. Transcription has its own time limit, because four
 * of the five providers have none. Words that are only punctuation are not
 * words. Each of these ends in the same sentence on the notch.
 *
 * Neither the audio nor the words are in an event's payload: payloads are not
 * private (see the skip list where sidecar events are broadcast).
 */
import { hasSpokenContent } from '../voice/wake-phrase.ts';
import type { NotchAsks } from './asks.ts';

export const NOTCH_TALK_EVENT = 'notch.talk';
/** Less voiced sound than this is not an instruction: nothing is transcribed. */
export const NOTCH_TALK_MIN_VOICED_MS = 250;
/** How long a transcription may take before it counts as failed. */
export const NOTCH_STT_TIMEOUT_MS = 20_000;

export interface NotchTalkPort {
  onEvent(listener: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void): void;
}

export interface NotchTalkDeps {
  asks: Pick<NotchAsks, 'listen' | 'released' | 'words' | 'nothing' | 'dropped' | 'tell'>;
  /** Speech-to-text as it is set up now, or null when it is not. */
  stt(): { transcribe(audio: Buffer): Promise<string> } | null;
  sttTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface NotchTalk {
  /**
   * For the hand test and the end-to-end run: goes through everything after
   * the microphone as if `words` had just been transcribed. Null is a
   * recording in which nothing was caught.
   */
  pretend(words: string | null): void;
}

/** Raw 16-bit PCM in the smallest WAV there is, which is what the providers take. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const REFUSALS: Record<string, string> = {
  muted: 'The microphone is muted. Unmute it from the tray icon, then hold the keys again.',
  busy: 'The microphone is already in use by Jarvis. Try again in a moment.',
  none: 'This desktop app has no microphone path. Type instead.',
};

export function attachNotchTalk(port: NotchTalkPort, deps: NotchTalkDeps): NotchTalk {
  const log = deps.log ?? ((line: string) => console.log(line));
  const timeoutMs = deps.sttTimeoutMs ?? NOTCH_STT_TIMEOUT_MS;
  /** The recordings whose microphone is open now, by desktop app. */
  const open = new Map<string, string>();
  const key = (sidecarId: string, talkId: string): string => `${sidecarId}:${talkId}`;

  async function transcribe(talkKey: string, pcm: Buffer, sampleRate: number): Promise<void> {
    const provider = deps.stt();
    if (!provider) { deps.asks.nothing(talkKey, 'no_stt'); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const words = await Promise.race([
        provider.transcribe(pcmToWav(pcm, sampleRate)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs); }),
      ]);
      const said = (words ?? '').trim();
      // The length, never the words: a log is not the place for what was said.
      log(`[notch] a recording was made into ${said.length} characters`);
      if (hasSpokenContent(said)) deps.asks.words(talkKey, said); else deps.asks.nothing(talkKey, 'silence');
    } catch (error) {
      log(`[notch] a recording could not be made into words: ${error instanceof Error ? error.message : String(error)}`);
      deps.asks.nothing(talkKey, 'failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  port.onEvent((sidecarId, event) => {
    if (event.event_type !== NOTCH_TALK_EVENT) return;
    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
    const phase = payload.phase;
    if (phase === 'refused') {
      const reason = typeof payload.reason === 'string' ? payload.reason : '';
      log(`[notch] the microphone was not opened: ${reason || 'no reason given'}`);
      deps.asks.tell([REFUSALS[reason] ?? 'I could not open the microphone.'], 'careful');
      return;
    }
    const talkId = typeof payload.talk_id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(payload.talk_id) ? payload.talk_id : null;
    if (!talkId) return;
    const talkKey = key(sidecarId, talkId);
    if (phase === 'start') {
      // One microphone per desktop app: a start means whatever was open there is over.
      const before = open.get(sidecarId);
      if (before && before !== talkKey) deps.asks.dropped(before);
      open.set(sidecarId, talkKey);
      deps.asks.listen(talkKey);
      return;
    }
    // Only the recording that is open on that desktop app can end or be cancelled.
    if (open.get(sidecarId) !== talkKey) return;
    open.delete(sidecarId);
    if (phase === 'cancelled') { deps.asks.dropped(talkKey); return; }
    if (phase !== 'end') return;
    // Turned away while the keys were still held: its sound is dropped here,
    // and is never sent to be made into words.
    if (!deps.asks.released(talkKey)) return;
    const voicedMs = Number(payload.voiced_ms ?? 0);
    const binary = event.binary as { type?: string; data?: string } | undefined;
    let pcm = Buffer.alloc(0);
    if (binary?.type === 'inline' && typeof binary.data === 'string') {
      try { pcm = Buffer.from(binary.data, 'base64'); } catch { pcm = Buffer.alloc(0); }
    }
    if (payload.reason === 'cap') { deps.asks.nothing(talkKey, 'too_long'); return; }
    if (!(voicedMs >= NOTCH_TALK_MIN_VOICED_MS) || pcm.length < 3200) {
      deps.asks.nothing(talkKey, voicedMs > 0 ? 'too_little' : 'silence');
      return;
    }
    const sampleRate = Number(payload.sample_rate ?? 16_000) || 16_000;
    void transcribe(talkKey, pcm, sampleRate);
  });

  let pretended = 0;
  return {
    pretend(words) {
      const talkKey = `pretend:${Date.now().toString(36)}-${++pretended}`;
      deps.asks.listen(talkKey);
      setTimeout(() => {
        deps.asks.released(talkKey);
        setTimeout(() => {
          if (words && hasSpokenContent(words)) deps.asks.words(talkKey, words.trim()); else deps.asks.nothing(talkKey, 'silence');
        }, 250);
      }, 700);
    },
  };
}
