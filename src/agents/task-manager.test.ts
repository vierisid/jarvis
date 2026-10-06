import { describe, expect, test } from 'bun:test';
import { AgentTaskManager, MAX_RUNNING_TASKS, TaskCapacityError } from './task-manager.ts';
import { reportExecutionActivity, withExecutionProgress, type ExecutionActivity } from '../actions/progress-context.ts';
import { checkpointExecution, executionSignal, withExecutionScope } from '../actions/execution-scope.ts';

/** A runner whose tasks finish only when the test says so. */
function controllableRunner() {
  const pending: Array<(value: unknown) => void> = [];
  const run = (() => new Promise((resolve) => pending.push(resolve))) as unknown as ConstructorParameters<
    typeof AgentTaskManager
  >[0];
  const finishOne = () =>
    pending.shift()?.({
      success: true,
      response: 'done',
      toolsUsed: [],
      tokensUsed: { input: 0, output: 0 },
      terminationReason: 'complete',
      messages: [],
    });
  return { run, finishOne };
}

const launchOptions = (id: string) =>
  ({
    agent: { id, agent: { role: { name: `agent ${id}`, id: 'role' } } },
    task: 'do the thing',
    context: '',
    llmManager: {},
    toolRegistry: {},
  }) as unknown as Parameters<AgentTaskManager['launch']>[0];

test.each([false, true])('detached runner and lifecycle callbacks keep execution scope but clear turn progress (reject=%s)', async reject => {
  const events: ExecutionActivity[] = [], lifecycle: string[] = [];
  const controller = new AbortController(); let checks = 0;
  const report = () => reportExecutionActivity({ kind: 'agent', executionId: 'background', phase: 'started' });
  const manager = new AgentTaskManager(async () => {
    await Bun.sleep(1);
    expect(executionSignal()).toBe(controller.signal); checkpointExecution();
    expect(report()).toBe(false);
    if (reject) throw Error('Synthetic failure');
    return { success: true, response: 'done', toolsUsed: [], tokensUsed: { input: 0, output: 0 }, terminationReason: 'completed', messages: [] };
  });
  manager.subscribeLifecycle(event => { lifecycle.push(event); expect(report()).toBe(false); });
  let complete!: () => void;
  const finished = new Promise<void>(resolve => { complete = resolve; });
  const taskId = withExecutionScope(() => { checks++; }, () => withExecutionProgress(event => events.push(event), () => manager.launch({
    ...launchOptions('background'), onComplete: () => { expect(report()).toBe(false); complete(); },
  })), controller.signal);
  await finished;
  expect(manager.getTask(taskId)?.status).toBe(reject ? 'failed' : 'completed');
  expect(lifecycle).toEqual(['launch', reject ? 'fail' : 'complete']);
  expect(checks).toBe(1); expect(events).toEqual([]);
});

describe('AgentTaskManager running-task cap', () => {
  test(`refuses a task past ${MAX_RUNNING_TASKS} running, leaves no record of it, and a finish frees a slot`, async () => {
    const runner = controllableRunner();
    const manager = new AgentTaskManager(runner.run);
    for (let i = 0; i < MAX_RUNNING_TASKS; i++) manager.launch(launchOptions(`a${i}`));
    expect(manager.runningCount()).toBe(MAX_RUNNING_TASKS);
    expect(manager.canLaunch()).toBe(false);

    expect(() => manager.launch(launchOptions('extra'))).toThrow(TaskCapacityError);
    expect(manager.listTasks()).toHaveLength(MAX_RUNNING_TASKS);

    runner.finishOne();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.runningCount()).toBe(MAX_RUNNING_TASKS - 1);
    expect(manager.canLaunch()).toBe(true);
    expect(() => manager.launch(launchOptions('extra'))).not.toThrow();
  });
});
