import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { continuedFailures } from './continued-failures';

beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());

function runWith(status: 'SUCCEEDED' | 'FAILED', steps: Record<string, unknown>) {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Lookup', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'bad', type: 'PIECE', displayName: 'Look up the customer', settings: { pieceName: 'p', actionName: 'a', input: {} } } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: 'TESTING' });
  updateRun(run.id, { status, steps });
  return getFlowRun(run.id)!;
}
const failed = { output: { type: 'PIECE', status: 'FAILED', errorMessage: 'Error: boom\n    at /srv/engine/main.js:1' } };
const fine = { output: { type: 'PIECE', status: 'SUCCEEDED' } };

test('a succeeded run with a failed step names the step by its display name and carries no error text', () => {
  const found = continuedFailures(runWith('SUCCEEDED', { trigger: fine, bad: failed }));
  expect(found).toEqual([{ name: 'bad', displayName: 'Look up the customer' }]);
});

test('a clean run and a failed run have no continued failure', () => {
  expect(continuedFailures(runWith('SUCCEEDED', { trigger: fine, bad: fine }))).toEqual([]);
  expect(continuedFailures(runWith('FAILED', { trigger: fine, bad: failed }))).toEqual([]);
});

test('a step that failed inside a loop round is found once', () => {
  const loop = { output: { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED', output: { index: 2, iterations: [{ bad: { type: 'PIECE', status: 'FAILED' } }, { bad: { type: 'PIECE', status: 'FAILED' } }] } } };
  expect(continuedFailures(runWith('SUCCEEDED', { loop })).map(step => step.name)).toEqual(['bad']);
});
