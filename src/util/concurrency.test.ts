import { describe, expect, test } from 'bun:test';
import { createLimiter } from './concurrency.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createLimiter', () => {
  test('never runs more than the limit at once, and runs everything', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const jobs = Array.from({ length: 6 }, (_, i) =>
      limit(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running--;
        return i;
      }),
    );
    await tick();
    expect(running).toBe(2);
    // Release one at a time; a newcomer arriving in the same tick must not
    // squeeze in ahead of the waiter the slot was handed to.
    while (releases.length > 0) {
      releases.shift()!();
      void limit(async () => 'late');
      await tick();
      expect(running).toBeLessThanOrEqual(2);
    }
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  test('a failing call still frees its slot', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await limit(async () => 'next')).toBe('next');
  });

  test('refuses a limit that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createLimiter(bad)).toThrow(/positive integer/);
    }
  });

  test('cancelled waiters settle immediately without releasing the running slot', async () => {
    const limit = createLimiter(1);
    let release!: () => void;
    const first = limit(() => new Promise<void>(resolve => { release = resolve; }));
    const abort = new AbortController();
    const calls: string[] = [];
    const waiting = limit(async () => { calls.push('cancelled'); }, abort.signal).catch(error => error);
    const next = limit(async () => { calls.push('next'); });
    try {
      abort.abort(new Error('Stopped in queue'));
      // Use a bounded race so the broken implementation cannot hang the test.
      const result = await Promise.race([waiting, tick().then(() => 'still waiting')]);
      expect(result).toBe(abort.signal.reason);
      expect(calls).toEqual([]);
    } finally { release(); await Promise.all([first, waiting, next]); }
    expect(calls).toEqual(['next']);
    expect(await limit(async () => 'reusable')).toBe('reusable');
  });

  test('abort during slot handoff and pre-aborted admission do not leak a slot', async () => {
    const limit = createLimiter(1);
    const abort = new AbortController();
    let release!: () => void;
    let executions = 0;
    const first = limit(() => new Promise<void>(resolve => { release = resolve; }));
    const waiting = limit(async () => { executions++; }, abort.signal).catch(error => error);
    release();
    // The first call releases the slot before this continuation, but the
    // queued function has not resumed yet.
    await Promise.resolve();
    abort.abort(new Error('Stopped at handoff'));
    await first;
    expect(await waiting).toBe(abort.signal.reason);
    expect(executions).toBe(0);
    await expect(limit(async () => { executions++; }, abort.signal)).rejects.toThrow('Stopped at handoff');
    expect(executions).toBe(0);
    expect(await limit(async () => 'next')).toBe('next');
  });
});
