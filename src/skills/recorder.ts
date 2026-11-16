/**
 * Skill recorder: learn-by-watching session buffer.
 *
 * While a recording session is live, the sidecar emits `ui_interaction`
 * events (each click/commit paired with the acted element's SemanticRef).
 * This buffers them per session and hands the sequence to the compiler on
 * stop. Redaction of obvious secrets happens here, at capture time, so raw
 * secrets never reach the compiler or the stored skill. The daemon's generic
 * sidecar-event listener skips `ui_interaction`, so the raw event is consumed
 * here and nowhere else (no dashboard broadcast, no coalescer slot).
 *
 * Session lifecycle: start -> (interactions) -> end(reason) -> takePending().
 * `end` keeps the buffered interactions so a stop that cannot save yet (no
 * name, name already taken) can be retried without losing the demonstration.
 * A session also ends on its own at the deadline: the sidecar enforces the
 * same cap on the hooks themselves, so this side is the second fence.
 */

import type { SemanticRef } from '../structural/types.ts';

export type RawInteraction = {
  action: 'click' | 'set_value' | 'press_keys' | 'launch_app' | 'navigate';
  ref?: SemanticRef;
  value?: string;
  ts: number;
  /** Process base name of the app the element belongs to (e.g. "chrome"). */
  app?: string;
  /** Top-level window title at the time of the interaction. */
  title?: string;
  /** Provider hint so the compiler knows desktop vs browser. */
  surface?: 'desktop' | 'browser';
  /** True when the source field was a password/secure input. */
  secure?: boolean;
  /**
   * The window the action was in, as the sidecar names one (a number that
   * stays the same while the window lives, its process, its size), and for a
   * click the place in that window it landed on and what was held down with
   * it. The compiler does not use these: a skill replays by element. They are
   * how a job shown several times over is told apart (src/notch/rounds.ts).
   */
  win?: { id: string; pid: number; w: number; h: number };
  pt?: { x: number; y: number };
  mods?: string;
};

export type RecordingEndReason = 'stop' | 'cap' | 'sidecar' | 'restart';

export type RecordingSession = {
  id: string;
  startedAt: number;
  /** Epoch ms after which interactions are dropped. */
  deadline: number;
  interactions: RawInteraction[];
  endedAt?: number;
  endReason?: RecordingEndReason;
};

/** Values matching these look like secrets even outside a password field. */
const SECRET_PATTERNS: RegExp[] = [
  /\b\d{13,19}\b/, // card-like number
  /\bsk-[A-Za-z0-9]{16,}\b/, // API-key-like
  /\b[A-Fa-f0-9]{32,}\b/, // long hex (tokens)
  /password|passwd|secret|api[_-]?key/i,
];

const SECRET_FIELD_HINT = /password|passcode|pin|secret|cvv|security code/i;

export function looksSecret(value: string, ref?: SemanticRef, secureFlag?: boolean): boolean {
  if (secureFlag) return true;
  if (ref && SECRET_FIELD_HINT.test(ref.name)) return true;
  return SECRET_PATTERNS.some((re) => re.test(value));
}

/** Redact a value if it looks secret; returns the (possibly) redacted event. */
export function redactInteraction(i: RawInteraction): RawInteraction {
  if (i.value !== undefined && looksSecret(i.value, i.ref, i.secure)) {
    return { ...i, value: '{{REDACTED}}', secure: true };
  }
  return i;
}

const ACTIONS: ReadonlySet<string> = new Set(['click', 'set_value', 'press_keys', 'launch_app', 'navigate']);

function isRef(v: unknown): v is SemanticRef {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.role === 'string' && typeof r.name === 'string' && Array.isArray(r.path)
    && typeof r.ordinal === 'number' && typeof r.sig === 'string';
}

/**
 * Validate a `ui_interaction` payload from the sidecar. Returns null for a
 * malformed event: an unknown action is dropped, never coerced into a click,
 * and an element action without a well-formed ref is dropped because nothing
 * could replay it.
 */
