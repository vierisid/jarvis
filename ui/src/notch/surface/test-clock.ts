/**
 * A clock for the page's tests: time stands still until it is moved on, and
 * what was scheduled is called in order as it comes due. Nothing a test
 * checks then depends on how fast the machine is that day.
 */
import type { NotchPageClock } from './dom.ts';

export interface NotchTestClock extends NotchPageClock {
  /** Moves the time on by `ms`, calling everything that comes due on the way, the earliest first. */
  advance(ms: number): void;
}

export function createTestClock(): NotchTestClock {
  let now = 0, ids = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    after(ms, fn) {
      const id = ++ids;
      due.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    cancel(id) { due.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, entry] of due) {
          if (entry.at <= end && (!next || entry.at < next.at)) next = { id, ...entry };
        }
        if (!next) break;
        due.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}
