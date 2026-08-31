import { describe, expect, test } from 'bun:test';
import { WARN_PCT as DAEMON_WARN_PCT } from './usage-alerts.ts';
import type { HostedUsageMeter } from './hosted-usage.ts';
import { WARN_PCT as UI_WARN_PCT, type HostedMeter } from '../../ui/src/v2/rooms/usage/hosted-budget.ts';

/**
 * The daemon and the room each declare the meter's shape and its warning
 * threshold, and neither imports the other — the room is bundled for the
 * browser and must not pull daemon code in. Comments in both files say "keep
 * these in step"; this is the thing that actually makes them.
 *
 * A review found the previous attempt tautological: the room's own test
 * asserted the room's own constant, which passes at any value.
 */

describe('the daemon and the Usage room agree', () => {
  test('on the warning threshold', () => {
    // Drift here means a user gets an OS notification while the room still
    // shows a calm bar, or a bar turns amber with no notification behind it.
    expect(UI_WARN_PCT).toBe(DAEMON_WARN_PCT);
  });

  test('on the meter shape, in both directions', () => {
    // Assigning each to the other is the check: a field added, removed or
    // retyped on one side fails to compile here rather than silently rendering
    // `undefined` in the room. `satisfies` keeps this a type assertion that
    // survives the value being unused.
    const fromDaemon: HostedUsageMeter = {
      entitled: true,
      blocked: false,
      sessionPct: 10,
      weekPct: 20,
      sessionResetsAt: '2026-08-26T12:00:00.000Z',
      weekResetsAt: '2026-08-31T00:00:00.000Z',
    };
    const asRoom: HostedMeter = fromDaemon;
    const backAgain: HostedUsageMeter = asRoom;
    expect(Object.keys(backAgain).sort()).toEqual([
      'blocked',
      'entitled',
      'sessionPct',
      'sessionResetsAt',
      'weekPct',
      'weekResetsAt',
    ]);
  });
});
