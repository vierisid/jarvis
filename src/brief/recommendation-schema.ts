import type { Database } from 'bun:sqlite';

/** Recommendation snapshots and receipts only; tasks remain commitment_work. */
export function ensureRecommendationSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS brief_recommendation (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, plan TEXT NOT NULL,
    created_at INTEGER NOT NULL, disposition TEXT NOT NULL DEFAULT 'open'
      CHECK(disposition IN ('open','accepted','dismissed')),
    accept_request_id TEXT UNIQUE, acceptance TEXT, dismissed_at INTEGER
  )`);
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(brief_recommendation)').all();
  if (!columns.some(c => c.name === 'dismissed_at')) db.run('ALTER TABLE brief_recommendation ADD COLUMN dismissed_at INTEGER');
}
