import { describe, expect, test } from 'bun:test';
import type { LLMStreamEvent } from '../llm/provider.ts';
import type { WebSocketServer, WSMessage } from './websocket.ts';
import { StreamRelay } from './streaming.ts';

function doneEvent(content: string): LLMStreamEvent {
  return {
    type: 'done',
    response: {
      content,
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'test',
      finish_reason: 'stop',
    },
  };
}

describe('StreamRelay cancellation', () => {
  test('stops relaying late chunks and does not emit done after abort', async () => {
    const messages: WSMessage[] = [];
    const controller = new AbortController();
    const server = {
      broadcast(message: WSMessage) {
        messages.push(message);
        if (
          message.type === 'stream'
          && typeof (message.payload as { text?: unknown } | undefined)?.text === 'string'
        ) {
          controller.abort('test');
        }
      },
    } as unknown as WebSocketServer;
    const relay = new StreamRelay(server);

    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text', text: 'first' };
      yield { type: 'text', text: ' late' };
      yield doneEvent('first late');
    }

    const text = await relay.relayStream(stream(), 'req-1', { signal: controller.signal });
    expect(text).toBe('first');
    expect(messages.map((message) => message.type)).toEqual(['stream']);
  });

  test('keeps the normal done lifecycle when not cancelled', async () => {
    const messages: WSMessage[] = [];
    const server = {
      broadcast(message: WSMessage) { messages.push(message); },
    } as unknown as WebSocketServer;
    const relay = new StreamRelay(server);

    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text', text: 'hello' };
      yield doneEvent('hello');
    }

    expect(await relay.relayStream(stream(), 'req-2')).toBe('hello');
    expect(messages.map((message) => message.type)).toEqual(['stream', 'status']);
  });
});

describe('StreamRelay progress narration', () => {
  test('starts UI/TTS immediately for a complete acknowledgment sentence', async () => {
    const messages: WSMessage[] = [];
    const sentences: string[] = [];
    let starts = 0;
    const server = {
      broadcast(message: WSMessage) { messages.push(message); },
    } as unknown as WebSocketServer;
    const relay = new StreamRelay(server);

    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text', text: 'I’m checking that now.' };
      // A slow tool would run here. The sentence callback must already have
      // fired instead of waiting for a later chunk or the done event.
      expect(starts).toBe(1);
      expect(sentences).toEqual(['I’m checking that now.']);
      yield doneEvent('I’m checking that now.');
    }

    await relay.relayStream(stream(), 'req-progress', {
      onTextStart: () => { starts++; },
      onSentence: (sentence) => sentences.push(sentence),
    });
    expect(starts).toBe(1);
    expect(sentences).toEqual(['I’m checking that now.']);
  });
});
