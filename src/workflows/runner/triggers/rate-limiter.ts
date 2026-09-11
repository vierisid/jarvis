/**
 * Sliding-window rate limiter keyed by an arbitrary string (a flow id, or
 * a single shared key for a global budget). Kept deliberately small: the
 * webhook ingress is public and unauthenticated by design, so this is the
 * one thing standing between a flood and a job queue full of runs.
 *
 * `check` and `record` are split so a caller can test several budgets and
 * only charge them once all have passed; `allow` does both in one step.
 */
export class KeyedRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxPerWindow: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reports whether one more hit for key would be within budget. No side effect beyond eviction. */
  check(key: string): boolean {
    const arr = this.evicted(key, false);
    return (arr?.length ?? 0) < this.maxPerWindow;
  }

  /** Records a hit for key. */
  record(key: string): void {
    const arr = this.evicted(key, true)!;
    arr.push(this.now());
    // Keep the map from growing without bound under many distinct keys.
    if (this.hits.size > 10_000) this.sweep(this.now() - this.windowMs);
  }

  /** check + record in one step. */
  allow(key: string): boolean {
    if (!this.check(key)) return false;
    this.record(key);
    return true;
  }

  /**
   * Seconds until capacity returns for key: when the oldest in-window hit
   * leaves the window. Meaningful only for a key whose check() just failed.
   */
  retryAfterSeconds(key: string): number {
    const arr = this.hits.get(key);
    if (!arr || arr.length === 0) return 1;
    return Math.max(1, Math.ceil((arr[0]! + this.windowMs - this.now()) / 1000));
  }

  private evicted(key: string, create: boolean): number[] | undefined {
    const cutoff = this.now() - this.windowMs;
    let arr = this.hits.get(key);
    if (!arr) {
      if (!create) return undefined;
      arr = [];
      this.hits.set(key, arr);
    }
    while (arr.length > 0 && arr[0]! <= cutoff) arr.shift();
    return arr;
  }

  private sweep(cutoff: number): void {
    for (const [key, arr] of this.hits) {
      while (arr.length > 0 && arr[0]! <= cutoff) arr.shift();
      if (arr.length === 0) this.hits.delete(key);
    }
  }
}
