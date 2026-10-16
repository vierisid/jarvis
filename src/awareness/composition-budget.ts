import type { Database } from 'bun:sqlite';
import { getDb } from '../vault/schema';

export const COMPOSITION_LIMITS = { queued: 20, attemptsPerJob: 3, dailyAttempts: 12, windowMs: 86_400_000 } as const;
export function ensureCompositionBudget(db: Database = getDb()): void {
  db.run(`CREATE TABLE IF NOT EXISTS suggestion_composition_attempts (
    id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, started_at INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_suggestion_attempts_started ON suggestion_composition_attempts(started_at)');
}
export function compositionQueueStatus(now = Date.now()) {
  const counts = getDb().query<{ queued: number; running: number }, [number]>(`SELECT
    COALESCE(SUM(state = 'queued'), 0) AS queued,
    COALESCE(SUM(state = 'running' AND lease_until > ?), 0) AS running FROM suggestion_composition_jobs WHERE state IN ('queued','running')`).get(now)!;
  const spent = getDb().query<{ attempts: number; oldest: number | null }, [number]>(
    'SELECT COUNT(*) AS attempts, MIN(started_at) AS oldest FROM suggestion_composition_attempts WHERE started_at > ?')
    .get(now - COMPOSITION_LIMITS.windowMs)!;
  const reason = counts.running ? 'concurrency' : spent.attempts >= COMPOSITION_LIMITS.dailyAttempts ? 'daily_budget' : null;
  return { ...counts, attempts: spent.attempts, limits: COMPOSITION_LIMITS, reason,
    retryAt: reason === 'daily_budget' ? spent.oldest! + COMPOSITION_LIMITS.windowMs : null };
}
