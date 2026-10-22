import type { Database } from 'bun:sqlite';

/** Additive state: removal never deletes a flow, version, run or effect; only a person's purge (#1096) does. */
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
    // #1096: a person may purge a restored workflow, or a removed one whose
    // Undo has expired. The receipt outlives the flow (no foreign key) and
    // records what went. `completed_at IS NULL` is an accepted purge whose
    // delete has not committed yet; recovery finishes it.
    db.run(`CREATE TABLE IF NOT EXISTS brief_workflow_purges (
      purge_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
      generation INTEGER NOT NULL, actor TEXT NOT NULL, accepted_at INTEGER NOT NULL, completed_at INTEGER, counts TEXT,
      granted INTEGER NOT NULL DEFAULT 0, files_pending TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_brief_workflow_purges_flow ON brief_workflow_purges(flow_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_brief_workflow_purges_pending ON brief_workflow_purges(project_id, accepted_at) WHERE completed_at IS NULL');
    db.run('CREATE INDEX IF NOT EXISTS idx_brief_workflow_purges_files ON brief_workflow_purges(project_id) WHERE files_pending IS NOT NULL');
    // A purge receipt is the audit record of what went; nothing deletes it.
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_purge_receipt_retained BEFORE DELETE ON brief_workflow_purges
      BEGIN SELECT RAISE(ABORT, 'workflow_history_retained'); END`);
    // A completed receipt is fixed; only its leftover-file list is cleared once the files are gone.
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_purge_receipt_fixed BEFORE UPDATE OF
      purge_id, flow_id, project_id, request_id, generation, actor, accepted_at, completed_at, counts, granted ON brief_workflow_purges
      WHEN OLD.completed_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'workflow_history_retained'); END`);
    // The flow and version fences above key on the removal receipts, and the
    // receipts' foreign key forces them to go before the flow does. So the
    // receipts are the fence that matters: only a purge deletes them, and its
    // grant is set and cleared inside its own delete transaction.
    // RAISE only: no trigger here writes a row (F-12).
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_receipt_purge BEFORE DELETE ON brief_workflow_removals
      WHEN NOT EXISTS(SELECT 1 FROM brief_workflow_purges WHERE flow_id = OLD.flow_id AND granted = 1)
      BEGIN SELECT RAISE(ABORT, 'workflow_history_retained'); END`);
    // Moving a receipt to another flow would open both flow fences just as deleting it would.
    // Undo still writes restored_at.
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_removed_receipt_identity BEFORE UPDATE OF receipt_id, flow_id, project_id ON brief_workflow_removals
      BEGIN SELECT RAISE(ABORT, 'workflow_history_retained'); END`);
    // Nothing new starts or is turned on between a purge's acceptance and its delete.
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_purge_pending_run BEFORE INSERT ON flow_run
      WHEN EXISTS(SELECT 1 FROM brief_workflow_purges WHERE flow_id = NEW.flow_id AND completed_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'workflow_purging'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS brief_purge_pending_enable BEFORE UPDATE OF status ON flow
      WHEN NEW.status = 'ENABLED' AND EXISTS(SELECT 1 FROM brief_workflow_purges WHERE flow_id = NEW.id AND completed_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'workflow_purging'); END`);
  }).immediate();
}
