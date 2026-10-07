import type { Database } from 'bun:sqlite';

/** Additive state: removal never deletes a flow, version, run or effect. */
export function ensureWorkflowRemovalSchema(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS brief_workflow_slots (
      position INTEGER PRIMARY KEY AUTOINCREMENT, flow_id TEXT NOT NULL UNIQUE REFERENCES flow(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 0, receipt_id TEXT, reconcile_pending INTEGER NOT NULL DEFAULT 0, reconcile_revision INTEGER NOT NULL DEFAULT 0
    )`);
    db.run(`INSERT INTO brief_workflow_slots (flow_id) SELECT id FROM flow
      WHERE id NOT IN (SELECT flow_id FROM brief_workflow_slots) ORDER BY updated, id`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_workflow_slot_insert AFTER INSERT ON flow
      BEGIN INSERT INTO brief_workflow_slots (flow_id) VALUES (NEW.id); END`);
    db.run(`CREATE TABLE IF NOT EXISTS brief_workflow_removals (
      receipt_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flow(id), project_id TEXT NOT NULL,
      version_id TEXT, before_revision TEXT NOT NULL, removed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      restored_at INTEGER
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_brief_workflow_removals_flow ON brief_workflow_removals(flow_id)');
    db.run(`CREATE TABLE IF NOT EXISTS brief_workflow_commands (
      project_id TEXT NOT NULL, request_id TEXT NOT NULL, flow_id TEXT NOT NULL,
      command_digest TEXT NOT NULL, result TEXT NOT NULL, recorded_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, request_id)
    )`);
    // These fences survive flag rollback and cover legacy writers and another DB connection.
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_enable BEFORE UPDATE OF status ON flow
      WHEN NEW.status = 'ENABLED' AND EXISTS(SELECT 1 FROM brief_workflow_slots WHERE flow_id = NEW.id AND receipt_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'workflow_removed'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_run BEFORE INSERT ON flow_run
      WHEN EXISTS(SELECT 1 FROM brief_workflow_slots WHERE flow_id = NEW.flow_id AND receipt_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'workflow_removed'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_purge BEFORE DELETE ON flow
      WHEN EXISTS(SELECT 1 FROM brief_workflow_removals WHERE flow_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'workflow_history_retained'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_flow_edit BEFORE UPDATE OF
      external_id, project_id, owner_id, folder_id, published_version_id, metadata, code_steps_enabled ON flow
      WHEN EXISTS(SELECT 1 FROM brief_workflow_slots WHERE flow_id = OLD.id AND receipt_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'workflow_removed'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_version_insert BEFORE INSERT ON flow_version
      WHEN EXISTS(SELECT 1 FROM brief_workflow_slots WHERE flow_id = NEW.flow_id AND receipt_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'workflow_removed'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_version_edit BEFORE UPDATE OF
      flow_id, display_name, trigger, state, valid, schema_version, agent_ids, connection_ids, notes, backup_files ON flow_version
      WHEN EXISTS(SELECT 1 FROM brief_workflow_slots WHERE flow_id = OLD.flow_id AND receipt_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'workflow_removed'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_version_purge BEFORE DELETE ON flow_version
      WHEN EXISTS(SELECT 1 FROM brief_workflow_removals WHERE flow_id = OLD.flow_id)
      BEGIN SELECT RAISE(ABORT, 'workflow_history_retained'); END`);
  }).immediate();
}
