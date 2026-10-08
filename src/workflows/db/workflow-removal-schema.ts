import type { Database } from 'bun:sqlite';

/** Additive state: removal never deletes a flow, version, run or effect. */
export function ensureWorkflowRemovalSchema(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS brief_workflow_slots (
      position INTEGER PRIMARY KEY AUTOINCREMENT, flow_id TEXT NOT NULL UNIQUE REFERENCES flow(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 0, receipt_id TEXT, reconcile_pending INTEGER NOT NULL DEFAULT 0, reconcile_revision INTEGER NOT NULL DEFAULT 0, pinned_draft_id TEXT
    )`);
    // Upgrade databases that already installed F20 before the draft pin existed.
    if (!(db.query('PRAGMA table_info(brief_workflow_slots)').all() as Array<{ name: string }>).some(c => c.name === 'pinned_draft_id')) {
      db.run('ALTER TABLE brief_workflow_slots ADD COLUMN pinned_draft_id TEXT');
    }
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
    // Bookkeeping may update an older draft's timestamp while a run finishes.
    // Preserve the removed draft through Undo, without changing DRAFT/LOCKED.
    db.run(`UPDATE brief_workflow_slots SET pinned_draft_id = (
      SELECT r.version_id FROM brief_workflow_removals r JOIN flow_version v ON v.id = r.version_id
      JOIN flow f ON f.id = r.flow_id
      WHERE r.receipt_id = brief_workflow_slots.receipt_id AND v.flow_id = f.id
        AND v.state = 'DRAFT' AND f.published_version_id IS NULL
    ) WHERE receipt_id IS NOT NULL AND pinned_draft_id IS NULL`);
    // One selector shared by reads, CODE/readiness gates and trigger dispatch.
    // Other workflows retain the existing updated-time selection rule.
    db.run(`CREATE VIEW IF NOT EXISTS brief_workflow_draft_selection AS
      SELECT f.id AS flow_id, COALESCE(
        (SELECT v.id FROM flow_version v WHERE v.id = s.pinned_draft_id AND v.flow_id = f.id AND v.state = 'DRAFT'),
        (SELECT v.id FROM flow_version v WHERE v.flow_id = f.id AND v.state = 'DRAFT' ORDER BY v.updated DESC LIMIT 1)
      ) AS version_id FROM flow f LEFT JOIN brief_workflow_slots s ON s.flow_id = f.id`);
    // Explicit authoring/publication ends the pin. Runtime/sample writes do not.
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_draft_pin_insert AFTER INSERT ON flow_version
      BEGIN UPDATE brief_workflow_slots SET pinned_draft_id = NULL WHERE flow_id = NEW.flow_id; END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_draft_pin_edit AFTER UPDATE OF
      flow_id, display_name, trigger, state, valid, schema_version, agent_ids, connection_ids, notes, backup_files ON flow_version
      BEGIN UPDATE brief_workflow_slots SET pinned_draft_id = NULL WHERE flow_id IN (OLD.flow_id, NEW.flow_id); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_draft_pin_publish AFTER UPDATE OF published_version_id ON flow
      BEGIN UPDATE brief_workflow_slots SET pinned_draft_id = NULL WHERE flow_id = NEW.id; END`);
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
