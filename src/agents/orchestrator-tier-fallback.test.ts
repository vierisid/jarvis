import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { AgentOrchestrator } from './orchestrator.ts';
import { LLMManager } from '../llm/manager.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { LLMProviderError } from '../llm/provider.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';

const ROLE = {
  id: 'personal-assistant',
  name: 'PA',
  authority_level: 5,
  tools: [],
  sub_roles: [],
} as unknown as RoleDefinition;

/**
 * A model that cannot accept images. The 400 it returns is a `bad_request`
 * that does not name model *availability*, so LLMManager deliberately will
 * not fail it over to another provider — which is exactly why streamMessage
 * needs an explicit fallback tier.
 */
class BlindProvider implements LLMProvider {
  name = 'blind';
  calls = 0;
  async chat(): Promise<LLMResponse> { throw new Error('not used'); }
  async *stream(): AsyncIterable<LLMStreamEvent> {
    this.calls++;
    throw new LLMProviderError('400 this model does not support image input', 'bad_request');
    // eslint-disable-next-line no-unreachable
    yield { type: 'done', response: { content: '', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'blind', finish_reason: 'stop' } };
  }
  async listModels(): Promise<string[]> { return ['blind']; }
}

/** Fails only after it has already streamed prose. */
class FlakyMidStreamProvider implements LLMProvider {
  name = 'blind';
  calls = 0;
  async chat(): Promise<LLMResponse> { throw new Error('not used'); }
  async *stream(): AsyncIterable<LLMStreamEvent> {
    this.calls++;
    yield { type: 'text', text: 'I can see that ' };
    throw new LLMProviderError('400 this model does not support image input', 'bad_request');
  }
  async listModels(): Promise<string[]> { return ['blind']; }
}

class CapableProvider implements LLMProvider {
  name = 'capable';
  calls = 0;
  async chat(): Promise<LLMResponse> {
    return { content: 'a screenshot of a terminal', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'capable', finish_reason: 'stop' };
  }
  async *stream(): AsyncIterable<LLMStreamEvent> {
    this.calls++;
    const response = await this.chat();
    yield { type: 'text', text: response.content };
    yield { type: 'done', response };
  }
  async listModels(): Promise<string[]> { return ['capable']; }
}

function makeOrchestrator(conv: LLMProvider, task: LLMProvider): AgentOrchestrator {
  const manager = new LLMManager();
  manager.registerProvider(conv);
  manager.registerProvider(task);
  manager.setTierMap({
    conversation: { provider: conv.name },
    medium: { provider: task.name },
  });

  const orch = new AgentOrchestrator();
  orch.setToolRegistry(new ToolRegistry());
  orch.setLLMManager(manager);
  orch.createPrimary(ROLE);
  return orch;
}

const IMAGE = [
  { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'aGk=' } },
  { type: 'text' as const, text: 'what is on my screen?' },
];

async function drain(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('AgentOrchestrator.streamMessage tier fallback', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  test('falls back to the task tier when the conv tier cannot see', async () => {
    const conv = new BlindProvider();
    const task = new CapableProvider();
    const orch = makeOrchestrator(conv, task);

    const events = await drain(
      orch.streamMessage('system', IMAGE, 'conversation', 'chat_orchestrator_image', 'medium'),
    );

    expect(events.some(e => e.type === 'error')).toBe(false);
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('');
    expect(text).toContain('a screenshot of a terminal');
    expect(conv.calls).toBeGreaterThan(0);
    expect(task.calls).toBe(1);
  });

  test('without a fallback tier the turn dead-ends', async () => {
    // The conversation tier has an empty fallback chain, so there is nowhere
    // for the manager to go on its own.
    const conv = new BlindProvider();
    const task = new CapableProvider();
    const orch = makeOrchestrator(conv, task);

    const events = await drain(
      orch.streamMessage('system', IMAGE, 'conversation', 'chat_orchestrator_image'),
    );

    expect(events.some(e => e.type === 'error')).toBe(true);
    expect(task.calls).toBe(0);
  });

  test('a failure after output has started is surfaced, not retried', async () => {
    const conv = new FlakyMidStreamProvider();
    const task = new CapableProvider();
    const orch = makeOrchestrator(conv, task);

    const events = await drain(
      orch.streamMessage('system', IMAGE, 'conversation', 'chat_orchestrator_image', 'medium'),
    );

    expect(events.some(e => e.type === 'error')).toBe(true);
    // Restarting here would silently replace a partial answer the user already saw.
    expect(task.calls).toBe(0);
  });

  test('classic mode is untouched — no tier or fallback given', async () => {
    const conv = new BlindProvider();
    const task = new CapableProvider();
    const orch = makeOrchestrator(conv, task);

    const events = await drain(orch.streamMessage('system', 'hello'));
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('');
    expect(text).toContain('a screenshot of a terminal');
    expect(conv.calls).toBe(0);
  });
});
