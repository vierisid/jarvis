/**
 * The 48-hour trial entitlement.
 *
 * ONE record per install, holding what the control plane grants a founder for
 * the length of the trial. The control plane that issues it is not deployed,
 * so this module owns the SHAPE and the local persistence; the issuing path is
 * a deliberate stub (`issueTrialEntitlement`, driven by an env seed or the
 * dev-only API route) rather than a fake server. When the plane ships, it
 * writes this same record and everything downstream is unchanged.
 *
 * The two decisions this file exists to enforce:
 *
 *  - D9. The clock starts at the founder's FIRST SPOKEN WORD. Not at signup,
 *    not at install, not when the app opens, not when Jarvis speaks first. A
 *    founder who signs up and closes the laptop loses nothing. `startTrialClock`
 *    is the only writer of `started_at` and it is idempotent, so a second
 *    utterance can never restart or extend the 48 hours.
 *  - D1. Realtime voice is on and NOT rationed for the length of the trial.
 *    The grant carries that, because it is the plane's to give — see
 *    `withTrialRealtime` for how it reaches the running config.
 *
 * Storage is the vault settings store, one JSON row. It is deliberately NOT a
 * `JarvisConfig` section: config sections are user-owned and dashboard-editable,
 * and a trial the user can extend by editing their own settings is not a trial.
 */

import { getSetting, setSetting, deleteSetting } from '../vault/settings.ts';

/** Settings-store key. Versioned: a plane-issued v2 record must not silently
 *  half-load through a v1 reader. */
export const TRIAL_ENTITLEMENT_KEY = 'trial.entitlement.v1';

/** 48 hours (D3, D9). The number the whole design is named after. */
export const TRIAL_DURATION_MS = 48 * 60 * 60 * 1000;

/**
 * The realtime session cap that applies during a trial, in minutes.
 *
 * D1 says realtime is uncapped, and `decisions.md` does not say what a session
 * cap of "uncapped" is in a field that must be a positive number
 * (`resolveRealtimeVoice` substitutes the 10-minute default for 0 or absent).
 * The trial's own length is the honest ceiling: a session cannot outlive the
 * entitlement that pays for it, so a session may run for the whole 48 hours and
 * `max_session_minutes` stops being a thing the founder can hit. Recorded as a
 * decision taken here, not one taken in the design session.
 */
export const TRIAL_MAX_SESSION_MINUTES = TRIAL_DURATION_MS / 60_000;

/**
 * `issued`  — granted, clock NOT started. The founder may sit here forever.
 * `active`  — the founder has spoken; `started_at` and `expires_at` are stamped.
 * `expired` — the 48 hours are up. Derived on read, never trusted from the row:
 *             a daemon that was off across the expiry moment must not wake up
 *             believing the trial is still live.
 */
export type TrialState = 'issued' | 'active' | 'expired';

export type TrialEntitlement = {
  version: 1;
  /** The grant's id. Control-plane id when it issues one; a local uuid for a stub. */
  id: string;
  /** The account the trial belongs to. Null on a stub, which has no account plane. */
  account_id: string | null;
  /** Where this record came from. `local_stub` never reaches a real user. */
  issuer: 'control_plane' | 'local_stub';
  issued_at: number;
  /** How long the trial runs ONCE STARTED. Stored, not assumed, so a plane that
   *  grants a different length does not need a client release. */
  duration_ms: number;
  /** D9 — the founder's first spoken word. Null until they speak. */
  started_at: number | null;
  /** `started_at + duration_ms`. Null until the clock starts. */
  expires_at: number | null;
  /** Last persisted state. `expired` is still derived on read; see resolveTrialState. */
  state: TrialState;
  /** D1 — what the grant buys for voice. */
  realtime: {
    enabled: boolean;
    /** Minutes. See TRIAL_MAX_SESSION_MINUTES for why this is the trial length. */
    max_session_minutes: number;
  };
  /**
   * Stamped when the opening (beats 1 to 5) has done its work and the
   * conversation is ready to continue into the room beats. THE SEAM: it is not
   * "onboarding finished" and it must never be read as such, because per D17
   * the conversation does not end here.
   */
  opening_completed_at: number | null;
};

