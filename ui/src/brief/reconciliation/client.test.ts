import { afterEach, expect, test } from 'bun:test';
import { BriefCapabilities, type BriefCapabilityId } from '../../../../src/brief/capabilities';
import { registerReconciliation } from '../../../../src/brief/registrations/reconciliation';
import { BriefReconciliationClient } from './client';
import { EventHints } from './events';
import { ReadFailure, type Read, type Source } from './resource';

const ids: BriefCapabilityId[] = ['reconciliation', 'decisions', 'memoryStream', 'memoryUsage', 'workflowContext'];
export const ready = new BriefCapabilities(ids.map(id => ({ id, provider: { readiness: () => 'ready' } })), ids).snapshot();
const clients: BriefReconciliationClient[] = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const result = <T>(data: T, empty = false): Read<T> => ({ data, empty, asOf: Date.now() });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup<T>(source: Source<T>, options: ConstructorParameters<typeof BriefReconciliationClient>[0] = {}) {
  const client = new BriefReconciliationClient({ capabilities: async () => ready, ...options }); clients.push(client);
  const projection = client.projection(source), unsubscribe = projection.subscribe(() => {}); client.start();
  return { client, projection, unsubscribe };
}
afterEach(() => { for (const client of clients.splice(0)) client.stop(); });
const goal = (sequence: number, eventId = `event-${sequence}`) => ({ type: 'goal_event', payload: { eventId, sequence } });

