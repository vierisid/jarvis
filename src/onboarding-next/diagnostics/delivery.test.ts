import { expect, test } from 'bun:test';
import { createDiagnosticsProvider, type DiagnosticInput } from './index.ts';

const event: DiagnosticInput = { schemaVersion: 1, eventId: 'first', kind: 'interview_turn', stage: 'interview',
  correlation: { journeyId: 'journey', operationId: 'operation' }, outcome: 'succeeded', failureCode: 'none', durationMs: 1 };
const owner = { actorId: 'owner', projectId: 'project' };

// EventTarget reports listener failures outside the abort() call stack. A child
// must exit cleanly with empty stderr; catching abort() or intercepting global
// uncaughtException/unhandledRejection would hide the regression.
for (const mode of ['timeout', 'throw', 'reject', 'dispose'] as const) {
  test(`logger cancellation contains sync and async listener failures on ${mode}`, async () => {
    const code = `
      import { createDiagnosticsProvider, observeOperation } from ${JSON.stringify(new URL('./index.ts', import.meta.url).pathname)};
      const mode = ${JSON.stringify(mode)}, event = ${JSON.stringify(event)};
      let callbacks = 0;
      const sink = createDiagnosticsProvider({ enabled: true, authorize: () => ({ actorId: 'owner', projectId: 'project' }),
        deliveryTimeoutMs: 5, logger: (_event, signal) => {
          const fail = () => { callbacks++; throw new Error('private cancellation details'); };
          signal.addEventListener('abort', fail);
          signal.addEventListener('abort', { handleEvent: fail });
          signal.onabort = fail;
          signal.addEventListener('abort', async () => { callbacks++; throw new Error('private async cancellation details'); });
          if (mode === 'throw') throw new Error('private logger details');
          if (mode === 'reject') return Promise.reject(new Error('private logger details'));
          return new Promise(() => {});
        } });
      const result = await observeOperation(sink, {}, event, () => 'operation result', {
        result: () => ({ outcome: 'succeeded', failureCode: 'none' }),
      });
      if (mode === 'dispose') sink.dispose();
      const deadline = Date.now() + 1000;
      while (callbacks < 4) { if (Date.now() > deadline) throw new Error('Missing cancellation callbacks'); await Bun.sleep(1); }
      await Bun.sleep(5);
      console.log(JSON.stringify({ result, callbacks, delivery: sink.receipt({}, 'journey').delivery }));
      sink.dispose();
    `;
    const child = Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ result: 'operation result', callbacks: 4,
      delivery: mode === 'timeout' ? 'timed_out' : mode === 'dispose' ? 'closed' : 'failed' });
  });
}

for (const settlement of ['resolve', 'reject'] as const) {
  test(`disposal counts active and queued losses once, even after late ${settlement}`, async () => {
    let resolve!: () => void, reject!: (error: Error) => void, aborted = 0, calls = 0;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const sink = createDiagnosticsProvider({ enabled: true, authorize: () => owner, logger: (_event, signal) => {
      calls++; signal.addEventListener('abort', () => { aborted++; }); return pending;
    } });
    try {
      sink.record({}, event);
      await Promise.resolve(); // The first event is in flight; the second is queued.
      sink.record({}, { ...event, eventId: 'second' });
      sink.dispose(); sink.dispose();
      expect(sink.receipt({}, 'journey')).toMatchObject({ delivery: 'closed', droppedDeliveries: 2 });
      expect(aborted).toBe(1); expect(calls).toBe(1);
      if (settlement === 'resolve') resolve(); else reject(new Error('private late rejection'));
      await Bun.sleep(1);
      expect(sink.receipt({}, 'journey')).toMatchObject({ delivery: 'closed', droppedDeliveries: 2 });
      expect(calls).toBe(1);
    } finally { resolve(); sink.dispose(); }
  });
}

test('disposal does not count acknowledged deliveries as dropped', async () => {
  const sink = createDiagnosticsProvider({ enabled: true, authorize: () => owner, logger: () => {} });
  sink.record({}, event);
  await Promise.resolve(); await Promise.resolve();
  sink.dispose(); sink.dispose();
  expect(sink.receipt({}, 'journey')).toMatchObject({ delivery: 'closed', droppedDeliveries: 0 });
});

test('logger failure followed by reentrant disposal does not double-count losses', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => { reject = no; });
  const sink = createDiagnosticsProvider({ enabled: true, authorize: () => owner, logger: (_event, signal) => {
    signal.addEventListener('abort', () => sink.dispose()); return pending;
  } });
  try {
    sink.record({}, event); await Promise.resolve();
    sink.record({}, { ...event, eventId: 'second' });
    reject(new Error('private logger failure'));
    await Bun.sleep(1);
    sink.dispose();
    expect(sink.receipt({}, 'journey')).toMatchObject({ delivery: 'closed', droppedDeliveries: 2 });
  } finally { sink.dispose(); }
});
