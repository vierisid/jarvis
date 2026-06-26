/**
 * Pebble realtime voice — daemon-side session manager.
 *
 * Mirrors `WSService.tryStartRealtimeVoice` (the dashboard path) but for the
 * native cursor pebble: the sidecar is the audio device, so audio rides the
 * sidecar's own WebSocket via RPCs instead of the browser binary-WS path.
 *
 *   sidecar  --(pebble.realtime_start event)-->  daemon: start()
 *   sidecar  --(pebble.audio_frame, base64 PCM)->  daemon: pushMicChunk()
 *   daemon   --(pebble.play_pcm, base64 PCM)----->  sidecar: stream playback
 *   daemon   --(pebble.stop_audio)-------------->  sidecar: barge-in flush
 *
 * The hard protocol logic (OpenAI realtime state machine, semantic VAD,
 * barge-in, function calls, transcripts) is entirely reused from
 * `RealtimeVoiceSession` + `PebbleAudioTransport`; this class only wires the
 * sidecar transport and the pebble's visual state.
 */

import { PebbleAudioTransport } from '../comms/pebble-audio-transport.ts';
import { RealtimeVoiceSession } from './realtime-voice.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import type { LLMTool } from '../llm/provider.ts';

export type PebbleRealtimeState = 'listening' | 'speaking' | 'thinking' | 'idle';
export type PebbleRealtimeStatus = 'live' | 'closed' | 'error';

export type PebbleRealtimeDeps = {
  /** Dispatch an RPC to a specific sidecar (fire-and-forget for audio frames). */
  dispatchRPC: (sidecarId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Resolve realtime config (key cascade, model, budget, session cap). */
  resolve: () => { ok: true; resolved: ResolvedRealtimeVoice } | { ok: false; reason?: string };
  /** Realtime tool set (agent tools converted for the realtime API). */
  tools: () => LLMTool[];
  /** Lean voice persona prompt. */
  instructions: () => string;
  /** Auto-approving tool bridge (emergency-stop + authority gate enforced). */
  executeToolCall: (name: string, args: Record<string, unknown>, blockedCategories: string[]) => Promise<string>;
  /** Drive the pebble's visual state + bubble text. */
  onState?: (sidecarId: string, state: PebbleRealtimeState, text?: string) => void;
  /** Surface session lifecycle to logs / the sidecar. */
  onStatus?: (sidecarId: string, status: PebbleRealtimeStatus, detail?: string) => void;
};

type Entry = {
  session: RealtimeVoiceSession;
  transport: PebbleAudioTransport;
  timeout: ReturnType<typeof setTimeout>;
  startedAt: number;
  lastState?: PebbleRealtimeState; // dedupe set_state so transcript deltas don't flood RPCs
};

export class PebbleRealtimeManager {
  private sessions = new Map<string, Entry>(); // sidecarId -> entry

  constructor(private deps: PebbleRealtimeDeps) {}

  isActive(sidecarId: string): boolean {
    return this.sessions.has(sidecarId);
  }

  /** Open a perpetual realtime session for this sidecar (idempotent). */
  async start(sidecarId: string): Promise<void> {
    if (this.sessions.has(sidecarId)) return;

    let resolved: ResolvedRealtimeVoice;
    try {
      const r = this.deps.resolve();
      if (!r.ok) {
        this.deps.onStatus?.(sidecarId, 'error', 'Realtime voice is not configured.');
        return;
      }
      resolved = r.resolved;
    } catch (err) {
      this.deps.onStatus?.(sidecarId, 'error', `Realtime resolve failed: ${String(err)}`);
      return;
    }

    const transport = new PebbleAudioTransport({
      // Output audio → the sidecar's streaming PCM player. Fire-and-forget:
      // dispatchRPC sends synchronously (frames stay in order); we don't await
      // each frame's ack so playback isn't gated on the round-trip.
      sendAudio: (chunk) => {
        void this.deps
          .dispatchRPC(sidecarId, 'pebble.play_pcm', { data: chunk.toString('base64') })
          .catch(() => {/* sidecar gone / mid-teardown */});
      },
      // Barge-in → flush the sidecar's playback immediately.
      signalStopPlayback: () => {
        void this.deps.dispatchRPC(sidecarId, 'pebble.stop_audio', {}).catch(() => {});
      },
      inputSampleRate: 24000,
      outputSampleRate: 24000,
    });

    const session = new RealtimeVoiceSession(resolved, transport, {
      tools: this.deps.tools(),
      instructions: this.deps.instructions(),
      executeToolCall: (name, args) => this.deps.executeToolCall(name, args, resolved.blockedCategories),
      onTranscript: (t) => {
        // Drive the pebble: assistant turn → speaking, user turn → listening.
        // Dedupe by state so a long response's many transcript deltas don't
        // fire a set_state RPC each (that flooded the sidecar dozens/sec).
        const next: PebbleRealtimeState | null =
          t.role === 'assistant' ? 'speaking' : t.final ? 'listening' : null;
        if (!next) return;
        const entry = this.sessions.get(sidecarId);
        if (entry?.lastState === next) return;
        if (entry) entry.lastState = next;
        this.deps.onState?.(sidecarId, next, t.role === 'assistant' ? t.text : undefined);
      },
      onError: (err) => {
        this.deps.onStatus?.(sidecarId, 'error', err);
        this.stop(sidecarId);
      },
      onClose: () => this.stop(sidecarId),
    });

    // Cost guard: the session is otherwise perpetual, so cap wall-clock.
    const timeout = setTimeout(() => {
      this.deps.onStatus?.(sidecarId, 'closed', 'Reached the max session length.');
      this.stop(sidecarId);
    }, resolved.maxSessionMinutes * 60_000);

    this.sessions.set(sidecarId, { session, transport, timeout, startedAt: Date.now() });

    try {
      await session.connect();
      this.deps.onStatus?.(sidecarId, 'live', resolved.model);
      this.deps.onState?.(sidecarId, 'listening'); // mic hot, awaiting the user
    } catch (err) {
      this.deps.onStatus?.(sidecarId, 'error', `Realtime connect failed: ${String(err)}`);
      this.stop(sidecarId);
    }
  }

  /** Feed one mic PCM frame (s16/mono/24 kHz) from the sidecar into the session. */
  pushMicChunk(sidecarId: string, pcm: Buffer): void {
    this.sessions.get(sidecarId)?.transport.pushMicChunk(pcm);
  }

  /** Close the session and return the pebble to idle (idempotent). */
  stop(sidecarId: string): void {
    const entry = this.sessions.get(sidecarId);
    if (!entry) return;
    this.sessions.delete(sidecarId);
    clearTimeout(entry.timeout);
    try { entry.session.close(); } catch {/* ignore */}
    try { entry.transport.stop(); } catch {/* ignore */}
    this.deps.onState?.(sidecarId, 'idle');
    this.deps.onStatus?.(sidecarId, 'closed');
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
