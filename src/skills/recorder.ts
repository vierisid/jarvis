/**
 * Skill recorder — learn-by-watching session buffer.
 *
 * While a recording session is live, the sidecar emits `ui_interaction`
 * events (each click/commit paired with the focused element's SemanticRef).
 * This buffers them per session and hands the sequence to the compiler on
 * stop. Redaction of obvious secrets happens here, at capture time, so raw
 * secrets never reach the compiler or the stored skill.
 */

import type { SemanticRef } from '../structural/types.ts';

export type RawInteraction = {
  action: 'click' | 'set_value' | 'press_keys' | 'launch_app' | 'navigate';
  ref?: SemanticRef;
  value?: string;
  ts: number;
  app?: string;
  title?: string;
  url?: string;
  /** Provider hint so the compiler knows desktop vs browser. */
  surface?: 'desktop' | 'browser';
  /** True when the source field was a password/secure input. */
  secure?: boolean;
};

export type RecordingSession = {
  id: string;
  startedAt: number;
  interactions: RawInteraction[];
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

/** Redact a value in place if it looks secret; returns the (possibly) redacted event. */
export function redactInteraction(i: RawInteraction): RawInteraction {
  if (i.value !== undefined && looksSecret(i.value, i.ref, i.secure)) {
    return { ...i, value: '{{REDACTED}}', secure: true };
  }
  return i;
}

/** In-memory recorder. One live session at a time (per the record_skill UX). */
export class SkillRecorder {
  private session: RecordingSession | null = null;

  start(id: string, now: number): RecordingSession {
    this.session = { id, startedAt: now, interactions: [] };
    return this.session;
  }

  isRecording(): boolean {
    return this.session !== null;
  }

  /** Buffer one interaction (redacted at capture time). */
  push(i: RawInteraction): void {
    if (!this.session) return;
    this.session.interactions.push(redactInteraction(i));
  }

  /** Stop and return the buffered session (or null if none). */
  stop(): RecordingSession | null {
    const s = this.session;
    this.session = null;
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
