import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketService } from './ws-service.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { clearTrialEntitlement, issueTrialEntitlement, markConductorFinished, startTrialClock } from '../trial/entitlement.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { DayOneDirector } from './trial/day-one-director.ts';

/**
 * The claim this file exists to make checkable: **a founder who is not in a
 * trial is not affected by any of day one.**
 *
 * Day one adds one branch to three of the daemon's ambient speech paths, one
 * call on `chat`, one on connect and one at start-up. Every one of them reads
 * `this.dayOne`, which is null unless a conductor has handed over. These tests
 * drive the real service with no entitlement and assert that nothing is
 * constructed, nothing is written and nothing is held back.
 */

let tmp: string | null = null;
afterEach(() => {
  clearTrialEntitlement();
  closeDb();
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function makeService(dataDir: string) {
  const config = {
    daemon: { data_dir: dataDir },
    voice: { wake_engine: 'openwakeword', realtime: { enabled: false, max_session_minutes: 10 } },
    llm: { providers: {} },
  } as unknown as JarvisConfig;
  const fakeAgent = { setDelegationCallback: () => {}, getConfig: () => config } as never;
  const svc = new WebSocketService(0, fakeAgent);
  const internals = svc as unknown as {
    dayOne: DayOneDirector | null;
    resumeDayOne: () => void;
    beginDayOne: (beats: unknown, at: number) => void;
  };
  return { svc, internals, ledger: join(dataDir, 'trial-day-one.json') };
}

describe('an install with no trial is untouched by day one', () => {
  test('no director is constructed and no ledger is written', () => {
    initDatabase(':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'no-trial-'));
    const { svc, internals, ledger } = makeService(tmp);

    internals.resumeDayOne();

    expect(internals.dayOne).toBeNull();
    expect(svc.getDayOne()).toBeNull();
    expect(existsSync(ledger)).toBe(false);
  });

  test('every ambient suggestion still speaks, and the governor never looks at it', () => {
    initDatabase(':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'no-trial-'));
    const { svc } = makeService(tmp);

    // Including the ones day one would refuse outright: a break reminder with
    // nothing on offer that names nothing of anybody's.
    expect(svc.allowAmbientSpeech({ type: 'break', title: 'Time for a break?', body: '90 minutes' })).toBe(true);
    expect(svc.allowAmbientSpeech({ type: 'error', title: 'x', body: 'y' })).toBe(true);
    expect(svc.allowAmbientSpeech({ type: 'automation', title: 'x', body: 'y', wouldDo: '' })).toBe(true);
  });

  test('the engagement counter is a no-op rather than a throw', () => {
    initDatabase(':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'no-trial-'));
    const { svc } = makeService(tmp);
    expect(() => svc.noteDayOneEngagement()).not.toThrow();
  });
});

describe('a trial whose conductor has not finished', () => {
  test('does not resume day one, because it has not started one', () => {
    initDatabase(':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'mid-trial-'));
    issueTrialEntitlement();
    startTrialClock(Date.now());

    const { internals, ledger } = makeService(tmp);
    internals.resumeDayOne();

    expect(internals.dayOne).toBeNull();
    expect(existsSync(ledger)).toBe(false);
  });
});

describe('a trial whose conductor HAS finished', () => {
  test('resumes day one at start-up, so a daemon restart does not end the afternoon', () => {
    initDatabase(':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'day-one-'));
    issueTrialEntitlement();
    startTrialClock(Date.now());
    markConductorFinished(Date.now());

    const { svc, internals, ledger } = makeService(tmp);
    internals.resumeDayOne();

    expect(internals.dayOne).not.toBeNull();
    expect(svc.getDayOne()!.running()).toBe(true);
    expect(existsSync(ledger)).toBe(true);
    svc.getDayOne()!.stop();
  });

  test('and the governor is live: nothing gets through that day one refuses', () => {
    initDatabase(':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'day-one-'));
    issueTrialEntitlement();
    startTrialClock(Date.now() - 3 * 60 * 60_000);
    // Two hours ago, so the ten-minute settle after the handover is long past
    // and every refusal below is the gate it says it is rather than the clock.
    markConductorFinished(Date.now() - 2 * 60 * 60_000);

    const { svc, internals } = makeService(tmp);
    internals.resumeDayOne();

    // Silent by type.
    expect(svc.allowAmbientSpeech({ type: 'break', title: 'Time for a break?', body: '90 minutes', wouldDo: 'x' })).toBe(false);
    // Nothing on offer, and nothing of theirs named either.
    expect(svc.allowAmbientSpeech({ type: 'error', title: 'x', body: 'y', wouldDo: '' })).toBe(false);
    // An offer, but about nothing of theirs. Worth reading twice: this vault
    // is EMPTY, so on a resumed day one with no objective, no board and no
    // landed names, nothing clears gate 5 and day one is silent. That is the
    // right way round for it to fail, and it is why the bar is stated as
    // "names something the two of them made this morning" rather than as a
    // number of interruptions.
    expect(svc.allowAmbientSpeech({ type: 'error', title: 'Steam', body: 'shader stall', wouldDo: 'fix it' })).toBe(false);
    svc.getDayOne()!.stop();
  });
});
