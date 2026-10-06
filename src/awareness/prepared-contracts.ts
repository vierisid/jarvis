import type { BriefBinding, BriefEvidenceRef, BriefPreparedOpportunity } from '../brief/contracts';
import type { JobKind } from './opportunity-types';

export interface PreparedSpecification {
  opportunityId: string; sourceRevision: string; kind: JobKind;
  name: string; description: string; expectedOutcome: string;
  evidence: BriefEvidenceRef[];
  goal: { goalId: string; revision: string; rationale: string } | null;
  confirmed: boolean; customConstraints: boolean;
}
export interface PreparedIdentity {
  proposalId: string; revision: string; specification: PreparedSpecification;
  compositionId: string;
  workflow: { flowId: string; versionId: string; versionDigest: string };
}
export interface PreparedQualification {
  qualifier: 'prepared-qualification-v1'; verdict: 'ready' | 'blocked' | 'review_needed';
  reasons: Array<{ code: string; severity: string; message: string; step?: string }>;
  snapshot: { proposalId: string; revision: string; flowId: string | null; versionId: string | null;
    versionDigest: string | null; fingerprint: string; bindings: BriefBinding[] };
  checkedAt: number;
}
export interface PreparedAssessment {
  request: Record<string, unknown>;
  qualification: PreparedQualification;
  previewBasis: 'illustrative_template' | 'sandbox_sample';
}
/** Q-13 is an optional activation dependency. This module compiles without it. */
export interface PreparedQualificationGate {
  readiness(): boolean;
  prepare(identity: PreparedIdentity): Promise<PreparedAssessment>;
  recheck(assessment: PreparedAssessment): { current: PreparedQualification; stale: boolean };
  close?(): Promise<void>;
}
export type PreparedOpportunityView = BriefPreparedOpportunity & {
  opportunityId: string; title: string; specification: PreparedSpecification;
  blockers: Array<{ code: string; message: string }>;
  /** Eligibility only. F-10 owns the actual approval/activation command. */
  canApprove: boolean;
};
export const PREPARATION_LIMITS = { timeoutMs: 120_000, dailyAttempts: 3, attemptsPerProposal: 2, queued: 20, page: 50 } as const;
