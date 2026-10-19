import type { Database } from 'bun:sqlite';
/** No foreign-key cascade: removing old run history must never release a request
 * identity for replay. At capacity, refuse new requests; never evict receipts. */
export function ensureWorkflowInspectionSchema(db: Database): void {
  // Scope and order together so first-page reads and cursor seeks do not scan
  // unrelated workflows or sort their accumulated history on the daemon thread.
  db.run(`CREATE INDEX IF NOT EXISTS idx_brief_run_history ON flow_run(project_id,flow_id,created DESC,id DESC)`);
  db.run(`CREATE TABLE IF NOT EXISTS brief_manual_run_requests (
    project_id TEXT NOT NULL, request_id TEXT NOT NULL, flow_id TEXT NOT NULL,
    digest TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY(project_id, request_id)
  )`);
  // Observe immutability at run acceptance, including legacy/manual writers.
  // Do not backfill old drafts from today's graph or turn inspection into a writer.
  db.run(`CREATE TABLE IF NOT EXISTS workflow_run_inspection_versions (
    run_id TEXT PRIMARY KEY REFERENCES flow_run(id) ON DELETE CASCADE,
    was_locked INTEGER NOT NULL CHECK(was_locked IN (0,1))
  )`);
  db.run(`CREATE TRIGGER IF NOT EXISTS workflow_run_inspection_version_insert AFTER INSERT ON flow_run
    BEGIN INSERT INTO workflow_run_inspection_versions(run_id,was_locked)
      VALUES (NEW.id, EXISTS(SELECT 1 FROM flow_version WHERE id=NEW.flow_version_id AND flow_id=NEW.flow_id AND state='LOCKED'));
    END`);
}
