import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from './index';

/**
 * #1281: close time became a column. A store from before it gets the column,
 * its index, and a close time for every closed row from the row itself.
 */
let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-human-closed-at-'));
  path = join(directory, 'workflow.db');
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

function oldStore(rows: Array<{ id: string; status: string; created?: number; deadline: number; record?: string }>) {
  initWorkflowDb(path);
  closeWorkflowDb();
  const raw = new Database(path);
  raw.run('DROP INDEX IF EXISTS idx_human_closed');
  raw.run('ALTER TABLE workflow_human_request DROP COLUMN closed_at');
  raw.run('PRAGMA foreign_keys=OFF');
  for (const row of rows) {
    raw.run(`INSERT INTO workflow_human_request (id,project_id,flow_id,fingerprint,record,deadline,status) VALUES (?,'p','flow','x',?,?,?)`,
      [row.id, row.record ?? JSON.stringify({ id: row.id, created: row.created }), row.deadline, row.status]);
  }
  raw.close();
}
const closedAt = () => Object.fromEntries(getWorkflowDb()
  .query<{ id: string; closed_at: number | null }, []>('SELECT id,closed_at FROM workflow_human_request ORDER BY id').all()
  .map(row => [row.id, row.closed_at]));

test('an old store gains closed_at, its index, and close times from each closed row', () => {
  oldStore([
    { id: 'expired', status: 'expired', created: 100, deadline: 200 },
    { id: 'submitted', status: 'submitted', created: 300, deadline: 900 },
    { id: 'cancelled', status: 'cancelled', created: 400, deadline: 950 },
    { id: 'pending', status: 'pending', created: 500, deadline: 1000 },
    { id: 'corrupt', status: 'rejected', deadline: 700, record: '{not json' },
  ]);
  const before = Date.now();
  expect(() => initWorkflowDb(path)).not.toThrow();
  // Expiry closes at the deadline; any other closed row falls back to when it was
  // created; an unreadable record to its deadline. None of them is the boot time.
  expect(closedAt()).toEqual({ cancelled: 400, corrupt: 700, expired: 200, pending: null, submitted: 300 });
  expect(Object.values(closedAt()).every(value => value === null || value < before)).toBe(true);
  const index = getWorkflowDb().query<{ name: string }, []>(`PRAGMA index_info(idx_human_closed)`).all().map(r => r.name);
  expect(index).toEqual(['project_id', 'closed_at', 'id']);
});

test('a pending row left with a close time by an older build is cleared', () => {
  oldStore([{ id: 'reopened', status: 'pending', created: 300, deadline: 900 }]);
  initWorkflowDb(path);
  getWorkflowDb().run(`UPDATE workflow_human_request SET closed_at=250`);
  closeWorkflowDb();
  initWorkflowDb(path);
  expect(closedAt()).toEqual({ reopened: null });
});
test('reopening the store does not move a close time', () => {
  oldStore([{ id: 'submitted', status: 'submitted', created: 300, deadline: 900 }]);
  initWorkflowDb(path);
  getWorkflowDb().run(`UPDATE workflow_human_request SET closed_at=350`);
  closeWorkflowDb();
  initWorkflowDb(path);
  expect(closedAt()).toEqual({ submitted: 350 });
});

test('the Recent list and history pages read the close-time index in order, without a sort', () => {
  initWorkflowDb(path);
  // The same statements as runtime/human-input.ts (historyPage, humanInputHistoryCursor).
  const plan = (sql: string, ...params: Array<string | number | null>) => getWorkflowDb()
    .query<{ detail: string }, Array<string | number | null>>('EXPLAIN QUERY PLAN ' + sql).all(...params).map(r => r.detail).join('\n');
  const recent = plan(`SELECT id,closed_at FROM workflow_human_request
    WHERE project_id=?1 AND closed_at IS NOT NULL ORDER BY closed_at DESC,id DESC LIMIT 21`, 'p');
  const page = plan(`SELECT * FROM workflow_human_request
    WHERE project_id=?1 AND closed_at IS NOT NULL AND (?2 IS NULL OR (closed_at,id)<(?2,?3))
    ORDER BY closed_at DESC,id DESC LIMIT 21`, 'p', 5, 'x');
  for (const detail of [recent, page]) {
    expect(detail).toContain('idx_human_closed');
    expect(detail).not.toContain('TEMP B-TREE');
  }
});
