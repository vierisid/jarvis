import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

export type CompositionTable = 'suggestion_composition_jobs' | 'prepared_opportunities';
export interface CompositionLease {
  id: string; state: string; attempts: number; lease_token: string | null; lease_until: number;
}
// Table names are a closed internal set, never taken from a request.
function tableName(table: CompositionTable) {
  if (table !== 'suggestion_composition_jobs' && table !== 'prepared_opportunities') throw Error('Unknown composition table');
  return table;
}
export function recoverCompositionLeases(db: Database, table: CompositionTable, now = Date.now()): void {
  db.run(`UPDATE ${tableName(table)} SET state = 'failed', lease_token = NULL, lease_until = 0,
    error = 'Composition was interrupted or timed out. Review the saved request and retry.', updated_at = ?
    WHERE state = 'running' AND lease_until <= ?`, [now, now]);
}
export function claimCompositionLease<T extends CompositionLease>(db: Database, table: CompositionTable, timeoutMs: number, now = Date.now()): T | null {
  return db.transaction(() => {
    recoverCompositionLeases(db, table, now);
    let row: T | null;
    while ((row = db.query<T, []>(`SELECT * FROM ${tableName(table)} WHERE state = 'queued' ORDER BY created_at, id LIMIT 1`).get())) {
      const source = row as T & { suggestion_id: string; opportunity_id: string };
      if (claimOpportunityComposition(db, table === 'prepared_opportunities' ? source.opportunity_id : source.suggestion_id,
        table === 'prepared_opportunities' ? 'prepared' : 'legacy', row.id)) break;
      db.run(`UPDATE ${tableName(table)} SET state = 'failed', error = 'This opportunity is owned by another composition. Inspect its existing draft.',
        lease_token = NULL, lease_until = 0, updated_at = ? WHERE id = ?`, [now, row.id]);
    }
    if (!row) return null;
    const token = randomUUID();
    db.run(`UPDATE ${tableName(table)} SET state = 'running', attempts = attempts + 1,
      lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?`, [token, now + timeoutMs, now, row.id]);
    return { ...row, state: 'running', attempts: row.attempts + 1, lease_token: token, lease_until: now + timeoutMs };
  }).immediate();
}


type CompositionOwner = { owner: 'legacy' | 'prepared'; job_id: string };
/** Resolve pre-reservation databases deterministically. A setup-only blocker owns no work.
 * Reservations survive failures, dismissal and feature disablement; only the owner may retry.
 */
export function opportunityCompositionOwner(db: Database, opportunityId: string): CompositionOwner | null {
  return db.transaction(() => {
    const saved = db.query<CompositionOwner, [string]>('SELECT owner, job_id FROM opportunity_composition_owners WHERE opportunity_id = ?').get(opportunityId);
    if (saved) return saved;
    const candidates = db.query<CompositionOwner & { created_at: number }, [string]>(
      "SELECT 'legacy' AS owner, id AS job_id, created_at FROM suggestion_composition_jobs WHERE suggestion_id = ?").all(opportunityId);
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prepared_opportunities'").get()) {
      candidates.push(...db.query<CompositionOwner & { created_at: number }, [string]>(
        `SELECT 'prepared' AS owner, id AS job_id, created_at FROM prepared_opportunities WHERE opportunity_id = ?
         AND (state IN ('queued', 'running', 'draft_ready') OR attempts > 0 OR flow_id IS NOT NULL)`).all(opportunityId));
    }
    candidates.sort((a, b) => a.created_at - b.created_at || a.owner.localeCompare(b.owner) || a.job_id.localeCompare(b.job_id));
    const first = candidates[0];
    if (!first) return null;
    db.run('INSERT INTO opportunity_composition_owners VALUES (?, ?, ?)', [opportunityId, first.owner, first.job_id]);
    return { owner: first.owner, job_id: first.job_id };
  }).immediate();
}

export function claimOpportunityComposition(db: Database, opportunityId: string, owner: CompositionOwner['owner'], jobId: string): boolean {
  return db.transaction(() => {
    const existing = opportunityCompositionOwner(db, opportunityId);
    if (existing) return existing.owner === owner && existing.job_id === jobId;
    db.run('INSERT INTO opportunity_composition_owners VALUES (?, ?, ?)', [opportunityId, owner, jobId]);
    return true;
  }).immediate();
}
