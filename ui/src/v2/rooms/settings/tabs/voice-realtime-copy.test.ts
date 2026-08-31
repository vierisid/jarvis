import { describe, expect, test } from 'bun:test';
import {
  realtimeBillingCopy,
  realtimeChip,
  realtimeUnavailableReason,
  showsPlanDefaultHint,
  type RealtimeCopyInput,
} from './voice-realtime-copy.ts';

const rt = (over: Partial<RealtimeCopyInput> = {}): RealtimeCopyInput => ({
  enabled: true,
  available: true,
  servedByPlan: true,
  enabledDefault: false,
  ...over,
});

describe('the status chip', () => {
  test('names the REAL reason a plan-served session is unavailable', () => {
    // "No OpenAI key" told a hosted tenant to add a key that does not exist for
    // them, and implied a bill they do not pay.
    expect(realtimeChip(rt({ available: false })).label).toBe('Not in your plan');
  });

  test('still says "No OpenAI key" where that is actually the problem', () => {
    expect(realtimeChip(rt({ available: false, servedByPlan: false })).label).toBe('No OpenAI key');
  });

  test('off and active read the same either way', () => {
    expect(realtimeChip(rt({ enabled: false })).label).toBe('Off');
    expect(realtimeChip(rt({ enabled: false, servedByPlan: false })).label).toBe('Off');
    expect(realtimeChip(rt()).label).toBe('Active');
    expect(realtimeChip(rt({ servedByPlan: false })).label).toBe('Active');
    expect(realtimeChip(null).label).toBe('Off');
  });
});

describe('the billing sentence', () => {
  test('does not flip when the tenant turns realtime OFF', () => {
    // It renders beside the toggle, i.e. to someone deciding whether to switch
    // it on. Deriving it from the live resolution made it say "you are billed
    // by OpenAI, ~$0.30/min" to a hosted tenant with realtime off.
    expect(realtimeBillingCopy(rt({ enabled: false }))).toBe('plan');
    expect(realtimeBillingCopy(rt({ enabled: true }))).toBe('plan');
  });

  test('does not flip when the plan turns out to exclude realtime', () => {
    // Who would serve it and whether you may have it are different questions.
    expect(realtimeBillingCopy(rt({ available: false }))).toBe('plan');
  });

  test('says BYO only where the user really is billed', () => {
    expect(realtimeBillingCopy(rt({ servedByPlan: false }))).toBe('byo');
    expect(realtimeBillingCopy(null)).toBe('byo');
  });
});

describe('the remaining surfaces', () => {
  test('the unavailable hint agrees with the chip', () => {
    // Three surfaces disagreeing about the same fact is how this feature got
    // through five review rounds still lying on one of them.
    for (const servedByPlan of [true, false]) {
      const input = rt({ available: false, servedByPlan });
      const chipSaysPlan = realtimeChip(input).label === 'Not in your plan';
      expect(realtimeUnavailableReason(input) === 'plan').toBe(chipSaysPlan);
      expect(realtimeBillingCopy(input) === 'plan').toBe(servedByPlan);
    }
  });

  test('the plan-default hint stays hidden while the verdict is still unknown-but-off', () => {
    expect(showsPlanDefaultHint(rt({ enabledDefault: true }))).toBe(true);
    expect(showsPlanDefaultHint(rt({ enabledDefault: true, available: false }))).toBe(false);
    expect(showsPlanDefaultHint(rt({ enabledDefault: false }))).toBe(false);
  });
});
