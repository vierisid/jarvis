import { expect, test } from 'bun:test';
import { createDiagnosticsProvider, observeOperation, LIMITS, type DiagnosticEvent, type DiagnosticInput, type EventMetadata } from './index.ts';
const owner = { actorId: 'owner', projectId: 'project' };
const key = new Uint8Array(32).fill(7);
function event(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return { schemaVersion: 1, eventId: 'event-1', kind: 'interview_turn', stage: 'interview',
    correlation: { journeyId: 'journey-1', operationId: 'operation-1', sessionId: 'session-1', turnId: 'turn-1' },
    outcome: 'failed', failureCode: 'model_timeout', durationMs: 123, ...overrides };
}
function provider(logger?: (event: Readonly<DiagnosticEvent>, signal: AbortSignal) => void | Promise<void>) {
  return createDiagnosticsProvider({ enabled: true, authorize: () => owner, correlationKey: key, logger });
}
async function until(done: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!done()) { if (Date.now() > deadline) throw new Error('Diagnostics did not settle'); await Bun.sleep(1); }
}

test('factory is inert, default off performs no authorization or delivery', () => {
  let effects = 0;
  const p = createDiagnosticsProvider({ authorize: () => { effects++; return owner; }, logger: () => { effects++; } });
  expect(effects).toBe(0); expect(p.probe().ready).toBe(false);
  expect(p.record({}, event())).toBe('unavailable'); expect(p.receipt({}, 'journey-1')).toBeNull(); expect(effects).toBe(0);
  p.dispose();
});
test('all six event families retain only bounded dimensions and correlated observations', () => {
  const p = provider();
  const events: (Partial<DiagnosticInput> & Pick<DiagnosticInput, 'kind'>)[] = [
    { kind: 'step_transition', stage: 'welcome', from: 'welcome', to: 'explain' },
    { kind: 'connection_attempt', stage: 'google', failureCode: 'transport_disconnected' },
    { kind: 'interview_turn', stage: 'interview', failureCode: 'save_failed' },
    { kind: 'build_phase', stage: 'build', phase: 'saving' },
    { kind: 'recovery', stage: 'build', recovery: 'reconcile' },
    { kind: 'result_handoff', stage: 'result', outcome: 'succeeded', failureCode: 'none' },
  ];
  for (const [i, e] of events.entries()) expect(p.record({}, event({ ...e, eventId: `event-${i}` }))).toBe('recorded');
  const receipt = p.receipt({}, 'journey-1')!;
  expect(receipt.events.map(e => e.kind)).toEqual(events.map(e => e.kind));
  expect(new Set(receipt.events.map(e => e.correlation.operationId)).size).toBe(1);
  expect(receipt.events.map(e => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]); p.dispose();
});
test('redacts content, arbitrary metadata and even credentials smuggled into IDs before logging', async () => {
  const delivered: DiagnosticEvent[] = [], p = provider(e => { delivered.push(e as DiagnosticEvent); });
  const secret = 'sk-uj-private-secret-do-not-export', email = 'founder@example.invalid';
  const raw = { ...event(), eventId: secret, correlation: { journeyId: email, operationId: secret, requestId: secret,
    attemptId: secret, sessionId: secret, turnId: secret, jobId: secret, compositionRecordId: secret, flowId: secret, versionId: secret, token: secret },
    model: { provider: secret, profileId: secret, apiKey: secret }, prompt: 'private founder routine', transcript: 'private answer',
    error: new Error(secret), stack: secret, accessToken: secret, emailBody: email, screenshot: 'data:image/png;private', scope: { actorId: 'victim' } };
  Object.defineProperty(raw, 'unrelatedSecretGetter', { get() { throw new Error('Must not read extra fields'); } });
  expect(p.record({}, raw)).toBe('recorded'); await until(() => delivered.length === 1);
  const receipt = p.receipt({}, email)!;
  const serialized = JSON.stringify({ delivered, receipt });
  for (const sensitive of [secret, email, 'private founder routine', 'private answer', 'data:image/png;private', 'victim']) expect(serialized).not.toContain(sensitive);
  expect(receipt.events[0]!.model!.provider).toBe('unknown');
  expect(receipt.events[0]!.model!.profileId).toMatch(/^d1_[a-f0-9]{32}$/);
  expect(receipt.events[0]!.correlation.journeyId).toBe(receipt.journeyId); p.dispose();
});
test('rejects unbounded dimensions, invalid schemas and contradictory success without echoing them', () => {
  const p = provider();
  for (const patch of [{ schemaVersion: 2 }, { kind: 'private-kind' }, { stage: 'private-stage' }, { outcome: 'private-outcome' },
    { failureCode: 'private error text' }, { eventId: 'x'.repeat(257) }, { durationMs: -1 }, { durationMs: NaN }, { durationMs: Infinity },
    { outcome: 'succeeded' }, { failureCode: 'none' }, { kind: 'build_phase', phase: 'private' }, { kind: 'recovery', recovery: 'private' },
    { kind: 'step_transition', from: 'welcome', to: 'private' }, { correlation: { journeyId: 'j' } }]) expect(p.record({}, { ...event(), ...patch })).toBe('invalid');
  expect(p.receipt({}, 'journey-1')).toBeNull();
  expect(p.record({}, event({ durationMs: 1e100 }))).toBe('recorded'); expect(p.receipt({}, 'journey-1')!.events[0]!.durationMs).toBe(LIMITS.durationMs); p.dispose();
});
test('changing getters cannot replace validated dimensions with private content', () => {
  const p = provider(), raw = event({ model: { provider: 'openai', profileId: 'profile' } });
  for (const field of ['kind', 'stage', 'outcome', 'failureCode'] as const) {
    const first = raw[field]; let reads = 0;
    Object.defineProperty(raw, field, { get: () => ++reads === 1 ? first : 'private content' });
  }
  let reads = 0;
  Object.defineProperty(raw.model!, 'provider', { get: () => ++reads === 1 ? 'openai' : 'private credential' });
  expect(p.record({}, raw)).toBe('recorded');
  const receipt = p.receipt({}, 'journey-1')!;
  expect(receipt.events[0]).toMatchObject({ kind: 'interview_turn', stage: 'interview', outcome: 'failed', failureCode: 'model_timeout', model: { provider: 'openai' } });
  expect(JSON.stringify(receipt)).not.toContain('private'); p.dispose();
});
test('reauthorizes receipt access and isolates identical IDs by actor and project', () => {
  let scope: typeof owner | null = owner;
  const p = createDiagnosticsProvider({ enabled: true, authorize: () => scope, correlationKey: key });
  p.record({}, event()); const first = p.receipt({}, 'journey-1')!;
  for (const other of [{ actorId: 'other', projectId: owner.projectId }, { actorId: owner.actorId, projectId: 'other' }]) {
    scope = other; expect(p.receipt({}, 'journey-1')).toBeNull(); p.record({}, event());
    expect(p.receipt({}, 'journey-1')!.events[0]!.eventId).not.toBe(first.events[0]!.eventId);
  }
  scope = null; expect(p.record({}, event())).toBe('unavailable'); expect(p.receipt({}, 'journey-1')).toBeNull();
  scope = owner; expect(p.receipt({}, 'journey-1')!.events).toEqual(first.events); p.dispose();
});
test('same key correlates across instances, default keys do not, invalid keys fail closed', () => {
  const a = provider(), b = provider(); a.record({}, event()); b.record({}, event());
  expect(a.receipt({}, 'journey-1')!.journeyId).toBe(b.receipt({}, 'journey-1')!.journeyId);
  const c = createDiagnosticsProvider({ enabled: true, authorize: () => owner }), d = createDiagnosticsProvider({ enabled: true, authorize: () => owner });
  c.record({}, event()); d.record({}, event()); expect(c.receipt({}, 'journey-1')!.journeyId).not.toBe(d.receipt({}, 'journey-1')!.journeyId);
  const invalid = createDiagnosticsProvider({ enabled: true, authorize: () => owner, correlationKey: new Uint8Array(2) });
  expect(invalid.record({}, event())).toBe('invalid'); expect(invalid.receipt({}, 'journey-1')).toBeNull();
  [a, b, c, d, invalid].forEach(p => p.dispose());
});
test('deduplicates redelivery, rejects changed observations, and never overwrites prior evidence', async () => {
  let logs = 0; const p = provider(() => { logs++; });
  expect(p.record({}, event())).toBe('recorded'); expect(p.record({}, event())).toBe('duplicate');
  expect(p.record({}, event({ failureCode: 'save_failed' }))).toBe('conflict'); await until(() => logs === 1);
  const r = p.receipt({}, 'journey-1')!;
  expect(r.events).toHaveLength(1); expect(r.events[0]!.failureCode).toBe('model_timeout');
  expect(r.duplicateEvents).toBe(1); expect(r.conflictingEvents).toBe(1); p.dispose();
});
test('bounds receipts, recent dedup windows and the number of retained journeys', () => {
  const p = provider();
  for (let i = 0; i <= LIMITS.dedup; i++) p.record({}, event({ eventId: `event-${i}` }));
  const receipt = p.receipt({}, 'journey-1')!;
  expect(receipt.events).toHaveLength(LIMITS.events); expect(receipt.evictedEvents).toBe(LIMITS.dedup + 1 - LIMITS.events);
  expect(p.record({}, event({ eventId: 'event-128' }))).toBe('duplicate');
  expect(p.record({}, event({ eventId: 'event-0' }))).toBe('recorded'); // Outside the advertised dedup window.
  for (let i = 0; i < LIMITS.journeys; i++) p.record({}, event({ correlation: { journeyId: `journey-${i + 2}`, operationId: 'op' } }));
  expect(p.receipt({}, 'journey-1')).toBeNull(); expect(JSON.stringify(receipt).length).toBeLessThan(32_768); p.dispose();
});
for (const failure of ['throw', 'reject', 'hang'] as const) test(`logger ${failure} cannot block operations and trips bounded delivery`, async () => {
  let calls = 0, aborted = false;
  const p = createDiagnosticsProvider({ enabled: true, authorize: () => owner, deliveryTimeoutMs: 5, logger: (_event, signal) => {
    calls++; signal.addEventListener('abort', () => { aborted = true; });
    if (failure === 'throw') throw new Error('private logger credential');
    if (failure === 'reject') return Promise.reject(new Error('private logger credential'));
    return new Promise(() => {});
  } });
  let operations = 0;
  const result = await observeOperation(p, {}, event(), async () => { operations++; return 42; }, { result: () => ({ outcome: 'succeeded', failureCode: 'none' }) });
  expect(result).toBe(42); expect(operations).toBe(1);
  for (let i = 0; i < 100; i++) p.record({}, event({ eventId: `later-${i}` }));
  await until(() => ['failed', 'timed_out'].includes(p.receipt({}, 'journey-1')!.delivery));
  expect(calls).toBe(1); expect(aborted).toBe(true); expect(p.receipt({}, 'journey-1')!.droppedDeliveries).toBeGreaterThan(0);
  p.record({}, event({ eventId: 'after-failure' })); await Bun.sleep(1); expect(calls).toBe(1); p.dispose();
});
test('queue overflow is bounded; logger and receipt mutations cannot alter retained events', async () => {
  let release!: () => void, calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const p = provider(async e => { calls++; (e.correlation as { journeyId: string }).journeyId = 'private injected value'; await pending; });
  for (let i = 0; i < 100; i++) p.record({}, event({ eventId: `e-${i}` }));
  await until(() => calls === 1);
  const r = p.receipt({}, 'journey-1')!;
  expect(r.droppedDeliveries).toBe(100 - LIMITS.queue);
  expect(JSON.stringify(r)).not.toContain('private injected value'); r.events[0]!.failureCode = 'save_failed';
  expect(p.receipt({}, 'journey-1')!.events[0]!.failureCode).toBe('model_timeout');
  release(); await until(() => p.receipt({}, 'journey-1')!.delivery === 'idle'); expect(calls).toBe(LIMITS.queue); p.dispose();
});
test('disposal stops delivery and accepts no new observations while retaining readable receipts', async () => {
  let calls = 0; const p = provider(() => { calls++; }); p.record({}, event()); p.dispose();
  await Bun.sleep(1); expect(calls).toBe(0); expect(p.record({}, event())).toBe('unavailable');
  expect(p.receipt({}, 'journey-1')!.events).toHaveLength(1); expect(p.receipt({}, 'journey-1')!.delivery).toBe('closed');
});
test('measures actual operations, preserves result/error identity, and distinguishes owner failure categories', async () => {
  const p = provider(); let time = 10, calls = 0; const result = { ready: false, secret: 'private result' }, error = new Error('private model body');
  const success = await observeOperation(p, {}, event(), () => { calls++; time = 25; return result; },
    { now: () => time, result: () => ({ outcome: 'failed', failureCode: 'save_failed' }) });
  expect(success).toBe(result);
  try { await observeOperation(p, {}, event({ eventId: 'error' }), () => { calls++; time = 35; throw error; },
    { now: () => time, error: () => ({ outcome: 'failed', failureCode: 'model_timeout' }) }); throw new Error('Expected failure'); }
  catch (received) { expect(received === error).toBe(true); }
  expect(calls).toBe(2); expect(p.receipt({}, 'journey-1')!.events.map(e => [e.durationMs, e.failureCode])).toEqual([[15, 'save_failed'], [10, 'model_timeout']]); p.dispose();
});
test('absent or broken ports, classifiers, metadata and clocks cannot change work', async () => {
  const p = provider(), value = { answer: 'private' }, metadata = event();
  for (const sink of [null, undefined, { record: () => { throw new Error('sink'); } }, { record: () => Promise.reject(new Error('sink')) }]) {
    let calls = 0; expect(await observeOperation(sink, {}, metadata, () => { calls++; return value; })).toBe(value); expect(calls).toBe(1);
  }
  expect(await observeOperation(p, {}, metadata, () => value, { now: () => { throw new Error('clock'); }, result: () => { throw new Error('classifier'); } })).toBe(value);
  expect(p.receipt({}, 'journey-1')!.events[0]).toMatchObject({ outcome: 'unknown', failureCode: 'unknown', durationMs: null });
  const bad = Object.defineProperty({}, 'schemaVersion', { get() { throw new Error('getter'); } });
  expect(p.record({}, bad)).toBe('invalid'); expect(await observeOperation(p, {}, bad as EventMetadata, () => value)).toBe(value); p.dispose();
});
test('throwing observation accessors preserve operation results and original errors', async () => {
  const p = provider(), error = new Error('original failure'), options = {};
  for (const field of ['now', 'result', 'error']) Object.defineProperty(options, field, { get() { throw new Error('diagnostic config failure'); } });
  expect(await observeOperation(p, {}, event(), () => 42, options)).toBe(42);
  await expect(observeOperation(p, {}, event({ eventId: 'failed' }), () => { throw error; }, options)).rejects.toBe(error);
  expect(p.receipt({}, 'journey-1')!.events.map(e => [e.outcome, e.failureCode, e.durationMs])).toEqual([
    ['unknown', 'unknown', null], ['unknown', 'unknown', null],
  ]); p.dispose();
});
