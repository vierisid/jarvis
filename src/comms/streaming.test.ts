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

function makeRelay() {
  const broadcasts: WSMessage[] = [];
  const server = {
    broadcast(message: WSMessage) { broadcasts.push(message); },
  } as unknown as WebSocketServer;
  return { relay: new StreamRelay(server), broadcasts };
}

/** Relay `chunks` as text events and collect the sentences handed to TTS. */
async function speak(chunks: LLMStreamEvent[]): Promise<string[]> {
  const { relay } = makeRelay();
  const sentences: string[] = [];
  async function* stream(): AsyncGenerator<LLMStreamEvent> {
    for (const chunk of chunks) yield chunk;
    yield doneEvent('');
  }
  await relay.relayStream(stream(), 'req', { onSentence: (s) => sentences.push(s) });
  return sentences;
}

function text(...parts: string[]): LLMStreamEvent[] {
  return parts.map((part) => ({ type: 'text', text: part }) as LLMStreamEvent);
}

describe('StreamRelay progress narration', () => {
  test('starts UI/TTS immediately for a segment the producer marked complete', async () => {
    const { relay } = makeRelay();
    const sentences: string[] = [];
    let starts = 0;

    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text', text: 'I’m checking that now.', segmentEnd: true };
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

  test('flushes a segment the model streamed in pieces', async () => {
    const { relay } = makeRelay();
    const sentences: string[] = [];

    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text', text: 'Let me' };
      yield { type: 'text', text: ' check that' };
      yield { type: 'text', text: ' for you.' };
      expect(sentences).toEqual([]);
      // segmentEnd-only event: signal without content.
      yield { type: 'text', text: '', segmentEnd: true };
      expect(sentences).toEqual(['Let me check that for you.']);
      yield doneEvent('Let me check that for you.');
    }

    const full = await relay.relayStream(stream(), 'req', {
      onSentence: (sentence) => sentences.push(sentence),
    });
    expect(sentences).toEqual(['Let me check that for you.']);
    // The empty signal event must not add anything to the response text.
    expect(full).toBe('Let me check that for you.');
  });

  test('an empty text event is not broadcast to clients', async () => {
    const { relay, broadcasts } = makeRelay();
    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text', text: 'Hi.' };
      yield { type: 'text', text: '', segmentEnd: true };
      yield doneEvent('Hi.');
    }
    await relay.relayStream(stream(), 'req');
    const streamChunks = broadcasts.filter((m) => m.type === 'stream');
    expect(streamChunks).toHaveLength(1);
    expect((streamChunks[0]?.payload as { text?: string })?.text).toBe('Hi.');
  });

  test('onTextStart does not fire for a signal-only event', async () => {
    const { relay } = makeRelay();
    let starts = 0;
    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text', text: '', segmentEnd: true };
      expect(starts).toBe(0);
      yield { type: 'text', text: 'Now there is text.' };
      yield doneEvent('Now there is text.');
    }
    await relay.relayStream(stream(), 'req', { onTextStart: () => { starts++; } });
    expect(starts).toBe(1);
  });
});

describe('StreamRelay sentence boundaries', () => {
  test('splits on a terminator followed by whitespace', async () => {
    expect(await speak(text('One sentence. ', 'And another. '))).toEqual([
      'One sentence.',
      'And another.',
    ]);
  });

  // A chunk boundary is not a sentence boundary: the buffer holds a partial
  // token stream, so a trailing "." may still be mid-word.
  test('does not split a decimal spanning chunks', async () => {
    expect(await speak(text('Version 1', '.', '5 is out now. '))).toEqual([
      'Version 1.5 is out now.',
    ]);
  });

  test('does not split a filename spanning chunks', async () => {
    expect(await speak(text('Check src/agents/progress', '.', 'ts for details. '))).toEqual([
      'Check src/agents/progress.ts for details.',
    ]);
  });

  test('does not split a price spanning chunks', async () => {
    expect(await speak(text('That costs $4', '.', '99 total. '))).toEqual([
      'That costs $4.99 total.',
    ]);
  });

  test('flushes the trailing sentence on done', async () => {
    const { relay } = makeRelay();
    const sentences: string[] = [];
    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text', text: 'No trailing space.' };
      yield doneEvent('No trailing space.');
    }
    await relay.relayStream(stream(), 'req', { onSentence: (s) => sentences.push(s) });
    expect(sentences).toEqual(['No trailing space.']);
  });
});

