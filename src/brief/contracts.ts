/** Brief v1 wire projections. These do not replace canonical records or writers. */
import type { ApprovalExecutionMode, ApprovalExecutionOutcome, ApprovalStatus } from '../authority/approval.ts';
import type { GoalHealth, GoalStatus } from '../goals/types.ts';
import type { WorkItem } from '../goals/work-items.ts';
import type { MessageRole } from '../vault/conversations.ts';
import type { FactBasis, FactState } from '../vault/fact-policy.ts';
import type { FlowStatus } from '../workflows/db/repos/flow.ts';
import type { FlowVersionState } from '../workflows/db/repos/flow-version.ts';
import type { FlowRunStatus } from '../workflows/db/repos/flow-run.ts';

export const BRIEF_CONTRACT_VERSION = 1 as const;
/** All wire times are UTC epoch milliseconds. IDs are existing opaque source IDs. */
export type BriefTimestamp = number;
export type BriefRevision = string;
/** Opaque pagination cursor; never use a timestamp alone to break ties. */
export type BriefCursor = string;
export interface BriefPage<T> { items: T[]; nextCursor: BriefCursor | null }
export interface BriefPageQuery { cursor?: BriefCursor; limit?: number }

export type BriefUnavailableReason = 'disabled' | 'dependency_not_ready' | 'provider_unavailable';
/** A valid empty result is neither a failed read nor an unknown measurement. */
export type BriefReadResult<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T; asOf: BriefTimestamp }
  | { state: 'empty'; asOf: BriefTimestamp }
  | { state: 'stale'; data: T; asOf: BriefTimestamp }
  | { state: 'unavailable'; reason: BriefUnavailableReason }
  | { state: 'unsupported' };

export interface BriefConversation {
  conversationId: string;
  workspaceId: string;
  title: string;
  revision: BriefRevision;
  /** Closing only hides the tab. History and active work remain. */
  tab: { open: boolean; order: number };
  lastMessageAt: BriefTimestamp | null;
}
export interface BriefTurnRef {
  conversationId: string;
  turnId: string;
  requestId: string;
}
export interface BriefCancelTurn extends BriefTurnRef {}
export interface BriefSendTurn extends BriefTurnRef { text: string; speak?: boolean }
export type BriefTurnState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface BriefMessage extends BriefTurnRef {
  messageId: string;
  role: MessageRole;
  content: string;
  createdAt: BriefTimestamp;
}
export interface BriefActivity {
  activityId: string;
  phase: 'started' | 'completed' | 'failed';
  /** Allowlisted, redacted commentary only. Never hidden reasoning or raw arguments. */
  summary: string;
  refs: BriefEvidenceRef[];
}
export type BriefChatPayload =
  | { kind: 'message'; message: BriefMessage }
  | { kind: 'delta'; messageId: string; text: string }
  | { kind: 'status'; state: 'queued' | 'running' }
  | { kind: 'activity'; activity: BriefActivity }
  | { kind: 'approval'; approvalId: string; status: ApprovalStatus }
  | { kind: 'terminal'; state: Extract<BriefTurnState, 'completed' | 'failed' | 'cancelled'>; error?: { code: string; message: string } };
export interface BriefChatEvent extends BriefTurnRef {
  eventId: string;
  /** Safe integer, strictly increasing per conversation, including terminal events. */
  sequence: number;
  payload: BriefChatPayload;
}

export interface BriefWorkflowRef {
  flowId: string;
  versionId: string;
  /** ENABLED/DISABLED is activation; DRAFT/LOCKED is version lifecycle. */
  activation: FlowStatus;
  versionState: FlowVersionState;
}
export interface BriefRunRef extends BriefWorkflowRef {
  runId: string;
  status: FlowRunStatus;
}
export interface BriefApproval {
  approvalId: string;
  status: ApprovalStatus;
  executionMode: ApprovalExecutionMode;
  /** An approved permission is not a successful effect. */
  executionOutcome: ApprovalExecutionOutcome | null;
}
export interface BriefDecision {
  decisionId: string;
  revision: BriefRevision;
  approval: BriefApproval | null;
  workItemId: WorkItem['id'] | null;
  workStatus: WorkItem['status'] | null;
  workflow: BriefWorkflowRef | null;
  run: BriefRunRef | null;
  /** Server-selected actions for this exact revision. Edits require fresh approval. */
  actions: Array<'approve' | 'reject' | 'keep_draft' | 'edit' | 'inspect'>;
}

