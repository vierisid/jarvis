import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';

/** Durable suppression has no expiry: pruning it would silently restore forgotten facts. */
export function ensureMemoryForgetSchema(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS memory_forget_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), hash_key BLOB NOT NULL
    )`);
    db.run('INSERT OR IGNORE INTO memory_forget_state VALUES (1, ?)', [randomBytes(32)]);
    db.run(`CREATE TABLE IF NOT EXISTS memory_forget_receipts (
      fact_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      expected_revision TEXT NOT NULL, forgotten_at INTEGER NOT NULL,
      suppressed_sources INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS memory_forget_suppressions (
      assertion_key TEXT NOT NULL, source_key TEXT NOT NULL, fact_id TEXT NOT NULL,
      PRIMARY KEY(assertion_key, source_key)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_memory_forget_source ON memory_forget_suppressions(source_key)');
  })();
}
