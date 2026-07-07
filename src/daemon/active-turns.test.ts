import { describe, expect, test } from 'bun:test';
import { ActiveTurns } from './active-turns.ts';

// Use fresh instances (not the process singleton) so tests are order-independent.

describe('ActiveTurns', () => {
  test('begin/end move the in-flight count; end is idempotent', () => {
    const t = new ActiveTurns();
    expect(t.active).toBe(0);
    const end1 = t.begin();
    const end2 = t.begin();
    expect(t.active).toBe(2);
    end1();
    end1(); // idempotent: no double-decrement
    expect(t.active).toBe(1);
    end2();
    expect(t.active).toBe(0);
  });

  test('drain resolves immediately when nothing is in flight', async () => {
    expect(await new ActiveTurns().drain(1000)).toEqual({ drained: true, remaining: 0 });
  });

  test('drain resolves once in-flight turns finish before the deadline', async () => {
    const t = new ActiveTurns();
    const end = t.begin();
    const drainP = t.drain(2000);
    setTimeout(end, 10);
    expect(await drainP).toEqual({ drained: true, remaining: 0 });
  });

  test('drain reports remaining turns when the deadline is hit', async () => {
    const t = new ActiveTurns();
    const end = t.begin();
    const result = await t.drain(20); // shorter than the turn
    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(1);
    end();
    expect(t.active).toBe(0);
  });

  test('quiesce flips isDraining (refuses new turns)', () => {
    const t = new ActiveTurns();
    expect(t.isDraining).toBe(false);
    t.quiesce();
    expect(t.isDraining).toBe(true);
  });
});
