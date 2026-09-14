import { getDb } from './schema.ts';
import { classifyJobSignals, OPPORTUNITY_WINDOW_MS } from '../awareness/job-hypotheses.ts';
import type { JobSignal } from '../awareness/opportunity-types.ts';

/** Retain only allowlisted job cues and provenance, never raw OCR, URLs or titles. */
export function recordOpportunityObservation(input: Parameters<typeof classifyJobSignals>[0]): void {
  const db = getDb();
  for (const signal of classifyJobSignals(input)) {
    if (signal.observedAt > Date.now() || signal.observedAt < Date.now() - OPPORTUNITY_WINDOW_MS) continue;
    db.prepare(`INSERT OR IGNORE INTO opportunity_observations
      (capture_id, kind, observed_at, app, cue) VALUES (?, ?, ?, ?, ?)`)
      .run(signal.captureId, signal.kind, signal.observedAt, signal.app, signal.cue);
  }
}

export function getOpportunityObservations(now = Date.now()): JobSignal[] {
  return getDb().prepare(`SELECT capture_id AS captureId, kind, observed_at AS observedAt, app, cue
    FROM opportunity_observations WHERE observed_at >= ? AND observed_at <= ?
    ORDER BY observed_at, capture_id`).all(now - OPPORTUNITY_WINDOW_MS, now) as JobSignal[];
}

export function pruneOpportunityObservations(now = Date.now()): void {
  getDb().prepare('DELETE FROM opportunity_observations WHERE observed_at < ?').run(now - OPPORTUNITY_WINDOW_MS);
}
