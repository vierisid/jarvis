/**
 * Goal Vault — CRUD operations for M16 Autonomous Goal Pursuit
 */

import type { SQLQueryBindings } from 'bun:sqlite';
import { getDb, generateId } from './schema.ts';
import type {
  Goal, GoalProgressEntry, GoalCheckIn,
  GoalLevel, GoalStatus, GoalHealth, EscalationStage,
  GoalQuery, GoalUpdate,
} from '../goals/types.ts';

// ── Row types (raw DB) ──────────────────────────────────────────────

type GoalRow = Omit<Goal, 'tags' | 'dependencies'> & {
  tags: string | null;
  dependencies: string | null;
};

type ProgressRow = GoalProgressEntry;

type CheckInRow = Omit<GoalCheckIn, 'goals_reviewed' | 'actions_planned' | 'actions_completed' | 'work_item_ids'> & {
  goals_reviewed: string | null;
  actions_planned: string | null;
  actions_completed: string | null;
};

// ── Parsers ─────────────────────────────────────────────────────────

function parseGoal(row: GoalRow): Goal {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    dependencies: row.dependencies ? JSON.parse(row.dependencies) : [],
  };
}

function parseCheckIn(row: CheckInRow): GoalCheckIn {
  return {
    ...row,
    goals_reviewed: row.goals_reviewed ? JSON.parse(row.goals_reviewed) : [],
    actions_planned: row.actions_planned ? JSON.parse(row.actions_planned) : [],
    actions_completed: row.actions_completed ? JSON.parse(row.actions_completed) : [],
    work_item_ids: getDb().query<{ work_id: string }, [string]>(
      'SELECT work_id FROM commitment_work WHERE plan_id = ? ORDER BY action_index',
    ).all(row.id).map(w => w.work_id),
  };
}

// ── Goals CRUD ──────────────────────────────────────────────────────

export function createGoal(
  title: string,
  level: GoalLevel,
  opts?: {
    parent_id?: string;
    description?: string;
    success_criteria?: string;
    time_horizon?: string;
    deadline?: number;
    estimated_hours?: number;
    authority_level?: number;
    tags?: string[];
    dependencies?: string[];
    status?: GoalStatus;
    sort_order?: number;
  },
): Goal {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    `INSERT INTO goals (id, parent_id, level, title, description, success_criteria,
      time_horizon, score, score_reason, status, health, deadline, started_at,
      estimated_hours, actual_hours, authority_level, tags, dependencies,
      escalation_stage, escalation_started_at, sort_order, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0.0, NULL, ?, 'on_track', ?, ?, ?, 0, ?, ?, ?, 'none', NULL, ?, ?, ?, NULL)`
  ).run(
    id,
    opts?.parent_id ?? null,
    level,
    title,
    opts?.description ?? '',
    opts?.success_criteria ?? '',
    opts?.time_horizon ?? 'quarterly',
    opts?.status ?? 'draft',
    opts?.deadline ?? null,
    opts?.status === 'active' ? now : null,
    opts?.estimated_hours ?? null,
    opts?.authority_level ?? 3,
    opts?.tags ? JSON.stringify(opts.tags) : null,
    opts?.dependencies ? JSON.stringify(opts.dependencies) : null,
    opts?.sort_order ?? 0,
    now, now,
  );

  return getGoal(id)!;
}

export function getGoal(id: string): Goal | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | null;
  return row ? parseGoal(row) : null;
}

export function findGoals(query: GoalQuery = {}): Goal[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status) {
    conditions.push('status = ?');
    params.push(query.status);
  }
  if (query.level) {
    conditions.push('level = ?');
    params.push(query.level);
  }
  if (query.parent_id !== undefined) {
    if (query.parent_id === null) {
      conditions.push('parent_id IS NULL');
    } else {
      conditions.push('parent_id = ?');
      params.push(query.parent_id);
    }
  }
  if (query.health) {
    conditions.push('health = ?');
    params.push(query.health);
  }
  if (query.tag) {
    conditions.push("tags LIKE ?");
    params.push(`%"${query.tag}"%`);
  }
  if (query.time_horizon) {
    conditions.push('time_horizon = ?');
    params.push(query.time_horizon);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(parseInt(String(query.limit ?? 100), 10) || 100, 1000));

  const rows = db.prepare(
    `SELECT * FROM goals ${where} ORDER BY sort_order ASC, created_at ASC LIMIT ?`
  ).all(...(params as SQLQueryBindings[]), limit) as GoalRow[];

  return rows.map(parseGoal);
}

export function getRootGoals(): Goal[] {
  return findGoals({ parent_id: null });
}

export function getGoalChildren(parentId: string): Goal[] {
  return findGoals({ parent_id: parentId });
}

