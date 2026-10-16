import type { Database } from 'bun:sqlite';
/** Retained drafts and immutable revision links. Always installed so legacy approval writers
 * and the workflow scheduler honor saved drafts even when the Brief feature is disabled. */
export function ensureDecisionDocumentSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS brief_decision_document (
    decision_id TEXT PRIMARY KEY, effect_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('review','deferred','rejected')),
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brief_decision_document_revision (
    decision_id TEXT NOT NULL, generation INTEGER NOT NULL, approval_id TEXT NOT NULL UNIQUE,
    document TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(decision_id, generation)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brief_decision_document_receipt (
    request_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL
  )`);
}
export interface DocumentReviewRow {
  decision_id: string; effect_id: string; approval_id: string; generation: number;
  disposition: 'review' | 'deferred' | 'rejected'; created_at: number;
}
