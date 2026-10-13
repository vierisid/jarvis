import { describe, expect, test } from 'bun:test';
import { AgentTaskManager, MAX_RUNNING_TASKS, TaskCapacityError } from './task-manager.ts';
import { AgentInstance } from './agent.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';

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

/**
 * #963: a cancelled task's loop actually stops. Run against the REAL
 * sub-agent loop with a scripted model, counting the model calls it makes.
 */
describe('AgentTaskManager.cancel stops the loop', () => {
  /** A model that always asks for one cheap tool, so the loop never ends by itself. */
  function busyModel(opts: { hangOn?: number } = {}) {
    let calls = 0;
    const llmManager = {
      chatTier: async (_tier: string, _sub: string, _messages: unknown[], o?: { signal?: AbortSignal }) => {
        calls++;
        if (opts.hangOn !== undefined && calls === opts.hangOn) {
          // A provider call that only ends when it is aborted.
          await new Promise((_, reject) => {
            o?.signal?.addEventListener('abort', () => reject(new Error('aborted by caller')), { once: true });
          });
        }
        await new Promise((r) => setTimeout(r, 1));
        return { content: '', finish_reason: 'tool_use', model: 'm',
          tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: {} }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    return { llmManager, calls: () => calls };
  }
  const registry = new ToolRegistry();
  registry.register({ name: 'noop', description: 'does nothing', category: 'general', parameters: {}, execute: async () => 'ok' });
  const agent = () => new AgentInstance({ id: 'spec', name: 'Spec', description: 'd', responsibilities: [], autonomous_actions: [],
    approval_required: [], tools: [], authority_level: 3 } as never);
  const settle = async (manager: AgentTaskManager, id: string) => {
    for (let i = 0; i < 500 && manager.getTask(id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 2));
  };

  test('after cancel the loop makes no further model call, and its slot comes back', async () => {
    const model = busyModel();
    const manager = new AgentTaskManager();
    const lifecycle: string[] = [];
    manager.subscribeLifecycle((event) => lifecycle.push(event));
    const id = manager.launch({ agent: agent(), task: 't', context: '', llmManager: model.llmManager as never, toolRegistry: registry });
    for (let i = 0; i < 200 && model.calls() < 3; i++) await new Promise((r) => setTimeout(r, 2));
    expect(model.calls()).toBeGreaterThanOrEqual(3);

    const atCancel = model.calls();
    expect(manager.cancel(id, 'asked to stop')).toBe(true);
    await settle(manager, id);
    await new Promise((r) => setTimeout(r, 50));

    // Not one model call started after the cancel. Without the abort the loop
    // ran on to its 100-call iteration cap (measured: 100).
    expect(model.calls()).toBe(atCancel);
    const task = manager.getTask(id)!;
    expect(task.status).toBe('cancelled');
    expect(task.result?.canceled).toBe(true);
    expect(task.result?.response).toContain('asked to stop');
    expect(manager.runningCount()).toBe(0);
    expect(lifecycle).toEqual(['launch', 'cancel']);
    expect(manager.cancel(id)).toBe(false);
  });

  test('a model call in flight is aborted, not waited out', async () => {
    const model = busyModel({ hangOn: 2 });
    const manager = new AgentTaskManager();
    const id = manager.launch({ agent: agent(), task: 't', context: '', llmManager: model.llmManager as never, toolRegistry: registry });
    for (let i = 0; i < 200 && model.calls() < 2; i++) await new Promise((r) => setTimeout(r, 2));
    expect(model.calls()).toBe(2);

    manager.cancel(id);
    await settle(manager, id);

    expect(manager.getTask(id)!.status).toBe('cancelled');
    expect(model.calls()).toBe(2);
  });

  test('cancelAgentTasks stops every running task of that agent only', async () => {
    const a = busyModel();
    const b = busyModel();
    const manager = new AgentTaskManager();
    const agentA = agent();
    const ta = manager.launch({ agent: agentA, task: 't', context: '', llmManager: a.llmManager as never, toolRegistry: registry });
    const tb = manager.launch({ agent: agent(), task: 't', context: '', llmManager: b.llmManager as never, toolRegistry: registry });
    expect(manager.cancelAgentTasks(agentA.id)).toBe(1);
    await settle(manager, ta);
    expect(manager.getTask(ta)!.status).toBe('cancelled');
    expect(manager.getTask(tb)!.status).toBe('running');
    manager.cancel(tb);
    await settle(manager, tb);
  });

  test('a cancel that lands after the run answered leaves the answer standing', async () => {
    let finish: (v: unknown) => void = () => {};
    const manager = new AgentTaskManager((() => new Promise((r) => { finish = r; })) as never);
    const id = manager.launch({ agent: agent(), task: 't', context: '', llmManager: {} as never, toolRegistry: registry });
    // The run has returned its answer; the cancel arrives before the task settles.
    finish({ success: true, response: 'THE ANSWER', toolsUsed: [], tokensUsed: { input: 0, output: 0 }, terminationReason: 'completed', messages: [] });
    manager.cancel(id, 'late');
    await settle(manager, id);
    expect(manager.getTask(id)!.status).toBe('completed');
    expect(manager.getTask(id)!.result?.response).toBe('THE ANSWER');
  });

  test('a cancel during a tool call holds the slot until the tool returns, then no model call follows', async () => {
    let release: () => void = () => {};
    let toolStarted = false;
    const slow = new ToolRegistry();
    slow.register({ name: 'noop', description: 'slow', category: 'general', parameters: {}, execute: async () => {
      toolStarted = true;
      await new Promise<void>((r) => { release = r; });
      return 'ok';
    } });
    const model = busyModel();
    const manager = new AgentTaskManager();
    const id = manager.launch({ agent: agent(), task: 't', context: '', llmManager: model.llmManager as never, toolRegistry: slow });
    for (let i = 0; i < 200 && !toolStarted; i++) await new Promise((r) => setTimeout(r, 2));
    expect(toolStarted).toBe(true);
    const atCancel = model.calls();
    manager.cancel(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.getTask(id)!.status).toBe('running');
    expect(manager.runningCount()).toBe(1);
    release();
    await settle(manager, id);
    expect(manager.getTask(id)!.status).toBe('cancelled');
    expect(manager.runningCount()).toBe(0);
    expect(model.calls()).toBe(atCancel);
  });
});
