/**
 * Structural Runtime — perception/action telemetry.
 *
 * Records how each control action was served: structurally (accessibility
 * tree) or by vision (screenshot fallback), plus coverage and verification
 * outcome. This is the honesty signal the roadmap's success metrics and
 * System 2's ledger consume — "every vision fallback logged with reason".
 *
 * Deliberately dependency-free (in-memory ring + console) so it can be
 * imported anywhere without a DB handle; a later pass can drain it to the
 * vault ledger.
 */

export type PerceptionEvent = {
  at: number;
  provider: 'uia' | 'ax' | 'atspi' | 'cdp' | 'vision';
  action: string;
  coverage: number;
  /** true = structural path served it; false = vision fallback. */
  structural: boolean;
  /** verification outcome when a postcondition was checked. */
  verified?: boolean;
  /** why vision was used, when it was. */
  visionReason?: 'low_coverage' | 'step_failure' | 'explicit';
  detail?: string;
};

const RING_MAX = 500;
const ring: PerceptionEvent[] = [];

export function recordPerception(ev: Omit<PerceptionEvent, 'at'>): void {
  const full: PerceptionEvent = { at: Date.now(), ...ev };
  ring.push(full);
  if (ring.length > RING_MAX) ring.shift();
  if (!full.structural) {
    console.log(
      `[structural] VISION fallback (${full.visionReason ?? 'unspecified'}) action=${full.action} coverage=${Math.round(full.coverage * 100)}%${full.detail ? ` — ${full.detail}` : ''}`,
    );
  }
}

/** Aggregate stats for the metrics harness / dashboard. */
export function perceptionStats(): {
  total: number;
  structural: number;
  vision: number;
  structuralRatio: number;
  verified: number;
  verifyChecked: number;
} {
  const total = ring.length;
  const structural = ring.filter((e) => e.structural).length;
  const vision = total - structural;
  const verifyChecked = ring.filter((e) => e.verified !== undefined).length;
  const verified = ring.filter((e) => e.verified === true).length;
  return {
    total,
    structural,
    vision,
    structuralRatio: total ? structural / total : 0,
    verified,
    verifyChecked,
  };
}

/** Drain the ring (e.g. to persist to the ledger). */
export function drainPerception(): PerceptionEvent[] {
  return ring.splice(0, ring.length);
}
