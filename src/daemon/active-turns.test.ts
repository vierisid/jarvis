import { describe, expect, test } from 'bun:test';
import { activeTurns } from './active-turns.ts';

// The singleton is shared; each test leaves the count at 0 and re-reads state.
// (isDraining is monotonic, so the quiesce test runs last.)

describe('ActiveTurns', () => {
  test('begin/end move the in-flight count; end is idempotent', () => {
    expect(activeTurns.active).toBe(0);
    const end1 = activeTurns.begin();
    const end2 = activeTurns.begin();
    expect(activeTurns.active).toBe(2);
    end1();
    end1(); // idempotent: no double-decrement
    expect(activeTurns.active).toBe(1);
    end2();
    expect(activeTurns.active).toBe(0);
  });

  test('drain resolves immediately when nothing is in flight', async () => {
    expect(await activeTurns.drain(1000)).toEqual({ drained: true, remaining: 0 });
  });

  test('drain resolves once in-flight turns finish before the deadline', async () => {
    const end = activeTurns.begin();
    const drainP = activeTurns.drain(2000);
    setTimeout(end, 10);
    expect(await drainP).toEqual({ drained: true, remaining: 0 });
  });

  test('drain reports remaining turns when the deadline is hit', async () => {
    const end = activeTurns.begin();
    const result = await activeTurns.drain(20); // shorter than the turn
    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(1);
    end(); // cleanup
    expect(activeTurns.active).toBe(0);
  });

  test('quiesce flips isDraining (refuses new turns)', () => {
    expect(activeTurns.isDraining).toBe(false);
    activeTurns.quiesce();
    expect(activeTurns.isDraining).toBe(true);
  });
});
