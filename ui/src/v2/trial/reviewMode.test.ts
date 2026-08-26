import { describe, expect, test } from 'bun:test';
import { REVIEW_KEY, reviewModeFrom, type Storage } from './reviewMode.ts';

function store(initial: Record<string, string> = {}): Storage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('review mode is off unless somebody asked for it', () => {
  test('a founder opening the dashboard normally sees no coverage counter', () => {
    expect(reviewModeFrom('', store())).toBe(false);
    expect(reviewModeFrom('?room=goals', store())).toBe(false);
  });

  test('?trialreview=1 turns it on and remembers, so a reload keeps it', () => {
    const s = store();
    expect(reviewModeFrom('?trialreview=1', s)).toBe(true);
    expect(s.data[REVIEW_KEY]).toBe('1');
    expect(reviewModeFrom('', s)).toBe(true);
  });

  test('?trialreview=0 turns it off again and forgets', () => {
    const s = store({ [REVIEW_KEY]: '1' });
    expect(reviewModeFrom('?trialreview=0', s)).toBe(false);
    expect(s.data[REVIEW_KEY]).toBeUndefined();
    expect(reviewModeFrom('', s)).toBe(false);
  });

  test('a browser with no usable storage is simply not in review mode', () => {
    expect(reviewModeFrom('', null)).toBe(false);
    expect(reviewModeFrom('?trialreview=1', null)).toBe(true);
  });

  test('storage that throws does not take the trial down with it', () => {
    const angry: Storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(reviewModeFrom('', angry)).toBe(false);
    expect(reviewModeFrom('?trialreview=1', angry)).toBe(true);
  });
});
