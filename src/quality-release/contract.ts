/** Q22 consumes reviewed, candidate-bound evidence. It never activates a provider. */
export const JOURNEYS = ['observation-prepared-enabled-result', 'goal-next-step-checked-outcome', 'memory-correction-next-reply'] as const;
export const CONDITIONS = ['normal', 'offline', 'reconnect', 'restart', 'expiry', 'mixed-version'] as const;
export const PREREQUISITES = ['F-09', 'F-10', 'F-12', 'F-13', 'F-15', 'F-16',
  ...Array.from({ length: 21 }, (_, i) => `Q-${String(i + 1).padStart(2, '0')}`)];
export const QUALITY_CHECKS = ['first-intent', 'repaired-intent', 'useful-opportunities', 'negative-proposals',
  'qualified-recall', 'grounded-inputs', 'median-corrections', 'median-correction-time', 'request-budget',
  'token-budget', 'latency-budget'] as const;
export const DISPOSITIONS = ['passed', 'failed', 'blocked', 'not_run', 'unsupported'] as const;
export type Disposition = typeof DISPOSITIONS[number];
export type Runtime = { brain: string; hosting: string | null; sidecar: string | null; schema: string;
  model: string | null; profileRevision: string | null; policy: string; prompt: string; catalog: string; environment: string };
export type Proof = { candidate: string; runtimeHash: string; artifact: string; reviewed: boolean;
  startedAt: string; finishedAt: string; kind: 'deterministic' | 'heldout' | 'live_sandbox' };
export type Safety = { unauthorizedEffects: number; duplicateEffects: number; falseVerifiedOutcomes: number;
  crossChatLeaks: number; inventedInputs: number };
export type JourneyResult = { journey: typeof JOURNEYS[number]; condition: typeof CONDITIONS[number];
  disposition: Disposition; proof: Proof | null; safety: Safety | null };
/** The measurement owner supplies counts including failed/unrun cases, and a
 * reviewed verdict against the exact frozen rubric. Q22 does not rescore a holdout. */
export type Measurement = { kind: 'rate'; numerator: number; denominator: number; missedEligible: number }
  | { kind: 'count'; value: number }
  | { kind: 'distribution'; count: number; p50: number; p90: number; p95: number; max: number; timeouts: number };
export const TASK_DISPOSITIONS = ['passed', 'checks_failed', 'missed_abstention', 'false_abstention', 'composition_failed', 'composition_timeout', 'provider_error', 'routing_fallback', 'budget_stopped', 'harness_error', 'not_run', 'unsupported'] as const;
export type QualityResult = { check: typeof QUALITY_CHECKS[number]; disposition: Disposition; proof: Proof | null;
  rubricHash: string; safety: Safety | null; scheduled: number; measured: number; supportedTasks: number; negativeTasks: number;
  taskDispositions: Partial<Record<typeof TASK_DISPOSITIONS[number], number>>; verdict: 'met' | 'not_met' | 'not_established'; measurement: Measurement | null };
export type Profile = { id: string; deployment: 'local' | 'hosted'; runtime: Runtime; jobs: string[];
  journeys: JourneyResult[]; quality: QualityResult[]; liveConnector: { disposition: Disposition; proof: Proof | null } };
export type ReleaseRecord = { schemaVersion: 1; candidate: string;
  rubric: { q01Hash: string; supplementHash: string; status: 'proposed' | 'frozen'; frozenAt: string | null;
    approved: boolean; budgetsAgreed: boolean };
  prerequisites: { card: string; disposition: Disposition; integratedHead: string; proof: Proof | null }[];
  profiles: Profile[] };
export const SAFETY_KEYS: (keyof Safety)[] = ['unauthorizedEffects', 'duplicateEffects', 'falseVerifiedOutcomes', 'crossChatLeaks', 'inventedInputs'];
