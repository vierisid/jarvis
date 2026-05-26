import { describe, expect, it } from 'bun:test';
import { resolveTier, validateTierMap, type TierMap } from './tiers.ts';

describe('resolveTier', () => {
  it('returns the requested tier when configured', () => {
    const tiers: TierMap = {
      medium: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      low: { provider: 'groq', model: 'llama-3.3-70b' },
    };
    const r = resolveTier('low', tiers);
    expect(r).not.toBeNull();
    expect(r!.tier).toBe('low');
    expect(r!.assignment.provider).toBe('groq');
  });

  it('falls up low -> medium', () => {
    const tiers: TierMap = {
      medium: { provider: 'anthropic' },
    };
    const r = resolveTier('low', tiers);
    expect(r!.tier).toBe('medium');
    expect(r!.assignment.provider).toBe('anthropic');
  });

  it('falls up low -> medium -> high', () => {
    const tiers: TierMap = {
      high: { provider: 'anthropic' },
    };
    const r = resolveTier('low', tiers);
    expect(r!.tier).toBe('high');
  });

  it('falls medium -> high', () => {
    const tiers: TierMap = {
      high: { provider: 'anthropic' },
    };
    expect(resolveTier('medium', tiers)!.tier).toBe('high');
  });

  it('falls high -> medium', () => {
    const tiers: TierMap = {
      medium: { provider: 'anthropic' },
    };
    expect(resolveTier('high', tiers)!.tier).toBe('medium');
  });

  it('conversation does NOT fall up - returns null when unset', () => {
    const tiers: TierMap = {
      medium: { provider: 'anthropic' },
      high: { provider: 'anthropic' },
    };
    expect(resolveTier('conversation', tiers)).toBeNull();
  });

  it('returns null when nothing is configured', () => {
    expect(resolveTier('low', {})).toBeNull();
    expect(resolveTier('medium', {})).toBeNull();
    expect(resolveTier('high', {})).toBeNull();
    expect(resolveTier('conversation', {})).toBeNull();
  });
});

describe('validateTierMap', () => {
  it('requires at least medium or high', () => {
    expect(validateTierMap({})).not.toBeNull();
    expect(validateTierMap({ low: { provider: 'groq' } })).not.toBeNull();
    expect(validateTierMap({ conversation: { provider: 'openai' } })).not.toBeNull();
  });

  it('passes when medium is set', () => {
    expect(validateTierMap({ medium: { provider: 'anthropic' } })).toBeNull();
  });

  it('passes when high is set', () => {
    expect(validateTierMap({ high: { provider: 'anthropic' } })).toBeNull();
  });
});
