import { describe, expect, it } from 'bun:test';
import { migrateLegacyLLMConfig } from './loader.ts';
import { DEFAULT_CONFIG } from './types.ts';
import type { JarvisConfig } from './types.ts';

function makeConfig(overrides: Partial<JarvisConfig['llm']>): JarvisConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  Object.assign(c.llm, overrides);
  return c;
}

function readTiers(c: JarvisConfig): NonNullable<JarvisConfig['llm']['tiers']> {
  return (c.llm.tiers ?? {}) as NonNullable<JarvisConfig['llm']['tiers']>;
}

describe('migrateLegacyLLMConfig', () => {
  it('derives medium tier from legacy primary when no tiers set', () => {
    const c = makeConfig({
      primary: 'openai',
      openai: { api_key: 'k', model: 'gpt-4o' },
    });
    c.llm.tiers = undefined;
    migrateLegacyLLMConfig(c);
    const tiers = readTiers(c);
    expect(tiers.medium).toBeDefined();
    expect(tiers.medium!.provider).toBe('openai');
    expect(tiers.medium!.model).toBe('gpt-4o');
  });

  it('leaves explicit tiers alone', () => {
    const c = makeConfig({
      primary: 'openai',
      tiers: {
        medium: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      },
    });
    migrateLegacyLLMConfig(c);
    const tiers = readTiers(c);
    expect(tiers.medium!.provider).toBe('anthropic');
    expect(tiers.medium!.model).toBe('claude-sonnet-4-6');
  });

  it('leaves explicit low/high tiers alone (does not synthesize medium)', () => {
    const c = makeConfig({
      primary: 'anthropic',
      tiers: { high: { provider: 'anthropic' } },
    });
    migrateLegacyLLMConfig(c);
    const tiers = readTiers(c);
    // medium not synthesized because high is already set
    expect(tiers.medium).toBeUndefined();
    expect(tiers.high!.provider).toBe('anthropic');
  });

  it('is idempotent across multiple calls', () => {
    const c = makeConfig({ primary: 'anthropic', anthropic: { api_key: 'k', model: 'claude' } });
    c.llm.tiers = undefined;
    migrateLegacyLLMConfig(c);
    const snap1 = JSON.stringify(c.llm.tiers);
    migrateLegacyLLMConfig(c);
    expect(JSON.stringify(c.llm.tiers)).toBe(snap1);
  });

  it('initializes empty tiers object even without primary', () => {
    const c = makeConfig({ primary: '' });
    c.llm.tiers = undefined;
    migrateLegacyLLMConfig(c);
    const tiers = readTiers(c);
    expect(Object.keys(tiers).length).toBe(0);
  });
});
