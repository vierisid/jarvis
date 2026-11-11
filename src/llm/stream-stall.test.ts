import { expect, test } from 'bun:test';
import { LLMManager } from './manager';
import type { LLMOptions, LLMProvider, LLMStreamEvent } from './provider';

const done: LLMStreamEvent = { type: 'done', response: { content: 'hi', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'm', finish_reason: 'stop' } };
const messages = [{ role: 'user' as const, content: 'hello' }];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function managerFor(stream: (options: LLMOptions | undefined, call: number) => AsyncIterable<LLMStreamEvent>) {
  const manager = new LLMManager({ streamFirstDataMs: 40, streamIdleMs: 40 });
  const state = { calls: 0, aborted: false };
  const provider: LLMProvider = {
    name: 'fixture',
    async chat() { throw new Error('unused'); },
    stream(_messages, options) {
      options?.signal?.addEventListener('abort', () => { state.aborted = true; });
      return stream(options, ++state.calls);
    },
    async listModels() { return []; },
  };
  manager.registerProvider(provider);
  return { manager, state };
}
async function collect(iterable: AsyncIterable<LLMStreamEvent>, perEvent?: () => Promise<void>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const event of iterable) { out.push(event); await perEvent?.(); }
  return out;
}

test('a stream that never sends a first token fails fast, once, and is aborted', async () => {
  // Ignores its signal on purpose: the manager must stop waiting by itself.
  const { manager, state } = managerFor(() => (async function* () { await new Promise(() => {}); })());
  const started = Date.now();
  const events = await collect(manager.stream(messages));
  expect(Date.now() - started).toBeLessThan(1500);
  expect(state.calls).toBe(1);
  expect(state.aborted).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'error', code: 'network' });
  expect((events[0] as { error: string }).error).toContain('sent no data');
});

test('a stream that goes quiet after some text fails with its partial text kept', async () => {
  const { manager, state } = managerFor(() => (async function* () {
    yield { type: 'text' as const, text: 'partial' };
    await new Promise(() => {});
  })());
  const events = await collect(manager.stream(messages));
  expect(events.map(e => e.type)).toEqual(['text', 'error']);
  expect(state.calls).toBe(1);
});

test('time the consumer spends on an event (a tool run) never counts as a stall', async () => {
  const { manager } = managerFor(() => (async function* () {
    yield { type: 'text' as const, text: 'working' };
    yield done;
  })());
  const events = await collect(manager.stream(messages), () => pause(120));
  expect(events.map(e => e.type)).toEqual(['text', 'done']);
});

test('bytes that are not yet an event keep the stream alive', async () => {
  const { manager } = managerFor((options) => (async function* () {
    for (let i = 0; i < 8; i++) { await pause(15); options?.onStreamActivity?.(); }
    yield done;
  })());
  const events = await collect(manager.stream(messages));
  expect(events.map(e => e.type)).toEqual(['done']);
});

test('a caller abort is not reported as a stall', async () => {
  const { manager } = managerFor(() => (async function* () { await new Promise(() => {}); })());
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 10);
  const events = await collect(manager.stream(messages, { signal: controller.signal }));
  expect(events.at(-1)).toMatchObject({ type: 'error' });
  expect(JSON.stringify(events)).not.toContain('sent no data');
});
