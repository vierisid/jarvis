import { expect, test } from 'bun:test';
import { LLMManager } from './manager';
import { LLMProviderError, type LLMOptions, type LLMProvider, type LLMStreamEvent } from './provider';
import { failureEvidence } from '../failures/evidence';
import { failureText, projectFailure } from '../failures/projection';

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

test('a stream that finishes is not aborted afterwards, one the consumer stops early is', async () => {
  const signals: AbortSignal[] = [];
  const { manager } = managerFor((options) => {
    signals.push(options!.signal!);
    return (async function* () { yield { type: 'text' as const, text: 'a' }; yield done; })();
  });
  await collect(manager.stream(messages));
  expect(signals[0]!.aborted).toBe(false);
  for await (const event of manager.stream(messages)) { if (event.type === 'text') break; }
  expect(signals[1]!.aborted).toBe(true);
});

/** A tier map whose high-tier provider stalls the way `primaryStream` says; medium answers. */
function tierPair(primaryStream: () => AsyncIterable<LLMStreamEvent>) {
  const manager = new LLMManager({ streamFirstDataMs: 40, streamIdleMs: 40 });
  const calls = { primary: 0, fallback: 0 };
  manager.registerProvider({ name: 'primary', async chat() { throw new Error('unused'); },
    stream() { calls.primary++; return primaryStream(); }, async listModels() { return []; } });
  manager.registerProvider({ name: 'fallback', async chat() { throw new Error('unused'); },
    async *stream() { calls.fallback++; yield { type: 'text' as const, text: 'from fallback' }; yield done; },
    async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'primary' }, medium: { provider: 'fallback' } });
  return { manager, calls };
}

test('with a tier map, a stream that stalls before showing anything moves on to the next provider', async () => {
  const { manager, calls } = tierPair(() => (async function* () { await new Promise(() => {}); })());
  const events = await collect(manager.streamTier('high', 't', messages));
  expect(events.map(e => e.type)).toEqual(['text', 'done']);
  expect((events[0] as { text: string }).text).toBe('from fallback');
  // A stall is not retried on the same provider, it fails over at once.
  expect(calls).toEqual({ primary: 1, fallback: 1 });
});

test('with a tier map, a stream that stalls after some text fails the turn as not answering in time', async () => {
  const { manager, calls } = tierPair(() => (async function* () {
    yield { type: 'text' as const, text: 'partial' };
    await new Promise(() => {});
  })());
  const events = await collect(manager.streamTier('high', 't', messages));
  expect(events.map(e => e.type)).toEqual(['text', 'error']);
  expect((events[0] as { text: string }).text).toBe('partial');
  expect(calls).toEqual({ primary: 1, fallback: 0 });
  const error = events[1] as Extract<LLMStreamEvent, { type: 'error' }>;
  expect(error.code).toBe('network');
  const text = failureText(projectFailure(failureEvidence(new LLMProviderError(error.error, error.code!)), { label: 'Chat', sideEffects: false }));
  expect(text).toContain('did not answer in time');
  expect(text).not.toContain('could not be reached');
});
