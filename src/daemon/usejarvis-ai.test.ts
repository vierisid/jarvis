import { test, expect, describe } from 'bun:test';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { applyUsejarvisAi, hasUsejarvisAi, USEJARVIS_PROVIDER_NAME } from './usejarvis-ai.ts';

const base = (): JarvisConfig => structuredClone(DEFAULT_CONFIG);

const hosted = (): JarvisConfig => {
  const config = base();
  config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc123' };
  return config;
};

describe('applyUsejarvisAi (fill-if-silent over every DB merge)', () => {
  test('no-op on self-hosted installs (block absent or incomplete)', () => {
    const config = base();
    applyUsejarvisAi(config);
    expect(config.llm.providers?.[USEJARVIS_PROVIDER_NAME]).toBeUndefined();
    expect(hasUsejarvisAi(config)).toBe(false);

    const partial = base();
    partial.usejarvis_ai = { base_url: 'https://llm.usejarvis.host' }; // no key
    applyUsejarvisAi(partial);
    expect(partial.llm.providers?.[USEJARVIS_PROVIDER_NAME]).toBeUndefined();
  });

  test('injects the provider and fills every silent tier with uj-* aliases', () => {
    const config = hosted();
    applyUsejarvisAi(config);
    expect(config.llm.providers![USEJARVIS_PROVIDER_NAME]).toEqual({
      kind: 'usejarvis_ai',
      base_url: 'https://llm.usejarvis.host',
      api_key: 'sk-uj-abc123',
    });
    expect(config.llm.tiers).toEqual({
      conversation: 'usejarvis_ai:uj-chat',
      low: 'usejarvis_ai:uj-low',
      medium: 'usejarvis_ai:uj-medium',
      high: 'usejarvis_ai:uj-high',
    });
  });

  test("a user's dashboard tier choice wins for THAT slot; the rest default", () => {
    const config = hosted();
    config.llm.providers = { anthropic: { api_key: 'sk-ant-user' } };
    config.llm.tiers = { high: 'anthropic:claude-x' };
    applyUsejarvisAi(config);
    expect(config.llm.tiers!.high).toBe('anthropic:claude-x'); // user wins
    expect(config.llm.tiers!.low).toBe('usejarvis_ai:uj-low'); // silence filled
    expect(config.llm.providers!.anthropic).toEqual({ api_key: 'sk-ant-user' }); // untouched
  });

  test('single-model mode (llm.default) disables tier-filling entirely', () => {
    const config = hosted();
    config.llm.default = 'anthropic:claude-x';
    applyUsejarvisAi(config);
    expect(config.llm.tiers ?? {}).toEqual({});
    // ...but the provider is still injected (it must always exist).
    expect(config.llm.providers![USEJARVIS_PROVIDER_NAME]).toBeDefined();
  });

  test('a DB row squatting on the reserved name is overwritten, not merged', () => {
    const config = hosted();
    config.llm.providers = {
      [USEJARVIS_PROVIDER_NAME]: { kind: 'openai', base_url: 'https://evil.example' },
    };
    applyUsejarvisAi(config);
    expect(config.llm.providers[USEJARVIS_PROVIDER_NAME]).toEqual({
      kind: 'usejarvis_ai',
      base_url: 'https://llm.usejarvis.host',
      api_key: 'sk-uj-abc123',
    });
  });

  test('idempotent: applying twice equals applying once', () => {
    const once = hosted();
    applyUsejarvisAi(once);
    const twice = hosted();
    applyUsejarvisAi(twice);
    applyUsejarvisAi(twice);
    expect(twice.llm).toEqual(once.llm);
  });
});
