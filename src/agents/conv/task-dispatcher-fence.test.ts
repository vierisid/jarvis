/**
 * #1155. A channel turn whose sender is removed mid-turn ends at its next
 * dispatch. On the conv tier that dispatch is inside a delegated task, whose
 * failure the dispatcher reported to the conv loop as an ordinary failed task,
 * so the loop went on paying for model calls whose reply would be dropped.
 */
import { expect, test } from 'bun:test';
import { TaskDispatcher, type TaskRunner } from './task-dispatcher.ts';
import { TaskRegistry } from './task-registry.ts';
import { checkpointExecution, withExecutionScope } from '../../actions/execution-scope.ts';
import type { LLMManager } from '../../llm/manager.ts';

class Revoked extends Error {}

function dispatcher(runner: TaskRunner) {
  return new TaskDispatcher({} as LLMManager, new TaskRegistry(), runner);
}

test('a task that fails because the calling turn\'s fence now refuses ends the turn', async () => {
  let revoked = false;
  const runner: TaskRunner = async () => { revoked = true; checkpointExecution(); throw new Error('unreachable'); };
  const run = withExecutionScope(() => { if (revoked) throw new Revoked('removed'); },
    () => dispatcher(runner).dispatch({ tier: 'medium', template: 'write', intent: 'x' }, { scope: null }));
  await expect(run).rejects.toBeInstanceOf(Revoked);
});

test('a dispatch after the fence refuses starts no task at all', async () => {
  let ran = 0;
  const runner: TaskRunner = async () => { ran++; return { kind: 'completed', text: 'ok', conversation: [] }; };
  const run = withExecutionScope(() => { throw new Revoked('removed'); },
    () => dispatcher(runner).dispatch({ tier: 'medium', template: 'write', intent: 'x' }, { scope: null }));
  await expect(run).rejects.toBeInstanceOf(Revoked);
  expect(ran).toBe(0);
});

test('control: a task that fails on its own is still reported as a failed task', async () => {
  const runner: TaskRunner = async () => { throw new Error('tool broke'); };
  const result = await withExecutionScope(() => {},
    () => dispatcher(runner).dispatch({ tier: 'medium', template: 'write', intent: 'x' }, { scope: null }));
  expect(result.status).toBe('failed');
  expect(result.error).toBe('tool broke');
});
