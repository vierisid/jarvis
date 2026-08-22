/**
 * Per-socket lifecycle for the trial conductor.
 *
 * Everything stateful about the opening lives here rather than in ws-service:
 * which sockets are running a conductor session, what each has landed, and the
 * one piece of timing the whole commercial model rests on — when the 48-hour
 * clock starts.
 *
 * ws-service keeps a four-line branch and delegates.
 */

import type { WSMessage } from '../../comms/websocket.ts';
import {
  createConductorSession,
  executeConductorTool,
  type ConductorSession,
  type CapturedFuel,
  type LandedEntity,
  type TrialOpeningHandoff,
} from './conductor.ts';
import {
  markOpeningCompleted,
  startTrialClock,
  trialSnapshot,
  type TrialSnapshot,
} from '../../trial/entitlement.ts';

/**
 * How long to wait for a transcript of the founder's first utterance before
 * starting the clock from the VAD alone.
 *
 * The clock is meant to start at the first spoken WORD (D9), and words come
 * from input transcription, which the conductor session turns on. If that
 * transcript never arrives — the model does not support it, the plan does not
 * include it, the event shape drifts — the alternative to a backstop is a
 * trial that never expires and bills uncapped realtime forever (open question
 * Q1). So: prefer the word, fall back to "a complete utterance was heard".
 */
export const CLOCK_TRANSCRIPT_GRACE_MS = 15_000;

/** True when a transcript contains something a person actually said. Guards
 *  the clock against empty and punctuation-only transcripts. */
export function transcriptHasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

type Timer = ReturnType<typeof setTimeout>;

type Entry<W> = {
  socket: W;
  session: ConductorSession;
  /** Backstop timer armed by the first `speech_stopped`. */
  clockFallback: Timer | null;
};

export type ConductorManagerDeps<W> = {
  send: (ws: W, msg: WSMessage) => void;
  broadcast: (msg: WSMessage) => void;
  /** Injectable clock so the tests are not timing-dependent. */
  now?: () => number;
  /** Backstop window, overridable so the fallback path is testable in ms. */
  clockGraceMs?: number;
};

export class TrialConductorManager<W> {
  private deps: ConductorManagerDeps<W>;
  /** Sockets that asked for the conductor and passed the entitlement check. */
  private armed = new Set<W>();
  private entries = new Map<W, Entry<W>>();

  constructor(deps: ConductorManagerDeps<W>) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Mark this socket as the trial's conductor socket. The realtime starter
   * reads this to decide which session to build; nothing else in the daemon
   * changes behaviour because of it.
   */
  arm(ws: W): void {
    this.armed.add(ws);
  }

  isArmed(ws: W): boolean {
    return this.armed.has(ws);
  }

  /** Is a conductor session actually running on this socket? */
  isRunning(ws: W): boolean {
    return this.entries.has(ws);
  }

  /** Open the conductor's bookkeeping for a socket whose realtime session is
   *  about to be built. Returns the session state the tool executor mutates. */
  begin(ws: W): ConductorSession {
    const existing = this.entries.get(ws);
    if (existing) return existing.session;
    const session = createConductorSession(this.now());
    this.entries.set(ws, { socket: ws, session, clockFallback: null });
    return session;
  }

  /** Tear down. Safe to call for a socket that never ran a conductor. */
  end(ws: W): void {
    const entry = this.entries.get(ws);
    if (entry?.clockFallback) clearTimeout(entry.clockFallback);
    this.entries.delete(ws);
    this.armed.delete(ws);
  }

  /**
   * Run one conductor tool call, wired to the live surfaces. Returns null when
   * the name is not a conductor tool.
   */
  executeTool(ws: W, name: string, args: Record<string, unknown>): string | null {
    const entry = this.entries.get(ws);
    if (!entry) return null;
    const result = executeConductorTool(entry.session, name, args, {
      onEntitiesLanded: (landed) => this.publishLanded(landed),
      onFuelCaptured: (fuel) => this.publishFuel(ws, fuel),
      onOpeningComplete: (handoff) => this.publishOpeningComplete(handoff),
    }, this.now());
    return result ? result.message : null;
  }

  /* ───────────────────────── D9, the clock ───────────────────────── */

  /**
   * A transcript arrived. Starts the 48-hour clock on the founder's first
   * spoken word, and does nothing at all for Jarvis's own speech — Jarvis
   * speaks FIRST in this session (D10), so an assistant transcript is
   * guaranteed to arrive before any user one and must never be mistaken for
   * the founder having said something.
   */
  onTranscript(ws: W, role: 'user' | 'assistant', text: string, final: boolean): void {
    if (role !== 'user' || !final) return;
    if (!transcriptHasWords(text)) return;
    this.startClock(ws);
  }

  /**
   * The VAD closed the founder's turn. Arms the backstop rather than starting
   * the clock outright, so a real transcript still gets to be the thing that
   * starts it when transcription is working.
   */
  onUserSpeechStopped(ws: W): void {
    const entry = this.entries.get(ws);
    if (!entry || entry.session.firstSpeechAt !== null || entry.clockFallback) return;
    entry.clockFallback = setTimeout(() => {
      entry.clockFallback = null;
      this.startClock(ws);
    }, this.deps.clockGraceMs ?? CLOCK_TRANSCRIPT_GRACE_MS);
    // Never hold the process open for this.
    (entry.clockFallback as { unref?: () => void }).unref?.();
  }

  /** Idempotent at both layers: here and in the entitlement record itself. */
  private startClock(ws: W): void {
    const entry = this.entries.get(ws);
    if (!entry || entry.session.firstSpeechAt !== null) return;
    const now = this.now();
    entry.session.firstSpeechAt = now;
    if (entry.clockFallback) {
      clearTimeout(entry.clockFallback);
      entry.clockFallback = null;
    }
    const updated = startTrialClock(now);
    console.log(
      `[Trial] clock started at first spoken word: ${new Date(now).toISOString()}` +
      `${updated?.expires_at ? ` → expires ${new Date(updated.expires_at).toISOString()}` : ''}`,
    );
    this.publishStatus(trialSnapshot(now));
  }

  /* ───────────────────────── surfaces ───────────────────────── */

  publishStatus(snapshot: TrialSnapshot): void {
    // Broadcast, not send: the shell's own socket needs the clock too.
    this.deps.broadcast({
      type: 'trial_status',
      payload: snapshot,
      timestamp: this.now(),
    });
  }

  private publishLanded(landed: LandedEntity[]): void {
    // D22 — this is the push that makes the vault visibly fill while the
    // founder is still mid-sentence. Broadcast so the memory room sees it
    // without waiting for its 8-second poll.
    this.deps.broadcast({
      type: 'trial_memory',
      payload: { landed },
      timestamp: this.now(),
    });
  }

  private publishFuel(ws: W, fuel: CapturedFuel): void {
    this.deps.send(ws, {
      type: 'trial_fuel',
      payload: fuel,
      timestamp: this.now(),
    });
  }

  private publishOpeningComplete(handoff: TrialOpeningHandoff): void {
    markOpeningCompleted(handoff.concludedAt);
    console.log(`[Trial] opening complete — ${handoff.fuel.length}/5 fuel areas, ${handoff.entities.length} entities landed`);
    // The seam, on the wire. The conversation is still live when this fires.
    this.deps.broadcast({
      type: 'trial_opening_complete',
      payload: {
        understanding: handoff.understanding,
        fuel: handoff.fuel,
        entityCount: handoff.entities.length,
        concludedAt: handoff.concludedAt,
      },
      timestamp: this.now(),
    });
  }
}
