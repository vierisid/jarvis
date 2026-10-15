/** Module-local v1 contract. No optional provider or runtime imports. */
export const STEPS = ['welcome', 'explain', 'legacy-provider-setup', 'google', 'interview', 'tour', 'activation', 'build', 'result', 'exited'] as const;
export const KINDS = ['step_transition', 'connection_attempt', 'interview_turn', 'build_phase', 'recovery', 'result_handoff'] as const;
export const OUTCOMES = ['succeeded', 'failed', 'cancelled', 'needs_input', 'skipped', 'unknown'] as const;
export const FAILURE_CODES = ['none', 'model_timeout', 'model_unavailable', 'transport_disconnected', 'save_failed', 'save_timeout', 'unauthorized', 'conflict', 'invalid_request', 'dependency_unavailable', 'cancelled', 'unknown'] as const;
export const PROVIDERS = ['usejarvis', 'openai', 'anthropic', 'google', 'local', 'other', 'unknown'] as const;
export const ID_FIELDS = ['journeyId', 'operationId', 'requestId', 'attemptId', 'sessionId', 'turnId', 'jobId', 'compositionRecordId', 'flowId', 'versionId'] as const;
export type Step = typeof STEPS[number];
export type Kind = typeof KINDS[number];
export type Outcome = typeof OUTCOMES[number];
export type FailureCode = typeof FAILURE_CODES[number];
export type Scope = Readonly<{ actorId: string; projectId: string }>;
export type Correlations = { journeyId: string; operationId: string } & Partial<Record<typeof ID_FIELDS[number], string>>;
export interface Completion { outcome: Outcome; failureCode: FailureCode }
export interface EventMetadata {
  schemaVersion: 1;
  /** Stable owner-issued ID for one observation, reused on redelivery. */
  eventId: string;
  kind: Kind;
  stage: Step;
  correlation: Correlations;
  from?: Step;
  to?: Step;
  phase?: 'understanding' | 'building' | 'validating' | 'saving';
  recovery?: 'reconnect' | 'resume' | 'retry' | 'reconcile';
  /** Server-selected profile identity, never a credential/configuration object. */
  model?: { provider: typeof PROVIDERS[number]; profileId: string };
}
export interface DiagnosticInput extends EventMetadata, Completion {
  /** Elapsed time measured at the operation boundary; null means unavailable. */
  durationMs: number | null;
}
/** IDs below are keyed pseudonyms, never the raw input IDs. */
export interface DiagnosticEvent extends DiagnosticInput { sequence: number }
export type RecordResult = 'recorded' | 'duplicate' | 'conflict' | 'invalid' | 'unavailable';
export type DeliveryState = 'absent' | 'idle' | 'pending' | 'failed' | 'timed_out' | 'closed';
export interface Receipt {
  schemaVersion: 1;
  /** Diagnostic observations do not certify business completion. */
  kind: 'onboarding_diagnostics';
  scopeId: string;
  journeyId: string;
  events: DiagnosticEvent[];
  evictedEvents: number;
  duplicateEvents: number;
  conflictingEvents: number;
  delivery: DeliveryState;
  /** Queued or active deliveries dropped for this receipt, not other tenants' counts. */
  droppedDeliveries: number;
}
export interface Sink<Context> { record(context: Context, input: unknown): unknown }
export interface Options<Context> {
  enabled?: boolean;
  /** Resolve live server authority. Request fields are never scope selectors. */
  authorize(context: Context): Scope | null;
  /** Local nonblocking logger only. No analytics/export destination is installed. */
  logger?: (event: Readonly<DiagnosticEvent>, signal: AbortSignal) => void | Promise<void>;
  /** Optional server secret (at least 32 bytes) for stable cross-restart IDs.
   * Otherwise a process-local key is generated lazily on first authorized use. */
  correlationKey?: Uint8Array;
  deliveryTimeoutMs?: number;
}
export const LIMITS = Object.freeze({ journeys: 32, events: 32, dedup: 128, queue: 32, idLength: 256, durationMs: 86_400_000 });
