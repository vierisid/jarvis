import { describe, expect, it } from 'bun:test';
import { SurfaceCache, cacheKey } from './surface-cache.ts';
import type { SemanticSurface } from './types.ts';

function surface(title: string): SemanticSurface {
  return { provider: 'uia', root: { app: '', title }, nodes: [], coverage: 0, capturedAt: 0 };
}

describe('SurfaceCache', () => {
  it('serves a fresh entry and expires it after the TTL', () => {
    let now = 1000;
    const c = new SurfaceCache(500, () => now);
    const key = cacheKey('desktop', 42);
    c.put(key, surface('a'));
    expect(c.get(key)?.root.title).toBe('a');
    now += 600; // past TTL
    expect(c.get(key)).toBeNull();
    expect(c.size()).toBe(0); // expired entry is dropped on read
  });

  it('invalidate drops a specific entry', () => {
    const c = new SurfaceCache();
    const key = cacheKey('browser', undefined);
    c.put(key, surface('p'));
    c.invalidate(key);
    expect(c.get(key)).toBeNull();
  });

  it('keys separate desktop pids and browser', () => {
    const c = new SurfaceCache();
    c.put(cacheKey('desktop', 1), surface('one'));
    c.put(cacheKey('desktop', 2), surface('two'));
    c.put(cacheKey('browser', undefined), surface('web'));
    expect(c.get(cacheKey('desktop', 1))?.root.title).toBe('one');
    expect(c.get(cacheKey('desktop', 2))?.root.title).toBe('two');
    expect(c.get(cacheKey('browser', undefined))?.root.title).toBe('web');
  });

  it('evicts the least-recently-put entry past the cap', () => {
    const c = new SurfaceCache();
    for (let i = 0; i < 10; i++) c.put(cacheKey('desktop', i), surface(`s${i}`));
    expect(c.size()).toBeLessThanOrEqual(8);
    // earliest keys evicted
    expect(c.get(cacheKey('desktop', 0))).toBeNull();
    expect(c.get(cacheKey('desktop', 9))?.root.title).toBe('s9');
  });

  it('clear empties the cache', () => {
    const c = new SurfaceCache();
    c.put(cacheKey('desktop', 1), surface('x'));
    c.clear();
    expect(c.size()).toBe(0);
  });
});
