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
import { RealtimeVoiceSession, type RealtimeVoiceDeps } from './realtime-voice.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import { hostedRealtimeIncluded } from './realtime-gate.ts';
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
  /** Re-push the sidecar's `configure_realtime` advertisement. Called when the
   *  plan gate refuses a start: the advertisement that let the summon key open
   *  a live session was computed under an advisory-allow (or a stale verdict),
   *  and re-advertising with the now-cached definitive verdict flips the
   *  hotkey back to one-shot capture instead of an error dead-end. */
  readvertise?: (sidecarId: string) => void;
  /** The session was never usable: the dial was refused (dead key, wrong
   *  endpoint, a plan that does not serve realtime), or it opened and died
   *  before the user got a word in. The advertisement that routed the summon
   *  key here was a guess (the plan gate advisory-allows when the catalog is
   *  unreachable), so the caller downgrades this sidecar to the one-shot
   *  capture path rather than letting every press open a session that dies
   *  half a second later. `detail` is for the log, not the user. */
  onUnusableSession?: (sidecarId: string, detail: string) => void;
  /** Injectable voice-session factory (tests), mirroring the seam
   *  RealtimeVoiceSession itself offers. Defaults to the real session. */
  createSession?: (
    resolved: ResolvedRealtimeVoice,
    transport: PebbleAudioTransport,
    deps: RealtimeVoiceDeps,
  ) => RealtimeVoiceSession;
};

