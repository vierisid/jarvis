import { describe, expect, it, beforeEach } from 'bun:test';
import { LLMManager } from '../../llm/manager.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent, LLMToolCall } from '../../llm/provider.ts';
import { TaskRegistry } from './task-registry.ts';
import { TaskDispatcher } from './task-dispatcher.ts';
import { ConvOrchestrator } from './conv-orchestrator.ts';

/**
 * Mock provider that returns canned responses by call order. Lets us simulate
 * the conv tier emitting delegate tool calls and the task tier returning
 * text results.
 */
class MockProvider implements LLMProvider {
  name = 'mock';
  private queue: LLMResponse[] = [];
  constructor(responses: LLMResponse[]) {
    this.queue = [...responses];
  }
  async chat(_messages: LLMMessage[], _opts?: LLMOptions): Promise<LLMResponse> {
    const next = this.queue.shift();
    if (!next) {
      return {
        content: 'fallback',
        tool_calls: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'mock',
        finish_reason: 'stop',
      };
    }
    return next;
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamEvent> {
    throw new Error('stream not used in these tests');
  }
  async listModels(): Promise<string[]> { return ['mock']; }
}

function textResponse(content: string): LLMResponse {
  return {
    content,
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'mock',
    finish_reason: 'stop',
  };
}

function toolCallResponse(name: string, args: Record<string, unknown>): LLMResponse {
  const call: LLMToolCall = { id: `call_${Math.random()}`, name, arguments: args };
  return {
    content: '',
    tool_calls: [call],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'mock',
    finish_reason: 'tool_use',
  };
}

function makeManager(provider: LLMProvider): LLMManager {
  const m = new LLMManager();
  m.registerProvider(provider);
  m.setTierMap({
    conversation: { provider: provider.name },
    medium: { provider: provider.name },
    low: { provider: provider.name },
  });
  return m;
}

describe('ConvOrchestrator', () => {
  let registry: TaskRegistry;
  beforeEach(() => {
    registry = new TaskRegistry();
  });

  it('answers directly when conv LLM emits text without tool calls', async () => {
    const provider = new MockProvider([textResponse('Hello there!')]);
    const llm = makeManager(provider);
    // Test runner: just calls the mock LLM directly. In production the
    // runner routes through the primary orchestrator with all tools.
    const runner = async ({ tier, subsystem, originalMessage }: { tier: 'low' | 'medium' | 'high'; subsystem: string; template: string; intent: string; originalMessage: string; signal: AbortSignal; history?: unknown[] }) => {
      const r = await llm.chatTier(tier, subsystem, [{ role: 'user', content: originalMessage }]);
      return { kind: 'completed' as const, text: r.content, conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    const result = await conv.processTurn('Hi', {});
    expect(result.text).toBe('Hello there!');
    expect(result.tasksRun).toEqual([]);
  });

  it('routes through delegate then verbalizes result', async () => {
    const provider = new MockProvider([
      // First conv call: emit delegate tool call
      toolCallResponse('delegate', {
        tier: 'medium',
        template: 'research',
        intent: 'Find the capital of Italy',
      }),
      // Task tier call: returns the answer
      textResponse('The capital of Italy is Rome.'),
      // Second conv call: verbalize the result (text only, no tool calls)
      textResponse('Rome is the capital of Italy.'),
    ]);
    const llm = makeManager(provider);
    // Test runner: just calls the mock LLM directly. In production the
    // runner routes through the primary orchestrator with all tools.
    const runner = async ({ tier, subsystem, originalMessage }: { tier: 'low' | 'medium' | 'high'; subsystem: string; template: string; intent: string; originalMessage: string; signal: AbortSignal; history?: unknown[] }) => {
      const r = await llm.chatTier(tier, subsystem, [{ role: 'user', content: originalMessage }]);
      return { kind: 'completed' as const, text: r.content, conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    const result = await conv.processTurn('What is the capital of Italy?', {});
    expect(result.text).toBe('Rome is the capital of Italy.');
    expect(result.tasksRun).toHaveLength(1);

    // The task should be completed in the registry
    const taskId = result.tasksRun[0]!;
    expect(registry.get(taskId)?.status).toBe('completed');
  });

  it('handles check_task on an unknown task gracefully', async () => {
    const provider = new MockProvider([
      toolCallResponse('check_task', { task_id: 'nonexistent' }),
      textResponse('That task isn\'t around any more.'),
    ]);
    const llm = makeManager(provider);
    // Test runner: just calls the mock LLM directly. In production the
    // runner routes through the primary orchestrator with all tools.
    const runner = async ({ tier, subsystem, originalMessage }: { tier: 'low' | 'medium' | 'high'; subsystem: string; template: string; intent: string; originalMessage: string; signal: AbortSignal; history?: unknown[] }) => {
      const r = await llm.chatTier(tier, subsystem, [{ role: 'user', content: originalMessage }]);
      return { kind: 'completed' as const, text: r.content, conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot.');

    const result = await conv.processTurn('How is that task going?', {});
    expect(result.text).toContain('isn\'t around');
  });

  it('hits the iteration cap and bails gracefully', async () => {
    // Conv LLM keeps emitting delegate calls forever - dispatcher returns
    // failed envelopes (no medium-tier responses queued).
    const responses: LLMResponse[] = [];
    for (let i = 0; i < 20; i++) {
      responses.push(toolCallResponse('delegate', { tier: 'medium', template: 'general', intent: 'loop' }));
    }
    const provider = new MockProvider(responses);
    const llm = makeManager(provider);
    // Test runner: just calls the mock LLM directly. In production the
    // runner routes through the primary orchestrator with all tools.
    const runner = async ({ tier, subsystem, originalMessage }: { tier: 'low' | 'medium' | 'high'; subsystem: string; template: string; intent: string; originalMessage: string; signal: AbortSignal; history?: unknown[] }) => {
      const r = await llm.chatTier(tier, subsystem, [{ role: 'user', content: originalMessage }]);
      return { kind: 'completed' as const, text: r.content, conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot.');

    const result = await conv.processTurn('stuck', {});
    expect(result.text).toContain('stuck routing');
  });
});