/** What the UI and the daemon read. Derived, never stored. */
export type TrialSnapshot = {
  /** False when no entitlement exists — the overwhelmingly common case. */
  present: boolean;
  state: TrialState | null;
  started_at: number | null;
  expires_at: number | null;
  /** Milliseconds left, or null when the clock has not started. Never negative. */
  ms_remaining: number | null;
  opening_completed_at: number | null;
};

/** Nothing here: the shape a non-trial install always reports. */
export const NO_TRIAL: TrialSnapshot = {
  present: false,
  state: null,
  started_at: null,
  expires_at: null,
  ms_remaining: null,
  opening_completed_at: null,
};

/* ─────────────────────────── pure logic ─────────────────────────── */

/**
 * The state an entitlement is REALLY in at `now`.
 *
 * Expiry is computed, not read: the stored `state` is a cache the daemon last
 * wrote, and the daemon is not running for most of the 48 hours.
 */
export function resolveTrialState(e: TrialEntitlement, now: number): TrialState {
  if (e.started_at === null || e.expires_at === null) return 'issued';
  return now >= e.expires_at ? 'expired' : 'active';
}

/**
 * D9, and the whole of it: stamp the clock at the founder's first spoken word.
 *
 * Pure and IDEMPOTENT — an entitlement that already carries `started_at` comes
 * back byte-identical. The caller fires this on every user utterance without
 * having to remember whether it already did, which is what keeps a second
 * sentence from moving the deadline.
 */
export function startedEntitlement(e: TrialEntitlement, now: number): TrialEntitlement {
  if (e.started_at !== null) return e;
  return {
    ...e,
    started_at: now,
    expires_at: now + e.duration_ms,
    state: 'active',
  };
}

/** Derive the snapshot the API and the shell read. */
export function snapshotOf(e: TrialEntitlement | null, now: number): TrialSnapshot {
  if (!e) return NO_TRIAL;
  const state = resolveTrialState(e, now);
  return {
    present: true,
    state,
    started_at: e.started_at,
    expires_at: e.expires_at,
    ms_remaining: e.expires_at === null ? null : Math.max(0, e.expires_at - now),
    opening_completed_at: e.opening_completed_at,
  };
}

/**
 * Is the trial live enough to run the opening and pay for realtime?
 *
 * `issued` counts: the clock has not started precisely BECAUSE the founder has
 * not spoken yet, and refusing them voice until they speak would be a deadlock.
 * `expired` does not.
 */
export function isTrialRunning(e: TrialEntitlement | null, now: number): boolean {
  if (!e) return false;
  const state = resolveTrialState(e, now);
  return state === 'issued' || state === 'active';
}

/**
 * Validate an untrusted record before anything acts on it. A malformed row (a
 * hand-edited settings table, a half-written plane response) must read as NO
 * trial rather than as a trial with `expires_at: NaN`, which never expires.
 */
export function parseTrialEntitlement(raw: unknown): TrialEntitlement | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (r.issuer !== 'control_plane' && r.issuer !== 'local_stub') return null;
  if (!Number.isFinite(r.issued_at)) return null;
  if (!Number.isFinite(r.duration_ms) || (r.duration_ms as number) <= 0) return null;

  const started = r.started_at === null || r.started_at === undefined
    ? null
    : Number.isFinite(r.started_at) ? (r.started_at as number) : NaN;
  if (Number.isNaN(started)) return null;

  // expires_at is re-derived from started_at rather than trusted: the two must
  // agree, and started_at is the one D9 makes authoritative.
  const duration = r.duration_ms as number;
  const expires = started === null ? null : started + duration;

  const rt = (typeof r.realtime === 'object' && r.realtime !== null)
    ? r.realtime as Record<string, unknown>
    : {};
  const maxMinutes = Number.isFinite(rt.max_session_minutes) && (rt.max_session_minutes as number) > 0
    ? (rt.max_session_minutes as number)
    : TRIAL_MAX_SESSION_MINUTES;

  return {
    version: 1,
    id: r.id,
    account_id: typeof r.account_id === 'string' ? r.account_id : null,
    issuer: r.issuer,
    issued_at: r.issued_at as number,
    duration_ms: duration,
    started_at: started,
    expires_at: expires,
    state: started === null ? 'issued' : 'active',
    realtime: {
      enabled: rt.enabled !== false,
      max_session_minutes: maxMinutes,
    },
    opening_completed_at: Number.isFinite(r.opening_completed_at)
      ? (r.opening_completed_at as number)
      : null,
  };
}

