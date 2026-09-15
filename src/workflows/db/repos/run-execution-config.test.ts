import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '..';
import { createSchema } from '../schema';
import { createFlow } from './flow';
import { createDraftVersion } from './flow-version';
import { createFlowRun, ensureRunExecutionConfig, getFlowRun } from './flow-run';
import { enqueue } from './job-queue';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });
function run(stepNameToTest?: string) {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'preview' });
  return createFlowRun({ flowId: flow.id, flowVersionId: version.id, stepNameToTest });
}

test('additive migration preserves legacy runs and can be reapplied', () => {
  closeWorkflowDb();
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-run-migration-'));
  const path = join(directory, 'legacy.db');
  try {
    initWorkflowDb(path);
    const original = run('one');
    getWorkflowDb().exec('ALTER TABLE flow_run DROP COLUMN execution_config');
    // Upgrade on a fresh connection, as daemon startup does. Reusing Bun's
    // cached SELECT * statement after DROP COLUMN would retain its old column map.
    closeWorkflowDb(); initWorkflowDb(path);
    createSchema(getWorkflowDb());
    expect(getFlowRun(original.id)).toEqual(original);
    expect(ensureRunExecutionConfig(original.id, { sampleData: { prior: 7 } })).toEqual({
      stepNameToTest: 'one', sampleData: { prior: 7 },
    });
  } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
});

test('initial settings are copied and cannot be changed by retries or returned objects', () => {
  const original = run();
  const config = { stepNameToTest: 'one', sampleInputOverride: { one: { value: 'initial' } } };
  const saved = ensureRunExecutionConfig(original.id, config);
  config.sampleInputOverride.one.value = 'changed';
  saved.sampleInputOverride!.one!.value = 'also changed';
  expect(ensureRunExecutionConfig(original.id, { stepNameToTest: 'another' })).toEqual({
    stepNameToTest: 'one', sampleInputOverride: { one: { value: 'initial' } },
  });
  expect(getFlowRun(original.id)!.stepNameToTest).toBe('one');
});

test('legacy approval resume recovers only the original BEGIN configuration', () => {
  const original = run('one');
  enqueue({ jobType: 'RUN_FLOW', flowRunId: original.id, payload: {
    runId: original.id, executionType: 'RESUME', stepNameToTest: 'wrong', sampleData: { before: 'wrong' },
  } });
  enqueue({ jobType: 'RUN_FLOW', flowRunId: original.id, payload: {
    runId: original.id, sampleData: { before: 'original' }, sampleInputOverride: { one: { value: 'reviewed' } },
  } });
  expect(ensureRunExecutionConfig(original.id)).toEqual({ stepNameToTest: 'one',
    sampleData: { before: 'original' }, sampleInputOverride: { one: { value: 'reviewed' } },
  });
});

test('legacy continuation without original configuration fails closed', () => {
  const original = run('one');
  enqueue({ jobType: 'RUN_FLOW', flowRunId: original.id, payload: { runId: original.id, executionType: 'RESUME' } });
  expect(() => ensureRunExecutionConfig(original.id)).toThrow('Original run configuration unavailable');
  expect(() => ensureRunExecutionConfig(original.id, { stepNameToTest: 'another' })).toThrow('preview scope');
});
