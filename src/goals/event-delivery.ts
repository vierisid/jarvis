import type { Database } from 'bun:sqlite';
import { generateId, getDb } from '../vault/schema.ts';
import { extractGoalCompletion } from '../vault/extractor.ts';
import type { Goal } from './types.ts';
import type { GoalEvent } from './events.ts';

/** Fully delivered events stay replayable for this long; pending records are never pruned. */
export const GOAL_EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
type EventRow = {
  sequence: number; event_id: string; event: string; completion_goal: string | null;
  memory_delivered_at: number | null; broadcast_delivered_at: number | null;
};
export function queueGoalEvent(event: GoalEvent, completion?: Goal): void {
  const eventId = generateId();
  getDb().run('INSERT INTO goal_events (event_id, event, completion_goal, created_at) VALUES (?, ?, ?, ?)',
    [eventId, JSON.stringify({ ...event, eventId }), completion ? JSON.stringify(completion) : null, Date.now()]);
}
function payload(row: EventRow): GoalEvent {
  return { ...JSON.parse(row.event), eventId: row.event_id, sequence: row.sequence };
}
export function readGoalEvents(after = 0, limit = 100) {
  const rows = getDb().query('SELECT * FROM goal_events WHERE sequence > ? ORDER BY sequence LIMIT ?').all(after, limit) as EventRow[];
  return rows.map(row => ({ ...payload(row), completionMemory: row.completion_goal === null ? 'not_required'
    : row.memory_delivered_at === null ? 'pending' : 'recorded' }));
}

/** One synchronous daemon broadcast sink. Completion projection is a separate durable consumer. */
export class GoalEventDelivery {
  private callback: ((event: GoalEvent) => void) | null = null;
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database) {}
  setCallback(callback: (event: GoalEvent) => void): void { this.callback = callback; }
  start(): void {
    if (this.timer) return;
    const attempt = () => {
      try { if (getDb() !== this.db) { this.stop(); return; } }
      catch { this.stop(); return; }
      try { this.flush(); this.prune(); }
      catch { console.warn('[Goals] Delivery unavailable; pending events will be retried.'); }
    };
    attempt();
    this.timer = setInterval(attempt, 30_000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /**
   * Request-path flushes pass retryFailed = false so a completion record that keeps
   * failing is retried by the worker, not by every later goal write.
   */
  flush(retryFailed = true): void {
    // Never announce a write before the outermost caller has committed it.
    if (this.flushing || this.db.inTransaction) return;
    this.flushing = true;
    try {
      const pendingMemory = this.db.query(`SELECT * FROM goal_events WHERE completion_goal IS NOT NULL AND memory_delivered_at IS NULL
        ${retryFailed ? '' : 'AND attempts = 0'} ORDER BY attempts, sequence LIMIT 100`).all() as EventRow[];
      for (const row of pendingMemory) {
        try {
          this.db.transaction(() => {
            const pending = this.db.query('SELECT * FROM goal_events WHERE event_id = ? AND memory_delivered_at IS NULL').get(row.event_id) as EventRow | null;
            if (!pending) return;
            extractGoalCompletion(JSON.parse(pending.completion_goal!), row.event_id);
            this.db.run('UPDATE goal_events SET memory_delivered_at = ?, last_error = NULL WHERE event_id = ?', [Date.now(), row.event_id]);
          }).immediate();
        } catch (error) { this.failed(row.event_id, error); }
      }
      if (this.callback) {
        const pending = this.db.query('SELECT * FROM goal_events WHERE broadcast_delivered_at IS NULL ORDER BY sequence LIMIT 100').all() as EventRow[];
        for (const row of pending) {
          try {
            this.callback(payload(row));
            this.db.run('UPDATE goal_events SET broadcast_delivered_at = ? WHERE event_id = ?', [Date.now(), row.event_id]);
          } catch (error) { this.failed(row.event_id, error); break; }
        }
      }
    } finally { this.flushing = false; }
  }
  /** Drops delivered history past the retention window, a bounded batch per pass. */
  prune(now = Date.now()): number {
    if (this.db.inTransaction) return 0;
    return this.db.run(`DELETE FROM goal_events WHERE sequence IN (SELECT sequence FROM goal_events
      WHERE created_at < ? AND broadcast_delivered_at IS NOT NULL
        AND (completion_goal IS NULL OR memory_delivered_at IS NOT NULL)
      ORDER BY sequence LIMIT 1000)`, [now - GOAL_EVENT_RETENTION_MS]).changes;
  }
  private failed(eventId: string, error: unknown): void {
    this.db.run('UPDATE goal_events SET attempts = attempts + 1, last_error = ? WHERE event_id = ?',
      [String(error).slice(0, 1000), eventId]);
    console.warn('[Goals] Event delivery deferred:', eventId);
  }
}
