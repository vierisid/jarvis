/**
 * Phase 0 regression boundary for background sub-agents.
 *
 * P0.1 — AgentTaskManager.launch() used to call runSubAgent with no authority
 *        engine, no audit trail and no emergency controller, and runSubAgent
 *        reads "no engine" as "no gate". These tests pin the wiring and the
 *        non-user-initiated impact ceiling.
 * P0.4 — token budget, concurrency cap, wall-clock timeout, cancel path.
 * P0.5 — the scoped browse grant that lets a research-analyst research.
 */

import { describe, expect, it, mock } from 'bun:test';
import { AgentInstance } from './agent.ts';
import {
  AgentTaskManager,
  TaskCapacityError,
  SYSTEM_INITIATED_IMPACT_CEILING,
  type AsyncTask,
} from './task-manager.ts';
import { runSubAgent, exceedsImpactCeiling, type SubAgentAuthorityContext } from './sub-agent-runner.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { EmergencyController } from '../authority/emergency.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { LLMResponse } from '../llm/provider.ts';

function makeRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    id: 'test-role',
    name: 'Test Role',
    description: 'A test role.',
    responsibilities: ['Test things'],
    autonomous_actions: [],
    approval_required: [],
    tools: [],
    authority_level: 5,
    ...overrides,
  } as RoleDefinition;
}

function makeEngine(config: Partial<AuthorityConfig> = {}): AuthorityEngine {
  return new AuthorityEngine({
    default_level: 5,
    governed_categories: [],
    overrides: [],
    context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 },
    emergency_state: 'normal',
    ...config,
  });
}

/**
 * An LLM stand-in that replays a scripted list of responses. Anything past
 * the end of the script is a plain final answer, so a loop that keeps going
 * terminates instead of hanging the test.
 */
function scriptedLLM(script: Partial<LLMResponse>[]): { llm: LLMManager; calls: () => number } {
  let i = 0;
  const llm = {
    chatTier: async (): Promise<LLMResponse> => {
      const step = script[i++];
      return {
        content: 'done',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { input_tokens: 10, output_tokens: 10 },
        ...step,
      } as LLMResponse;
    },
  } as unknown as LLMManager;
  return { llm, calls: () => i };
}

function registryWith(name: string, category: string, result = 'tool ran'): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name,
    description: 'test tool',
    category,
    parameters: {},
    execute: async () => result,
  });
  return registry;
}

/** One tool-call turn, then a final answer. */
function callThenFinish(toolName: string): Partial<LLMResponse>[] {
  return [
    {
      content: '',
      tool_calls: [{ id: 'c1', name: toolName, arguments: {} }],
      finish_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 10 },
    } as Partial<LLMResponse>,
  ];
}

describe('exceedsImpactCeiling', () => {
  it('permits equal and lower impact, refuses higher', () => {
    expect(exceedsImpactCeiling('read', 'write')).toBe(false);
    expect(exceedsImpactCeiling('write', 'write')).toBe(false);
    expect(exceedsImpactCeiling('external', 'write')).toBe(true);
    expect(exceedsImpactCeiling('destructive', 'write')).toBe(true);
    expect(exceedsImpactCeiling('destructive', 'destructive')).toBe(false);
  });
});

describe('P0.1 — the impact ceiling on non-user-initiated runs', () => {
  it('refuses an external action even with authority level 10 and no engine', async () => {
    // Level 10 + no engine is the most permissive configuration there is.
    // The ceiling must still bind, because "no engine wired" must not mean
    // "no limit" for a capped run.
    const agent = new AgentInstance(makeRole({ authority_level: 10, tools: ['browser'] }));
    const { llm } = scriptedLLM(callThenFinish('browser_navigate'));

    const result = await runSubAgent({
      agent,
      task: 'go look something up',
      context: '',
      llmManager: llm,
      toolRegistry: registryWith('browser_navigate', 'browser'),
      impactCeiling: 'write',
    });

    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('[AUTHORITY DENIED]');
    expect(String(toolMsg?.content)).toContain('not initiated by the user');
  });

  it('still allows a write-impact action under the same ceiling', async () => {
    const agent = new AgentInstance(makeRole({ authority_level: 3, tools: ['file-ops'] }));
    const { llm } = scriptedLLM(callThenFinish('write_file'));

    const result = await runSubAgent({
      agent,
      task: 'save a note',
      context: '',
      llmManager: llm,
      toolRegistry: registryWith('write_file', 'file-ops', 'written'),
      impactCeiling: 'write',
    });

    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toBe('written');
  });

  it('applies no ceiling when none is asked for (user-initiated behaviour)', async () => {
    const agent = new AgentInstance(makeRole({ authority_level: 10, tools: ['browser'] }));
    const { llm } = scriptedLLM(callThenFinish('browser_navigate'));

    const result = await runSubAgent({
      agent,
      task: 'go look something up',
      context: '',
      llmManager: llm,
      toolRegistry: registryWith('browser_navigate', 'browser', 'navigated'),
    });

    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toBe('navigated');
  });
});