export function getGoalTree(rootId: string): Goal[] {
  const result: Goal[] = [];
  const root = getGoal(rootId);
  if (!root) return result;

  result.push(root);

  const collectChildren = (parentId: string) => {
    const children = getGoalChildren(parentId);
    for (const child of children) {
      result.push(child);
      collectChildren(child.id);
    }
  };

  collectChildren(rootId);
  return result;
}

export function updateGoal(id: string, updates: GoalUpdate): Goal | null {
  const db = getDb();
  const existing = getGoal(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.success_criteria !== undefined) { sets.push('success_criteria = ?'); params.push(updates.success_criteria); }
  if (updates.time_horizon !== undefined) { sets.push('time_horizon = ?'); params.push(updates.time_horizon); }
  if (updates.deadline !== undefined) { sets.push('deadline = ?'); params.push(updates.deadline); }
  if (updates.estimated_hours !== undefined) { sets.push('estimated_hours = ?'); params.push(updates.estimated_hours); }
  if (updates.authority_level !== undefined) { sets.push('authority_level = ?'); params.push(updates.authority_level); }
  if (updates.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(updates.tags)); }
  if (updates.dependencies !== undefined) { sets.push('dependencies = ?'); params.push(JSON.stringify(updates.dependencies)); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(updates.sort_order); }

  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...(params as SQLQueryBindings[]));

  return getGoal(id);
}

export function updateGoalScore(id: string, score: number, reason: string, source = 'user'): Goal | null {
  const db = getDb();
  const existing = getGoal(id);
  if (!existing) return null;

  const clampedScore = Math.max(0, Math.min(1, score));
  const now = Date.now();

  // Log progress entry
  addProgressEntry(id, source === 'user' ? 'manual' : 'system', existing.score, clampedScore, reason, source);

  // Update the goal
  db.prepare(
    `UPDATE goals SET score = ?, score_reason = ?, updated_at = ? WHERE id = ?`
  ).run(clampedScore, reason, now, id);

  return getGoal(id);
}

export function updateGoalStatus(id: string, status: GoalStatus): Goal | null {
  const db = getDb();
  const existing = getGoal(id);
  if (!existing) return null;

  const now = Date.now();
  const isTerminal = status === 'completed' || status === 'failed' || status === 'killed';

  const sets: string[] = ['status = ?', 'updated_at = ?'];
  const params: unknown[] = [status, now];

  if (status === 'active' && !existing.started_at) {
    sets.push('started_at = ?');
    params.push(now);
  }

  if (isTerminal) {
    sets.push('completed_at = ?');
    params.push(now);
  }

  params.push(id);
  db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...(params as SQLQueryBindings[]));

  return getGoal(id);
}

export function updateGoalHealth(id: string, health: GoalHealth): Goal | null {
  const db = getDb();
  const now = Date.now();
  db.prepare(`UPDATE goals SET health = ?, updated_at = ? WHERE id = ?`).run(health, now, id);
  return getGoal(id);
}

export function updateGoalEscalation(id: string, stage: EscalationStage): Goal | null {
  const db = getDb();
  const now = Date.now();

  if (stage === 'none') {
    db.prepare(`UPDATE goals SET escalation_stage = 'none', escalation_started_at = NULL, updated_at = ? WHERE id = ?`).run(now, id);
  } else {
    const existing = getGoal(id);
    if (!existing) return null;
    // Only set escalation_started_at if transitioning from 'none'
    const startedAt = existing.escalation_stage === 'none' ? now : existing.escalation_started_at;
    db.prepare(
      `UPDATE goals SET escalation_stage = ?, escalation_started_at = ?, updated_at = ? WHERE id = ?`
    ).run(stage, startedAt, now, id);
  }

  return getGoal(id);
}

export function updateGoalActualHours(id: string, hours: number): Goal | null {
  const db = getDb();
  const now = Date.now();
  db.prepare(`UPDATE goals SET actual_hours = ?, updated_at = ? WHERE id = ?`).run(hours, now, id);
  return getGoal(id);
}

export function deleteGoal(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  return result.changes > 0;
}

export function reorderGoals(items: { id: string; sort_order: number }[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE goals SET sort_order = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();

  const tx = db.transaction(() => {
    for (const item of items) {
      stmt.run(item.sort_order, now, item.id);
    }
  });
  tx();
}

export function getOverdueGoals(): Goal[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(
    `SELECT * FROM goals WHERE status = 'active' AND deadline IS NOT NULL AND deadline < ? ORDER BY deadline ASC`
  ).all(now) as GoalRow[];
  return rows.map(parseGoal);
}

export function getGoalsByDependency(goalId: string): Goal[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM goals WHERE dependencies LIKE ? AND status IN ('draft', 'active', 'paused')`
  ).all(`%"${goalId}"%`) as GoalRow[];
  return rows.map(parseGoal);
}

export function getGoalsNeedingEscalation(): Goal[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM goals WHERE status = 'active' AND health IN ('behind', 'critical') ORDER BY deadline ASC`
  ).all() as GoalRow[];
  return rows.map(parseGoal);
}

