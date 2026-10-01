import type { Database } from 'bun:sqlite';

/** Additive audit/outbox. No goal FK: deletion must not erase committed events. */
export function ensureGoalEventSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS goal_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event TEXT NOT NULL,
    completion_goal TEXT,
    memory_delivered_at INTEGER,
    broadcast_delivered_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER
  )`);
  // Tables from builds before created_at gain the column; their NULL rows are never pruned.
  try { db.run('ALTER TABLE goal_events ADD COLUMN created_at INTEGER'); } catch {}
  db.run('CREATE INDEX IF NOT EXISTS idx_goal_events_broadcast ON goal_events(sequence) WHERE broadcast_delivered_at IS NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_goal_events_created ON goal_events(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_goal_events_memory ON goal_events(attempts, sequence) WHERE completion_goal IS NOT NULL AND memory_delivered_at IS NULL');
}
