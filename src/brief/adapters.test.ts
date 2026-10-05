import { expect, test } from 'bun:test';
import { BriefCapabilities } from './capabilities.ts';
import { projectLegacyGoal, projectWorkflowRef, readBriefProvider } from './adapters.ts';
import type { BriefReadProvider } from './providers.ts';
import type { BriefReadResult } from './contracts.ts';
import type { Goal } from '../goals/types.ts';
import type { BriefReadProviders } from './providers.ts';
import { registerConversations } from './registrations/conversations.ts';
import { registerDecisions } from './registrations/decisions.ts';
import { createBriefCapabilities } from './registrations/index.ts';

function fixture() {
  let calls = 0;
  const provider: BriefReadProvider<{ query: string }, string[]> = {
    readiness: () => 'ready',
    read: async query => { calls++; return { state: 'ready', data: [query.query], asOf: 12 }; },
  };
  return { provider, calls: () => calls };
}

test('an independent optional reader fails closed without another feature module', async () => {
  const { provider, calls } = fixture();
  const registry = new BriefCapabilities();
  expect(await readBriefProvider(registry, 'decisions', undefined, {})).toEqual({ state: 'unsupported' });
  expect(await readBriefProvider(registry, 'decisions', provider, { query: 'no' })).toEqual({ state: 'unsupported' });
  expect(calls()).toBe(0);
});

test('typed feature registrations compile and read independently of an absent collaborator', async () => {
  const providers: BriefReadProviders = {
    conversations: { readiness: () => 'ready', read: async () => ({ state: 'ready', data: { items: [], nextCursor: null }, asOf: 1 }) },
  };
  const registry = createBriefCapabilities([
    ...registerConversations(providers.conversations), ...registerDecisions(providers.decisions),
  ], ['conversations', 'decisions']);
  expect(await readBriefProvider(registry, 'conversations', providers.conversations, { limit: 5 }))
    .toEqual({ state: 'ready', data: { items: [], nextCursor: null }, asOf: 1 });
  expect(await readBriefProvider(registry, 'decisions', providers.decisions, {})).toEqual({ state: 'unsupported' });
  expect(registry.snapshot().capabilities.decisions.enabled).toBe(false);
});

test('disabled and dependency-blocked readers never invoke their data handler', async () => {
  const { provider, calls } = fixture();
  const disabled = new BriefCapabilities([{ id: 'decisions', provider }]);
  expect(await readBriefProvider(disabled, 'decisions', provider, { query: 'no' })).toEqual({ state: 'unavailable', reason: 'disabled' });
  const blocked = new BriefCapabilities([{ id: 'recommendations', provider }], ['recommendations']);
  expect(await readBriefProvider(blocked, 'recommendations', provider, { query: 'no' })).toEqual({ state: 'unavailable', reason: 'dependency_not_ready' });
  expect(calls()).toBe(0);
});

test('only the registered provider can be used, and ready reads preserve the supplied query', async () => {
  const { provider, calls } = fixture();
  const registry = new BriefCapabilities([{ id: 'decisions', provider }], ['decisions']);
  expect(await readBriefProvider(registry, 'decisions', fixture().provider, { query: 'wrong' })).toEqual({ state: 'unsupported' });
  expect(await readBriefProvider(registry, 'decisions', provider, { query: 'original' })).toEqual({ state: 'ready', data: ['original'], asOf: 12 });
  expect(calls()).toBe(1);
});

test.each(['loading', 'unavailable'] as const)('provider %s is not an empty collection', async state => {
  const provider: BriefReadProvider<void, string[]> = { readiness: () => state, read: async () => { throw new Error('Must not read'); } };
  const registry = new BriefCapabilities([{ id: 'decisions', provider }], ['decisions']);
  expect(await readBriefProvider(registry, 'decisions', provider, undefined)).toEqual(state === 'loading'
    ? { state: 'loading' } : { state: 'unavailable', reason: 'provider_unavailable' });
});

test('stale and empty results remain distinct and preserve their as-of times', async () => {
  for (const result of [
    { state: 'stale', data: ['old'], asOf: 4 }, { state: 'empty', asOf: 5 },
  ] satisfies BriefReadResult<string[]>[]) {
    const provider: BriefReadProvider<void, string[]> = { readiness: () => 'ready', read: async () => result };
    const registry = new BriefCapabilities([{ id: 'decisions', provider }], ['decisions']);
    expect(await readBriefProvider(registry, 'decisions', provider, undefined)).toEqual(result);
  }
});

test('failed reads redact internal error details', async () => {
  const provider: BriefReadProvider<void, string[]> = { readiness: () => 'ready', read: async () => { throw new Error('secret://token'); } };
  const registry = new BriefCapabilities([{ id: 'decisions', provider }], ['decisions']);
  expect(await readBriefProvider(registry, 'decisions', provider, undefined)).toEqual({ state: 'unavailable', reason: 'provider_unavailable' });
});

test('legacy goal projections preserve source identity and never infer measured counts', () => {
  const goal = { id: 'goal-original', updated_at: 100, score: 0.6, health: 'on_track', status: 'active' } as Goal;
  expect(projectLegacyGoal(goal)).toEqual({ goalId: 'goal-original', revision: '100', score: 0.6, health: 'on_track', status: 'active', measurement: null });
  expect(goal).not.toHaveProperty('measurement');
});

test('workflow projection keeps activation and version lifecycle distinct and rejects foreign versions', () => {
  for (const activation of ['ENABLED', 'DISABLED'] as const) {
    for (const versionState of ['DRAFT', 'LOCKED'] as const) {
      expect(projectWorkflowRef({ id: 'f', status: activation }, { id: 'v', flowId: 'f', state: versionState }))
        .toEqual({ flowId: 'f', versionId: 'v', activation, versionState });
    }
  }
  expect(() => projectWorkflowRef({ id: 'a', status: 'DISABLED' }, { id: 'v', flowId: 'b', state: 'LOCKED' })).toThrow('different flow');
});
