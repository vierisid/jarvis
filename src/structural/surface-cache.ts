/**
 * Structural Runtime — speculative perception cache.
 *
 * A short-TTL cache of recent SemanticSurfaces keyed by (kind, pid|url). When
 * the awareness subsystem sees the foreground app change, it pre-warms this
 * cache so the agent's first ui_snapshot/ui_act on that app starts from a hot
 * capture instead of paying a fresh tree walk — perceived latency toward zero.
 *
 * Entries are invalidated on any mutating action (the surface just changed) and
 * expire on a TTL (the user may have interacted meanwhile). This is a cache,
 * not a source of truth: verification always re-captures.
 */

import type { SemanticSurface } from './types.ts';

export type CacheKey = string;

export function cacheKey(kind: 'desktop' | 'browser', id: string | number | undefined): CacheKey {
  return `${kind}:${id ?? 'foreground'}`;
}

type Entry = {
  surface: SemanticSurface;
  capturedAt: number;
  /** monotonic epoch used only for LRU eviction ordering */
  seq: number;
};

const DEFAULT_TTL_MS = 4_000;
const MAX_ENTRIES = 8;

export class SurfaceCache {
  private map = new Map<CacheKey, Entry>();
  private seq = 0;
  constructor(private ttlMs: number = DEFAULT_TTL_MS, private now: () => number = Date.now) {}

  /** Store a freshly captured surface. */
  put(key: CacheKey, surface: SemanticSurface): void {
    this.map.set(key, { surface, capturedAt: this.now(), seq: ++this.seq });
    // LRU eviction.
    if (this.map.size > MAX_ENTRIES) {
      let oldestKey: CacheKey | null = null;
      let oldestSeq = Infinity;
      for (const [k, e] of this.map) {
        if (e.seq < oldestSeq) { oldestSeq = e.seq; oldestKey = k; }
      }
      if (oldestKey) this.map.delete(oldestKey);
    }
  }

  /** Return a still-fresh surface, or null if absent/expired. */
  get(key: CacheKey): SemanticSurface | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (this.now() - e.capturedAt > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return e.surface;
  }

  /** Drop a specific entry — called after a mutating action on that surface. */
  invalidate(key: CacheKey): void {
    this.map.delete(key);
  }

  /** Drop everything (e.g. emergency stop, sidecar reconnect). */
  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

/** Process-wide cache shared by captureSurface and the awareness pre-warmer. */
let shared: SurfaceCache | null = null;
export function getSurfaceCache(): SurfaceCache {
  if (!shared) shared = new SurfaceCache();
  return shared;
}
