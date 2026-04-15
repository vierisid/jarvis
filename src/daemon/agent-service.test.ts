import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentService } from './agent-service.ts';
import { DEFAULT_CONFIG } from '../config/types.ts';
import { addMessage, getOrCreateConversation } from '../vault/conversations.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';

class RecordingProvider implements LLMProvider {
  name = 'recording';
  calls: LLMMessage[][] = [];
  streamCalls: LLMMessage[][] = [];

  async chat(messages: LLMMessage[], _options?: LLMOptions): Promise<LLMResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    return {
      content: 'Got it.',
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'recording',
      finish_reason: 'stop',
    };
  }

  async *stream(messages: LLMMessage[], _options?: LLMOptions): AsyncIterable<LLMStreamEvent> {
    this.streamCalls.push(messages.map((message) => ({ ...message })));
    yield { type: 'text', text: 'Got it.' };
    yield {
      type: 'done',
      response: {
        content: 'Got it.',
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'recording',
        finish_reason: 'stop',
      },
    };
  }

  async listModels(): Promise<string[]> {
    return ['recording'];
  }
}

describe('AgentService conversation context', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(async () => {
    closeDb();
  });

  test('rehydrates recent channel conversation before handling the next message', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.llm = {
      primary: 'recording',
      fallback: [],
    };

    const service = new AgentService(config);
    await service.start();
    const provider = new RecordingProvider();
    service.getLLMManager().registerProvider(provider);
    service.getLLMManager().setPrimary('recording');

    const conversation = getOrCreateConversation('websocket');
    addMessage(conversation.id, { role: 'user', content: 'Help me plan a trip to Tokyo.' });
    addMessage(conversation.id, { role: 'assistant', content: 'Sure — what dates are you considering?' });
    addMessage(conversation.id, { role: 'user', content: 'Next April.' });

    const primary = service.getOrchestrator().getPrimary();
    primary?.setMessages([]);

    const response = await service.handleMessage('Next April.', 'websocket');

    expect(response).toBe('Got it.');
    expect(primary?.getMessages()).toEqual([
      { role: 'user', content: 'Help me plan a trip to Tokyo.' },
      { role: 'assistant', content: 'Sure — what dates are you considering?' },
      { role: 'user', content: 'Next April.' },
      { role: 'assistant', content: 'Got it.' },
    ]);
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls[0]?.slice(1)).toEqual([
      { role: 'user', content: 'Help me plan a trip to Tokyo.' },
      { role: 'assistant', content: 'Sure — what dates are you considering?' },
      { role: 'user', content: 'Next April.' },
    ]);

    await service.stop();
  });

  test('rehydrates recent channel conversation before streaming the next message', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.llm = {
      primary: 'recording',
      fallback: [],
    };

    const service = new AgentService(config);
    await service.start();
    const provider = new RecordingProvider();
    service.getLLMManager().registerProvider(provider);
    service.getLLMManager().setPrimary('recording');

    const conversation = getOrCreateConversation('websocket');
    addMessage(conversation.id, { role: 'user', content: 'Help me plan a trip to Tokyo.' });
    addMessage(conversation.id, { role: 'assistant', content: 'Sure — what dates are you considering?' });
    addMessage(conversation.id, { role: 'user', content: 'Next April.' });

    const primary = service.getOrchestrator().getPrimary();
    primary?.setMessages([]);

    const { stream, onComplete } = service.streamMessage('Next April.', 'websocket');
    const events: LLMStreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await onComplete('Got it.');

    expect(events).toEqual([
      { type: 'text', text: 'Got it.' },
      {
        type: 'done',
        response: {
          content: 'Got it.',
          tool_calls: [],
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'recording',
          finish_reason: 'stop',
        },
      },
    ]);
    expect(primary?.getMessages()).toEqual([
      { role: 'user', content: 'Help me plan a trip to Tokyo.' },
      { role: 'assistant', content: 'Sure — what dates are you considering?' },
      { role: 'user', content: 'Next April.' },
      { role: 'assistant', content: 'Got it.' },
    ]);
    expect(provider.streamCalls.length).toBeGreaterThan(0);
    expect(provider.streamCalls[0]?.slice(1)).toEqual([
      { role: 'user', content: 'Help me plan a trip to Tokyo.' },
      { role: 'assistant', content: 'Sure — what dates are you considering?' },
      { role: 'user', content: 'Next April.' },
    ]);

    await service.stop();
  });
});