test('goal cursor detects holes, deduplicates IDs, and does not discard unfamiliar reordered updates', () => {
  const hints = new EventHints();
  expect(hints.accept(goal(1))).toContain('goals');
  expect(hints.accept(goal(1))).toEqual([]);
  expect(hints.accept(goal(3))).toContain('memory');
  expect(hints.accept(goal(2))).toContain('goals');
  expect(hints.accept(goal(3))).toEqual([]);
  hints.reset(); expect(hints.accept(goal(1))).toContain('goals');
});
test('chat cursors are per conversation, track non-approval frames and refresh everything on a gap', () => {
  const hints = new EventHints();
  const chat = (conversationId: string, sequence: number, kind = 'delta') => ({ type: 'brief_chat_event', payload: { conversationId, sequence, eventId: String(sequence), payload: { kind } } });
  expect(hints.accept(chat('a', 1))).toEqual([]);
  expect(hints.accept(chat('b', 12))).toEqual([]);
  expect(hints.accept(chat('a', 2, 'approval'))).toEqual(['decisions', 'today', 'runs']);
  expect(hints.accept(chat('a', 4))).toContain('memory');
  expect(hints.accept(chat('a', 3, 'approval'))).toContain('decisions');
  expect(hints.accept({ type: 'tts_start' })).toEqual([]);
});
test('delivered chat audio advances its conversation cursor without invalidating selected inspection', async () => {
  let reads = 0;
  const { client, projection } = setup({ domains: ['runs'], retainStale: false, read: async () => {
    reads++; return result({ runId: 'selected-run', status: 'paused' });
  } });
  await tick(); const snapshot = projection.getSnapshot();
  const chat = (sequence: number, kind: string) => ({ type: 'brief_chat_event', payload: {
    conversationId: 'a', eventId: `a-${sequence}`, sequence, payload: { kind },
  } });
  client.observer.onMessage(chat(1, 'delta'));
  for (const [sequence, phase] of [[2, 'start'], [3, 'chunk'], [4, 'end']] as const) {
    client.observer.onMessage({ type: 'brief_chat_audio', payload: { conversationId: 'a', sequence, phase } });
    expect(projection.getSnapshot()).toBe(snapshot);
  }
  client.observer.onMessage(chat(5, 'message'));
  expect(projection.getSnapshot()).toBe(snapshot);
  await tick(); expect(reads).toBe(1);
  // Missing event 6 must still invalidate the snapshot when the next audio frame arrives.
  client.observer.onMessage({ type: 'brief_chat_audio', payload: { conversationId: 'a', sequence: 7, phase: 'start' } });
  expect(projection.getSnapshot()).toMatchObject({ state: 'stale', data: null });
  await tick(); expect(reads).toBe(2); expect(projection.getSnapshot().data).toEqual(snapshot.data);
});
test('audio cursors stay per conversation and duplicate or older frames never regress them', () => {
  const hints = new EventHints();
  const audio = (conversationId: string, sequence: number) => ({ type: 'brief_chat_audio', payload: { conversationId, sequence, phase: 'chunk' } });
  expect(hints.accept(audio('a', 1))).toEqual([]);
  expect(hints.accept(audio('b', 20))).toEqual([]);
  expect(hints.accept(audio('a', 2))).toEqual([]);
  expect(hints.accept(audio('a', 2))).toEqual([]);
  expect(hints.accept(audio('a', 1))).toEqual([]);
  expect(hints.accept(audio('a', 3))).toEqual([]);
  expect(hints.accept(audio('b', 21))).toEqual([]);
  expect(hints.accept({ type: 'brief_chat_event', payload: { conversationId: 'a', eventId: 'a-4', sequence: 4,
    payload: { kind: 'approval' } } })).toEqual(['decisions', 'today', 'runs']);
  expect(hints.accept(audio('b', 23))).toContain('memory');
});
test('dropped, duplicate and reordered messages converge without local count arithmetic', async () => {
  let state = { items: ['a'], count: 8 }, reads = 0;
  const { client, projection } = setup({ domains: ['decisions'], read: async () => { reads++; return result(state); } });
  await tick(); client.observer.onMessage(goal(1)); await tick();
  state = { items: ['a', 'b'], count: 12 }; // event 2 was dropped
  client.observer.onMessage(goal(3)); client.observer.onMessage(goal(3)); client.observer.onMessage(goal(2));
  await tick(); expect(projection.getSnapshot().data).toEqual(state); expect(reads).toBe(3);
  state = { items: ['b'], count: 11 }; // final event dropped, no later sequence to expose the gap
  client.observer.onClose(); client.observer.onOpen(); await tick();
  expect(projection.getSnapshot()).toMatchObject({ state: 'ready', data: state });
});
test('an event during a slow read retires its stale result and coalesces into one follow-up', async () => {
  const first = deferred<Read<string>>(), second = deferred<Read<string>>(); let reads = 0;
  const { client, projection } = setup({ domains: ['goals'], read: () => (++reads === 1 ? first : second).promise });
  await tick(); client.observer.onMessage(goal(1)); client.observer.onMessage(goal(2));
  first.resolve(result('old')); await tick(); expect(reads).toBe(2); expect(projection.getSnapshot().data).toBeNull();
  second.resolve(result('current')); await tick(); expect(projection.getSnapshot().data).toBe('current');
});
test('reconnect retires an outstanding read even if the transport ignores cancellation', async () => {
  const old = deferred<Read<string>>(); let reads = 0;
  const { client, projection } = setup({ domains: ['goals'], read: () => ++reads === 1 ? old.promise : Promise.resolve(result('fresh')) });
  await tick(); client.observer.onOpen(); await tick(); expect(projection.getSnapshot().data).toBe('fresh');
  old.resolve(result('obsolete')); await tick(); expect(projection.getSnapshot().data).toBe('fresh');
});
test('last lost event converges by periodic snapshots even without a socket', async () => {
  let value = 1;
  const { projection } = setup({ domains: ['today'], read: async () => result(value) }, { pollMs: 15 });
  await tick(); value = 2; await new Promise(resolve => setTimeout(resolve, 35));
  expect(projection.getSnapshot().data).toBe(2);
});
test('valid empty, first-read failure and stale cached data remain distinct', async () => {
  let fail = true;
  const { projection } = setup({ domains: ['decisions'], read: async () => { if (fail) throw Error('private detail'); return result([], true); } });
  await tick(); expect(projection.getSnapshot()).toMatchObject({ state: 'unavailable', data: null, reason: 'read_failed' });
  fail = false; projection.refresh(); await tick(); expect(projection.getSnapshot()).toMatchObject({ state: 'empty', data: [] });
  fail = true; projection.refresh(); expect(projection.getSnapshot().state).toBe('stale');
  await tick(); expect(projection.getSnapshot()).toMatchObject({ state: 'stale', data: [], reason: 'read_failed' });
});
test('memory is cleared as soon as invalidated and failure cannot masquerade as empty', async () => {
  let fail = false;
  const { projection } = setup({ domains: ['memory'], retainStale: false, read: async () => {
    if (fail) throw new ReadFailure('source_unavailable'); return result(['forget-me']);
  } });
  await tick(); fail = true; projection.refresh();
  expect(projection.getSnapshot()).toMatchObject({ state: 'stale', data: null }); await tick();
  expect(projection.getSnapshot()).toMatchObject({ state: 'unavailable', data: null, refreshing: false, reason: 'source_unavailable' });
});
test('capability loss, unauthorized reads and stop clear every cache and reject late replies', async () => {
  let capabilities: unknown = ready, unauthorized = false;
  const { client, projection } = setup({ domains: ['decisions'], read: async () => {
    if (unauthorized) throw new ReadFailure('denied', true, false, 403); return result('private');
  } }, { capabilities: async () => capabilities });
  const other = client.projection({ domains: ['goals'], read: async () => result('also private') }); other.subscribe(() => {});
  await tick(); unauthorized = true; projection.refresh(); await tick();
  expect(other.getSnapshot()).toMatchObject({ state: 'unavailable', data: null });
  unauthorized = false; await client.refresh(); await tick(); expect(other.getSnapshot().data).toBe('also private');
  capabilities = {}; await client.refresh(); expect(projection.getSnapshot()).toMatchObject({ state: 'unsupported', data: null });
  capabilities = ready; await client.refresh(); await tick(); client.stop();
  expect(other.getSnapshot().data).toBeNull();
});
test('stopped identity cannot publish its delayed capabilities into a restarted lifetime', async () => {
  const old = deferred<unknown>(); let calls = 0, reads = 0;
  const { client, projection } = setup({ domains: ['goals'], read: async () => { reads++; return result('new account'); } },
    { capabilities: () => ++calls === 1 ? old.promise : Promise.resolve({}) });
  await tick(); client.stop(); client.start(); await tick(); old.resolve(ready); await tick();
  expect(reads).toBe(0); expect(projection.getSnapshot().state).toBe('unsupported');
});
test('unsubscribed selections are retired, and a read ignoring abort times out without tight retries', async () => {
  let reads = 0; const never = deferred<Read<string>>();
  const { projection, unsubscribe } = setup({ domains: ['runs'], read: () => { reads++; return never.promise; } }, { timeoutMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(projection.getSnapshot()).toMatchObject({ state: 'unavailable', reason: 'read_timeout' }); expect(reads).toBe(1);
  projection.refresh(); await tick(); unsubscribe(); never.resolve(result('late selection')); await tick();
  expect(projection.getSnapshot().data).toBeNull();
});
test('absent reconciliation or absent optional provider never issues a domain read', async () => {
  let reads = 0;
  const { projection } = setup({ domains: ['decisions'], capability: 'decisions', read: async () => { reads++; return result([]); } },
    { capabilities: async () => new BriefCapabilities(registerReconciliation(() => ({ snapshots: true, sharedSocket: true, identityLifecycle: true })), ['reconciliation']).snapshot() });
  await tick(); expect(projection.getSnapshot().state).toBe('unsupported'); expect(reads).toBe(0);
  expect(registerReconciliation()).toEqual([]);
  const registrations = registerReconciliation(() => ({ snapshots: true, sharedSocket: false, identityLifecycle: true }));
  expect(new BriefCapabilities(registrations, ['reconciliation']).snapshot().capabilities.reconciliation.enabled).toBe(false);
});
test('a present degraded provider is unavailable, while a disabled or missing provider is unsupported', async () => {
  let healthy = true, reads = 0;
  const caps = new BriefCapabilities([
    ...registerReconciliation(() => ({ snapshots: true, sharedSocket: true, identityLifecycle: true })),
    { id: 'decisions', provider: { readiness: () => healthy ? 'ready' : 'unavailable' } },
  ], ['reconciliation', 'decisions']);
  const { client, projection } = setup({ domains: ['decisions'], capability: 'decisions', read: async () => {
    reads++; return result(['pending-approval']);
  } }, { capabilities: async () => caps.snapshot() });
  await tick(); healthy = false; await client.refresh(); await tick();
  expect(projection.getSnapshot()).toMatchObject({ state: 'unavailable', data: null }); expect(reads).toBe(1);
  healthy = true; await client.refresh(); await tick();
  expect(projection.getSnapshot()).toMatchObject({ state: 'ready', data: ['pending-approval'] });
});
test('an unsupported read after a successful snapshot clears cached records immediately', async () => {
  let removed = false;
  const { projection } = setup({ domains: ['decisions'], read: async () => {
    if (removed) throw new ReadFailure('http_501', false, true, 501); return result(['old-approval']);
  } });
  await tick(); removed = true; projection.refresh(); await tick();
  expect(projection.getSnapshot()).toMatchObject({ state: 'unsupported', data: null, refreshing: false });
});