/* ─────────────────────────── persistence ─────────────────────────── */

/** Read the entitlement, or null on a normal install (which is almost all of them). */
export function readTrialEntitlement(): TrialEntitlement | null {
  let raw: string | null;
  try {
    raw = getSetting(TRIAL_ENTITLEMENT_KEY);
  } catch {
    // No vault DB open (CLI tools, early boot). No trial.
    return null;
  }
  if (!raw) return null;
  try {
    return parseTrialEntitlement(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeTrialEntitlement(e: TrialEntitlement): void {
  setSetting(TRIAL_ENTITLEMENT_KEY, JSON.stringify(e));
}

/** Remove the grant entirely. Used by the onboarding reset path and by tests. */
export function clearTrialEntitlement(): void {
  try {
    deleteSetting(TRIAL_ENTITLEMENT_KEY);
  } catch {
    /* no DB — nothing to clear */
  }
}

/**
 * Issue a trial. STUB for the control plane: the plane will POST this record,
 * and until it exists an install is seeded from the environment or the dev
 * route. Refuses to overwrite an existing grant — one trial per install is the
 * only local half of the one-trial-per-account rule (Q3 owns the real half),
 * and re-issuing would hand a fresh 48 hours to anyone who can call it twice.
 */
export function issueTrialEntitlement(opts?: {
  account_id?: string | null;
  issuer?: TrialEntitlement['issuer'];
  duration_ms?: number;
  now?: number;
}): TrialEntitlement | null {
  if (readTrialEntitlement()) return null;
  const now = opts?.now ?? Date.now();
  const e: TrialEntitlement = {
    version: 1,
    id: crypto.randomUUID(),
    account_id: opts?.account_id ?? null,
    issuer: opts?.issuer ?? 'local_stub',
    issued_at: now,
    duration_ms: opts?.duration_ms ?? TRIAL_DURATION_MS,
    started_at: null,
    expires_at: null,
    state: 'issued',
    realtime: { enabled: true, max_session_minutes: TRIAL_MAX_SESSION_MINUTES },
    opening_completed_at: null,
  };
  writeTrialEntitlement(e);
  return e;
}

/**
 * D9 at the persistence layer. Called from the conductor the moment the
 * founder's first utterance is recognised, and on every one after it — the
 * idempotence is in `startedEntitlement`, so callers do not track state.
 *
 * Returns the entitlement as it now stands, or null when there is no trial.
 */
export function startTrialClock(now = Date.now()): TrialEntitlement | null {
  const e = readTrialEntitlement();
  if (!e) return null;
  const started = startedEntitlement(e, now);
  if (started !== e) writeTrialEntitlement(started);
  return started;
}

/**
 * Mark the opening done. THE SEAM the room beats attach to. Idempotent, and
 * deliberately separate from anything that would read as "onboarding is
 * finished" — under D17 the conversation carries straight on into the rooms.
 */
export function markOpeningCompleted(now = Date.now()): TrialEntitlement | null {
  const e = readTrialEntitlement();
  if (!e) return null;
  if (e.opening_completed_at !== null) return e;
  const next = { ...e, opening_completed_at: now };
  writeTrialEntitlement(next);
  return next;
}

/** The snapshot the API route and the shell read. */
export function trialSnapshot(now = Date.now()): TrialSnapshot {
  return snapshotOf(readTrialEntitlement(), now);
}

/** Env var that seeds a stub grant at boot. See `seedTrialFromEnv`. */
export const TRIAL_SEED_ENV = 'JARVIS_TRIAL';

/**
 * Boot-time stub for the control plane.
 *
 * `JARVIS_TRIAL=1` on an install with no grant issues one, clock not started.
 * This is the ONLY way a trial exists today, and it is how the opening is run
 * and reviewed before the plane that issues real entitlements is deployed.
 * Absent the variable this does nothing at all, which is the state of every
 * install.
 */
export function seedTrialFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env[TRIAL_SEED_ENV] ?? '').trim().toLowerCase();
  if (flag !== '1' && flag !== 'true' && flag !== 'yes') return false;
  return issueTrialEntitlement({ issuer: 'local_stub' }) !== null;
}
