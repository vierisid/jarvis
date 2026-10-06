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
  kind: 'intent' | 'permission' | 'recovery';
  title: string;
  state: ApprovalExecutionState | NonNullable<BriefDecision['workStatus']> | EffectStatus;
  /** These are separate facts. A permission grant or committed effect is not a verified result. */
  refs: DecisionReference[];
  relatedTruncated: boolean;
  supportedActions: DecisionAction[];
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
