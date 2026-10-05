import { expect, test } from 'bun:test';
import { checkpointExecution, executionSignal, withExecutionScope } from './execution-scope.ts';

test('nested execution scopes retain both dispatch fences and parent cancellation', () => {
  const parent = new AbortController(), child = new AbortController();
  const calls: string[] = [];
  withExecutionScope(() => { calls.push('parent'); parent.signal.throwIfAborted(); }, () => {
    withExecutionScope(() => { calls.push('child'); }, () => {
      expect(executionSignal()).toBe(parent.signal);
      checkpointExecution();
    });
    withExecutionScope(() => {}, () => {
      const inherited = executionSignal()!;
      expect(inherited.aborted).toBe(false);
      parent.abort(new Error('Parent cancelled'));
      expect(inherited.aborted).toBe(true);
      expect(() => checkpointExecution()).toThrow('Parent cancelled');
      expect(child.signal.aborted).toBe(false);
    }, child.signal);
  }, parent.signal);
  expect(calls).toEqual(['parent', 'child', 'parent']);
  expect(executionSignal()).toBeUndefined();
});

test('concurrent execution scopes never share cancellation signals', async () => {
  const a = new AbortController(), b = new AbortController();
  await Promise.all([a, b].map(controller => withExecutionScope(() => {}, async () => {
    await Bun.sleep(0);
    expect(executionSignal()).toBe(controller.signal);
    a.abort();
    expect(executionSignal()!.aborted).toBe(controller === a);
  }, controller.signal)));
  expect(executionSignal()).toBeUndefined();
});
