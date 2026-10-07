import type { Database } from 'bun:sqlite';

/** Additive: old goals have no measurement, and no score is converted into a count. */
export function ensureGoalMeasurementSchema(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS goal_measurement (
      goal_id TEXT PRIMARY KEY REFERENCES goals(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision > 0), snapshot TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS goal_measurement_receipt (
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, command TEXT NOT NULL, receipt TEXT NOT NULL,
      evidence_key TEXT, measured_at INTEGER,
      PRIMARY KEY(goal_id, request_id), UNIQUE(goal_id, evidence_key)
    )`);
  })();
}
