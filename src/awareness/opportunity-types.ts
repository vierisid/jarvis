/** Versioned C6 contract. Observations and user reports never imply verified progress. */
import type { RoutineSignalEvidence } from './routine-signals.ts';
import type { RoutineStage } from './routine-catalog.ts';

export type JobKind = 'invoice_review' | 'lead_followup' | 'recurring_report'
  | 'meeting_followup' | 'expense_reconciliation' | 'support_triage';

export type JobSignal = {
  captureId: string;
  observedAt: number;
  app: string;
  kind: JobKind;
  cue: string;
  routine?: RoutineSignalEvidence;
};

export type GoalCandidate = {
  goalId: string;
  title: string;
  reason: string;
  evidenceCaptureIds: string[];
  basis: 'text_overlap_requires_confirmation' | 'causal_contribution_requires_confirmation';
  grounding?: {
    policy: 'goal-contribution-v1';
    objectiveId: string;
    path: Array<{ goalId: string; title: string; updatedAt: number }>;
    requiredOutcome: { goalId: string; field: 'success_criteria' | 'title'; text: string };
    contribution: string;
    uncertainty: string;
  };
};

export type GoalRelevance = {
  policy: 'goal-contribution-v1';
  assessedAt: number;
  status: 'candidate' | 'competing_goals' | 'no_supported_goal' | 'insufficient_evidence' | 'incomplete_goal_context';
  competingGoalIds: string[];
};

export type JobHypothesis = {
  schemaVersion: 1;
  assessedAt: number;
  patternKey: string;
  kind: JobKind;
  job: { title: string; proposedOutcome: string; question: string };
  evidence: JobSignal[];
  /** Optional for stored v1 hypotheses; new proposals include all three evidence roles. */
  routine?: {
    policy: 'routine-cues-v2';
    episodes: Array<Record<RoutineStage, { captureId: string; observedAt: number; cue: string }>>;
  };
  recurrence: {
    episodes: number;
    distinctDays: number;
    firstObservedAt: number;
    lastObservedAt: number;
    windowDays: 14;
    basis: 'observed_activity';
  };
  goalCandidates: GoalCandidate[];
  /** Optional for persisted older hypotheses. Current reads recompute this projection. */
  goalRelevance?: GoalRelevance;
  feasibility: {
    status: 'unverified';
    requiredChecks: string[];
    reason: string;
  };
  uncertainty: string[];
};

export type OpportunityValidation = {
  feedbackId: string;
  job: string;
  expectedOutcome: string;
  goalLink: { goalId: string; title: string; reason: string; basis: 'user_confirmed' } | null;
  confirmedAt: number;
};

export type Opportunity = {
  id: string; // same ID as awareness_suggestions; C7/C10 can reference this directly
  hypothesis: JobHypothesis;
  status: 'proposed' | 'interested' | 'validated' | 'dismissed';
  validation: OpportunityValidation | null;
  createdAt: number;
};

export type OpportunityAssessment = {
  schemaVersion: 1;
  assessedAt: number;
  proposals: JobHypothesis[];
  abstention: null | 'no_job_evidence' | 'insufficient_recurrence' | 'already_proposed';
};
