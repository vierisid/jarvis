import { describe, expect, it } from 'bun:test';
import { modelForOnboardingTest, onboardingDefaultModelRef } from './llm-setup.ts';

describe('Anthropic onboarding model selection', () => {
  it('omits the curated model when testing a custom endpoint', () => {
    expect(modelForOnboardingTest('anthropic', true, 'claude-fable-5')).toBeUndefined();
  });

  it('keeps the selected model for official Anthropic and other providers', () => {
    expect(modelForOnboardingTest('anthropic', false, 'claude-fable-5')).toBe('claude-fable-5');
    expect(modelForOnboardingTest('openai', true, 'gpt-5-mini')).toBe('gpt-5-mini');
  });

  it('keeps a model picked from the discovered gateway catalog', () => {
    expect(modelForOnboardingTest('anthropic', true, 'gateway-large', ['gateway-fast', 'gateway-large']))
      .toBe('gateway-large');
  });

  it('re-discovers when the selection is not in the known catalog', () => {
    expect(modelForOnboardingTest('anthropic', true, 'claude-fable-5', ['gateway-fast']))
      .toBeUndefined();
  });

  it('saves the validated gateway model ahead of the curated selection', () => {
    expect(onboardingDefaultModelRef('anthropic', 'claude-fable-5', 'gateway-fast'))
      .toBe('anthropic:gateway-fast');
  });
});
