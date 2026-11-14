import { describe, expect, test } from 'bun:test';
import { firstWay } from './ways.ts';

describe('more than one way to the same thing', () => {
  test('the first way that answers is used, and the later ones are not asked', async () => {
    let asked = 0;
    const reached = await firstWay([
      { name: 'connection', get: async () => ['a'] },
      { name: 'browser', get: async () => { asked++; return ['b']; } },
    ]);
    expect(reached).toEqual({ value: ['a'], through: 'connection', tried: [] });
    expect(asked).toBe(0);
  });

  test('a way that is not here is passed over for the next: no connection is not "I can\'t"', async () => {
    const reached = await firstWay([
      { name: 'connection', get: async () => null },
      { name: 'browser', get: async () => ['b'] },
    ]);
    expect(reached).toEqual({ value: ['b'], through: 'browser', tried: [{ name: 'connection', why: 'not-here' }] });
  });

  test('a way that fails is passed over too, and its reason is kept', async () => {
    const reached = await firstWay<string[]>([
      { name: 'connection', get: async () => { throw new Error('Google said no'); } },
      { name: 'browser', get: async () => ['b'] },
    ]);
    expect(reached.through).toBe('browser');
    expect(reached.tried).toEqual([{ name: 'connection', why: 'failed', reason: 'Google said no' }]);
  });

  test('an empty answer is an answer: an empty calendar is not a missing one', async () => {
    const reached = await firstWay<string[]>([{ name: 'connection', get: async () => [] }, { name: 'browser', get: async () => ['b'] }]);
    expect(reached).toEqual({ value: [], through: 'connection', tried: [] });
  });

  test('only when every way was tried is there nothing, and what was tried is said', async () => {
    const reached = await firstWay<string[]>([
      { name: 'connection', get: async () => null },
      { name: 'browser', get: async () => { throw new Error('not signed in'); } },
    ]);
    expect(reached).toEqual({ value: null, through: null, tried: [{ name: 'connection', why: 'not-here' }, { name: 'browser', why: 'failed', reason: 'not signed in' }] });
  });
});
