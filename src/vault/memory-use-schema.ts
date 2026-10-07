import type { Database } from 'bun:sqlite';

/** IDs and revision digests only. No foreign-key cascade can erase retained use history. */
export function ensureMemoryUseSchema(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS memory_use_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), started_at INTEGER NOT NULL,
      retained_from INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS memory_use_events (
      use_id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, source_revision TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('selected', 'supplied', 'outcome_verified')),
      purpose TEXT NOT NULL CHECK(purpose IN ('conversation_context', 'workflow_context')),
      conversation_id TEXT, turn_id TEXT, request_id TEXT, run_id TEXT, workflow_id TEXT,
      call_id TEXT NOT NULL, recorded_at INTEGER NOT NULL,
      CHECK((purpose = 'conversation_context' AND conversation_id IS NOT NULL AND turn_id IS NOT NULL
        AND request_id IS NOT NULL AND run_id IS NULL AND workflow_id IS NULL)
        OR (purpose = 'workflow_context' AND conversation_id IS NULL AND turn_id IS NULL
        AND request_id IS NULL AND run_id IS NOT NULL AND workflow_id IS NOT NULL))
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_memory_use_fact ON memory_use_events(fact_id, recorded_at, use_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_memory_use_conversation ON memory_use_events(conversation_id, recorded_at, use_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_memory_use_run ON memory_use_events(run_id, recorded_at, use_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_memory_use_retention ON memory_use_events(recorded_at, use_id)');
  })();
}
