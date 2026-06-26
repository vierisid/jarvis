/**
 * Pebble audio transport for premium realtime voice (gpt-realtime-2).
 *
 * Sibling of `BrowserAudioTransport`: same `AudioTransport` contract, but the
 * audio device is the native Go sidecar (miniaudio mic + a low-latency PCM
 * playback device) instead of a browser. The realtime session is unchanged —
 * it still streams PCM s16/mono and never learns where the bytes come from.
 *
 * Wiring (daemon side):
 *   - mic frames arrive from the sidecar as `pebble.audio_frame` events; the
 *     daemon decodes the PCM and calls `pushMicChunk(buf)`.
 *   - `playback(chunk)` / `stopPlayback()` call the hooks, which dispatch
 *     `pebble.play_pcm` / `pebble.stop_audio` RPCs to that one sidecar.
 *
 * Audio contract: PCM signed-16 little-endian, mono, 24 kHz both directions
 * (OpenAI rejects realtime input below 24 kHz). The sidecar must capture/upsample
 * to 24 kHz before streaming. See docs/GPT_REALTIME_2_INTEGRATION.md §3a.
 */

import type { AudioTransport } from './audio-transport.ts';

/** Hooks a `PebbleAudioTransport` needs from the daemon's sidecar-RPC layer. */
export type PebbleTransportHooks = {
  /** Send a PCM s16/mono frame to the sidecar for low-latency playback. */
  sendAudio: (chunk: Buffer) => void;
  /** Tell the sidecar to flush/stop playback immediately (barge-in). */
  signalStopPlayback?: () => void;
  /** Sample rates of the sidecar capture/playback pipeline (default 24 kHz). */
  inputSampleRate?: number;
  outputSampleRate?: number;
};

/**
 * Max mic frames buffered while the OpenAI socket is still connecting. At
 * 24 kHz / ~20 ms frames this is ~12 s of audio — generous headroom so the
 * user's opening words during the connect window are never dropped.
 */
const MAX_PENDING_MIC_FRAMES = 600;

export class PebbleAudioTransport implements AudioTransport {
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
  private micCb: ((pcm: Buffer) => void) | null = null;
  private hooks: PebbleTransportHooks;
  // Frames that arrive before the realtime session wires its mic listener
  // (while the OpenAI socket is still connecting). Bounded so it can't grow
  // unbounded if connect stalls.
  private pending: Buffer[] = [];
  private stopped = false;

  constructor(hooks: PebbleTransportHooks) {
    this.hooks = hooks;
    this.inputSampleRate = hooks.inputSampleRate ?? 24000;
    this.outputSampleRate = hooks.outputSampleRate ?? 24000;
  }

  onMicChunk(cb: (pcm: Buffer) => void): void {
    this.micCb = cb;
    if (this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const frame of queued) cb(frame);
    }
  }

  /** Called by the daemon when a `pebble.audio_frame` (mic PCM) arrives. */
  pushMicChunk(pcm: Buffer): void {
    if (this.stopped) return;
    if (this.micCb) {
      this.micCb(pcm);
      return;
    }
    this.pending.push(pcm);
    if (this.pending.length > MAX_PENDING_MIC_FRAMES) this.pending.shift();
  }

  playback(chunk: Buffer): void {
    if (this.stopped) return;
    this.hooks.sendAudio(chunk);
  }

  stopPlayback(): void {
    this.hooks.signalStopPlayback?.();
  }

  async start(): Promise<void> {
    // The sidecar owns capture/playback; the daemon only relays. Nothing to
    // open here — the sidecar begins streaming mic frames when it activates.
  }

  stop(): void {
    this.stopped = true;
    this.micCb = null;
    this.pending = [];
  }
}