// Q-19: a failed reply carries the typed failure the dashboard renders as is.
describe('StreamRelay failure frames', () => {
  async function relayError(events: LLMStreamEvent[]): Promise<WSMessage> {
    const messages: WSMessage[] = [];
    const relay = new StreamRelay({ broadcast(message: WSMessage) { messages.push(message); } } as unknown as WebSocketServer);
    async function* stream(): AsyncGenerator<LLMStreamEvent> { for (const event of events) yield event; }
    await expect(relay.relayStream(stream(), 'req-7')).rejects.toThrow();
    return messages.find(m => m.type === 'error')!;
  }

  test('a typed provider code becomes the failure, with credentials redacted', async () => {
    const frame = await relayError([{ type: 'error', error: 'Incorrect API key provided: sk-ant-api03-abcdefghijklmnopqrstuvwxyz', code: 'auth' }]);
    const payload = frame.payload as { message: string; code: string; failure: { category: string; effect: string; links: unknown; detail: string } };
    expect(payload.code).toBe('auth');
    expect(payload.failure).toMatchObject({ category: 'missing_binding', effect: 'none', links: { requestId: 'req-7' } });
    expect(payload.message).not.toContain('abcdefghijklmnop');
    expect(payload.failure.detail).not.toContain('abcdefghijklmnop');
  });

  test('without a typed code it stays untyped, whatever the text says', async () => {
    const frame = await relayError([{ type: 'error', error: '429 Too Many Requests: rate limit' }]);
    expect(frame.payload).toMatchObject({ code: 'unknown', failure: { category: 'internal' } });
  });

  test('a turn that already called a tool never reads as "nothing was done"', async () => {
    const frame = await relayError([
      { type: 'tool_call', tool_call: { id: 't1', name: 'send_email', arguments: {} } },
      { type: 'error', error: 'rate limited', code: 'rate_limit' },
    ]);
    expect(frame.payload).toMatchObject({ failure: { category: 'provider_limit', effect: 'unknown',
      outcome: 'Actions it had already taken may have gone through.' } });
  });
});

describe('StreamRelay: one error per failed turn', () => {
  test('a stream that throws is shown once, and the caller is told so with the same failure', async () => {
    const messages: WSMessage[] = [];
    const relay = new StreamRelay({ broadcast(message: WSMessage) { messages.push(message); } } as unknown as WebSocketServer);
    async function* stream(): AsyncGenerator<LLMStreamEvent> { throw new Error('socket hang up'); }
    const error = await relay.relayStream(stream(), 'req-9').catch(e => e) as Error & { _streamErrorBroadcast?: boolean; failure?: { key: string } };
    expect(messages.filter(m => m.type === 'error')).toHaveLength(1);
    expect(error._streamErrorBroadcast).toBe(true);
    expect(error.failure!.key).toBe((messages[0]!.payload as { failure: { key: string } }).failure.key);
  });
});

// Review suggestion: only a call that can change something counts toward
// "may have acted"; a failed turn after a read alone did nothing.
test('a turn that only read before failing still reads as nothing done', async () => {
  const messages: WSMessage[] = [];
  const relay = new StreamRelay({ broadcast(message: WSMessage) { messages.push(message); } } as unknown as WebSocketServer);
  async function* stream(): AsyncGenerator<LLMStreamEvent> {
    yield { type: 'tool_call', tool_call: { id: 't1', name: 'read_file', arguments: { path: '/tmp/a' } } };
    yield { type: 'error', error: 'rate limited', code: 'rate_limit' };
  }
  await expect(relay.relayStream(stream(), 'req-8', { mayAct: call => call.name !== 'read_file' })).rejects.toThrow();
  expect(messages.find(m => m.type === 'error')!.payload).toMatchObject({ failure: { effect: 'none', outcome: 'Nothing was done.' } });
});
