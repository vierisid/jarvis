/**
 * Q-19, owner decision "one, then quiet": the first urgent alert about an
 * issue may interrupt (sound, desktop, external channels); later alerts about
 * the same issue within the window reach the dashboard quietly. One on-screen
 * error used to interrupt up to twice (the suggestion and the researched fix),
 * and again each time it was detected.
 *
 * In memory on purpose: after a restart an issue may interrupt once more,
 * never less.
 */
import { createHash } from 'node:crypto';

export const INTERRUPTION_WINDOW_MS = 60 * 60_000;

export class InterruptionGate {
  private readonly claimed = new Map<string, number>();

  constructor(private readonly windowMs = INTERRUPTION_WINDOW_MS, private readonly now: () => number = Date.now) {}

  /** True once per key within the window: that alert may interrupt. False after: deliver it quietly. */
  claim(key: string): boolean {
    const t = this.now();
    for (const [k, at] of this.claimed) if (t - at >= this.windowMs) this.claimed.delete(k);
    if (this.claimed.has(key)) return false;
    this.claimed.set(key, t);
    return true;
  }
}

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * One issue on the person's screen: an error (by its text) or a struggle (one
 * per app). The awareness pipeline and the daemon's research both key their
 * alerts with it, so the suggestion and the researched fix share one key.
 */
export function screenIssueKey(kind: 'error' | 'struggle', appName: string, text = ''): string {
  return createHash('sha256').update(`${kind}\u0000${normalize(appName)}\u0000${kind === 'error' ? normalize(text) : ''}`)
    .digest('hex').slice(0, 32);
}

export type AlertDelivery = 'interrupt' | 'quiet';

/**
 * How the awareness alerts about one screen issue are delivered (Q-19, owner
 * decision: the researched fix is the one interruption). While research into
 * an issue is under way, a heads-up about it goes to the dashboard quietly and
 * claims nothing; the fix then claims the issue and interrupts once. With no
 * research, the heads-up may interrupt. Anything later about the same issue
 * in the window is quiet. If research finds nothing, nothing interrupts.
 */
export class ScreenAlerts {
  private readonly researching = new Map<string, number>();

  constructor(private readonly gate = new InterruptionGate(), private readonly now: () => number = Date.now,
    private readonly windowMs = INTERRUPTION_WINDOW_MS) {}

  /** Research into this issue has started: its fix will be the interruption. */
  researchStarted(key: string): void {
    this.researching.set(key, this.now());
  }

  /** Research ended without a fix to deliver. */
  researchEnded(key: string): void {
    this.researching.delete(key);
  }

  /** A heads-up about the issue (or about nothing in particular, with no key). */
  headsUp(key: string | null): AlertDelivery {
    if (!key) return 'interrupt';
    const started = this.researching.get(key);
    if (started !== undefined && this.now() - started < this.windowMs) return 'quiet';
    return this.gate.claim(key) ? 'interrupt' : 'quiet';
  }

  /** The researched fix for the issue. */
  fix(key: string): AlertDelivery {
    this.researching.delete(key);
    return this.gate.claim(key) ? 'interrupt' : 'quiet';
  }
}
