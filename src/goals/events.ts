/**
 * Goal Event Types for M16 — Autonomous Goal Pursuit
 *
 * Events emitted by GoalService and broadcast via WebSocket.
 */

export type GoalEventType =
  | 'goal_created'
  | 'goal_updated'
  | 'goal_scored'
  | 'goal_measurement_recorded'
  | 'goal_activity_recorded'
  | 'goal_status_changed'
  | 'goal_completed'
  | 'goal_failed'
  | 'goal_killed'
  | 'goal_health_changed'
  | 'goal_escalated'
  | 'goal_deleted'
  | 'check_in_morning'
  | 'check_in_evening'
  | 'daily_actions_generated'
  | 'replan_triggered';

export type GoalEvent = {
  /** Stable delivery identity and ordered replay cursor, assigned on commit. */
  eventId?: string;
  sequence?: number;
  type: GoalEventType;
  goalId?: string;
  data: Record<string, unknown>;
  timestamp: number;
};
