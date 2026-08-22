import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { resolveRealtimeVoice } from '../config/realtime.ts';
import { TRIAL_DURATION_MS, TRIAL_MAX_SESSION_MINUTES, type TrialEntitlement } from './entitlement.ts';
import { withTrialRealtime } from './realtime-overlay.ts';

const T0 = 1_780_000_000_000;

function grant(over: Partial<TrialEntitlement> = {}): TrialEntitlement {
  return {
    version: 1,
    id: 'g',
    account_id: null,
    issuer: 'local_stub',
    issued_at: T0,
    duration_ms: TRIAL_DURATION_MS,
    started_at: null,
    expires_at: null,
    state: 'issued',
    realtime: { enabled: true, max_session_minutes: TRIAL_MAX_SESSION_MINUTES },
    opening_completed_at: null,
    ...over,
  };
}

/** A config shaped like a real install: realtime off, a BYO OpenAI key. */
function aConfig(over: Partial<JarvisConfig> = {}): JarvisConfig {
  return {
    ...DEFAULT_CONFIG,
    llm: {
      ...DEFAULT_CONFIG.llm,
      providers: { openai: { api_key: 'sk-test' } },
    },
    ...over,
  } as JarvisConfig;
}

describe('the config of everyone who is not in a trial is untouched', () => {
  test('no entitlement returns the SAME object, not a clone', () => {
    const cfg = aConfig();
    expect(withTrialRealtime(cfg, null, T0)).toBe(cfg);
  });

  test('an expired trial returns the same object', () => {
    const cfg = aConfig();
    const expired = grant({ started_at: T0, expires_at: T0 + TRIAL_DURATION_MS, state: 'active' });
    expect(withTrialRealtime(cfg, expired, T0 + TRIAL_DURATION_MS + 1)).toBe(cfg);
  });

  test('a grant that does not include realtime returns the same object', () => {
    const cfg = aConfig();
    const noVoice = grant({ realtime: { enabled: false, max_session_minutes: 10 } });
    expect(withTrialRealtime(cfg, noVoice, T0)).toBe(cfg);
  });

  test('realtime stays off for them, exactly as it ships', () => {
    const cfg = aConfig();
    expect(resolveRealtimeVoice(withTrialRealtime(cfg, null, T0)).ok).toBe(false);
  });
});

describe('D1: a running trial gets realtime, uncapped', () => {
  test('turns it on and lifts the 10-minute cap to the length of the trial', () => {
    const res = resolveRealtimeVoice(withTrialRealtime(aConfig(), grant(), T0));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.maxSessionMinutes).toBe(TRIAL_MAX_SESSION_MINUTES);
    expect(res.resolved.maxSessionMinutes * 60_000).toBe(TRIAL_DURATION_MS);
  });

  test('applies before the founder has spoken, the clock has not started yet', () => {
    const unstarted = grant({ started_at: null, state: 'issued' });
    expect(resolveRealtimeVoice(withTrialRealtime(aConfig(), unstarted, T0)).ok).toBe(true);
  });

  test('does not mutate the config it was handed', () => {
    const cfg = aConfig();
    withTrialRealtime(cfg, grant(), T0);
    expect(cfg.voice?.realtime?.enabled).toBe(false);
    expect(cfg.voice?.realtime?.max_session_minutes).toBe(10);
  });

  test("leaves the founder's own spend ceiling alone", () => {
    // D1 removes OUR rationing of the trial. It does not authorise spending a
    // founder's own OpenAI credit past a limit they set for themselves.
    const cfg = aConfig({
      voice: {
        wake_engine: 'openwakeword',
        realtime: { enabled: false, max_session_minutes: 10, monthly_budget_usd: 25 },
      },
    });
    const res = resolveRealtimeVoice(withTrialRealtime(cfg, grant(), T0));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.monthlyBudgetUsd).toBe(25);
  });

  test('leaves the destructive-category backstop alone', () => {
    const res = resolveRealtimeVoice(withTrialRealtime(aConfig(), grant(), T0));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.blockedCategories).toContain('delete_data');
    expect(res.resolved.blockedCategories).toContain('make_payment');
  });

  test('keeps the voice and model the install already chose', () => {
    const cfg = aConfig({
      voice: {
        wake_engine: 'webspeech',
        realtime: { enabled: false, model: 'gpt-realtime-2', voice: 'cedar', reasoning_effort: 'medium' },
      },
    });
    const overlaid = withTrialRealtime(cfg, grant(), T0);
    expect(overlaid.voice?.wake_engine).toBe('webspeech');
    const res = resolveRealtimeVoice(overlaid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.voice).toBe('cedar');
    expect(res.resolved.reasoningEffort).toBe('medium');
  });
});
