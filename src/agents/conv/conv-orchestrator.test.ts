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
/** Deliberately small and not aligned to any token boundary. */
const CHUNK_SIZE = 4;

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
  /**
   * Emits content in small pieces the way a real provider does. Streaming a
   * whole response as one text event would hide anything that depends on where
   * chunk boundaries fall — which is exactly where serialized tool calls leak.
   */
  async *stream(messages: LLMMessage[], opts?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    const response = await this.chat(messages, opts);
    for (let index = 0; index < response.content.length; index += CHUNK_SIZE) {
      yield { type: 'text', text: response.content.slice(index, index + CHUNK_SIZE) };
    }
    for (const toolCall of response.tool_calls) {
      yield { type: 'tool_call', tool_call: toolCall };
    }
    yield { type: 'done', response };
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

function toolCallResponse(name: string, args: Record<string, unknown>, content = ''): LLMResponse {
  const call: LLMToolCall = { id: `call_${Math.random()}`, name, arguments: args };
  return {
    content,
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
    expect(result.text).toBe(
      'I’m looking into that now and I’ll report back.\nRome is the capital of Italy.',
    );
    expect(result.tasksRun).toHaveLength(1);

    // The task should be completed in the registry
    const taskId = result.tasksRun[0]!;
    expect(registry.get(taskId)?.status).toBe('completed');
  });

  it('hides and executes a delegate call serialized as fallback text', async () => {
    const provider = new MockProvider([
      textResponse('FALLBACK_OK/delegate{"intent":"Provide friendly greeting.","template":"general","tier":"medium"} I’ll handle that.'),
      textResponse('Hi again!'),
      textResponse('Hi again, how is your day going?'),
    ]);
    const llm = makeManager(provider);
    const runner = async ({ tier, subsystem, originalMessage }: { tier: 'low' | 'medium' | 'high'; subsystem: string; template: string; intent: string; originalMessage: string; signal: AbortSignal; history?: unknown[] }) => {
      const r = await llm.chatTier(tier, subsystem, [{ role: 'user', content: originalMessage }]);
      return { kind: 'completed' as const, text: r.content, conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    const result = await conv.processTurn('Hello', {});
    expect(result.text).toBe('I’ll handle that.\nHi again, how is your day going?');
    expect(result.text).not.toContain('FALLBACK_OK');
    expect(result.text).not.toContain('/delegate');
    expect(result.text).not.toContain('"template"');
    expect(result.tasksRun).toHaveLength(1);
  });

  it('hides and executes a parenthesized delegate call', async () => {
    const provider = new MockProvider([
      textResponse('(delegate {"intent":"Check the last email in my inbox","template":"research","tier":"medium"}) Let me check your inbox now.'),
      textResponse('Your latest email is from Alice.'),
      textResponse('Your latest email is from Alice.'),
    ]);
    const llm = makeManager(provider);
    const runner = async ({ tier, subsystem, originalMessage }: { tier: 'low' | 'medium' | 'high'; subsystem: string; template: string; intent: string; originalMessage: string; signal: AbortSignal; history?: unknown[] }) => {
      const r = await llm.chatTier(tier, subsystem, [{ role: 'user', content: originalMessage }]);
      return { kind: 'completed' as const, text: r.content, conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    const result = await conv.processTurn('Check my last email', {});
    expect(result.text).toBe('Let me check your inbox now.\nYour latest email is from Alice.');
    expect(result.text).not.toContain('(delegate');
    expect(result.text).not.toContain('"template"');
    expect(result.tasksRun).toHaveLength(1);
  });

  it('hides a serialized delegate call the model prints after its prose', async () => {
    // The prompt asks the model to acknowledge first, so the leaked call
    // usually arrives *after* prose — the position a prefix-only guard misses.
    const provider = new MockProvider([
      textResponse('Sure, let me look into that. /delegate{"tier":"medium","template":"research","intent":"Check the inbox"}'),
      textResponse('Your latest email is from Alice.'),
      textResponse('Your latest email is from Alice.'),
    ]);
    const llm = makeManager(provider);
    const runner = async ({ tier, subsystem, originalMessage }: { tier: 'low' | 'medium' | 'high'; subsystem: string; originalMessage: string }) => {
      const r = await llm.chatTier(tier, subsystem, [{ role: 'user', content: originalMessage }]);
      return { kind: 'completed' as const, text: r.content, conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    const spoken: string[] = [];
    for await (const event of conv.streamTurn('Check my email', {})) {
      if (event.type === 'text') spoken.push(event.text);
    }
    const streamed = spoken.join('');
    expect(streamed).not.toContain('/delegate');
    expect(streamed).not.toContain('"template"');
    expect(streamed).not.toContain('{');
    expect(streamed).toBe('Sure, let me look into that. Your latest email is from Alice.');
  });

  it('marks the acknowledgment segment complete before delegating', async () => {
    const provider = new MockProvider([
      textResponse('Let me check that. /delegate{"tier":"medium","template":"research","intent":"x"}'),
      textResponse('All done.'),
      textResponse('All done.'),
    ]);
    const llm = makeManager(provider);
    let dispatched = false;
    const runner = async () => {
      dispatched = true;
      return { kind: 'completed' as const, text: 'All done.', conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    let sawSegmentEnd = false;
    for await (const event of conv.streamTurn('Check it', {})) {
      if (event.type === 'text' && event.segmentEnd) {
        // The signal has to arrive while the task tier is still idle, or TTS
        // gains nothing over waiting for the answer.
        expect(dispatched).toBe(false);
        sawSegmentEnd = true;
      }
    }
    expect(sawSegmentEnd).toBe(true);
  });

  it('separates the routing-failure message from the preceding acknowledgment', async () => {
    // Every turn delegates and never settles, so the loop runs to its cap.
    const responses = Array.from({ length: 40 }, (_, index) => toolCallResponse(
      'delegate',
      { tier: 'medium', template: 'research', intent: `step ${index}` },
      'Working on it.',
    ));
    const provider = new MockProvider(responses);
    const llm = makeManager(provider);
    const runner = async () => ({ kind: 'completed' as const, text: 'partial', conversation: [] });
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    const result = await conv.processTurn('go', {});
    expect(result.text).toContain('I got stuck routing your request.');
    expect(result.text).not.toContain('it.I got stuck');
    expect(result.text.endsWith('\nI got stuck routing your request. Could you rephrase or try again?')).toBe(true);
  });

  it('surfaces a fallback acknowledgment before a silent delegated task starts', async () => {
    const provider = new MockProvider([
      toolCallResponse('delegate', {
        tier: 'medium',
        template: 'code',
        intent: 'Inspect the failing route',
      }),
    ]);
    const llm = makeManager(provider);
    let runnerStarted = false;
    const runner = async () => {
      runnerStarted = true;
      return { kind: 'completed' as const, text: 'done', conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    const stream = conv.streamTurn('Fix the route', {});
    const first = await stream.next();
    expect(first.value).toMatchObject({
      type: 'text',
      text: 'I’m checking the relevant code now.',
    });
    expect(runnerStarted).toBe(false);
    await stream.return(undefined);
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

  it('splits the system prompt into a cache-marked static prefix and a dynamic suffix', async () => {
    // Capture the messages the conv tier actually sends to the LLM.
    const captured: LLMMessage[][] = [];
    class CapturingProvider extends MockProvider {
      override async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
        captured.push(messages);
        return super.chat(messages, opts);
      }
    }
    const provider = new CapturingProvider([textResponse('Hi!'), textResponse('Hello again!')]);
    const llm = makeManager(provider);
    const runner = async ({ tier, subsystem, originalMessage }: { tier: 'low' | 'medium' | 'high'; subsystem: string; template: string; intent: string; originalMessage: string; signal: AbortSignal; history?: unknown[] }) => {
      const r = await llm.chatTier(tier, subsystem, [{ role: 'user', content: originalMessage }]);
      return { kind: 'completed' as const, text: r.content, conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    await conv.processTurn('Hi', { userIdentity: 'Name: Alice', ambientFacts: 'Weather: sunny' });
    await conv.processTurn('Hi again', { userIdentity: 'Name: Alice', ambientFacts: 'Weather: rainy' });

    expect(captured).toHaveLength(2);
    for (const messages of captured) {
      // message[0]: static system prompt, marked as cache boundary
      expect(messages[0]!.role).toBe('system');
      expect(messages[0]!.cache).toBe(true);
      const staticText = String(messages[0]!.content);
      expect(staticText).toContain('TestBot persona.');
      expect(staticText).not.toContain('Alice');
      expect(staticText).not.toContain('Weather');
      // message[1]: dynamic system prompt, NOT cache-marked
      expect(messages[1]!.role).toBe('system');
      expect(messages[1]!.cache).toBeUndefined();
      const dynamicText = String(messages[1]!.content);
      expect(dynamicText).toContain('Alice');
      expect(dynamicText).toContain('Weather');
    }
    // The static prefix must be byte-identical across turns even though the
    // dynamic context changed - that's what makes it cacheable.
    expect(captured[0]![0]!.content).toBe(captured[1]![0]!.content);
    expect(captured[0]![1]!.content).not.toBe(captured[1]![1]!.content);
  });

  it('renders the user profile as a cache-marked system block between static and dynamic', async () => {
    const captured: LLMMessage[][] = [];
    class CapturingProvider extends MockProvider {
      override async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
        captured.push(messages);
        return super.chat(messages, opts);
      }
    }
    const provider = new CapturingProvider([textResponse('Hi!'), textResponse('Hello again!')]);
    const llm = makeManager(provider);
    const runner = async () => ({ kind: 'completed' as const, text: '', conversation: [] });
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot persona.');

    const profileBlock = '# User Profile\n- Preferred name: Alice';
    await conv.processTurn('Hi', { userIdentity: 'Name: Alice', userProfile: profileBlock, ambientFacts: 'Weather: sunny' });
    await conv.processTurn('Hi again', { userIdentity: 'Name: Alice', userProfile: profileBlock, ambientFacts: 'Weather: rainy' });

    expect(captured).toHaveLength(2);
    for (const messages of captured) {
      // message[0]: static persona, cache-marked; profile stays out of it
      expect(messages[0]!.role).toBe('system');
      expect(messages[0]!.cache).toBe(true);
      expect(String(messages[0]!.content)).not.toContain('User Profile');
      // message[1]: profile block, cache-marked (provider puts the single
      // breakpoint on the LAST marked block, caching persona + profile)
      expect(messages[1]!.role).toBe('system');
      expect(messages[1]!.cache).toBe(true);
      expect(String(messages[1]!.content)).toBe(profileBlock);
      // message[2]: dynamic system prompt, NOT cache-marked
      expect(messages[2]!.role).toBe('system');
      expect(messages[2]!.cache).toBeUndefined();
      expect(String(messages[2]!.content)).toContain('Weather');
    }
    // Cached prefix (persona + profile) must be byte-identical across turns
    // while the dynamic block changes.
    expect(captured[0]![0]!.content).toBe(captured[1]![0]!.content);
    expect(captured[0]![1]!.content).toBe(captured[1]![1]!.content);
    expect(captured[0]![2]!.content).not.toBe(captured[1]![2]!.content);
  });

  it('omits the profile block when userProfile is not provided', async () => {
    const captured: LLMMessage[][] = [];
    class CapturingProvider extends MockProvider {
      override async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
        captured.push(messages);
        return super.chat(messages, opts);
      }
    }
    const provider = new CapturingProvider([textResponse('Hi!')]);
    const llm = makeManager(provider);
    const runner = async () => ({ kind: 'completed' as const, text: '', conversation: [] });
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot.');

    await conv.processTurn('Hi', { userIdentity: 'Name: Alice' });
    const messages = captured[0]!;
    // No profile block: the dynamic system prompt sits directly after the
    // static persona, and it alone carries the identity.
    expect(messages[0]!.cache).toBe(true);
    expect(messages[1]!.role).toBe('system');
    expect(messages[1]!.cache).toBeUndefined();
    expect(String(messages[1]!.content)).toContain('Alice');
    expect(messages[2]!.role).toBe('user');
    for (const m of messages) {
      expect(String(m.content)).not.toContain('User Profile');
    }
  });

  it('omits the dynamic system message entirely when there is no dynamic context', async () => {
    const captured: LLMMessage[][] = [];
    class CapturingProvider extends MockProvider {
      override async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
        captured.push(messages);
        return super.chat(messages, opts);
      }
    }
    const provider = new CapturingProvider([textResponse('Hi!')]);
    const llm = makeManager(provider);
    const runner = async () => ({ kind: 'completed' as const, text: '', conversation: [] });
    const dispatcher = new TaskDispatcher(llm, registry, runner as never);
    const conv = new ConvOrchestrator(llm, registry, dispatcher, 'TestBot.');

    await conv.processTurn('Hi', {});
    const messages = captured[0]!;
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user'); // no empty dynamic system message
  });
});
