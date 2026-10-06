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
    const row = db.query<T, []>(`SELECT * FROM ${tableName(table)} WHERE state = 'queued' ORDER BY created_at, id LIMIT 1`).get();
    if (!row) return null;
    const token = randomUUID();
    db.run(`UPDATE ${tableName(table)} SET state = 'running', attempts = attempts + 1,
      lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?`, [token, now + timeoutMs, now, row.id]);
    return { ...row, state: 'running', attempts: row.attempts + 1, lease_token: token, lease_until: now + timeoutMs };
  }).immediate();
}