describe('P0.1 — AgentTaskManager forwards the authority gate', () => {
  function harness(initiator: 'user' | 'system' | undefined) {
    const engine = makeEngine();
    const checkSpy = mock(engine.checkAuthority.bind(engine));
    engine.checkAuthority = checkSpy as typeof engine.checkAuthority;
    const emergency = new EmergencyController();
    const grants = new Map();
    const authority: SubAgentAuthorityContext = {
      authorityEngine: engine,
      emergencyController: emergency,
      temporaryGrants: grants,
    };
    const manager = new AgentTaskManager({
      authoritySource: { getAuthorityContext: () => authority },
    });
    const agent = new AgentInstance(makeRole({ authority_level: 5, tools: ['file-ops'] }));
    const { llm } = scriptedLLM(callThenFinish('write_file'));

    const settled = new Promise<AsyncTask>((resolve) => {
      manager.launch({
        agent,
        task: 'do a thing',
        context: '',
        llmManager: llm,
        toolRegistry: registryWith('write_file', 'file-ops', 'written'),
        onComplete: resolve,
        ...(initiator ? { initiator } : {}),
      });
    });
    return { settled, checkSpy };
  }

  it('runs the engine check for a launched task (it used to run none at all)', async () => {
    const { settled, checkSpy } = harness('user');
    await settled;
    expect(checkSpy).toHaveBeenCalled();
  });

  it('defaults an omitted initiator to system, not user', async () => {
    const plain = new AgentTaskManager();
    const agent = new AgentInstance(makeRole({ authority_level: 10, tools: ['browser'] }));
    const { llm } = scriptedLLM(callThenFinish('browser_navigate'));

    const task = await new Promise<AsyncTask>((resolve) => {
      plain.launch({
        agent,
        task: 'browse something',
        context: '',
        llmManager: llm,
        toolRegistry: registryWith('browser_navigate', 'browser', 'navigated'),
        onComplete: resolve,
        // initiator deliberately omitted
      });
    });

    expect(task.initiator).toBe('system');
    const toolMsg = task.result?.messages.find((m) => m.role === 'tool');
    // The system ceiling denied the browse even though nothing else would have.
    expect(String(toolMsg?.content)).toContain('[AUTHORITY DENIED]');
  });

  it('caps system-initiated runs at write impact', () => {
    expect(SYSTEM_INITIATED_IMPACT_CEILING).toBe('write');
  });
});

