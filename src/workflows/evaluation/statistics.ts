/** A rate is reported with its counts and a 95% Wilson score interval, which
 * stays inside [0, 1] and remains honest for the small samples this harness
 * produces. No denominator means no rate, never zero. */
export interface Rate { successes: number; n: number; rate: number | null; ci95: [number, number] | null }

const Z95 = 1.959963984540054;

export function rate(successes: number, n: number): Rate {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(successes) || successes < 0 || successes > n)
    throw new Error('Invalid rate counts');
  if (n === 0) return { successes, n, rate: null, ci95: null };
  const p = successes / n, z2 = Z95 * Z95, scale = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / scale;
  const margin = (Z95 / scale) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { successes, n, rate: p, ci95: [Math.max(0, centre - margin), Math.min(1, centre + margin)] };
}

/** Nearest-rank percentile of what was observed; null when nothing was. */
export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function distribution(values: number[]) {
  return { observed: values.filter(Number.isFinite).length, p50: percentile(values, 50), p90: percentile(values, 90),
    p95: percentile(values, 95), max: percentile(values, 100) };
}
