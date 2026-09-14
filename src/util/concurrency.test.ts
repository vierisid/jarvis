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
});