export function getActiveGoalsByLevel(level: GoalLevel): Goal[] {
  return findGoals({ status: 'active', level });
}

// ── Progress Entries ────────────────────────────────────────────────

export function addProgressEntry(
  goalId: string,
  type: 'manual' | 'auto_detected' | 'review' | 'system',
  scoreBefore: number,
  scoreAfter: number,
  note: string,
  source: string,
): GoalProgressEntry {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    `INSERT INTO goal_progress (id, goal_id, type, score_before, score_after, note, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, goalId, type, scoreBefore, scoreAfter, note, source, now);

  return { id, goal_id: goalId, type, score_before: scoreBefore, score_after: scoreAfter, note, source, created_at: now };
}

export function getProgressHistory(goalId: string, limit = 50): GoalProgressEntry[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const rows = db.prepare(
    `SELECT * FROM goal_progress WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(goalId, safeLimit) as ProgressRow[];
  return rows;
}

// ── Check-Ins ───────────────────────────────────────────────────────

export function createCheckIn(
  type: 'morning_plan' | 'evening_review',
  summary: string,
  goalsReviewed: string[],
  actionsPlanned: string[] = [],
  actionsCompleted: string[] = [],
): GoalCheckIn {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    `INSERT INTO goal_check_ins (id, type, summary, goals_reviewed, actions_planned, actions_completed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, type, summary,
    JSON.stringify(goalsReviewed),
    JSON.stringify(actionsPlanned),
    JSON.stringify(actionsCompleted),
    now,
  );

  return {
    id, type, summary,
    goals_reviewed: goalsReviewed,
    actions_planned: actionsPlanned,
    actions_completed: actionsCompleted,
    work_item_ids: [],
    created_at: now,
  };
}

export function getRecentCheckIns(type?: 'morning_plan' | 'evening_review', limit = 10): GoalCheckIn[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(limit, 100));

  if (type) {
    const rows = db.prepare(
      `SELECT * FROM goal_check_ins WHERE type = ? ORDER BY created_at DESC LIMIT ?`
    ).all(type, safeLimit) as CheckInRow[];
    return rows.map(parseCheckIn);
  }

  const rows = db.prepare(
    `SELECT * FROM goal_check_ins ORDER BY created_at DESC LIMIT ?`
  ).all(safeLimit) as CheckInRow[];
  return rows.map(parseCheckIn);
}

export function getTodayCheckIn(type: 'morning_plan' | 'evening_review'): GoalCheckIn | null {
  const db = getDb();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const row = db.prepare(
    `SELECT * FROM goal_check_ins WHERE type = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`
  ).get(type, startOfDay.getTime()) as CheckInRow | null;

  return row ? parseCheckIn(row) : null;
}

// ── Metrics ─────────────────────────────────────────────────────────

export function getGoalMetrics(): {
  total: number;
  active: number;
  completed: number;
  failed: number;
  killed: number;
  avg_score: number;
  on_track: number;
  at_risk: number;
  behind: number;
  critical: number;
  overdue: number;
} {
  const db = getDb();

  const statusCounts = db.prepare(
    `SELECT status, COUNT(*) as count FROM goals GROUP BY status`
  ).all() as { status: string; count: number }[];

  const healthCounts = db.prepare(
    `SELECT health, COUNT(*) as count FROM goals WHERE status = 'active' GROUP BY health`
  ).all() as { health: string; count: number }[];

  const avgScore = db.prepare(
    `SELECT AVG(score) as avg FROM goals WHERE status = 'active' AND level = 'objective'`
  ).get() as { avg: number | null };

  const overdueCount = db.prepare(
    `SELECT COUNT(*) as count FROM goals WHERE status = 'active' AND deadline IS NOT NULL AND deadline < ?`
  ).get(Date.now()) as { count: number };

  const statusMap: Record<string, number> = {};
  for (const row of statusCounts) statusMap[row.status] = row.count;

  const healthMap: Record<string, number> = {};
  for (const row of healthCounts) healthMap[row.health] = row.count;

  return {
    total: Object.values(statusMap).reduce((a, b) => a + b, 0),
    active: statusMap['active'] ?? 0,
    completed: statusMap['completed'] ?? 0,
    failed: statusMap['failed'] ?? 0,
    killed: statusMap['killed'] ?? 0,
    avg_score: avgScore.avg ?? 0,
    on_track: healthMap['on_track'] ?? 0,
    at_risk: healthMap['at_risk'] ?? 0,
    behind: healthMap['behind'] ?? 0,
    critical: healthMap['critical'] ?? 0,
    overdue: overdueCount.count,
  };
}