export interface BriefEvidenceRef {
  kind: 'observation' | 'fact' | 'goal' | 'work_item' | 'run' | 'receipt' | 'source';
  id: string;
  revision: BriefRevision | null;
}
export interface BriefBinding {
  kind: 'connection' | 'target';
  id: string;
  revision: BriefRevision;
  availability: 'ready' | 'unavailable' | 'unknown';
}
interface BriefPreparedSnapshot {
  proposalId: string;
  revision: BriefRevision;
  evidence: BriefEvidenceRef[];
  goal: { goalId: string; revision: BriefRevision; rationale: string } | null;
  compositionId: string | null;
  workflow: BriefWorkflowRef | null;
  bindings: BriefBinding[];
  previewBasis: 'illustrative_template' | 'sandbox_sample' | 'verified_output' | null;
}
type BriefPreparationReadiness =
  | { state: 'ready'; checkedAt: BriefTimestamp }
  | { state: 'unchecked' | 'blocked' | 'stale'; checkedAt: BriefTimestamp | null };
export type BriefPreparedOpportunity = BriefPreparedSnapshot & (
  | { state: 'ready'; readiness: { state: 'ready'; checkedAt: BriefTimestamp };
      evidence: [BriefEvidenceRef, ...BriefEvidenceRef[]];
      goal: NonNullable<BriefPreparedSnapshot['goal']>; compositionId: string;
      workflow: BriefWorkflowRef; previewBasis: NonNullable<BriefPreparedSnapshot['previewBasis']> }
  | { state: 'preparing' | 'blocked' | 'stale';
      readiness: { state: 'unchecked' | 'blocked' | 'stale'; checkedAt: BriefTimestamp | null } }
  // Terminal proposals retain their historical readiness, without offering activation again.
  | { state: 'accepted' | 'dismissed'; readiness: BriefPreparationReadiness }
);

export interface BriefMeasurement {
  value: number;
  unit: string;
  baseline: number | null;
  target: number | null;
  asOf: BriefTimestamp;
  provenance: BriefEvidenceRef[];
  qualification: 'measured' | 'user_reported';
}
export interface BriefGoal {
  goalId: string;
  revision: BriefRevision;
  status: GoalStatus;
  health: GoalHealth;
  score: number;
  /** Null means unknown. A score of 0.6 is never converted into six partners. */
  measurement: BriefMeasurement | null;
}
export interface BriefOutcome {
  outcomeId: string;
  workItemId: string;
  runId: string | null;
  goalIds: string[];
  window: { start: BriefTimestamp; end: BriefTimestamp; timezone: string };
  result: BriefMeasurement;
  /** Only with a defensible manual baseline minus measured intervention. */
  timeBack: BriefMeasurement | null;
}
export interface BriefMemoryUse {
  useId: string;
  factId: string;
  sourceRevision: BriefRevision;
  stage: 'selected' | 'supplied' | 'outcome_verified';
  turn: BriefTurnRef | null;
  runId: string | null;
  at: BriefTimestamp;
}
export interface BriefMemory {
  factId: string;
  sourceId: string | null;
  sentence: string;
  basis: FactBasis;
  status: FactState;
  provenance: BriefEvidenceRef[];
  /** Null means usage instrumentation is unavailable, not unused. */
  uses: BriefMemoryUse[] | null;
  permissions: { canRead: boolean; canCorrect: boolean; canForget: boolean };
}
export interface BriefConnection {
  sourceId: string;
  kind: 'device' | 'native_service' | 'channel' | 'workflow_connection' | 'library_piece';
  accountId: string | null;
  availability: 'ready' | 'unavailable' | 'unknown';
  permissions: { canInspect: boolean; canConnect: boolean; canRevoke: boolean };
  /** Installed library availability never establishes account authentication. */
  authenticated: boolean | null;
}
