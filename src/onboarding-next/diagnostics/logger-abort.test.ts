import { expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLoggerAbortController } from './logger-abort.ts';

test('guarded cancellation remains a native signal for abortable IO and composition', async () => {
  const controller = createLoggerAbortController(), signal = controller.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  const combined = AbortSignal.any([signal]);
  const pending = delay(60_000, undefined, { signal }).then(() => 'completed', error => error.name);
  controller.abort();
  expect(signal.aborted).toBe(true); expect(combined.aborted).toBe(true);
  expect(() => signal.throwIfAborted()).toThrow();
  expect(await pending).toBe('AbortError');
});

test('listener identity, capture, once, removal and callback receivers retain native behavior', () => {
  const controller = createLoggerAbortController(), signal = controller.signal;
  let calls = 0, removed = 0, objectCalls = 0, objectReceiver: unknown;
  const receivers: unknown[] = [];
  function listener(this: unknown, event: Event) { calls++; receivers.push(this, event.target, event.currentTarget); }
  const never = () => { removed++; };
  const object = { handleEvent() { objectCalls++; objectReceiver = this; } };
  signal.addEventListener('abort', listener, { once: true });
  signal.addEventListener('abort', listener); // Same identity/capture is a duplicate.
  signal.addEventListener('abort', listener, true);
  signal.removeEventListener('abort', listener, true);
  signal.addEventListener('abort', never); signal.removeEventListener('abort', never);
  signal.addEventListener('abort', object); signal.removeEventListener('abort', object);
  signal.addEventListener('abort', object, { once: true });
  controller.abort();
  signal.dispatchEvent(new Event('abort')); // Once listeners remain removed.
  expect(calls).toBe(1); expect(objectCalls).toBe(1); expect(removed).toBe(0);
  expect(objectReceiver).toBe(object);
  expect(receivers).toEqual([signal, signal, signal]);
  signal.addEventListener('abort', listener, { once: true });
  signal.dispatchEvent(new Event('abort'));
  expect(calls).toBe(2);
});

test('onabort replacement and removal do not register duplicate callbacks', () => {
  const controller = createLoggerAbortController(), signal = controller.signal;
  let removed = 0, calls = 0, receiver: unknown;
  const never = () => { removed++; };
  signal.onabort = never; signal.onabort = null;
  signal.onabort = never;
  signal.onabort = function () { calls++; receiver = this; };
  controller.abort(); controller.abort();
  expect(removed).toBe(0); expect(calls).toBe(1); expect(receiver).toBe(signal);
  signal.onabort = null;
  signal.dispatchEvent(new Event('abort'));
  expect(calls).toBe(1);
});
