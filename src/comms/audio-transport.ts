/**
 * Audio transport abstraction for premium realtime voice (gpt-realtime-2).
 *
 * The realtime session must not know *where* mic audio comes from or *where*
 * output audio goes. This interface has (so far) one implementation —
 * `BrowserAudioTransport`, which bridges the existing binary-WebSocket voice
 * path. A `PebbleAudioTransport` (sidecar mic via miniaudio + pebble.play_audio)
 * lands once `refractor/UI_UX_phase2` merges; it implements the same interface
 * so `RealtimeSession` needs no changes.
 *
 * Audio contract: PCM signed-16 little-endian, mono. Sample rate is declared by
 * the transport via `inputSampleRate` so the realtime session can announce the
 * matching `audio.input.format.rate` to OpenAI. The Pebble already produces
 * s16/16kHz/mono natively; the browser path may need resampling upstream.
 *
 * See docs/GPT_REALTIME_2_INTEGRATION.md §3a.
 */

export interface AudioTransport {
  /** Sample rate (Hz) of the PCM frames this transport emits/expects. */
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;

  /** Register the mic-chunk listener. Frames are raw PCM s16/mono. */
  onMicChunk(cb: (pcm: Buffer) => void): void;

  /** Play a chunk of realtime output audio (PCM s16/mono). */
  playback(chunk: Buffer): void;

  /** Barge-in: stop/flush any audio currently playing or queued. */
  stopPlayback(): void;

  /** Begin capturing/output. Resolves once the transport is ready. */
  start(): Promise<void>;

  /** Tear down capture + playback and release resources. */
  stop(): void;
}

/** Hooks a `BrowserAudioTransport` needs from the ws-service layer. */
export type BrowserTransportHooks = {
  /** Send a binary audio frame to the browser client (e.g. ws.sendBinary). */
  sendAudio: (chunk: Buffer) => void;
  /** Notify the browser that playback should stop/flush (barge-in). */
  signalStopPlayback?: () => void;
  /** Sample rates negotiated with the browser capture/playback pipeline. */
  inputSampleRate?: number;
  outputSampleRate?: number;
};

/**
 * Browser transport: mic audio arrives as binary WS frames (fed in via
 * `pushMicChunk` from the ws-service binary handler), output audio is sent back
 * to the browser through the `sendAudio` hook. Playback timing/queueing lives
 * in the browser client; this class is a thin relay.
 */
/**
 * Max mic frames buffered while the OpenAI socket is still connecting. At
 * 24kHz/~5ms frames this is ~3s of audio — enough to capture the user's opening
 * words during the connect window without growing unbounded.
 */
const MAX_PENDING_MIC_FRAMES = 600;

export class BrowserAudioTransport implements AudioTransport {
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
  private micCb: ((pcm: Buffer) => void) | null = null;
  private hooks: BrowserTransportHooks;
  // Frames that arrive before the realtime session wires its mic listener (i.e.
  // while the OpenAI socket is still connecting). Without this they were
  // dropped, so the user's first words vanished and the turn never registered.
  private pending: Buffer[] = [];

  constructor(hooks: BrowserTransportHooks) {
    this.hooks = hooks;
    // OpenAI realtime default is 24kHz; browsers commonly capture at 48kHz and
    // resample client-side. Default to 24kHz unless the caller overrides.
    this.inputSampleRate = hooks.inputSampleRate ?? 24000;
    this.outputSampleRate = hooks.outputSampleRate ?? 24000;
  }

  onMicChunk(cb: (pcm: Buffer) => void): void {
    this.micCb = cb;
    // Flush anything captured during the connect window so no audio is lost.
    if (this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const frame of queued) cb(frame);
    }
  }

  /** Called by ws-service when a binary mic frame arrives from the browser. */
  pushMicChunk(pcm: Buffer): void {
    if (this.micCb) {
      this.micCb(pcm);
      return;
    }
    // Session not connected yet — buffer (bounded) instead of dropping.
    this.pending.push(pcm);
    if (this.pending.length > MAX_PENDING_MIC_FRAMES) this.pending.shift();
  }

  playback(chunk: Buffer): void {
    this.hooks.sendAudio(chunk);
  }

  stopPlayback(): void {
    this.hooks.signalStopPlayback?.();
  }

  async start(): Promise<void> {
    // Browser capture is driven by the client; nothing to open server-side.
  }

  stop(): void {
    this.micCb = null;
    this.pending = [];
  }
}
