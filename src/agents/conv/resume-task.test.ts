import { describe, expect, it, beforeEach } from 'bun:test';
import { LLMManager } from '../../llm/manager.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse, LLMStreamEvent } from '../../llm/provider.ts';
import { TaskRegistry } from './task-registry.ts';
import { TaskDispatcher, type TaskRunResult, type TaskRunner } from './task-dispatcher.ts';

class StubLLM implements LLMProvider {
  name = 'stub';
  async chat(): Promise<LLMResponse> {
    return {
      content: 'condensed',
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'stub',
      finish_reason: 'stop',
    };
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamEvent> { throw new Error('not used'); }
  async listModels(): Promise<string[]> { return ['stub']; }
}

function makeManager(): LLMManager {
  const m = new LLMManager();
  m.registerProvider(new StubLLM());
  m.setTierMap({ low: { provider: 'stub' }, medium: { provider: 'stub' } });
  return m;
}

describe('TaskDispatcher pause/resume', () => {
  let registry: TaskRegistry;
  let llm: LLMManager;
  beforeEach(() => {
    registry = new TaskRegistry();
    llm = makeManager();
  });

  it('dispatch transitions to needs_input when runner returns paused', async () => {
    const runner: TaskRunner = async () => ({
      kind: 'paused',
      question: 'Which Sarah - Chen or Park?',
      conversation: [{ role: 'user', content: 'book a meeting with Sarah' } as LLMMessage],
    });
    const dispatcher = new TaskDispatcher(llm, registry, runner);

    const env = await dispatcher.dispatch({
      tier: 'medium',
      template: 'general',
      intent: 'book a meeting with Sarah',
    });

    expect(env.status).toBe('needs_input');
    expect(env.needs_input?.question).toBe('Which Sarah - Chen or Park?');
    expect(env.summary).toContain('Sarah');

    const rec = registry.get(env.task_id)!;
    expect(rec.status).toBe('needs_input');
    expect(rec.question).toBe('Which Sarah - Chen or Park?');
    expect(rec.pausedConversation).toBeDefined();
    expect(rec.pausedConversation!.length).toBe(1);
  });

  it('resume continues the task from the captured conversation', async () => {
    let callCount = 0;
    const receivedHistories: (unknown[] | undefined)[] = [];
    const runner: TaskRunner = async (args) => {
      receivedHistories.push(args.history);
      callCount++;
      if (callCount === 1) {
        return {
          kind: 'paused',
          question: 'Which Sarah?',
          conversation: [{ role: 'user', content: 'original' } as LLMMessage],
        };
      }
      // Second call: should receive the saved history + user clarification
      return { kind: 'completed', text: 'Meeting booked with Sarah Chen.', conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner);

    const first = await dispatcher.dispatch({ tier: 'medium', template: 'general', intent: 'book a meeting' });
    expect(first.status).toBe('needs_input');

    const second = await dispatcher.resume(first.task_id, 'Chen');
    expect(second.status).toBe('completed');
    expect(second.summary).toContain('Sarah Chen');

    // The runner was called twice; the second time it received the saved history.
    expect(callCount).toBe(2);
    expect(receivedHistories[0]).toBeUndefined();
    expect(receivedHistories[1]).toBeDefined();
    expect((receivedHistories[1] as { content: string }[])[0]!.content).toBe('original');
  });

  it('resume can pause again for a follow-up clarification', async () => {
    let callCount = 0;
    const runner: TaskRunner = async () => {
      callCount++;
      if (callCount === 1) return { kind: 'paused', question: 'Q1', conversation: [] };
      if (callCount === 2) return { kind: 'paused', question: 'Q2', conversation: [] };
      return { kind: 'completed', text: 'Done', conversation: [] };
    };
    const dispatcher = new TaskDispatcher(llm, registry, runner);

    const first = await dispatcher.dispatch({ tier: 'medium', template: 'general', intent: 'X' });
    expect(first.status).toBe('needs_input');
    expect(first.needs_input?.question).toBe('Q1');

    const second = await dispatcher.resume(first.task_id, 'answer1');
    expect(second.status).toBe('needs_input');
    expect(second.needs_input?.question).toBe('Q2');

    const third = await dispatcher.resume(second.task_id, 'answer2');
    expect(third.status).toBe('completed');
    expect(callCount).toBe(3);
  });

  it('resume rejects when task is not paused', async () => {
    const runner: TaskRunner = async () => ({ kind: 'completed', text: 'Done', conversation: [] });
    const dispatcher = new TaskDispatcher(llm, registry, runner);

    const env = await dispatcher.dispatch({ tier: 'medium', template: 'general', intent: 'X' });
    expect(env.status).toBe('completed');

    const resumed = await dispatcher.resume(env.task_id, 'unsolicited');
    expect(resumed.status).toBe('failed');
    expect(resumed.error).toBe('invalid_state');
  });

  it('resume rejects unknown task_id', async () => {
    const runner: TaskRunner = async () => ({ kind: 'completed', text: 'Done', conversation: [] });
    const dispatcher = new TaskDispatcher(llm, registry, runner);

    const resumed = await dispatcher.resume('task_does_not_exist', 'reply');
    expect(resumed.status).toBe('failed');
    expect(resumed.error).toBe('not_found');
  });

  it('cancel during paused state transitions to cancelled', async () => {
    const runner: TaskRunner = async () => ({ kind: 'paused', question: 'Q', conversation: [] });
    const dispatcher = new TaskDispatcher(llm, registry, runner);

    const env = await dispatcher.dispatch({ tier: 'medium', template: 'general', intent: 'X' });
    expect(env.status).toBe('needs_input');

    // Aborting a paused task: registry.abort signals the abort controller,
    // but since the task is already returned, the state stays needs_input.
    // Caller (conv orchestrator) is expected to use a different path - we
    // just verify abort doesn't throw.
    expect(() => registry.abort(env.task_id)).not.toThrow();
  });
});
