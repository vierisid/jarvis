/**
 * Best-of-N for high-stakes steps.
 *
 * Before an irreversible action (send / delete / pay), generate N candidate
 * plans from independent rollouts, judge them, and act on the best — the
 * Agent-S3 "bBoN" idea, scoped to the single decision that matters. A weak
 * majority of judges must also approve, so a plausible-but-wrong candidate
 * doesn't win by default.
 *
 * Pure and generator/judge-injected so it is unit-testable and can be wired
 * into the Authority gate without pulling in an LLM here.
 */

export type Candidate<T> = { value: T; source: number };

export type Judgement = {
  /** 0–1 quality score. */
  score: number;
  /** whether this candidate is safe/correct to execute at all. */
  approve: boolean;
  reason?: string;
};

export type BestOfNDeps<T> = {
  /** Produce one candidate for rollout index i (0-based). */
  generate: (i: number) => Promise<T>;
  /** Judge a candidate; called once per (candidate × judge). */
  judge: (candidate: T, judgeIndex: number) => Promise<Judgement>;
};

export type BestOfNResult<T> = {
  /** The chosen candidate, or null when none cleared the approval bar. */
  winner: T | null;
  /** All candidates with their aggregated scores, best first. */
  ranked: Array<{ value: T; source: number; avgScore: number; approvals: number; judges: number }>;
  reason: string;
};

export type BestOfNOptions = {
  /** Number of candidate rollouts. Default 3. */
  n?: number;
  /** Judges per candidate. Default 3. */
  judges?: number;
  /** Fraction of judges that must approve the winner. Default 0.5 (majority). */
  approvalThreshold?: number;
};

export async function bestOfN<T>(
  deps: BestOfNDeps<T>,
  opts: BestOfNOptions = {},
): Promise<BestOfNResult<T>> {
  const n = Math.max(1, opts.n ?? 3);
  const judges = Math.max(1, opts.judges ?? 3);
  const threshold = opts.approvalThreshold ?? 0.5;

  // Generate candidates concurrently. A failed rollout is dropped.
  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => deps.generate(i)),
  );
  const candidates: Candidate<T>[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') candidates.push({ value: r.value, source: i });
  });
  if (candidates.length === 0) {
    return { winner: null, ranked: [], reason: 'all candidate rollouts failed' };
  }

  // Judge each candidate by every judge, concurrently.
  const scored = await Promise.all(
    candidates.map(async (c) => {
      const results = await Promise.all(
        Array.from({ length: judges }, (_, j) => deps.judge(c.value, j)),
      );
      const approvals = results.filter((r) => r.approve).length;
      const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
      return { value: c.value, source: c.source, avgScore, approvals, judges };
    }),
  );

  // Rank by score; the winner must also clear the approval threshold.
  scored.sort((a, b) => b.avgScore - a.avgScore);
  const approvedWinner = scored.find((s) => s.approvals / s.judges >= threshold);

  if (!approvedWinner) {
    return {
      winner: null,
      ranked: scored,
      reason: `no candidate cleared the approval bar (${Math.round(threshold * 100)}% of ${judges} judges); highest score ${scored[0]!.avgScore.toFixed(2)} had ${scored[0]!.approvals}/${judges} approvals — do NOT execute; ask the user`,
    };
  }

  return {
    winner: approvedWinner.value,
    ranked: scored,
    reason: `selected candidate from rollout ${approvedWinner.source} (score ${approvedWinner.avgScore.toFixed(2)}, ${approvedWinner.approvals}/${judges} approvals)`,
  };
}
