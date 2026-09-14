/**
 * Goal Pursuit Types for M16 — Autonomous Goal Pursuit & Long-Term Planning
 *
 * OKR-style hierarchical goal system with Google-style 0.0-1.0 scoring.
 * Goals nest: objective → key_result → milestone → task → daily_action.
 */

// ── Enums ───────────────────────────────────────────────────────────

export type GoalLevel = 'objective' | 'key_result' | 'milestone' | 'task' | 'daily_action';

export type GoalStatus = 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'killed';

export type GoalHealth = 'on_track' | 'at_risk' | 'behind' | 'critical';

export type TimeHorizon = 'life' | 'yearly' | 'quarterly' | 'monthly' | 'weekly' | 'daily';

export type EscalationStage = 'none' | 'pressure' | 'root_cause' | 'suggest_kill';

export type ProgressType = 'manual' | 'auto_detected' | 'review' | 'system';

export type CheckInType = 'morning_plan' | 'evening_review';

// ── Core Types ──────────────────────────────────────────────────────

export type Goal = {
  id: string;
  parent_id: string | null;
  level: GoalLevel;
  title: string;
  description: string;
  success_criteria: string;
  time_horizon: TimeHorizon;
  score: number;                     // 0.0-1.0 OKR score (0.7 = good)
  score_reason: string | null;
  status: GoalStatus;
  health: GoalHealth;
  deadline: number | null;           // epoch ms
  started_at: number | null;
  estimated_hours: number | null;
  actual_hours: number;
  authority_level: number;           // min authority for actions within this goal
  tags: string[];
  dependencies: string[];            // goal IDs that must complete first
  escalation_stage: EscalationStage;
  escalation_started_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export type GoalProgressEntry = {
  id: string;
  goal_id: string;
  type: ProgressType;
  score_before: number;
  score_after: number;
  note: string;
  source: string;                    // 'user', 'awareness', 'daily_review', etc.
  created_at: number;
};

export type GoalCheckIn = {
  id: string;
  type: CheckInType;
  summary: string;
  goals_reviewed: string[];          // goal IDs
  actions_planned: string[];         // for morning
  actions_completed: string[];       // for evening
  created_at: number;
  work_item_ids: string[];          // commitment IDs, ordered like actions_planned
};

export type GoalEstimate = {
  llm_estimate_hours: number;
  historical_estimate_hours: number | null;
  final_estimate_hours: number;
  confidence: number;                // 0.0-1.0
  reasoning: string;
  similar_past_goals: string[];      // vault entity IDs
};

// ── Query Types ─────────────────────────────────────────────────────

export type GoalQuery = {
  status?: GoalStatus;
  level?: GoalLevel;
  parent_id?: string | null;
  health?: GoalHealth;
  tag?: string;
  time_horizon?: TimeHorizon;
  limit?: number;
};

export type GoalUpdate = {
  title?: string;
  description?: string;
  success_criteria?: string;
  time_horizon?: TimeHorizon;
  deadline?: number | null;
  estimated_hours?: number | null;
  authority_level?: number;
  tags?: string[];
  dependencies?: string[];
  sort_order?: number;
};
