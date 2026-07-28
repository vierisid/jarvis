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
import type { SidecarAudioChannel } from '../sidecar/manager.ts';

export type PebbleRealtimeState = 'listening' | 'speaking' | 'thinking' | 'idle';
export type PebbleRealtimeStatus = 'live' | 'closed' | 'error';

export type PebbleRealtimeDeps = {
  /** Dispatch a tracked RPC to a specific sidecar. */
  dispatchRPC: (sidecarId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Fire-and-forget RPC (no response tracking) — for high-rate audio frames,
   *  where a pending-tracker entry + timeout timer per PCM chunk is pure overhead. */
  dispatchNotify: (sidecarId: string, method: string, params?: Record<string, unknown>) => void;
  /** The sidecar's dedicated audio pipe, if connected (preferred over RPC for PCM). */
  getAudioChannel: (sidecarId: string) => SidecarAudioChannel | null;
  /** Resolve realtime config (key cascade, model, budget, session cap). */
  resolve: () => { ok: true; resolved: ResolvedRealtimeVoice } | { ok: false; reason?: string };
  /** Realtime tool set (agent tools converted for the realtime API). */
  tools: () => LLMTool[];
  /** Lean voice persona prompt. */
  instructions: () => string;
  /** Auto-approving tool bridge (emergency-stop + authority gate enforced).
   *  sidecarId is passed so nav tools (open_dashboard_room, …) can spawn a
   *  panel on the right machine. */
  executeToolCall: (sidecarId: string, name: string, args: Record<string, unknown>, blockedCategories: string[]) => Promise<string>;
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
  lastState?: PebbleRealtimeState; // dedupe textless set_state so repeats don't flood RPCs
  transcript: TranscriptAccumulator;
};

/** Accumulator for assistant transcript deltas (incremental fragments). */
export type TranscriptAccumulator = { buffer: string; lastEmitAt: number };

export function newTranscriptAccumulator(): TranscriptAccumulator {
  return { buffer: '', lastEmitAt: 0 };
}

/**
 * Fold one transcript event into the accumulator and decide what (if anything)
 * to push to the pebble. Assistant deltas are fragments, not cumulative text —
 * they append to the buffer and surface at most every `throttleMs` (each push
 * is a set_state RPC; unthrottled deltas flooded the sidecar dozens/sec). The
 * assistant-final event carries the complete utterance and always emits, so the
 * bubble ends on the full response. A user-final resets for the next turn and
 * flips the pebble back to listening.
 */
export function foldTranscript(
  acc: TranscriptAccumulator,
  t: { role: 'user' | 'assistant'; text: string; final: boolean },
  now: number,
  throttleMs = 400,
): { state: PebbleRealtimeState; text?: string } | null {
  if (t.role === 'assistant') {
    if (t.final) {
      acc.buffer = '';
      acc.lastEmitAt = 0;
      return { state: 'speaking', text: t.text };
    }
    acc.buffer += t.text;
    if (now - acc.lastEmitAt < throttleMs) return null;
    acc.lastEmitAt = now;
    return { state: 'speaking', text: acc.buffer };
  }
  if (!t.final) return null;
  acc.buffer = '';
  acc.lastEmitAt = 0;
  return { state: 'listening' };
}

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
      // Output audio → the sidecar's streaming PCM player. Prefer the dedicated
      // audio channel (raw binary, isolated from the bulk control connection so
      // screenshots can't stutter it); fall back to the RPC path (base64 over
      // the control connection) when no audio channel is connected.
      sendAudio: (chunk) => {
        const ch = this.deps.getAudioChannel(sidecarId);
        if (ch) { ch.sendPCM(chunk); return; }
        this.deps.dispatchNotify(sidecarId, 'pebble.play_pcm', { data: chunk.toString('base64') });
      },
      // Barge-in → flush the sidecar's playback immediately. The interrupted
      // utterance may never get its transcript final, so drop the partial
      // buffer too — the next response must not inherit it.
      signalStopPlayback: () => {
        const entry = this.sessions.get(sidecarId);
        if (entry) entry.transcript = newTranscriptAccumulator();
        const ch = this.deps.getAudioChannel(sidecarId);
        if (ch) { ch.sendFlush(); return; }
        this.deps.dispatchNotify(sidecarId, 'pebble.stop_audio', {});
      },
      inputSampleRate: 24000,
      outputSampleRate: 24000,
    });

    const session = new RealtimeVoiceSession(resolved, transport, {
      tools: this.deps.tools(),
      instructions: this.deps.instructions(),
      executeToolCall: (name, args) => this.deps.executeToolCall(sidecarId, name, args, resolved.blockedCategories),
      onTranscript: (t) => {
        // Drive the pebble: assistant turn → speaking (with growing bubble
        // text), user turn → listening. foldTranscript accumulates the delta
        // fragments and throttles the pushes so RPCs stay bounded.
        const entry = this.sessions.get(sidecarId);
        if (!entry) return;
        const out = foldTranscript(entry.transcript, t, Date.now());
        if (!out) return;
        // Textless pushes are only worth an RPC when the state actually flips.
        if (out.text === undefined && entry.lastState === out.state) return;
        entry.lastState = out.state;
        this.deps.onState?.(sidecarId, out.state, out.text);
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

    this.sessions.set(sidecarId, { session, transport, timeout, startedAt: Date.now(), transcript: newTranscriptAccumulator() });

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
