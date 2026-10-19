/** Module-local projection of handoff-contract-v1. No sibling imports. */
export const JOURNEY_STEPS = [
  'welcome', 'explain', 'legacy-provider-setup', 'google', 'interview',
  'tour', 'activation', 'build', 'result', 'exited',
] as const;
export type JourneyStep = typeof JOURNEY_STEPS[number];
export type Scope = { actorId: string; projectId: string };

export interface JourneySnapshot {
  schemaVersion: 1;
  scopeId: string;
  journeyId: string;
  revision: number;
  stepId: JourneyStep;
  setupState: 'pending' | 'completed';
  /** Contract's unresolved initial state; no connection is started here. */
  interviewState: 'connecting' | 'ready' | 'thinking' | 'error' | 'done' | 'skipped';
  tourState: 'pending' | 'in_progress' | 'done' | 'skipped';
  tourStepId: string | null;
  /** Kept verbatim for ON-B-06 to interpret; never used as a new room ID. */
  legacyTourStepId: string | null;
  activationState: 'pending' | 'building' | 'draft_saved' | 'explored' | 'legacy_completed';
  completion: 'active' | 'completed' | 'explored' | 'legacy_completed';
  jobId: string | null;
  /** Optional only for v1 records written before build reservation support. */
  buildRequestId?: string | null;
  /** Retain terminal identities so old events cannot attach to a new attempt. */
  buildHistory?: Array<{
    buildRequestId: string | null;
    jobId: string | null;
    outcome: 'failed' | 'cancelled';
    [key: string]: unknown;
  }>;
  draft: { flowId: string; versionId: string; [key: string]: unknown } | null;
  replayReturnStepId: JourneyStep | null;
  [key: string]: unknown;
}

/** Read through current user-settings/profile services, under server scope. */
export interface LegacyStatus {
  setup_completed: boolean;
  setup_skipped_profile: boolean;
  profile_completed: boolean;
  tutorial_completed: boolean;
  tutorial_dismissed: boolean;
  tutorial_progress_step: string | null;
}

export type Navigation =
  | { type: 'navigate'; stepId: 'welcome' | 'explain' | 'legacy-provider-setup' | 'google' | 'interview' | 'tour' | 'activation' }
  | { type: 'replay_tutorial' }
  | { type: 'explore' }
  | { type: 'finish' };

/** Internal acknowledgements, NEVER forward an HTTP body to this port. */
export type Acknowledgement =
  | { type: 'setup_completed' }
  | { type: 'interview_finished'; state: 'done' | 'skipped' }
  | { type: 'tour_progress'; stepId: string }
  | { type: 'tour_finished'; state: 'done' | 'skipped' }
  /** MUST commit before ON-B-08 accepts/enqueues the corresponding request. */
  | { type: 'reserve_build'; buildRequestId: string }
  | { type: 'build_started'; buildRequestId: string; jobId: string }
  /** Only after the owner fences further work and confirms terminal work AND no durable draft association.
   * Null jobId requires durable rejection/cancellation of the unaccepted request key, not a missing read.
   * Null buildRequestId is exclusively for pre-reservation v1 jobs. */
  | { type: 'build_finished_without_draft'; buildRequestId: string | null; jobId: string | null; outcome: 'failed' | 'cancelled' }
  | { type: 'draft_saved'; jobId: string; flowId: string; versionId: string };

export interface Transition<C = Navigation> {
  journeyId: string;
  expectedRevision: number;
  requestId: string;
  command: C;
}

export interface StoredJourney {
  snapshot: JourneySnapshot;
  receipts: Array<{ requestId: string; digest: string; revision: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type JourneyResult =
  | { availability: 'ready'; snapshot: JourneySnapshot; appliedRevision?: number; replayed?: boolean }
  | { availability: 'unavailable' | 'unsupported'; reason: string; snapshot?: JourneySnapshot };

export interface JourneyTransaction {
  /** Opaque backing resource for synchronous guards; settings supplies its SQLite handle. */
  resource?: unknown;
  /** Null means absent, never a read/parse failure. */
  current: unknown | null;
  /** Must throw on unavailable/corrupt legacy status, never supply defaults. */
  readLegacy(): LegacyStatus;
  write(record: StoredJourney): void;
}

export interface JourneyPersistence {
  /** Atomic across connections/processes; throw rolls back ALL writes. */
  transaction<T>(scope: Scope, operation: (tx: JourneyTransaction) => T): T;
}

export interface JourneyDependencies {
  /** Re-evaluated on every call from authenticated SERVER context, not client IDs. */
  authorize(): Scope | null | Promise<Scope | null>;
  persistence: JourneyPersistence;
  /** Required for a new finish transition. Check the exact authorized draft
   * synchronously inside this transaction; missing/failed checks cannot finish.
   * No writes, promises or network calls. B10 supplies the result guard. */
  validateFinish?(scope: Scope, snapshot: JourneySnapshot, resource: unknown): boolean;
}
