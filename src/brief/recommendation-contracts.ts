import type { BriefEvidenceRef } from './contracts';
import type { BriefProvider } from './providers';

/** Structural Q-18 seam. No compile-time import of its separately delivered planner. */
export interface RecommendedAction {
  kind: 'check_result' | 'resolve_blocker' | 'restore_capability' | 'decide_work' | 'continue_work' | 'close_goal' | 'start_step' | 'review_goal';
  title: string;
  goal: { goalId: string; revision: string; path: string[] } | null;
  workItemId: string | null;
  rationale: string[];
  evidence: BriefEvidenceRef[];
  load: 'adds' | 'reduces' | 'none';
}
export type RecommendationPlan = {
  planner: 'next-action-v1'; generatedAt: number; expiresAt: number; basis: string;
} & (
  | { outcome: 'recommend'; action: RecommendedAction }
  | { outcome: 'ask'; question: string; about: RecommendedAction[] }
  | { outcome: 'none'; reason: string; evidence: BriefEvidenceRef[] }
);
export interface RecommendationPlanner extends BriefProvider { plan(now: number): unknown }
export interface RecommendationReceipt {
  receiptId: string; recommendationId: string; requestId: string; revision: string; acceptedAt: number;
  destination: { decisionId: string; workItemId: string; title: string };
  created: boolean;
}
export interface StoredRecommendation {
  recommendationId: string; requestId: string; revision: string; plan: RecommendationPlan;
  state: 'available' | 'accepted' | 'dismissed' | 'expired' | 'blocked' | 'ask' | 'none';
  reason: string | null;
  acceptance: RecommendationReceipt | null;
}
