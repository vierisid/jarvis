/**
 * Browser audio driver for premium realtime voice (gpt-realtime-2) — Phase 4c.
 *
 * Unlike the standard push-to-talk path (buffer → 16 kHz WAV at voice_end),
 * realtime needs to:
 *   - stream mic audio CONTINUOUSLY as 24 kHz PCM s16 binary frames, and
 *   - play streamed 24 kHz PCM s16 output as it arrives, with barge-in.
 *
 * All Web Audio lives here so useVoice only flips a guarded branch. The pure
 * sample math is in ./pcm.ts (unit-tested); this orchestration needs a real
 * browser and is verified in-app. See docs/GPT_REALTIME_2_INTEGRATION.md.
 */

import { floatTo16BitPCM, pcm16ToFloat32, resampleFloat32 } from "./pcm.ts";

const REALTIME_SAMPLE_RATE = 24000; // OpenAI realtime minimum.
const CAPTURE_WORKLET_URL = "/audio/pcm-capture-processor.js";

export type RealtimeControllerOpts = {
  ws: WebSocket;
  getCurrentRoom?: () => string;
  /** Fired when output audio begins playing (drive UI → "speaking"). */
  onPlaybackStart?: () => void;
  /** Fired when the output queue drains (drive UI → "idle"). */
  onPlaybackIdle?: () => void;
  onError?: (msg: string) => void;
};

export class RealtimeVoiceController {
  private opts: RealtimeControllerOpts;
  private streaming = false;
  private requestId: string | null = null;

  // Capture graph
  private stream: MediaStream | null = null;
  private captureCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;

  // Playback graph (scheduled queue)
  private playbackCtx: AudioContext | null = null;
  private playhead = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  constructor(opts: RealtimeControllerOpts) {
    this.opts = opts;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  /** Open the mic and begin streaming continuous 24 kHz PCM frames. */
  async startStreaming(): Promise<void> {
    if (this.streaming) return;
    const ws = this.opts.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.opts.onError?.("WebSocket not open");
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      // Request the context at the realtime rate; the MediaStreamSource is
      // resampled into it automatically. We still resample defensively below
      // in case a browser ignores the requested rate.
      this.captureCtx = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE });
      await this.captureCtx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
      this.source = this.captureCtx.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.captureCtx, "pcm-capture-processor");

      this.requestId = crypto.randomUUID();
      ws.send(
        JSON.stringify({
          type: "voice_start",
          payload: { requestId: this.requestId, currentRoom: this.opts.getCurrentRoom?.() ?? "home" },
          timestamp: Date.now(),
        }),
      );

      const ctxRate = this.captureCtx.sampleRate;
      this.worklet.port.onmessage = (e: MessageEvent) => {
        if (!this.streaming || ws.readyState !== WebSocket.OPEN) return;
        const raw = new Float32Array(e.data as ArrayBuffer);
        const float = ctxRate !== REALTIME_SAMPLE_RATE ? resampleFloat32(raw, ctxRate, REALTIME_SAMPLE_RATE) : raw;
        ws.send(floatTo16BitPCM(float));
      };

      this.source.connect(this.worklet);
      // Keep the worklet's graph alive with a muted sink (some browsers won't
      // pull from a worklet that isn't connected to a destination).
      const sink = this.captureCtx.createGain();
      sink.gain.value = 0;
      this.worklet.connect(sink);
      sink.connect(this.captureCtx.destination);

      this.streaming = true;
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      this.stopStreaming();
    }
  }

  /** Stop the mic + tell the server this turn is done (session stays open). */
  stopStreaming(): void {
    if (this.streaming && this.requestId) {
      try {
        this.opts.ws.send(
          JSON.stringify({ type: "voice_end", payload: { requestId: this.requestId }, timestamp: Date.now() }),
        );
      } catch { /* socket may be gone */ }
    }
    this.streaming = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.worklet?.disconnect();
    this.worklet = null;
    this.source?.disconnect();
    this.source = null;
    this.captureCtx?.close().catch(() => {});
    this.captureCtx = null;
  }

  /** Enqueue a raw PCM s16 24 kHz output frame for gapless playback. */
  enqueuePlayback(pcm: ArrayBuffer): void {
    const float = pcm16ToFloat32(pcm);
    if (float.length === 0) return;
    const ctx = this.getPlaybackCtx();
    const buffer = ctx.createBuffer(1, float.length, REALTIME_SAMPLE_RATE);
    buffer.copyToChannel(float, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const wasIdle = this.activeSources.size === 0 && this.playhead <= now;
    const startAt = Math.max(now, this.playhead);
    src.start(startAt);
    this.playhead = startAt + buffer.duration;
    this.activeSources.add(src);
    if (wasIdle) this.opts.onPlaybackStart?.();
    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0) this.opts.onPlaybackIdle?.();
    };
  }

  /** Barge-in: stop and discard all queued/playing output. */
  flushPlayback(): void {
    for (const s of this.activeSources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.activeSources.clear();
    this.playhead = 0;
    this.opts.onPlaybackIdle?.();
  }

  dispose(): void {
    this.stopStreaming();
    this.flushPlayback();
    this.playbackCtx?.close().catch(() => {});
    this.playbackCtx = null;
  }

  private getPlaybackCtx(): AudioContext {
    if (!this.playbackCtx || this.playbackCtx.state === "closed") {
      this.playbackCtx = new AudioContext();
      this.playhead = 0;
    }
    if (this.playbackCtx.state === "suspended") this.playbackCtx.resume().catch(() => {});
    return this.playbackCtx;
  }
}
