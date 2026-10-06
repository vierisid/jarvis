import { expect, test } from 'bun:test';
import { ToolRegistry } from './tools/registry';
import { failedToolResult, withExecutionProgress, type ExecutionActivity } from './progress-context';
import { ActionOutcomeError } from './action-outcome';

test('the real registry observes execution and failures without arguments, results or error text', async () => {
  const registry = new ToolRegistry();
  const events: ExecutionActivity[] = [];
  const outcome = new ActionOutcomeError({ status: 'blocked', code: 'SECRET', message: 'PRIVATE ERROR', effect: 'not_started' });
  let calls = 0;
  registry.register({ name: 'fixture', category: 'fixture', description: 'Fixture', parameters: {}, execute: async args => {
    calls++; if (args.fail) throw outcome; return { success: true, token: 'PRIVATE RESULT' };
  } });
  await withExecutionProgress(event => events.push(event), async () => {
    expect(await registry.execute('fixture', { secret: 'PRIVATE ARGUMENT' })).toEqual({ success: true, token: 'PRIVATE RESULT' });
    await expect(registry.execute('fixture', { fail: true })).rejects.toBe(outcome);
  });
  expect(calls).toBe(2);
  expect(events.map(event => event.phase)).toEqual(['started', 'completed', 'started', 'failed']);
  expect(events[0]?.executionId).toBe(events[1]?.executionId);
  expect(events[2]?.executionId).toBe(events[3]?.executionId);
  expect(events[0]?.executionId).not.toBe(events[2]?.executionId);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET/);
});

test.each([{ error: 'PRIVATE' }, { success: false }, { ok: false }, { isError: true }, 'Error: PRIVATE', { status: 'error', code: 'PRIVATE', message: 'PRIVATE', effect: 'not_started' }])('arbitrary returned data %j cannot select execution status', async result => {
  const registry = new ToolRegistry(), events: ExecutionActivity[] = [];
  registry.register({ name: 'fixture', description: 'Fixture', category: 'fixture', parameters: {}, execute: async () => result });
  const actual = await withExecutionProgress(event => events.push(event), () => registry.execute('fixture', {}));
  expect(actual).toBe(result); expect(events.at(-1)?.phase).toBe('completed');
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
});

test('observation is optional, isolated across concurrent calls and cannot change execution', async () => {
  const registry = new ToolRegistry(); let calls = 0;
  registry.register({ name: 'fixture', description: 'Fixture', category: 'fixture', parameters: {}, execute: async () => { calls++; await Bun.sleep(1); return 'ok'; } });
  const a: ExecutionActivity[] = [], b: ExecutionActivity[] = [];
  await Promise.all([withExecutionProgress(event => a.push(event), () => registry.execute('fixture', {})),
    withExecutionProgress(event => b.push(event), () => registry.execute('fixture', {})), registry.execute('fixture', {})]);
  expect(a).toHaveLength(2); expect(b).toHaveLength(2); expect(a[0]?.executionId).not.toBe(b[0]?.executionId);
  expect(await withExecutionProgress(() => { throw new Error('storage unavailable'); }, () => registry.execute('fixture', {}))).toBe('ok');
  expect(calls).toBe(4);
});

test('a disabled nested scope cannot publish through its enclosing observer', async () => {
  const registry = new ToolRegistry(), events: ExecutionActivity[] = [];
  registry.register({ name: 'fixture', description: 'Fixture', category: 'fixture', parameters: {}, execute: async () => 'ok' });
  await withExecutionProgress(event => events.push(event), async () => {
    await withExecutionProgress(undefined, () => registry.execute('fixture', {}));
    expect(events).toEqual([]);
    await registry.execute('fixture', {});
  });
  expect(events.map(event => event.phase)).toEqual(['started', 'completed']);
});

test('trusted adapter failures preserve values and remain isolated in nested and parallel tool calls', async () => {
  const registry = new ToolRegistry(), events: ExecutionActivity[] = [];
  const result = { detail: 'PRIVATE', arbitrary: true };
  registry.register({ name: 'failed', description: 'Fixture', category: 'fixture', parameters: {}, execute: async () => {
    await Bun.sleep(1); return failedToolResult(result);
  } });
  registry.register({ name: 'recovered', description: 'Fixture', category: 'fixture', parameters: {}, execute: async () => {
    expect(await registry.execute('failed', {})).toBe(result); return 'Recovered';
  } });
  registry.register({ name: 'normal', description: 'Fixture', category: 'fixture', parameters: {}, execute: async () => { await Bun.sleep(2); return 'ok'; } });
  await withExecutionProgress(event => events.push(event), () => Promise.all([
    registry.execute('recovered', {}), registry.execute('normal', {}), registry.execute('failed', {}),
  ]));
  expect(events.filter(event => event.phase !== 'started').map(event => [event.toolName, event.phase]).sort()).toEqual([
    ['failed', 'failed'], ['failed', 'failed'], ['normal', 'completed'], ['recovered', 'completed'],
  ]);
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
  expect(await withExecutionProgress(() => { throw Error('unavailable'); }, () => registry.execute('failed', {}))).toBe(result);
  expect(await registry.execute('failed', {})).toBe(result);
});

test('a detached failure cannot change the enclosing tool outcome', async () => {
  const registry = new ToolRegistry(), events: ExecutionActivity[] = [];
  registry.register({ name: 'handoff', description: 'Fixture', category: 'fixture', parameters: {}, execute: async () => {
    await withExecutionProgress(undefined, async () => { await Bun.sleep(1); failedToolResult('PRIVATE'); });
    return 'Handed off';
  } });
  await withExecutionProgress(event => events.push(event), () => registry.execute('handoff', {}));
  expect(events.map(event => event.phase)).toEqual(['started', 'completed']);
});
