import type { Database } from 'bun:sqlite';

export function ensurePreparedSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS prepared_opportunities (
    id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL UNIQUE REFERENCES awareness_suggestions(id),
    revision TEXT NOT NULL, specification TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','failed','draft_ready')),
    attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    error TEXT, composition_id TEXT, flow_id TEXT, version_id TEXT, version_digest TEXT,
    assessment TEXT, dismissed_at INTEGER, accepted_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK ((flow_id IS NULL) = (version_id IS NULL))
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_prepared_opportunity_state ON prepared_opportunities(state, created_at)');
  db.run(`CREATE TABLE IF NOT EXISTS prepared_opportunity_attempts (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES prepared_opportunities(id), started_at INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_prepared_attempt_time ON prepared_opportunity_attempts(started_at)');
  db.run(`CREATE TABLE IF NOT EXISTS prepared_opportunity_history (
    proposal_id TEXT NOT NULL REFERENCES prepared_opportunities(id), revision TEXT NOT NULL,
    snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(proposal_id, revision)
  )`);
}
