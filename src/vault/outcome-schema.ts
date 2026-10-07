import type { Database } from 'bun:sqlite';

/** F16 owns optional time evidence, never a second task or goal identity. */
export function ensureOutcomeSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS outcome_time_record (
    work_id TEXT NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0), request_id TEXT NOT NULL,
    command TEXT NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(work_id, revision), UNIQUE(work_id, request_id)
  )`);
}
