import { describe, expect, test } from 'bun:test';
import { AgentTaskManager, MAX_RUNNING_TASKS, RUN_STOPPED_REASON, TaskCapacityError, TaskRunStoppedError } from './task-manager.ts';
import { withRunOwner, type RunOwner } from '../actions/run-owner-scope.ts';
import { AgentInstance } from './agent.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { AuthorityEngine } from '../authority/engine.ts';
import { EmergencyController } from '../authority/emergency.ts';
import { currentBriefTurn, withBriefTurn } from '../brief/chat-context.ts';
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

describe('a background task outlives the Brief chat turn that started it', () => {
  test('the task runs outside that turn, so its progress and approval cards are not filed under it', async () => {
    let seen: unknown = 'not run';
    const run = (async () => { seen = currentBriefTurn(); return new Promise(() => {}); }) as unknown as ConstructorParameters<typeof AgentTaskManager>[0];
    const manager = new AgentTaskManager(run);
    const turn = { conversationId: 'c', turnId: 't', requestId: 'r', signal: new AbortController().signal, progress: () => {} };
    withBriefTurn(turn, () => manager.launch(launchOptions('brief')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toBeUndefined();
  });
});

test.each([false, true])('detached runner and lifecycle callbacks leave the caller execution scope (#988) and turn progress (reject=%s)', async reject => {
  const events: ExecutionActivity[] = [], lifecycle: string[] = [];
  const controller = new AbortController(); let checks = 0;
  const report = () => reportExecutionActivity({ kind: 'agent', executionId: 'background', phase: 'started' });
  const manager = new AgentTaskManager(async () => {
    await Bun.sleep(1);
    expect(executionSignal()).toBeUndefined(); checkpointExecution();
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
  expect(checks).toBe(0); expect(events).toEqual([]);
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

/**
 * #987: Kill cancels every task started under that controller. Before, Kill
 * refused the tools and left the loop calling the model to its iteration cap
 * (measured: 97 more model calls after Kill, then status `completed`).
 */
describe('emergency Kill cancels running tasks', () => {
  function busyModel() {
    let calls = 0;
    const llmManager = {
      chatTier: async () => {
        calls++;
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
  // The production shape: an engine is wired, so a halted system refuses the tools.
  const engine = () => new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const launchUnder = (manager: AgentTaskManager, emergency: EmergencyController, model: ReturnType<typeof busyModel>) =>
    manager.launch({ agent: agent(), task: 't', context: '', llmManager: model.llmManager as never, toolRegistry: registry,
      authority: { authorityEngine: engine(), emergencyController: emergency } });
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 2));
  };

  test('Kill cancels a running task and no model call follows it', async () => {
    const emergency = new EmergencyController();
    const model = busyModel();
    const manager = new AgentTaskManager();
    const id = launchUnder(manager, emergency, model);
    await until(() => model.calls() >= 3);
    expect(model.calls()).toBeGreaterThanOrEqual(3);

    const atKill = model.calls();
    emergency.kill();
    await until(() => manager.getTask(id)!.status !== 'running');
    await new Promise((r) => setTimeout(r, 50));

    expect(model.calls()).toBe(atKill);
    const task = manager.getTask(id)!;
    expect(task.status).toBe('cancelled');
    expect(task.result?.response).toContain('the system was killed');
    expect(manager.runningCount()).toBe(0);
  });

  test('Kill stops only the tasks started under that controller', async () => {
    const killed = new EmergencyController();
    const other = new EmergencyController();
    const a = busyModel();
    const b = busyModel();
    const manager = new AgentTaskManager();
    const ta = launchUnder(manager, killed, a);
    const tb = launchUnder(manager, other, b);
    await until(() => a.calls() >= 2 && b.calls() >= 2);
    killed.kill();
    await until(() => manager.getTask(ta)!.status !== 'running');
    expect(manager.getTask(ta)!.status).toBe('cancelled');
    expect(manager.getTask(tb)!.status).toBe('running');
    const bAt = b.calls();
    await until(() => b.calls() > bAt);
    expect(b.calls()).toBeGreaterThan(bAt);
    manager.cancel(tb);
    await until(() => manager.getTask(tb)!.status !== 'running');
  });

  test('Pause does not cancel a running task (the owner has not decided that, #987)', async () => {
    const emergency = new EmergencyController();
    const model = busyModel();
    const manager = new AgentTaskManager();
    const id = launchUnder(manager, emergency, model);
    await until(() => model.calls() >= 2);
    emergency.pause();
    const atPause = model.calls();
    await until(() => model.calls() > atPause + 2);
    expect(model.calls()).toBeGreaterThan(atPause + 2);
    expect(manager.getTask(id)!.status).toBe('running');
    expect(manager.getTask(id)!.cancelRequested).toBeUndefined();
    emergency.resume();
    manager.cancel(id);
    await until(() => manager.getTask(id)!.status !== 'running');
  });
});

/**
 * #987 at the sink: a sub-agent run with NO signal -- what `delegate_task`
 * and a workflow delegation make -- also stops at its next fence on Kill.
 * Before, it ran on to its iteration cap with every tool refused.
 */
describe('emergency Kill stops a sub-agent run that has no signal', () => {
  test('no model call follows Kill, and the run reports a cancel', async () => {
    const { runSubAgent } = await import('./sub-agent-runner.ts');
    let calls = 0;
    const emergency = new EmergencyController();
    const llmManager = {
      chatTier: async () => {
        calls++;
        if (calls === 3) emergency.kill();
        await new Promise((r) => setTimeout(r, 1));
        return { content: '', finish_reason: 'tool_use', model: 'm',
          tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: {} }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const registry = new ToolRegistry();
    let toolRuns = 0;
    registry.register({ name: 'noop', description: 'd', category: 'general', parameters: {}, execute: async () => { toolRuns++; return 'ok'; } });
    const result = await runSubAgent({
      agent: new AgentInstance({ id: 'spec', name: 'Spec', description: 'd', responsibilities: [], autonomous_actions: [],
        approval_required: [], tools: [], authority_level: 3 } as never),
      task: 't', context: '', llmManager: llmManager as never, toolRegistry: registry,
      authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
        learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
      emergencyController: emergency,
    });
    expect(calls).toBe(3);
    // The turn returned by the call that issued Kill dispatched nothing.
    expect(toolRuns).toBe(2);
    expect(result.canceled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.response).toContain('the system was killed');
  });

  test('a Kill then Reset during one model call still stops the run', async () => {
    const { runSubAgent } = await import('./sub-agent-runner.ts');
    let calls = 0;
    const emergency = new EmergencyController();
    const llmManager = {
      chatTier: async () => {
        calls++;
        if (calls === 2) { emergency.kill(); emergency.reset(); }
        await new Promise((r) => setTimeout(r, 1));
        return { content: '', finish_reason: 'tool_use', model: 'm',
          tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: {} }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const registry = new ToolRegistry();
    registry.register({ name: 'noop', description: 'd', category: 'general', parameters: {}, execute: async () => 'ok' });
    const result = await runSubAgent({
      agent: new AgentInstance({ id: 'spec', name: 'Spec', description: 'd', responsibilities: [], autonomous_actions: [],
        approval_required: [], tools: [], authority_level: 3 } as never),
      task: 't', context: '', llmManager: llmManager as never, toolRegistry: registry, emergencyController: emergency,
    });
    expect(calls).toBe(2);
    expect(result.canceled).toBe(true);
  });
});

describe('a task started for a workflow run belongs to that run (#1018)', () => {
  /** A runner that only returns when its task is cancelled. */
  const untilStopped = (async (o: { signal?: AbortSignal }) => {
    await new Promise((resolve) => o.signal?.addEventListener('abort', resolve, { once: true }));
    return { success: false, canceled: true, response: 'stopped', toolsUsed: [], tokensUsed: { input: 0, output: 0 },
      terminationReason: 'cancelled', messages: [] };
  }) as unknown as ConstructorParameters<typeof AgentTaskManager>[0];
  /**
   * A run the test stops or ends by hand, counting who listens for that.
   * `gone()` is the workflow turned off or deleted after the run ended: a live
   * run would read as stopped then.
   */
  function run(runId = 'run-1') {
    let state: 'live' | 'ended' | 'stopped' = 'live';
    const listeners = new Set<() => void>();
    const endedListeners = new Set<() => void>();
    const owner: RunOwner = { runId, stopped: () => state === 'stopped', ended: () => state === 'ended',
      onStopped: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      onEnded: (listener) => { endedListeners.add(listener); return () => endedListeners.delete(listener); } };
    return { owner, listeners, endedListeners,
      stop: () => { state = 'stopped'; for (const listener of [...listeners]) listener(); },
      end: () => { state = 'ended'; for (const listener of [...endedListeners]) listener(); },
      gone: () => { state = 'stopped'; } };
  }
  /**
   * A runner whose first task waits for `next()`, then starts one nested task
   * from inside its own async context (where the run's scope is), and then
   * runs until cancelled. Nested tasks run until cancelled too.
   */
  function nestingRunner(manager: () => AgentTaskManager) {
    let calls = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const nested: Array<{ id?: string; error?: unknown }> = [];
    const runner = (async (o: { signal?: AbortSignal }) => {
      if (++calls === 1) {
        await gate;
        try { nested.push({ id: manager().launch(launchOptions('nested')) }); } catch (error) { nested.push({ error }); }
      }
      await new Promise((resolve) => o.signal?.addEventListener('abort', resolve, { once: true }));
      return { success: false, canceled: true, response: 'stopped', toolsUsed: [], tokensUsed: { input: 0, output: 0 },
        terminationReason: 'cancelled', messages: [] };
    }) as unknown as ConstructorParameters<typeof AgentTaskManager>[0];
    const startNested = async () => { open(); for (let i = 0; i < 50 && nested.length === 0; i++) await new Promise((r) => setTimeout(r, 1)); return nested[0]!; };
    return { runner, startNested };
  }
  const settle = async (manager: AgentTaskManager, id: string) => {
    for (let i = 0; i < 200 && manager.getTask(id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 1));
  };

  test('stopping the run cancels the task, saying why, and the task stops listening', async () => {
    const manager = new AgentTaskManager(untilStopped);
    const r = run();
    const id = withRunOwner(r.owner, () => manager.launch(launchOptions('wf')));
    expect(manager.getTask(id)).toMatchObject({ status: 'running', workflowRunId: 'run-1' });
    expect(r.listeners.size).toBe(1);
    r.stop();
    await settle(manager, id);
    expect(manager.getTask(id)).toMatchObject({ status: 'cancelled', cancelRequested: RUN_STOPPED_REASON });
    expect(manager.getTask(id)!.result!.response).toBe(`Task cancelled: ${RUN_STOPPED_REASON}`);
    expect(r.listeners.size).toBe(0);
  });

  test('a task whose run is already stopped does not start, and leaves no record', () => {
    const manager = new AgentTaskManager(untilStopped);
    const r = run();
    r.stop();
    expect(() => withRunOwner(r.owner, () => manager.launch(launchOptions('wf')))).toThrow(TaskRunStoppedError);
    expect(manager.listTasks()).toEqual([]);
    expect(r.listeners.size).toBe(0);
  });

  test('a task that finishes stops listening to its run, and a later stop changes nothing', async () => {
    const runner = controllableRunner();
    const manager = new AgentTaskManager(runner.run);
    const r = run();
    const id = withRunOwner(r.owner, () => manager.launch(launchOptions('wf')));
    runner.finishOne();
    await settle(manager, id);
    expect(manager.getTask(id)!.status).toBe('completed');
    expect(r.listeners.size).toBe(0);
    r.stop();
    expect(manager.getTask(id)!.status).toBe('completed');
  });

  test('a task started while its run is live belongs to the run, and stopping the run cancels both', async () => {
    let manager!: AgentTaskManager;
    const n = nestingRunner(() => manager);
    manager = new AgentTaskManager(n.runner);
    const r = run();
    const id = withRunOwner(r.owner, () => manager.launch(launchOptions('wf')));
    const nested = await n.startNested();
    expect(manager.getTask(nested.id!)).toMatchObject({ status: 'running', workflowRunId: 'run-1' });
    r.stop();
    await settle(manager, id);
    await settle(manager, nested.id!);
    expect([manager.getTask(id)!.status, manager.getTask(nested.id!)!.status]).toEqual(['cancelled', 'cancelled']);
  });

  test('a run that ends on its own releases its task: it keeps running, and what it starts later is its own', async () => {
    let manager!: AgentTaskManager;
    const n = nestingRunner(() => manager);
    manager = new AgentTaskManager(n.runner);
    const r = run();
    const id = withRunOwner(r.owner, () => manager.launch(launchOptions('wf')));
    r.end();
    // The task stops listening to its run, and is not cancelled.
    expect([r.listeners.size, r.endedListeners.size]).toEqual([0, 0]);
    expect(manager.getTask(id)!.status).toBe('running');
    // The finished workflow is turned off or deleted later: nothing the task
    // starts now is refused for it.
    r.gone();
    const nested = await n.startNested();
    expect(nested.error).toBeUndefined();
    expect(manager.getTask(nested.id!)).toMatchObject({ status: 'running' });
    expect(manager.getTask(nested.id!)!.workflowRunId).toBeUndefined();
    manager.cancel(id);
    manager.cancel(nested.id!);
    await settle(manager, id);
  });

  test('a task started after its run already ended is not the run\'s', async () => {
    const manager = new AgentTaskManager(untilStopped);
    const r = run();
    r.end();
    const id = withRunOwner(r.owner, () => manager.launch(launchOptions('wf')));
    expect(manager.getTask(id)!.workflowRunId).toBeUndefined();
    expect([r.listeners.size, r.endedListeners.size]).toEqual([0, 0]);
    manager.cancel(id);
    await settle(manager, id);
  });

  test('a task started outside any run is not tied to one', async () => {
    const manager = new AgentTaskManager(untilStopped);
    const id = manager.launch(launchOptions('chat'));
    expect(manager.getTask(id)!.workflowRunId).toBeUndefined();
    manager.cancel(id);
    await settle(manager, id);
  });
});