describe('P0.4 — bounded resources', () => {
  it('stops at the token budget and reports it', async () => {
    const agent = new AgentInstance(makeRole({ tools: ['file-ops'] }));
    // Each turn bills 60 tokens; a 100-token budget allows one turn, then the
    // pre-call check trips.
    const { llm, calls } = scriptedLLM(
      Array.from({ length: 5 }, () => ({
        content: '',
        tool_calls: [{ id: 'c', name: 'write_file', arguments: {} }],
        finish_reason: 'tool_use',
        usage: { input_tokens: 30, output_tokens: 30 },
      })) as Partial<LLMResponse>[],
    );

    const result = await runSubAgent({
      agent,
      task: 'loop forever',
      context: '',
      llmManager: llm,
      toolRegistry: registryWith('write_file', 'file-ops'),
      tokenBudget: 100,
    });

    expect(result.terminationReason).toBe('token_budget');
    expect(result.success).toBe(false);
    expect(calls()).toBe(2); // 2 turns = 120 tokens, then the check trips
  });

  it('defaults the budget to the agent max_token_budget', async () => {
    const agent = new AgentInstance(makeRole({ tools: ['file-ops'] }), {
      authority: { max_token_budget: 100 } as never,
    });
    const { llm } = scriptedLLM(
      Array.from({ length: 5 }, () => ({
        content: '',
        tool_calls: [{ id: 'c', name: 'write_file', arguments: {} }],
        finish_reason: 'tool_use',
        usage: { input_tokens: 30, output_tokens: 30 },
      })) as Partial<LLMResponse>[],
    );

    const result = await runSubAgent({
      agent,
      task: 'loop forever',
      context: '',
      llmManager: llm,
      toolRegistry: registryWith('write_file', 'file-ops'),
    });

    expect(result.terminationReason).toBe('token_budget');
  });

  it('enforces the global concurrency cap', () => {
    const manager = new AgentTaskManager({ maxConcurrent: 1 });
    // A never-resolving LLM keeps the first task in `running`.
    const stuck = { chatTier: () => new Promise<LLMResponse>(() => {}) } as unknown as LLMManager;

    manager.launch({
      agent: new AgentInstance(makeRole()),
      task: 'first',
      context: '',
      llmManager: stuck,
      toolRegistry: new ToolRegistry(),
      initiator: 'user',
    });
    expect(manager.runningCount()).toBe(1);

    expect(() =>
      manager.launch({
        agent: new AgentInstance(makeRole()),
        task: 'second',
        context: '',
        llmManager: stuck,
        toolRegistry: new ToolRegistry(),
        initiator: 'user',
      }),
    ).toThrow(TaskCapacityError);

    manager.cancelAll();
  });

  it('cancels a running task and reports cancelled, not completed', async () => {
    const manager = new AgentTaskManager({ maxConcurrent: 2 });
    // Resolves on the next microtask turn so cancel() lands between LLM calls.
    let turn = 0;
    const slow = {
      chatTier: async (): Promise<LLMResponse> => {
        turn++;
        await Bun.sleep(20);
        return {
          content: '',
          tool_calls: [{ id: `c${turn}`, name: 'write_file', arguments: {} }],
          finish_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        } as LLMResponse;
      },
    } as unknown as LLMManager;

    const settled = new Promise<AsyncTask>((resolve) => {
      const id = manager.launch({
        agent: new AgentInstance(makeRole({ tools: ['file-ops'] })),
        task: 'long job',
        context: '',
        llmManager: slow,
        toolRegistry: registryWith('write_file', 'file-ops'),
        initiator: 'user',
        onComplete: resolve,
      });
      setTimeout(() => {
        expect(manager.cancel(id)).toBe(true);
      }, 30);
    });

    const task = await settled;
    expect(task.status).toBe('cancelled');
    expect(task.result?.terminationReason).toBe('cancelled');
    expect(task.result?.success).toBe(false);
  });

  it('reports timeout distinctly from cancellation', async () => {
    const manager = new AgentTaskManager({ maxConcurrent: 2, taskTimeoutMs: 25 });
    const slow = {
      chatTier: async (): Promise<LLMResponse> => {
        await Bun.sleep(20);
        return {
          content: '',
          tool_calls: [{ id: 'c', name: 'write_file', arguments: {} }],
          finish_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        } as LLMResponse;
      },
    } as unknown as LLMManager;

    const task = await new Promise<AsyncTask>((resolve) => {
      manager.launch({
        agent: new AgentInstance(makeRole({ tools: ['file-ops'] })),
        task: 'long job',
        context: '',
        llmManager: slow,
        toolRegistry: registryWith('write_file', 'file-ops'),
        initiator: 'user',
        onComplete: resolve,
      });
    });

    expect(task.result?.terminationReason).toBe('timeout');
  });

  it('frees the concurrency slot once a task settles', async () => {
    const manager = new AgentTaskManager({ maxConcurrent: 1 });
    const { llm } = scriptedLLM([]);

    await new Promise<AsyncTask>((resolve) => {
      manager.launch({
        agent: new AgentInstance(makeRole()),
        task: 'quick',
        context: '',
        llmManager: llm,
        toolRegistry: new ToolRegistry(),
        initiator: 'user',
        onComplete: resolve,
      });
    });

    expect(manager.runningCount()).toBe(0);
    expect(() =>
      manager.launch({
        agent: new AgentInstance(makeRole()),
        task: 'next',
        context: '',
        llmManager: scriptedLLM([]).llm,
        toolRegistry: new ToolRegistry(),
        initiator: 'user',
      }),
    ).not.toThrow();
  });
});
