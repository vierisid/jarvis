import { afterEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../../config/types.ts';
import { loadUserSection } from '../user-settings.ts';
import { markTrialInstallOnboarded } from './provision.ts';

const T0 = 1_780_000_000_000;

function aConfig(over: Partial<JarvisConfig> = {}): JarvisConfig {
  return { ...DEFAULT_CONFIG, ...over } as JarvisConfig;
}

describe('a trial install is onboarded without the wizard (D10)', () => {
  afterEach(() => closeDb());

  test('marks setup complete so the founder lands in a working shell', () => {
    initDatabase(':memory:');
    const config = aConfig({ onboarding: undefined });

    const result = markTrialInstallOnboarded(config, T0);

    expect(result).toEqual({ marked: true, setup_completed_at: T0 });
    expect(config.onboarding?.setup_completed_at).toBe(T0);
    // Persisted, not just held in memory: a daemon restart mid-conversation
    // must not drop them into a wizard they were never shown.
    expect((loadUserSection('onboarding') as { setup_completed_at?: number })?.setup_completed_at).toBe(T0);
  });

  test('dismisses the wizard tour, which the room beats replace (D17)', () => {
    initDatabase(':memory:');
    const config = aConfig({ onboarding: undefined });
    markTrialInstallOnboarded(config, T0);
    expect(config.onboarding?.tutorial_dismissed_at).toBe(T0);
  });

  test('does NOT mark the profile skipped — the conductor fills it for real', () => {
    initDatabase(':memory:');
    const config = aConfig({ onboarding: undefined });
    markTrialInstallOnboarded(config, T0);
    expect(config.onboarding?.setup_skipped_profile).toBeUndefined();
  });

  test('is idempotent and never rewrites an existing completion stamp', () => {
    initDatabase(':memory:');
    const config = aConfig({
      onboarding: {
        setup_completed_at: T0 - 999_999,
        tutorial_completed_at: null,
      },
    });

    const result = markTrialInstallOnboarded(config, T0);

    expect(result).toEqual({ marked: false, setup_completed_at: T0 - 999_999 });
    expect(config.onboarding?.setup_completed_at).toBe(T0 - 999_999);
  });
});
