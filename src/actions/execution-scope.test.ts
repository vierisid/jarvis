import { expect, test } from 'bun:test';
import { checkpointExecution, executionSignal, outsideExecutionScope, withExecutionScope } from './execution-scope.ts';

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

test('detached background work keeps its own cancellation after the caller settles', async () => {
  const caller = new AbortController(), background = new AbortController();
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await withExecutionScope(() => caller.signal.throwIfAborted(), async () => {
    const task = outsideExecutionScope(() => withExecutionScope(() => background.signal.throwIfAborted(), async () => {
      await ready;
      expect(executionSignal()).toBe(background.signal);
      expect(() => checkpointExecution()).not.toThrow();
      background.abort(new Error('Background stopped'));
      expect(() => checkpointExecution()).toThrow('Background stopped');
    }, background.signal));
    caller.abort(new Error('Caller settled'));
    expect(() => checkpointExecution()).toThrow('Caller settled');
    release();
    await task;
    expect(executionSignal()).toBe(caller.signal);
  }, caller.signal);
  expect(executionSignal()).toBeUndefined();
});
