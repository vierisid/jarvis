import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from './index';
import { releaseDeferredSteps } from '../runtime/deferred-cards';

/**
 * #1152: the deferred-steps index is partial over json_extract, so building it
 * over an existing store evaluated json_extract on every pending record, and
 * one malformed record failed schema init (and, once built, any write of one).
 */
let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-effect-deferred-index-'));
  path = join(directory, 'workflow.db');
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

function insertMalformed(db: Database, id: string) {
  db.run('PRAGMA foreign_keys=OFF');
  db.run(`INSERT INTO workflow_effect (id, run_id, status, approval_id, waitpoint_id, record) VALUES (?, 'run-x', 'pending', NULL, NULL, '{not json')`, [id]);
  db.run('PRAGMA foreign_keys=ON');
}

test('schema init over a store holding a malformed pending effect record succeeds', () => {
  initWorkflowDb(path);
  closeWorkflowDb();
  // A store from before the index: no deferred index, one malformed record.
  const raw = new Database(path);
  raw.run('DROP INDEX IF EXISTS idx_workflow_effect_deferred');
  raw.run('DROP INDEX IF EXISTS idx_workflow_effect_deferred_valid');
  insertMalformed(raw, 'bad-1');
  raw.close();

  expect(() => initWorkflowDb(path)).not.toThrow();
  const names = getWorkflowDb().query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_workflow_effect_deferred%'`).all().map((r) => r.name);
  expect(names).toEqual(['idx_workflow_effect_deferred_valid']);
  // The release tick names the index (INDEXED BY), so this also proves its
  // filter still matches the queries' filter, and the bad row is skipped.
  expect(releaseDeferredSteps()).toBe(0);
});

test('a malformed pending effect record can be written once the index exists', () => {
  initWorkflowDb(path);
  expect(() => insertMalformed(getWorkflowDb(), 'bad-2')).not.toThrow();
  expect(releaseDeferredSteps()).toBe(0);
});

test('the first index version is replaced on an existing store', () => {
  initWorkflowDb(path);
  getWorkflowDb().run(`CREATE INDEX idx_workflow_effect_deferred ON workflow_effect(json_extract(record, '$.flowId'))
    WHERE status = 'pending' AND approval_id IS NULL AND json_extract(record, '$.deferral.budget') IS NOT NULL`);
  closeWorkflowDb();
  initWorkflowDb(path);
  expect(() => insertMalformed(getWorkflowDb(), 'bad-3')).not.toThrow();
});
