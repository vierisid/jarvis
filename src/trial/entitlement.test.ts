import { afterEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import {
  NO_TRIAL,
  TRIAL_DURATION_MS,
  TRIAL_MAX_SESSION_MINUTES,
  clearTrialEntitlement,
  isTrialRunning,
  issueTrialEntitlement,
  markOpeningCompleted,
  parseTrialEntitlement,
  readTrialEntitlement,
  resolveTrialState,
  seedTrialFromEnv,
  snapshotOf,
  startTrialClock,
  startedEntitlement,
  trialSnapshot,
  type TrialEntitlement,
} from './entitlement.ts';

const T0 = 1_780_000_000_000;

function anEntitlement(over: Partial<TrialEntitlement> = {}): TrialEntitlement {
  return {
    version: 1,
    id: 'grant-1',
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

describe('trial state, derived not trusted', () => {
  test('an unstarted grant is `issued` however long it sits there', () => {
    const e = anEntitlement();
    expect(resolveTrialState(e, T0)).toBe('issued');
    expect(resolveTrialState(e, T0 + 30 * 24 * 60 * 60 * 1000)).toBe('issued');
  });

  test('expiry is computed at read time, not read from the row', () => {
    // The row still SAYS active, this is what a daemon that was killed
    // mid-trial and restarted three days later finds on disk.
    const e = anEntitlement({ started_at: T0, expires_at: T0 + TRIAL_DURATION_MS, state: 'active' });
    expect(resolveTrialState(e, T0 + TRIAL_DURATION_MS - 1)).toBe('active');
    expect(resolveTrialState(e, T0 + TRIAL_DURATION_MS)).toBe('expired');
    expect(resolveTrialState(e, T0 + TRIAL_DURATION_MS + 1)).toBe('expired');
  });

  test('the opening may run before the clock starts, but never after it ends', () => {
    expect(isTrialRunning(null, T0)).toBe(false);
    expect(isTrialRunning(anEntitlement(), T0)).toBe(true);
    const started = startedEntitlement(anEntitlement(), T0);
    expect(isTrialRunning(started, T0 + 1000)).toBe(true);
    expect(isTrialRunning(started, T0 + TRIAL_DURATION_MS)).toBe(false);
  });
});

describe('D9: the clock starts at the first spoken word', () => {
  test('starting stamps 48 hours from THAT moment, not from issue', () => {
    const issuedLongAgo = anEntitlement({ issued_at: T0 - 5 * 24 * 60 * 60 * 1000 });
    const started = startedEntitlement(issuedLongAgo, T0);
    expect(started.started_at).toBe(T0);
    expect(started.expires_at).toBe(T0 + TRIAL_DURATION_MS);
    expect(started.state).toBe('active');
  });

  test('starting twice cannot move the deadline, and returns the SAME object', () => {
    const first = startedEntitlement(anEntitlement(), T0);
    const second = startedEntitlement(first, T0 + 60_000);
    // Reference equality is the contract: the caller fires this on every
    // utterance, so "already started" has to be free and inert.
    expect(second).toBe(first);
    expect(second.expires_at).toBe(T0 + TRIAL_DURATION_MS);
  });
});

describe('snapshot', () => {
  test('no grant reads as no trial', () => {
    expect(snapshotOf(null, T0)).toEqual(NO_TRIAL);
  });

  test('an unstarted grant reports no remaining time rather than a full 48h', () => {
    const s = snapshotOf(anEntitlement(), T0);
    expect(s.present).toBe(true);
    expect(s.state).toBe('issued');
    expect(s.ms_remaining).toBeNull();
  });

  test('remaining time never goes negative', () => {
    const e = startedEntitlement(anEntitlement(), T0);
    expect(snapshotOf(e, T0 + TRIAL_DURATION_MS / 2).ms_remaining).toBe(TRIAL_DURATION_MS / 2);
    expect(snapshotOf(e, T0 + TRIAL_DURATION_MS * 3).ms_remaining).toBe(0);
  });
});

describe('parsing an untrusted record', () => {
  test('garbage reads as no trial, never as a trial that cannot expire', () => {
    expect(parseTrialEntitlement(null)).toBeNull();
    expect(parseTrialEntitlement('nope')).toBeNull();
    expect(parseTrialEntitlement([])).toBeNull();
    expect(parseTrialEntitlement({ ...anEntitlement(), version: 2 })).toBeNull();
    expect(parseTrialEntitlement({ ...anEntitlement(), id: '' })).toBeNull();
    expect(parseTrialEntitlement({ ...anEntitlement(), issuer: 'someone_else' })).toBeNull();
    expect(parseTrialEntitlement({ ...anEntitlement(), duration_ms: 0 })).toBeNull();
    expect(parseTrialEntitlement({ ...anEntitlement(), duration_ms: 'forever' })).toBeNull();
    expect(parseTrialEntitlement({ ...anEntitlement(), started_at: 'yesterday' })).toBeNull();
  });

  test('expires_at is re-derived, so a tampered one is ignored', () => {
    const tampered = parseTrialEntitlement({
      ...anEntitlement({ started_at: T0, state: 'active' }),
      expires_at: T0 + 999 * TRIAL_DURATION_MS,
    });
    expect(tampered?.expires_at).toBe(T0 + TRIAL_DURATION_MS);
  });
});

describe('persistence', () => {
  afterEach(() => {
    closeDb();
  });

  test('no grant on a normal install', () => {
    initDatabase(':memory:');
    expect(readTrialEntitlement()).toBeNull();
    expect(trialSnapshot()).toEqual(NO_TRIAL);
  });

  test('issue writes a grant with the clock unstarted', () => {
    initDatabase(':memory:');
    const issued = issueTrialEntitlement({ now: T0 });
    expect(issued?.state).toBe('issued');
    expect(issued?.started_at).toBeNull();
    expect(issued?.realtime.enabled).toBe(true);
    expect(issued?.realtime.max_session_minutes).toBe(TRIAL_MAX_SESSION_MINUTES);
    expect(readTrialEntitlement()?.id).toBe(issued!.id);
  });

  test('a second issue is refused, one grant per install', () => {
    initDatabase(':memory:');
    const first = issueTrialEntitlement({ now: T0 });
    expect(issueTrialEntitlement({ now: T0 + 1 })).toBeNull();
    expect(readTrialEntitlement()?.id).toBe(first!.id);
  });

  test('startTrialClock persists once and is inert afterwards', () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const started = startTrialClock(T0 + 5_000);
    expect(started?.started_at).toBe(T0 + 5_000);
    expect(readTrialEntitlement()?.expires_at).toBe(T0 + 5_000 + TRIAL_DURATION_MS);

    startTrialClock(T0 + 90_000);
    expect(readTrialEntitlement()?.started_at).toBe(T0 + 5_000);
  });

  test('startTrialClock on an install with no trial does nothing', () => {
    initDatabase(':memory:');
    expect(startTrialClock(T0)).toBeNull();
  });

  test('the opening seam is stamped once', () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    expect(markOpeningCompleted(T0 + 1000)?.opening_completed_at).toBe(T0 + 1000);
    expect(markOpeningCompleted(T0 + 9999)?.opening_completed_at).toBe(T0 + 1000);
  });

  test('clearing removes the grant', () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    clearTrialEntitlement();
    expect(readTrialEntitlement()).toBeNull();
  });
});

describe('the control-plane stub', () => {
  afterEach(() => {
    closeDb();
  });

  test('does nothing without the env flag, which is every install', () => {
    initDatabase(':memory:');
    expect(seedTrialFromEnv({})).toBe(false);
    expect(seedTrialFromEnv({ JARVIS_TRIAL: '' })).toBe(false);
    expect(seedTrialFromEnv({ JARVIS_TRIAL: '0' })).toBe(false);
    expect(readTrialEntitlement()).toBeNull();
  });

  test('seeds once with the flag set', () => {
    initDatabase(':memory:');
    expect(seedTrialFromEnv({ JARVIS_TRIAL: '1' })).toBe(true);
    expect(readTrialEntitlement()?.issuer).toBe('local_stub');
    // A restart must not re-issue.
    expect(seedTrialFromEnv({ JARVIS_TRIAL: '1' })).toBe(false);
  });
});
