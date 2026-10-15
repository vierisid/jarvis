import { expect, test } from 'bun:test';
import { BriefCapabilities, BRIEF_CAPABILITIES, BRIEF_CAPABILITY_IDS, isBriefCapabilityEnabled, type BriefCapabilityId } from './capabilities.ts';
import type { BriefProvider } from './providers.ts';
import { createBriefCapabilities } from './registrations/index.ts';

const ready: BriefProvider = { readiness: () => 'ready' };

test('production registration enables nothing, even when activation is requested without providers', () => {
  for (const registry of [createBriefCapabilities(), new BriefCapabilities([], BRIEF_CAPABILITY_IDS)]) {
    const snapshot = registry.snapshot();
    expect(snapshot.contractVersion).toBe(1);
    expect(snapshot.asOf).toBeGreaterThan(0);
    for (const id of BRIEF_CAPABILITY_IDS) {
      expect(snapshot.capabilities[id]).toMatchObject({ supported: false, ready: false, enabled: false, state: 'unsupported' });
      expect(isBriefCapabilityEnabled(snapshot, id)).toBe(false);
    }
  }
});

test('installed and ready does not activate a feature without an explicit selection', () => {
  const snapshot = new BriefCapabilities([{ id: 'conversations', provider: ready }]).snapshot();
  expect(snapshot.capabilities.conversations).toEqual({ supported: true, ready: true, enabled: false, state: 'ready', reason: 'disabled' });
});

test('readiness changes are reflected without restarting or retaining a stale true flag', () => {
  let state: ReturnType<BriefProvider['readiness']> = 'ready';
  const registry = new BriefCapabilities([{ id: 'conversations', provider: { readiness: () => state } }], ['conversations']);
  expect(isBriefCapabilityEnabled(registry.snapshot(), 'conversations')).toBe(true);
  for (const next of ['loading', 'unavailable'] as const) {
    state = next;
    expect(registry.snapshot().capabilities.conversations).toMatchObject({ supported: true, ready: false, enabled: false, state: next });
  }
});

test('transitive activation dependencies must themselves be enabled', () => {
  const registrations = ['conversations', 'chatTransport', 'chatState'].map(id => ({ id: id as BriefCapabilityId, provider: ready }));
  const missing = new BriefCapabilities(registrations, ['chatTransport', 'chatState']).snapshot();
  expect(missing.capabilities.chatTransport.reason).toBe('dependency_not_ready');
  expect(missing.capabilities.chatState.enabled).toBe(false);
  const complete = new BriefCapabilities(registrations, ['conversations', 'chatTransport', 'chatState']).snapshot();
  expect(isBriefCapabilityEnabled(complete, 'chatState')).toBe(true);
});

test('dependency failure disables consumers on the next snapshot', () => {
  let state: ReturnType<BriefProvider['readiness']> = 'ready';
  const registry = new BriefCapabilities([
    { id: 'memoryUsage', provider: { readiness: () => state } },
    { id: 'memoryStream', provider: ready },
  ], ['memoryStream', 'memoryUsage']);
  expect(registry.snapshot().capabilities.memoryStream.enabled).toBe(true);
  state = 'unavailable';
  expect(registry.snapshot().capabilities.memoryStream).toMatchObject({ ready: true, enabled: false, reason: 'dependency_not_ready' });
});

test.each([() => { throw new Error('secret://credential'); }, () => true, () => null, () => 'READY'])(
  'failed or malformed provider readiness fails closed without serializing internals', readiness => {
    const registry = new BriefCapabilities([{ id: 'decisions', provider: { readiness } as BriefProvider }], ['decisions']);
    const snapshot = registry.snapshot();
    expect(snapshot.capabilities.decisions).toMatchObject({ ready: false, enabled: false, state: 'unavailable', reason: 'provider_unavailable' });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  },
);

test('duplicate and unknown registrations fail early, and registries do not share state', () => {
  expect(() => new BriefCapabilities([{ id: 'conversations', provider: ready }, { id: 'conversations', provider: ready }])).toThrow('Duplicate');
  expect(() => new BriefCapabilities([{ id: 'constructor' as BriefCapabilityId, provider: ready }])).toThrow('Unknown');
  expect(() => new BriefCapabilities([], ['unknown' as BriefCapabilityId])).toThrow('Unknown');
  expect(() => new BriefCapabilities([{ id: 'conversations', provider: {} as BriefProvider }])).toThrow('Missing');
  const active = new BriefCapabilities([{ id: 'conversations', provider: ready }], ['conversations']);
  expect(active.snapshot().capabilities.conversations.enabled).toBe(true);
  expect(new BriefCapabilities().snapshot().capabilities.conversations.enabled).toBe(false);
});

test.each([null, {}, { error: 'Not found' }, { contractVersion: 2, capabilities: {} }, { contractVersion: 1, capabilities: null }])(
  'old or unsupported server response cannot enable new controls: %j', snapshot => {
    expect(isBriefCapabilityEnabled(snapshot, 'conversations')).toBe(false);
  },
);

test('v1 clients accept additive fields but reject inconsistent booleans or unknown capability IDs', () => {
  const snapshot = new BriefCapabilities([{ id: 'conversations', provider: ready }], ['conversations']).snapshot();
  expect(isBriefCapabilityEnabled({ ...snapshot, futureField: 'ignored' }, 'conversations')).toBe(true);
  for (const patch of [{ ready: false }, { enabled: 'true' }, { supported: false }, { state: 'unavailable' }, { reason: 'disabled' }]) {
    expect(isBriefCapabilityEnabled({ ...snapshot, capabilities: { conversations: { ...snapshot.capabilities.conversations, ...patch } } }, 'conversations')).toBe(false);
  }
  expect(isBriefCapabilityEnabled({ ...snapshot, capabilities: { futureFeature: snapshot.capabilities.conversations } }, 'futureFeature' as BriefCapabilityId)).toBe(false);
});

test('the fixed activation graph has only known dependencies and no cycles', () => {
  function walk(id: BriefCapabilityId, stack: BriefCapabilityId[]) {
    expect(stack).not.toContain(id);
    expect(BRIEF_CAPABILITY_IDS).toContain(id);
    for (const dependency of BRIEF_CAPABILITIES[id]) walk(dependency, [...stack, id]);
  }
  for (const id of BRIEF_CAPABILITY_IDS) walk(id, []);
});

test('contracts and capability consumer bundle for a browser without importing backend implementations', async () => {
  const result = await Bun.build({ entrypoints: [`${import.meta.dir}/contracts.ts`, `${import.meta.dir}/capabilities.ts`], target: 'browser' });
  expect(result.success).toBe(true);
  for (const output of result.outputs) expect(await output.text()).not.toContain('bun:sqlite');
});
