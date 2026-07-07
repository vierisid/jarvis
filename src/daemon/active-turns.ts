/**
 * In-flight primary agent-turn tracker, for graceful drain (UPDATES.md).
 *
 * Primary turns (WS chat, background reactions, commitments) are fire-and-forget
 * and untracked elsewhere, so a drain has nothing to await. This is a tiny
 * process-wide counter: entry points `begin()` a turn and call the returned
 * `end` when it settles; the drain `quiesce()`s (new turns are refused) then
 * `drain(deadline)`s (await the count to zero). Per UPDATES.md a turn that
 * overruns the deadline is ABANDONED (not checkpointed) — the process exits and
 * the user re-asks. One daemon per process, so a singleton is correct.
 */
export class ActiveTurns {
  private count = 0;
  private draining = false;
  private waiters: Array<() => void> = [];

  /** Once draining, new turns should be refused (checked by the entry points). */
  get isDraining(): boolean {
    return this.draining;
  }

  /** Number of turns currently in flight. */
  get active(): number {
    return this.count;
  }

  /** Stop accepting new turns (idempotent). Existing turns keep running. */
  quiesce(): void {
    this.draining = true;
  }

  /**
   * Mark a turn in-flight. Returns an idempotent `end` to call when it settles
   * (success OR error) — always call it in a `finally` so a throwing turn can't
   * leak the count and wedge the drain.
   */
  begin(): () => void {
    this.count += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.count -= 1;
      if (this.count === 0) this.flush();
    };
  }

  /**
   * Resolve when no turns are in flight, or after `deadlineMs`. `drained` is
   * false on timeout (the caller then proceeds to teardown, abandoning them).
   */
  drain(deadlineMs: number): Promise<{ drained: boolean; remaining: number }> {
    if (this.count === 0) return Promise.resolve({ drained: true, remaining: 0 });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ drained: false, remaining: this.count }),
        deadlineMs,
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve({ drained: true, remaining: 0 });
      });
    });
  }

  private flush(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

/** Thrown by turn entry points when the daemon is draining (reject new work). */
export class DrainingError extends Error {
  constructor() {
    super('daemon is draining; not accepting new work');
    this.name = 'DrainingError';
  }
}

/** Process-wide singleton (one daemon per process). */
export const activeTurns = new ActiveTurns();
