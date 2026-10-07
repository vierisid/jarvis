import type { Database } from 'bun:sqlite';
import { getDb } from '../vault/schema';
import { getGoal } from '../vault/goals';
import { getGoalApplication } from '../goals/application-service';
import { measurementProgress, readMeasurementReceipt } from '../goals/measurements';
import type { Goal } from '../goals/types';
import type { BriefGoal, BriefReadResult } from './contracts';
import { projectLegacyGoal } from './adapters';

/** Same counts and progress for Today, goal detail and any other Brief consumer. */
export function projectMeasuredGoal(goal: Goal): BriefGoal {
  const measurement = goal.measurement ?? null;
  const value = measurement ? measurementProgress(measurement) : goal.score;
  return { ...projectLegacyGoal(goal),
    revision: `${goal.updated_at}:${measurement?.revision ?? 0}`,
    measurementRevision: measurement?.revision ?? 0,
    measurementDefinition: measurement ? { unit: measurement.unit, baseline: measurement.baseline, target: measurement.target } : null,
    progress: { value, basis: measurement ? value === null ? 'unknown' : 'measurement' : 'legacy_score', rollup: 'independent' },
    measurement: measurement?.value != null ? {
      value: measurement.value, unit: measurement.unit, baseline: measurement.baseline, target: measurement.target,
      asOf: measurement.measuredAt!, qualification: 'user_reported',
      provenance: [{ kind: 'source', id: measurement.evidence!.id, revision: measurement.evidence!.revision }],
    } : null,
  };
}
export class GoalMeasurements {
  constructor(private readonly db: Database) {}
  readiness(): 'ready' | 'unavailable' {
    try {
      if (getDb() !== this.db) return 'unavailable';
      this.db.query('SELECT goal_id FROM goal_measurement LIMIT 1').get();
      return 'ready';
    } catch { return 'unavailable'; }
  }
  private available(): void { if (this.readiness() !== 'ready') throw Error('Goal measurements unavailable'); }
  async read(query: { goalId: string }): Promise<BriefReadResult<BriefGoal>> {
    this.available(); const goal = getGoal(query.goalId);
    return goal ? { state: 'ready', data: projectMeasuredGoal(goal), asOf: Date.now() } : { state: 'empty', asOf: Date.now() };
  }
  record(goalId: string, command: unknown) { this.available(); return getGoalApplication().recordMeasurement(goalId, command); }
  receipt(goalId: string, requestId: string) { this.available(); return readMeasurementReceipt(this.db, goalId, requestId); }
}
