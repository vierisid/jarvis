import { describe, expect, test } from 'bun:test';
import { AgentInstance } from './agent.ts';
import { AgentTaskManager, type AsyncTask, type TaskLifecycleEvent } from './task-manager.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { LLMManager } from '../llm/manager.ts';

/**
 * The defect this file exists for, in one sentence: a sub-agent that dies on a
 * hard provider error was reported as `completed`.
 *
 * `runSubAgent` catches everything and RESOLVES with `{success: false,
 * terminationReason: 'error'}` rather than rejecting, so the manager's `.then`
 * branch stamped `completed` on a run that had been dead for three provider
 * calls. Verified in a real log: three `credit_balance_exhausted` lines and
 * then `[TaskManager] Task eb7b2f32 completed (Research Analyst)`. It is the
 * reason the trial's finale was concluded three separate times never to spawn
 * an agent at all.
 *
 * These tests drive the REAL runner, with only the LLM stubbed, because the
 * bug lives in the seam between the runner and the manager and a test that
 * stubbed the runner would have passed all along.
 */

function makeRole(): RoleDefinition {
  return {
    id: 'test-analyst',
    name: 'Research Analyst',
    description: 'A test role.',
    responsibilities: ['Answer the question'],
    autonomous_actions: [],
    approval_required: [],
    tools: [],
    authority_level: 3,
  } as RoleDefinition;
}

/** Just enough LLMManager for runSubAgent: it only ever calls `chatTier`. */
function llmThat(behaviour: 'answers' | 'throws', detail = ''): LLMManager {
  return {
    chatTier: async () => {
      if (behaviour === 'throws') throw new Error(detail);
      return {
        content: 'The other schedulers charge between 180 and 320 a seat.',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { input_tokens: 10, output_tokens: 20 },
      };
    },
  } as unknown as LLMManager;
}

function settled(tm: AgentTaskManager, id: string): Promise<AsyncTask> {
  return new Promise((resolve) => {
    const stop = tm.subscribeLifecycle((_event: TaskLifecycleEvent, task: AsyncTask) => {
      if (task.id !== id || task.status === 'running') return;
      stop();
      resolve(task);
    });
  });
}

function launch(tm: AgentTaskManager, llm: LLMManager, opts: { displayName?: string } = {}): string {
  return tm.launch({
    agent: new AgentInstance(makeRole()),
    task: 'What do the other studio schedulers charge a seat?',
    context: 'They sell to studios.',
    llmManager: llm,
    toolRegistry: new ToolRegistry(),
    ...opts,
  });
}

describe('a sub-agent that died is not reported as finished', () => {
  test('a billing refusal comes out as failed, not completed', async () => {
    const tm = new AgentTaskManager();
    const id = launch(tm, llmThat('throws', '429 credit_balance_exhausted: your credit balance is too low'));
    const task = await settled(tm, id);

    expect(task.status).toBe('failed');
    expect(task.result?.success).toBe(false);
    expect(task.result?.terminationReason).toBe('error');
  });

  test('and it says WHICH way it died, so what the founder sees can be honest', async () => {
    const tm = new AgentTaskManager();
    const id = launch(tm, llmThat('throws', '429 credit_balance_exhausted'));
    const task = await settled(tm, id);

    expect(task.failure).not.toBeNull();
    expect(task.failure!.kind).toBe('billing');
    expect(task.failure!.says).toContain('billing');
    // The raw text is kept for whoever is debugging, and is not what a person
    // is shown.
    expect(task.failure!.detail).toContain('credit_balance_exhausted');
  });

  test('the lifecycle event is `fail`, so anything subscribed hears the truth too', async () => {
    const tm = new AgentTaskManager();
    const seen: TaskLifecycleEvent[] = [];
    tm.subscribeLifecycle((event) => { seen.push(event); });
    const id = launch(tm, llmThat('throws', 'ECONNREFUSED'));
    await settled(tm, id);
    expect(seen).toEqual(['launch', 'fail']);
  });

  test('a run that worked is still completed, with no failure on it', async () => {
    const tm = new AgentTaskManager();
    const seen: TaskLifecycleEvent[] = [];
    tm.subscribeLifecycle((event) => { seen.push(event); });
    const id = launch(tm, llmThat('answers'));
    const task = await settled(tm, id);

    expect(task.status).toBe('completed');
    expect(task.failure).toBeNull();
    expect(task.result?.response).toContain('180');
    expect(seen).toEqual(['launch', 'complete']);
  });

  test('onComplete fires on both paths, because the caller is waiting either way', async () => {
    for (const behaviour of ['answers', 'throws'] as const) {
      const tm = new AgentTaskManager();
      let called: AsyncTask | null = null;
      const id = tm.launch({
        agent: new AgentInstance(makeRole()),
        task: 'q',
        context: '',
        llmManager: llmThat(behaviour, 'boom'),
        toolRegistry: new ToolRegistry(),
        onComplete: (t) => { called = t; },
      });
      await settled(tm, id);
      // The lifecycle emit and onComplete are separate calls; give the second one its turn.
      await new Promise((r) => setTimeout(r, 5));
      expect(called).not.toBeNull();
      expect(called!.id).toBe(id);
    }
  });

  test('a failed task is listed as failed, so the strip and the API agree with the log', async () => {
    const tm = new AgentTaskManager();
    const id = launch(tm, llmThat('throws', '401 invalid_api_key'));
    await settled(tm, id);
    expect(tm.listTasks({ status: 'failed' }).map((t) => t.id)).toEqual([id]);
    expect(tm.listTasks({ status: 'completed' })).toEqual([]);
  });

  test('a failed agent is no longer busy, so the founder can be asked again', async () => {
    const tm = new AgentTaskManager();
    const agent = new AgentInstance(makeRole());
    const id = tm.launch({
      agent, task: 'q', context: '', llmManager: llmThat('throws', 'x'), toolRegistry: new ToolRegistry(),
    });
    await settled(tm, id);
    expect(tm.isAgentBusy(agent.id)).toBe(false);
  });
});

describe('two agents of the same role are told apart', () => {
  test('displayName replaces the role name on the record every surface reads', async () => {
    const tm = new AgentTaskManager();
    const id = launch(tm, llmThat('answers'), { displayName: 'Reading your files' });
    const task = await settled(tm, id);
    expect(task.agentName).toBe('Reading your files');
  });

  test('without one, nothing changes: it is still the role name', async () => {
    const tm = new AgentTaskManager();
    const id = launch(tm, llmThat('answers'));
    const task = await settled(tm, id);
    expect(task.agentName).toBe('Research Analyst');
  });

  test('a blank or whitespace displayName falls back rather than showing nothing', async () => {
    const tm = new AgentTaskManager();
    const id = launch(tm, llmThat('answers'), { displayName: '   ' });
    const task = await settled(tm, id);
    expect(task.agentName).toBe('Research Analyst');
  });
});
