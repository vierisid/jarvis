import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, generateId, initDatabase } from './schema.ts';
import { ApprovalManager } from '../authority/approval.ts';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'jarvis-approval-migration-')); });
afterEach(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

/** The table as the previous version created it: no claim or receipt columns. */
function legacyDatabase(path: string) {
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE approval_requests (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, tool_name TEXT NOT NULL,
    tool_arguments TEXT NOT NULL, action_category TEXT NOT NULL, urgency TEXT NOT NULL DEFAULT 'normal',
    reason TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    decided_at INTEGER, decided_by TEXT, executed_at INTEGER, execution_result TEXT, created_at INTEGER NOT NULL,
    execution_mode TEXT NOT NULL DEFAULT 'deferred')`);
  const insert = (id: string, status: string, mode = 'deferred', result: string | null = null) => db.run(
    `INSERT INTO approval_requests (id, agent_id, agent_name, tool_name, tool_arguments, action_category, reason, status, decided_at, decided_by, executed_at, execution_result, created_at, execution_mode)
     VALUES (?, 'a1', 'PA', 'send_email', '{}', 'send_email', 'old', ?, ?, 'dashboard', ?, ?, ?, ?)`,
    [id, status, status === 'pending' ? null : 1_000, result ? 2_000 : null, result, 500, mode]);
  insert('approved-old', 'approved');
  insert('approved-inline-old', 'approved', 'inline');
  insert('approved-workflow-old', 'approved', 'workflow');
  insert('pending-old', 'pending');
  insert('executed-old', 'executed', 'deferred', 'Error executing send_email: smtp down');
  db.close();
}

test('the upgrade closes approved rows written before receipts existed, once, and leaves everything else alone', () => {
  const path = join(directory, 'vault.db');
  legacyDatabase(path);

  initDatabase(path, { quiet: true });
  const mgr = new ApprovalManager(generateId());
  for (const id of ['approved-old', 'approved-inline-old']) {
    expect(mgr.getRequest(id)).toMatchObject({ status: 'approved', execution_outcome: 'closed', resolved_by: 'migration',
      resolution_note: expect.stringContaining('before execution receipts existed'), execution_claimed_at: null });
  }
  expect(mgr.getRequest('approved-workflow-old')).toMatchObject({ status: 'approved', execution_outcome: null });
  expect(mgr.getRequest('pending-old')).toMatchObject({ status: 'pending', execution_outcome: null });
  expect(mgr.getRequest('executed-old')).toMatchObject({ status: 'executed', execution_outcome: null });
  // The first boot's reconciliation finds nothing to surface from the old rows.
  expect(mgr.reconcileAfterRestart()).toEqual({ demotedInline: 0, notStarted: 0, interrupted: 0 });
  expect(mgr.getUnresolved()).toEqual([]);
  expect(mgr.claimExecution('approved-old', 'dashboard')).toBe(false);

  // A row approved after the upgrade is reconciled on the next boot, not closed.
  const fresh = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'send_email', toolArguments: {},
    actionCategory: 'send_email', urgency: 'normal', reason: 'new', context: '' });
  mgr.approve(fresh.id, 'dashboard');
  closeDb();
  initDatabase(path, { quiet: true });
  const next = new ApprovalManager(generateId());
  expect(next.reconcileAfterRestart()).toEqual({ demotedInline: 0, notStarted: 1, interrupted: 0 });
  expect(next.getRequest(fresh.id)).toMatchObject({ execution_outcome: 'not_started' });
  expect(next.getRequest('approved-old')).toMatchObject({ execution_outcome: 'closed', resolved_by: 'migration' });
});

test('the columns and the closure land together: a failed closure rolls the columns back', () => {
  const path = join(directory, 'vault.db');
  legacyDatabase(path);
  // A closure that cannot commit stands in for a crash between the column
  // additions and the closure. Without one transaction the columns would
  // survive, and the next boot would read them as "already migrated" and
  // reconcile every pre-upgrade approved row to not_started instead.
  const blocked = new Database(path);
  blocked.run(`CREATE TRIGGER block_closure BEFORE UPDATE ON approval_requests
               BEGIN SELECT RAISE(ABORT, 'closure blocked'); END`);
  blocked.close();

  // Pinned to the closure failing, so a future migration that throws earlier
  // cannot make this pass without the columns ever having been added.
  expect(() => initDatabase(path, { quiet: true })).toThrow(/closure blocked/);
  closeDb();

  const after = new Database(path);
  const columns = (after.query(`PRAGMA table_info(approval_requests)`).all() as Array<{ name: string }>).map((c) => c.name);
  expect(columns).not.toContain('execution_outcome');
  expect(after.query(`SELECT status FROM approval_requests WHERE id = 'approved-old'`).get()).toEqual({ status: 'approved' });
  after.run(`DROP TRIGGER block_closure`);
  after.close();

  // The retry on the next boot closes the row, so nothing offers to run it.
  initDatabase(path, { quiet: true });
  const mgr = new ApprovalManager(generateId());
  expect(mgr.getRequest('approved-old')).toMatchObject({ execution_outcome: 'closed', resolved_by: 'migration' });
  expect(mgr.reconcileAfterRestart()).toEqual({ demotedInline: 0, notStarted: 0, interrupted: 0 });
  expect(mgr.getUnresolved()).toEqual([]);
});
