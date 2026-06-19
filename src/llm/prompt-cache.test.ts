import { describe, expect, test } from 'bun:test';
import { CACHE_BREAKPOINT, splitCachePrefix, stripCacheBreakpoint } from './prompt-cache.ts';

describe('prompt-cache', () => {
  test('splitCachePrefix returns whole text as cached when no breakpoint', () => {
    const { cached, fresh } = splitCachePrefix('just a system prompt');
    expect(cached).toBe('just a system prompt');
    expect(fresh).toBeNull();
  });

  test('splitCachePrefix separates stable prefix from volatile tail', () => {
    const text = `STABLE PREFIX${CACHE_BREAKPOINT}Time: now`;
    const { cached, fresh } = splitCachePrefix(text);
    expect(cached).toBe('STABLE PREFIX');
    expect(fresh).toBe('Time: now');
  });

  test('splitCachePrefix treats an empty tail as no fresh content', () => {
    const { cached, fresh } = splitCachePrefix(`STABLE${CACHE_BREAKPOINT}   `);
    expect(cached).toBe('STABLE');
    expect(fresh).toBeNull();
  });

  test('stripCacheBreakpoint rejoins the halves and removes the marker', () => {
    const out = stripCacheBreakpoint(`STABLE${CACHE_BREAKPOINT}Time: now`);
    expect(out).not.toContain(CACHE_BREAKPOINT);
    expect(out).toContain('STABLE');
    expect(out).toContain('Time: now');
    // Stable content must remain first so automatic prefix cachers still hit.
    expect(out.indexOf('STABLE')).toBeLessThan(out.indexOf('Time: now'));
  });

  test('stripCacheBreakpoint is a no-op when there is no marker', () => {
    expect(stripCacheBreakpoint('plain text')).toBe('plain text');
  });
});