type Entry = {
  session: RealtimeVoiceSession;
  transport: PebbleAudioTransport;
  timeout: ReturnType<typeof setTimeout>;
  startedAt: number;
  lastState?: PebbleRealtimeState; // dedupe textless set_state so repeats don't flood RPCs
  transcript: TranscriptAccumulator;
  /** Set on the first transcript from either side. A session that closes
   *  without one carried no conversation, which is what separates "the server
   *  would not serve this" from "the conversation ended". */
  used?: boolean;
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

/**
 * A session that closes within this window without a single transcript never
 * became a conversation. Generous enough to cover a slow first turn on a cold
 * proxy, short enough that a real conversation's ending never trips it.
 */
const UNUSABLE_SESSION_MS = 8_000;

export class PebbleRealtimeManager {
  private sessions = new Map<string, Entry>(); // sidecarId -> entry
  /** Starts parked on the plan-gate await. `stop()` (summon toggled off, or
   *  the sidecar disconnected) cancels the token; the start aborts instead of
   *  opening a perpetual billed session for a peer that already left. Before
   *  this existed the first await in start() came AFTER sessions.set(), so
   *  stop() always found the entry — the gate await reopened that window. */
  private pendingStarts = new Map<string, { cancelled: boolean }>();

  constructor(private deps: PebbleRealtimeDeps) {}

  isActive(sidecarId: string): boolean {
    return this.sessions.has(sidecarId);
  }

  /** Open a perpetual realtime session for this sidecar (idempotent). */
  async start(sidecarId: string): Promise<void> {
    if (this.sessions.has(sidecarId)) return;
    // A start already parked on the gate await adopts this request: un-cancel
    // it (covers a quick stop→start toggle) rather than racing a second gate.
    const parked = this.pendingStarts.get(sidecarId);
    if (parked) {
      parked.cancelled = false;
      return;
    }

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

    const pending = { cancelled: false };
    this.pendingStarts.set(sidecarId, pending);
    try {
      // Same plan gate as WSService.tryStartRealtimeVoice — without it a hosted
      // plan that excludes realtime would dial and fail instead of the sidecar
      // falling back to one-shot capture.
      if (!(await hostedRealtimeIncluded(resolved))) {
        this.deps.onStatus?.(sidecarId, 'closed', 'Realtime voice is not included in this plan.');
        // The summon key only got here because the advertisement said realtime
        // was on (advisory-allow or a stale verdict). Re-advertise with the
        // now-cached definitive verdict so the hotkey falls back to one-shot
        // capture instead of erroring on every press.
        this.deps.readvertise?.(sidecarId);
        return;
      }
      if (pending.cancelled) return; // stop()/disconnect arrived mid-gate
      if (this.sessions.has(sidecarId)) return; // re-check across the await
    } finally {
      this.pendingStarts.delete(sidecarId);
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

    const voiceDeps: RealtimeVoiceDeps = {
      tools: this.deps.tools(),
      instructions: this.deps.instructions(),
      executeToolCall: (name, args) => this.deps.executeToolCall(sidecarId, name, args, resolved.blockedCategories),
      onTranscript: (t) => {
        // Drive the pebble: assistant turn → speaking (with growing bubble
        // text), user turn → listening. foldTranscript accumulates the delta
        // fragments and throttles the pushes so RPCs stay bounded.
        const entry = this.sessions.get(sidecarId);
        if (!entry) return;
        entry.used = true; // a real turn happened; this session was serviceable
        const out = foldTranscript(entry.transcript, t, Date.now());
        if (!out) return;
        // Textless pushes are only worth an RPC when the state actually flips.
        if (out.text === undefined && entry.lastState === out.state) return;
        entry.lastState = out.state;
        this.deps.onState?.(sidecarId, out.state, out.text);
      },
      onError: (err) => {
        this.deps.onStatus?.(sidecarId, 'error', err);
        this.reportIfUnusable(sidecarId, err);
        this.stop(sidecarId);
      },
      onClose: (detail) => {
        // A socket that drops this early carried no conversation. Checked
        // before stop() deletes the entry it reads.
        this.reportIfUnusable(sidecarId, detail ?? 'the session closed');
        this.stop(sidecarId, detail);
      },
    };
    const session = this.deps.createSession
      ? this.deps.createSession(resolved, transport, voiceDeps)
      : new RealtimeVoiceSession(resolved, transport, voiceDeps);

    // Cost guard: the session is otherwise perpetual, so cap wall-clock.
    const timeout = setTimeout(() => {
      this.deps.onStatus?.(sidecarId, 'closed', 'Reached the max session length.');
      this.stop(sidecarId);
    }, resolved.maxSessionMinutes * 60_000);

    this.sessions.set(sidecarId, { session, transport, timeout, startedAt: Date.now(), transcript: newTranscriptAccumulator() });

    try {
      // Resolves only once the socket is OPEN (comms/realtime.ts connect), so
      // `live` and the listening pebble now mean the session really is up.
      await session.connect();
      this.deps.onStatus?.(sidecarId, 'live', resolved.model);
      this.deps.onState?.(sidecarId, 'listening'); // mic hot, awaiting the user
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.onStatus?.(sidecarId, 'error', `Realtime connect failed: ${detail}`);
      this.stop(sidecarId);
      // Stop the summon key opening a session the server will not serve.
      this.deps.onUnusableSession?.(sidecarId, detail);
    }
  }

  /**
   * Report a session that ended without ever being usable, so the caller can
   * stop routing the summon hotkey into it.
   *
   * The window matters: a conversation that ran and then dropped says nothing
   * about whether the next one can open, and downgrading on that would cost the
   * user live voice for the rest of the connection over a normal ending. A
   * socket that dies within seconds having carried no transcript is a different
   * animal -- that is a server refusing the session, and repeating it on every
   * press is what makes the hotkey look broken.
   */
  private reportIfUnusable(sidecarId: string, detail: string): void {
    const entry = this.sessions.get(sidecarId);
    if (!entry || entry.used) return;
    if (Date.now() - entry.startedAt > UNUSABLE_SESSION_MS) return;
    this.deps.onUnusableSession?.(sidecarId, detail);
  }

  /** Feed one mic PCM frame (s16/mono/24 kHz) from the sidecar into the session. */
  pushMicChunk(sidecarId: string, pcm: Buffer): void {
    this.sessions.get(sidecarId)?.transport.pushMicChunk(pcm);
  }

  /** Close the session and return the pebble to idle (idempotent).
   *  `detail` explains an involuntary close (the socket's code/reason) so the
   *  sidecar log and the pebble can say why the conversation ended. */
  stop(sidecarId: string, detail?: string): void {
    // A start parked on the gate await has no session entry yet — cancel the
    // token so it aborts instead of opening a session for a peer that's gone.
    const pending = this.pendingStarts.get(sidecarId);
    if (pending) pending.cancelled = true;
    const entry = this.sessions.get(sidecarId);
    if (!entry) return;
    this.sessions.delete(sidecarId);
    clearTimeout(entry.timeout);
    try { entry.session.close(); } catch {/* ignore */}
    try { entry.transport.stop(); } catch {/* ignore */}
    this.deps.onState?.(sidecarId, 'idle');
    this.deps.onStatus?.(sidecarId, 'closed', detail);
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
