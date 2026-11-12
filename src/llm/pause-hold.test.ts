/**
 * Pause can hold the model loops: background work makes no model call while
 * Jarvis is paused, and carries on from where it was after Resume. Off unless
 * turned on, and never for the person's own turn.
 */
import { afterEach, expect, test } from 'bun:test';
import { EmergencyController, HeldCallStopped, setActiveEmergencyController, setPauseHoldsLoops, whenRunnable } from '../authority/emergency.ts';
import { LLMManager } from './manager.ts';
import { runWithOrigin } from './origin.ts';
import type { LLMProvider, LLMResponse } from './provider.ts';

afterEach(() => { setActiveEmergencyController(null); setPauseHoldsLoops(false); });

const messages = [{ role: 'user' as const, content: 'Synthetic fixture' }];
const reply: LLMResponse = { content: 'ok', tool_calls: [], model: 'fixture', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function manager() {
  const calls: string[] = [];
  const m = new LLMManager();
  m.registerProvider({
    name: 'fixture',
    async chat() { calls.push('chat'); return reply; },
    async *stream() { calls.push('stream'); yield { type: 'done', response: reply }; },
    listModels: async () => [],
  } as LLMProvider);
  m.setTierMap({ medium: { provider: 'fixture' } });
  return { m, calls };
}

function paused(holds = true) {
  const controller = new EmergencyController();
  setActiveEmergencyController(controller);
  setPauseHoldsLoops(holds);
  controller.pause();
  return controller;
}

test('a background call waits for Resume, then goes out once', async () => {
  const controller = paused();
  const { m, calls } = manager();
  let done = false;
  const call = runWithOrigin('background', () => m.chatTier('medium', 'test', messages)).then((r) => { done = true; return r; });
  await settle();
  expect(calls).toEqual([]);
  expect(done).toBe(false);
  controller.resume();
  expect((await call).content).toBe('ok');
  expect(calls).toEqual(['chat']);
});

test('a background stream and a call with an override wait the same way', async () => {
  const controller = paused();
  const { m, calls } = manager();
  const stream = runWithOrigin('background', async () => {
    const events: string[] = [];
    for await (const event of m.streamTier('medium', 'test', messages)) events.push(event.type);
    return events;
  });
  const override = runWithOrigin('background', () => m.chatWithOverride(messages, 'fixture'));
  await settle();
  expect(calls).toEqual([]);
  controller.resume();
  expect(await stream).toEqual(['done']);
  expect((await override).content).toBe('ok');
  expect(calls.sort()).toEqual(['chat', 'stream']);
});

test('the person\'s own turn, a workflow step and an untagged call are not held', async () => {
  paused();
  const { m, calls } = manager();
  await runWithOrigin('user', () => m.chatTier('medium', 'test', messages));
  await runWithOrigin('workflow', () => m.chatTier('medium', 'test', messages));
  await m.chatTier('medium', 'test', messages);
  expect(calls).toHaveLength(3);
});

test('with the hold off, Pause is what it was: the call goes out', async () => {
  paused(false);
  const { m, calls } = manager();
  await runWithOrigin('background', () => m.chatTier('medium', 'test', messages));
  expect(calls).toEqual(['chat']);
});

test('Kill while a call is held ends it: it never goes out', async () => {
  const controller = paused();
  const { m, calls } = manager();
  const call = runWithOrigin('background', () => m.chatTier('medium', 'test', messages));
  await settle();
  controller.kill();
  await expect(call).rejects.toBeInstanceOf(HeldCallStopped);
  expect(calls).toEqual([]);
});

test('a caller that gives up while held is let go, and nothing is left listening', async () => {
  const controller = paused();
  const abort = new AbortController();
  const waiting = whenRunnable(abort.signal);
  abort.abort(new Error('gave up'));
  await expect(waiting).rejects.toThrow('gave up');
  const listeners = (controller as unknown as { listeners: Set<unknown> }).listeners;
  expect(listeners.size).toBe(0);
  // Already given up before it asked: the same.
  await expect(whenRunnable(abort.signal)).rejects.toThrow('gave up');
  expect(listeners.size).toBe(0);
});

test('running, or with no controller at all, nothing waits', async () => {
  setPauseHoldsLoops(true);
  await whenRunnable();
  const controller = new EmergencyController();
  setActiveEmergencyController(controller);
  await whenRunnable();
  controller.kill();
  // Kill is not Pause: it has its own stops, and this does not hold for it.
  await whenRunnable();
});