export function parseInteractionEvent(payload: unknown, now = Date.now()): RawInteraction | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.action !== 'string' || !ACTIONS.has(p.action)) return null;
  const action = p.action as RawInteraction['action'];
  const ref = isRef(p.ref) ? p.ref : undefined;
  if ((action === 'click' || action === 'set_value') && !ref) return null;
  const whole = (v: unknown, least: number, most: number): number | null =>
    (typeof v === 'number' && Number.isInteger(v) && v >= least && v <= most ? v : null);
  const w = (typeof p.win === 'object' && p.win !== null ? p.win : {}) as Record<string, unknown>;
  const winPid = whole(w.pid, 1, 0xffffffff);
  const winW = whole(w.w, 1, 100_000);
  const winH = whole(w.h, 1, 100_000);
  const win = typeof w.id === 'string' && /^0x[0-9a-f]{1,16}$/.test(w.id) && winPid && winW && winH
    ? { id: w.id, pid: winPid, w: winW, h: winH } : undefined;
  const at = (typeof p.pt === 'object' && p.pt !== null ? p.pt : {}) as Record<string, unknown>;
  const x = whole(at.x, -100_000, 100_000);
  const y = whole(at.y, -100_000, 100_000);
  return {
    action,
    ref,
    value: typeof p.value === 'string' ? p.value : undefined,
    ts: typeof p.ts === 'number' ? p.ts : now,
    app: typeof p.app === 'string' && p.app ? p.app : undefined,
    title: typeof p.title === 'string' && p.title ? p.title : undefined,
    surface: p.surface === 'browser' ? 'browser' : 'desktop',
    secure: p.secure === true,
    ...(win ? { win } : {}),
    ...(win && action === 'click' && x !== null && y !== null ? { pt: { x, y } } : {}),
    ...(typeof p.mods === 'string' && /^(?:ctrl|shift|alt)(?:,(?:ctrl|shift|alt))*$/.test(p.mods) ? { mods: p.mods } : {}),
  };
}

/** In-memory recorder. One session at a time (per the record_skill UX). */
export class SkillRecorder {
  private session: RecordingSession | null = null;
  private readonly listeners = new Set<(interaction: RawInteraction, count: number) => void>();

  /**
   * Hears each interaction as it is kept, already redacted, with how many
   * the session holds now. For whoever shows the person that they are being
   * watched (the notch counts the steps). Comes back with how to stop hearing.
   */
  onPush(listener: (interaction: RawInteraction, count: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(id: string, now: number, maxMs: number): RecordingSession {
    this.session = { id, startedAt: now, deadline: now + maxMs, interactions: [] };
    return this.session;
  }

  /** Live and accepting interactions. */
  isRecording(now = Date.now()): boolean {
    return this.session !== null && this.session.endedAt === undefined && now < this.session.deadline;
  }

  /** Buffer one interaction (redacted at capture time). Ignored once the session ended. */
  push(i: RawInteraction, now = Date.now()): void {
    if (!this.isRecording(now)) return;
    const kept = redactInteraction(i);
    this.session!.interactions.push(kept);
    for (const listener of [...this.listeners]) {
      try { listener(kept, this.session!.interactions.length); } catch { /* a watcher is not part of the recording */ }
    }
  }

  /**
   * Close the live session, keeping its interactions pending until they are
   * taken. Returns the session, or null when nothing was recording and
   * nothing is pending.
   */
  end(reason: RecordingEndReason, now = Date.now()): RecordingSession | null {
    const s = this.session;
    if (!s) return null;
    if (s.endedAt === undefined) {
      s.endedAt = now;
      s.endReason = reason;
    }
    return s;
  }

  /** The ended session awaiting a save, if any. */
  pending(): RecordingSession | null {
    const s = this.session;
    return s && s.endedAt !== undefined ? s : null;
  }

  /** Consume the pending session (after a successful save, or to discard it). */
  takePending(): RecordingSession | null {
    const s = this.pending();
    if (s) this.session = null;
    return s;
  }

  current(): RecordingSession | null {
    return this.session;
  }
}

/** Process-wide recorder shared by the record_skill tool and the event handler. */
let sharedRecorder: SkillRecorder | null = null;
export function getRecorder(): SkillRecorder {
  if (!sharedRecorder) sharedRecorder = new SkillRecorder();
  return sharedRecorder;
}
