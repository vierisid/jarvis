import type { Database } from 'bun:sqlite';

/** Additive transport/job metadata alongside the canonical workflow journal and drafts. */
export function ensureCompositionJobSchema(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS brief_workflow_composition_jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
      name TEXT NOT NULL, prompt TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','draft_ready','blocked','failed','cancelled')),
      checked_candidates INTEGER NOT NULL DEFAULT 0,
      composition_id TEXT, flow_id TEXT, version_id TEXT, blocker TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(project_id, request_id)
    )`);
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(brief_workflow_composition_jobs)').all();
    if (!columns.some(c => c.name === 'ingredients')) db.run("ALTER TABLE brief_workflow_composition_jobs ADD COLUMN ingredients TEXT NOT NULL DEFAULT '[]'");
    db.run('CREATE INDEX IF NOT EXISTS idx_brief_composition_queue ON brief_workflow_composition_jobs(project_id, state, created_at, id)');
  }).immediate();
}
