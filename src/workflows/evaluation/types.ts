import type { WorkflowJobSpecification, CompositionCandidate, ComposeResult } from '../../actions/tools/workflow-composer';
import type { PlanningPolicy, CompositionProvenance } from '../../actions/tools/composition-provenance';
import type { FlowTriggerNode } from '../db/repos/flow-version';
export interface Notification { message: string; channels: string[] }
export interface Scenario {
  id: string; payload: Record<string, unknown>; notifications: Notification[];
  ai?: { reply: string; promptIncludes: string[] };
}
export interface QualityTask {
  id: string; split: 'development' | 'heldout'; category: string;
  specification: WorkflowJobSpecification;
  expectation: {
    trigger: { kind: 'manual' | 'schedule' | 'webhook' | 'event'; cron?: string; eventType?: string };
    maxAiSteps: number; blocked?: boolean; negativeConstraints: string[];
  };
  scenarios: Scenario[];
}
export interface EffectReceipt {
  kind: 'notification' | 'ai'; input: Record<string, unknown>;
  runId: string; stepName: string | null;
}
export interface ScenarioResult {
  id: string; runId: string | null; status: string; receipts: EffectReceipt[];
  checks: { name: string; pass: boolean }[]; error?: string; elapsedMs: number;
}
export interface CallTrace {
  path: 'tools' | 'text'; request: unknown; response?: unknown; injectedResponse?: unknown; error?: string;
  elapsedMs: number; requestSha256: string; injectedFault?: string;
  /** Index of the failed candidate preceding this call; null for initial/discovery calls. Absent in legacy rows. */
  repairOfCandidate?: number | null;
}
export interface TransportAttempt {
  index: number; status: number | null; elapsedMs: number; requestedModel: string | null; reportedModel: string | null;
  usage: { input: number; output: number; cachedInput: number } | null;
  error?: string;
}
/** A request the evaluation refused to send. Nothing reached the provider. */
export interface TransportStop {
  reason: 'request_budget' | 'token_budget' | 'unaccounted_usage' | 'routing_fallback';
  afterAttempts: number; requestedModel: string | null;
}
export interface EvaluationRow {
  schemaVersion: 1; id: string; taskId: string; split: QualityTask['split']; repeat: number;
  kind: 'hosted' | 'harness-smoke'; policy: PlanningPolicy; condition: 'natural' | 'malformed-first';
  specification: WorkflowJobSpecification; provenance: CompositionProvenance;
  calls: CallTrace[]; transport: TransportAttempt[]; candidates: CompositionCandidate[];
  result: ComposeResult | null; error?: string; compositionMs: number;
  staticChecks: { name: string; pass: boolean }[]; aiSteps: number | null;
  scenarios: ScenarioResult[]; intentChecksPassed: boolean;
  humanIntentCorrect: null | boolean; supervision: null | { reviewer: string; elapsedMs: number; edits: number; notes: string };
  estimatedCostUsd: number | null; costComplete: boolean;
  /** Hosted profile under test; its revision is null without admin evidence. Absent in older rows. */
  profile?: { id: string; revisionSha256: string | null } | null;
  /** Requests refused during this task (budget or alias pin). Absent in older rows. */
  interruptions?: TransportStop[];
  /** Fingerprints of the system prompt and tool definitions each call sent. Absent in older rows. */
  promptSha256s?: string[];
}
export interface EffectExecutor {
  catalog: import('../runtime/piece-catalog').PieceCatalog;
  bundleHash: string;
  execute(graph: FlowTriggerNode, scenarios: Scenario[]): Promise<ScenarioResult[]>;
}
