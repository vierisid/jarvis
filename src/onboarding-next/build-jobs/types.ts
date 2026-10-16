import type { BuildStore } from './store';

// Local structural ports. No optional onboarding module is imported at runtime or for types.
export type Scope = Readonly<{ actorId: string; projectId: string }>;
export interface Submission {
  action: 'create';
  request: { schemaVersion: 1; intentVersion: 1; requestId: string; prompt: string; contextRefs: { kind: string; id: string }[] };
  answers: Record<string, string>;
}
export interface DraftInput { schemaVersion: 1; intentId: string; submission: Submission }
export interface SubmitInput extends DraftInput { journeyId: string }
export interface Artifact {
  scopeId: string; requestId: string; requestDigest: string;
  compositionRecordId: string; flowId: string; versionId: string;
}
export type Phase = 'understanding' | 'building' | 'validating' | 'saving';
export type Outcome = 'queued' | 'working' | 'needs_input' | 'succeeded' | 'failed' | 'cancelled';
export type Reason = 'disabled' | 'invalid_request' | 'unauthorized' | 'binding_missing' | 'provider_unavailable'
  | 'storage_unavailable' | 'conflict' | 'not_found' | 'request_cancelled' | 'journey_unavailable' | 'intent_changed'
  | 'needs_input' | 'composition_failed' | 'timeout' | 'attempt_limit' | 'interrupted' | 'claim_lost';
export interface Status {
  schemaVersion: 1; scopeId: string; journeyId: string; jobId: string; requestId: string; requestDigest: string;
  revision: number; outcome: Outcome; phase?: Phase; completedPhases: Phase[];
  cancellation: 'not_requested' | 'requested' | 'acknowledged';
  /** Unknown is never absence. Only a fenced authoritative reconciliation can establish none/saved. */
  resolution: 'pending' | 'unknown' | 'none' | 'saved';
  safeError?: string; missingInputs: string[]; artifact: Artifact | null;
  journeySync: 'pending' | 'started' | 'settled';
}
export type Result = { availability: 'ready'; status: Status; events: Status[]; cursor: number; truncated: boolean }
  | { availability: 'ready'; requestCancellation: {
    schemaVersion: 1; revision: 1 | 2; scopeId: string; journeyId: string; requestId: string; jobId: null;
    cancellation: 'requested' | 'acknowledged'; resolution: 'none'; journeySync: 'pending' | 'settled';
  } }
  | { availability: 'unsupported' | 'unavailable'; reason: Reason };
export interface IntentResult {
  availability: string; state?: string; issues?: { message: string }[];
  intent?: { schemaVersion: 1; intentVersion: 1; intentId: string; scopeId: string; requestDigest: string;
    request: Submission['request']; answers: Submission['answers'];
    creationPolicy: { artifact: 'disabled_draft'; publish: false; enable: false; run: false; grantTools: false; linkGoal: false } } | null;
}
export type DraftResult = { availability: 'ready'; state: 'saved'; artifact: Artifact }
  | { availability: 'ready'; state: 'absent' | 'pending' }
  | { availability: 'unsupported' | 'unavailable'; reason: string };
export interface DraftControl {
  signal: AbortSignal;
  /** Must be called inside B09's transaction on the SAME database as this store. */
  mayCommit(): boolean;
  /** Optional real stage notifications; never emit invented progress around an opaque composer. */
  onPhase(phase: Phase, sequence: number): void;
}
export interface JourneySnapshot {
  scopeId: string; journeyId: string; revision: number; buildRequestId?: string | null; jobId: string | null;
  draft: { flowId: string; versionId: string } | null;
  buildHistory?: { buildRequestId: string | null; jobId: string | null; outcome: 'failed' | 'cancelled' }[];
}
export type JourneyCommand = { type: 'reserve_build'; buildRequestId: string }
  | { type: 'build_started'; buildRequestId: string; jobId: string }
  | { type: 'draft_saved'; jobId: string; flowId: string; versionId: string }
  | { type: 'build_finished_without_draft'; buildRequestId: string; jobId: string | null; outcome: 'failed' | 'cancelled' };
export interface JourneyPort {
  read(): Promise<{ availability: string; snapshot?: JourneySnapshot }>;
  acknowledge(input: { journeyId: string; expectedRevision: number; requestId: string; command: JourneyCommand }): Promise<{
    availability: string; snapshot?: JourneySnapshot;
  }>;
}
export interface Services {
  /** Immutable generation. Replace it when account, vault, authorization services or adapters change. */
  id: string; store: BuildStore; access(): Promise<boolean>;
  journey?: JourneyPort;
  validate?(input: Submission, signal?: AbortSignal): Promise<IntentResult>;
  draft?: {
    compose(input: DraftInput, control: DraftControl): Promise<DraftResult>;
    reconcile(input: DraftInput): Promise<DraftResult>;
  };
}
export interface Dependencies<C> {
  enabled?: boolean;
  authorize(context: C): Scope | null | Promise<Scope | null>;
  servicesFor(scope: Scope, context: C): Services | null;
  /** Host policy, never client input. Production defaults: 30s lease, 120s total build, 3 model attempts. */
  leaseMs?: number; timeoutMs?: number; maxAttempts?: number;
}
export class BuildError extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
