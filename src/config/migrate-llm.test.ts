import { describe, expect, it } from 'bun:test';
import { migrateLegacyLLMConfig } from './loader.ts';
import { DEFAULT_CONFIG } from './types.ts';
import type { JarvisConfig } from './types.ts';

function makeConfig(overrides: Partial<JarvisConfig['llm']>): JarvisConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  Object.assign(c.llm, overrides);
  return c;
}

describe('migrateLegacyLLMConfig', () => {
  it('promotes legacy per-provider blocks into providers + derives default from primary', () => {
    const c = makeConfig({
      primary: 'openai',
      openai: { api_key: 'k', model: 'gpt-4o' },
    });
    migrateLegacyLLMConfig(c);
    expect(c.llm.providers?.openai).toBeDefined();
    expect(c.llm.providers!.openai!.api_key).toBe('k');
    // No model in the providers entry - models live in default/tier strings.
    expect((c.llm.providers!.openai as { model?: string }).model).toBeUndefined();
    expect(c.llm.default).toBe('openai:gpt-4o');
  });

  it('skips legacy promotion when the provider entry already exists in new shape', () => {
    const c = makeConfig({
      providers: { openai: { api_key: 'new-key' } },
      openai: { api_key: 'legacy-key', model: 'gpt-3.5' },
    });
    migrateLegacyLLMConfig(c);
    // New-shape entry untouched
    expect(c.llm.providers!.openai!.api_key).toBe('new-key');
  });

  it('converts legacy tier object form to "name:model" strings', () => {
    const c = makeConfig({
      anthropic: { api_key: 'k', model: 'claude-sonnet' },
      tiers: {
        medium: { provider: 'anthropic', model: 'claude-opus' } as never,
      },
    });
    migrateLegacyLLMConfig(c);
    expect(c.llm.tiers!.medium).toBe('anthropic:claude-opus');
  });

  it('falls back to provider default model when tier object has no explicit model', () => {
    const c = makeConfig({
      anthropic: { api_key: 'k', model: 'claude-sonnet' },
      tiers: { high: { provider: 'anthropic' } as never },
    });
    migrateLegacyLLMConfig(c);
    expect(c.llm.tiers!.high).toBe('anthropic:claude-sonnet');
  });

  it('preserves explicit tier strings unchanged', () => {
    const c = makeConfig({
      tiers: { medium: 'openai:gpt-4o-mini' },
    });
    migrateLegacyLLMConfig(c);
    expect(c.llm.tiers!.medium).toBe('openai:gpt-4o-mini');
  });

  it('does not derive default when tiers are already configured', () => {
    const c = makeConfig({
      primary: 'anthropic',
      anthropic: { api_key: 'k', model: 'claude' },
      tiers: { medium: 'openai:gpt-4o' },
    });
    migrateLegacyLLMConfig(c);
    expect(c.llm.default).toBeUndefined();
  });

  it('is idempotent across multiple calls', () => {
    const c = makeConfig({ primary: 'anthropic', anthropic: { api_key: 'k', model: 'claude' } });
    migrateLegacyLLMConfig(c);
    const snap1 = JSON.stringify({ p: c.llm.providers, d: c.llm.default, t: c.llm.tiers });
    migrateLegacyLLMConfig(c);
    expect(JSON.stringify({ p: c.llm.providers, d: c.llm.default, t: c.llm.tiers })).toBe(snap1);
  });

  it('handles missing legacy fields gracefully', () => {
    const c = makeConfig({});
    migrateLegacyLLMConfig(c);
    expect(c.llm.providers).toEqual({});
    expect(c.llm.default).toBeUndefined();
    expect(c.llm.tiers).toEqual({});
  });
});
