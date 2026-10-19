import type { WorkflowJobSpecification, CompositionCandidate, ComposeResult } from '../../actions/tools/workflow-composer';
import type { PlanningPolicy, CompositionProvenance } from '../../actions/tools/composition-provenance';
import type { FlowTriggerNode } from '../db/repos/flow-version';
export interface Notification { message: string; channels: string[] }
/** A tool call a scenario expects. Listed params must match exactly; any other
 * param must be absent. `outcome` is what the sandbox answers for that call. */
export interface ToolCallExpectation {
  toolName: string; params: Record<string, unknown>;
  outcome?: 'succeeded' | 'approval_pending' | 'blocked' | 'error';
}
/** State the scenario's fake services serve. None of it reaches the composer. */
export interface ScenarioSandbox {
  files?: Record<string, string>; clipboard?: string;
  entities?: Array<{ id: string; type: string; name: string; properties: Record<string, unknown> | null }>;
  commitments?: Array<{ id: string; description: string; status: string; dueAt: number | null; priority: string }>;
  activity?: Array<{ id: string; appName: string | null; windowTitle: string | null; url: string | null; summary: string | null }>;
  /** Tools whose calls need approval here: the run pauses before the tool does anything. */
  approvals?: string[];
  /** Machine names that are offline here: calls to them are blocked, not started. */
  offlineTargets?: string[];
  agentReply?: string;
}
export interface Scenario {
  id: string; payload: Record<string, unknown>; notifications: Notification[];
  /** The one AI step's simulated reply, what its prompt must include, and what it must not. */
  ai?: { reply: string; promptIncludes: string[]; promptExcludes?: string[] };
  /** Expected tool calls as a multiset; absent means none. */
  tools?: ToolCallExpectation[];
  /** Expected agent delegations; absent means none. */
  agents?: number;
  /** Expected final run status; absent means SUCCEEDED. */
  status?: 'SUCCEEDED' | 'PAUSED' | 'FAILED';
  sandbox?: ScenarioSandbox;
}
/** A step on a connection-bound integration that cannot run in the sandbox,
 * graded on the composed graph: action, connection binding and literal inputs. */
export interface ExternalStepExpectation {
  piece: string; action: string; connection: string; input: Record<string, unknown>;
}
export interface QualityTask {
  id: string; split: 'development' | 'heldout'; category: string;
  specification: WorkflowJobSpecification;
  expectation: {
    trigger: { kind: 'manual' | 'schedule' | 'webhook' | 'event'; cron?: string; eventType?: string };
    maxAiSteps: number; blocked?: boolean; negativeConstraints: string[];
    /** Structured constraints checked on the composed graph; receipts are held to exact expectations. */
    forbidden?: { pieces?: string[]; actions?: string[]; tools?: string[]; channels?: string[]; agents?: boolean };
    /** Expected external steps. A task with any is graded on its graph and has no scenarios. */
    external?: ExternalStepExpectation[];
  };
  scenarios: Scenario[];
}
export interface EffectReceipt {
  kind: 'notification' | 'ai' | 'tool' | 'agent' | 'context'; input: Record<string, unknown>;
  runId: string; stepName: string | null;
  /** What the sandbox answered: a pending approval or a blocked target means nothing happened. */
  outcome?: 'succeeded' | 'approval_pending' | 'blocked' | 'error';
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
  humanIntentCorrect: null | boolean;
  /** Review: correction time and edits, plus business usefulness and AI fidelity when judged. */
  supervision: null | { reviewer: string; elapsedMs: number; edits: number; notes: string; useful?: boolean | null; fidelity?: boolean | null };
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
  /** What the composer is shown besides the catalog; absent means the original W8 envelope. */
  environment?: import('./environment').EvaluationEnvironment;
  execute(graph: FlowTriggerNode, scenarios: Scenario[]): Promise<ScenarioResult[]>;
}
