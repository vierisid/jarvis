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
    // Q-17: one cited entry per counted thing. An entry corrects at most one
    // earlier entry and is corrected at most once, so each thing's lineage is a
    // single chain whose last link is its current word.
    db.run(`CREATE TABLE IF NOT EXISTS goal_observation (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, request_id TEXT NOT NULL, command TEXT NOT NULL,
      subject_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('counted', 'retracted')),
      source_key TEXT NOT NULL, corrects TEXT REFERENCES goal_observation(id) ON DELETE CASCADE,
      entry TEXT NOT NULL, receipt TEXT NOT NULL,
      UNIQUE(goal_id, request_id), UNIQUE(goal_id, source_key), UNIQUE(goal_id, seq), UNIQUE(corrects)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_goal_observation_subject ON goal_observation(goal_id, subject_key)');
  })();
}
