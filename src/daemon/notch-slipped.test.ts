/**
 * What slipped today, on the product's own store of promises.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createCommitment, failCommitment, getCommitment, completeCommitment } from '../vault/commitments.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { CANCELLED_RESULT, INTERRUPTED_RESULT } from './commitment-executor.ts';
import { notchMoveSlipped, notchSlipped } from './notch-slipped.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 18, 19, 0).getTime();
const MIDNIGHT = new Date(2026, 10, 18, 0, 0).getTime();
const TOMORROW = new Date(2026, 10, 19, 9, 0).getTime();
const promise = (what: string, due: number): string => createCommitment(what, { when_due: due, assigned_to: 'jarvis', created_from: 'test' }).id;

describe('what was promised for today and was not kept', () => {
  test('a promise that was due today and failed, or was cancelled in its window, has slipped', () => {
    const failed = promise("Send Anna the contract", NOW - 4 * HOUR);
    failCommitment(failed, 'The mail could not be sent.');
    const cancelled = promise('Remind me of the board call', NOW - 2 * HOUR);
    failCommitment(cancelled, CANCELLED_RESULT);
    // The earliest first.
    expect(notchSlipped(MIDNIGHT, NOW)).toEqual([{ id: failed, what: "Send Anna the contract" }, { id: cancelled, what: 'Remind me of the board call' }]);
  });

  test('what was kept, what is still to come, and what was due on another day has not', () => {
    completeCommitment(promise('Kept today', NOW - 3 * HOUR), 'Done.');
    promise('Still open, due tonight', NOW + 2 * HOUR);
    promise('Open and overdue: the executor keeps it late, it has not failed', NOW - HOUR);
    const yesterday = promise('Failed yesterday', MIDNIGHT - 5 * HOUR);
    failCommitment(yesterday, 'No.');
    expect(notchSlipped(MIDNIGHT, NOW)).toEqual([]);
  });

  test('one a restart interrupted is not offered: it may have partly run, and is not run again', () => {
    const interrupted = promise('Pay the supplier', NOW - 3 * HOUR);
    failCommitment(interrupted, INTERRUPTED_RESULT);
    expect(notchSlipped(MIDNIGHT, NOW)).toEqual([]);
    // Nor is it moved when asked for by id.
    expect(notchMoveSlipped([interrupted], TOMORROW, NOW)).toBe(0);
    expect(getCommitment(interrupted)).toMatchObject({ status: 'failed', when_due: NOW - 3 * HOUR });
  });

  test('linked work has its own contract, and is neither offered nor moved', () => {
    const work = promise('A work item', NOW - 3 * HOUR);
    failCommitment(work, 'No.');
    getDb().run('INSERT INTO commitment_work (work_id, updated_at) VALUES (?, ?)', [work, NOW]);
    expect(notchSlipped(MIDNIGHT, NOW)).toEqual([]);
    expect(notchMoveSlipped([work], TOMORROW, NOW)).toBe(0);
  });
});

describe('moving what slipped', () => {
  test('it is open again and due then: the executor keeps it at that hour', () => {
    const id = promise("Send Anna the contract", NOW - 4 * HOUR);
    failCommitment(id, 'The mail could not be sent.');
    expect(notchMoveSlipped([id], TOMORROW, NOW)).toBe(1);
    expect(getCommitment(id)).toMatchObject({ status: 'pending', when_due: TOMORROW, completed_at: null });
    // It has not slipped any more.
    expect(notchSlipped(MIDNIGHT, NOW)).toEqual([]);
  });

  test('only what slipped is moved: not what was kept, what is open, or what is not there', () => {
    const kept = promise('Kept', NOW - 3 * HOUR);
    completeCommitment(kept, 'Done.');
    const open = promise('Open', NOW + HOUR);
    const failed = promise('Failed', NOW - HOUR);
    failCommitment(failed, 'No.');
    expect(notchMoveSlipped([kept, open, 'nothing', failed], TOMORROW, NOW)).toBe(1);
    expect(getCommitment(kept)).toMatchObject({ status: 'completed' });
    expect(getCommitment(open)).toMatchObject({ status: 'pending', when_due: NOW + HOUR });
    expect(getCommitment(failed)).toMatchObject({ status: 'pending', when_due: TOMORROW });
  });

  test('a moment that is not ahead moves nothing', () => {
    const id = promise('Failed', NOW - HOUR);
    failCommitment(id, 'No.');
    for (const at of [NOW, NOW - HOUR, Number.NaN, Infinity]) expect(notchMoveSlipped([id], at, NOW)).toBe(0);
    expect(getCommitment(id)).toMatchObject({ status: 'failed' });
  });
});
