import type { BriefDecision, BriefPageQuery } from './contracts';
import type { EffectStatus } from '../workflows/db/repos/workflow-effect';
import type { ApprovalExecutionState } from '../authority/approval';

export type DecisionReference =
  | { kind: 'approval'; id: string }
  | { kind: 'work_item'; id: string }
  | { kind: 'effect'; id: string; runId: string; status: EffectStatus };
export type DecisionAction = 'accept_intent' | 'reject_intent' | 'approve_permission' | 'reject_permission'
  | 'execute_once' | 'close_without_running' | 'inspect';
export interface QueuedDecision extends BriefDecision {
  kind: 'intent' | 'permission' | 'recovery' | 'held';
  /**
   * Only on `held`: runs of one workflow waiting behind its approval-card
   * limit. There is nothing to decide for them, so they never count as things
   * that need the owner; the title is the plain sentence to show.
   */
  held?: { workflowName: string; count: number };
  title: string;
  state: 'deferred' | ApprovalExecutionState | NonNullable<BriefDecision['workStatus']> | EffectStatus;
  /** These are separate facts. A permission grant or committed effect is not a verified result. */
  refs: DecisionReference[];
  relatedTruncated: boolean;
  supportedActions: DecisionAction[];
  review?: { toolName: string; reason: string; target?: string; origin?: string; element?: string; workflowName?: string; requestedAt?: number; message?: string; channels?: string[]; fallback?: 'desktop';
    /** #1314: a reviewed browser/desktop workflow card: the computer, the window, and every value with where it came from. */
    computer?: string; window?: string; values?: Array<{ name: string; value: string; source: 'workflow' | 'run_data' | 'agent' }> };
  placement: number;
  createdAt: number;
}
export interface DecisionQuery extends BriefPageQuery { runId?: string }
export interface DecisionResolution {
  revision: string;
  action: Exclude<DecisionAction, 'inspect'>;
  reason?: string;
  note?: string;
}
