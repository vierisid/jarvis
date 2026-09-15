import { expect, test } from 'bun:test';
import { runRecallBenchmark } from '../../scripts/benchmark-memory-recall.ts';

// Frozen before ranking was implemented. Once evaluated, this is a regression
// gate; tuning against failures in it requires a new untouched evaluation set.
test.each([
  ['heldout', 'aea6643f13e78c601b169210cd15c17011fa03056037d05951e651310964e9f3'],
  ['heldout-v2', 'b0887c026dbcf4000ccf4740d08329ebe1f8380afd9879ad99d402adf73e5d7d'],
] as const)('frozen recall %s preserves useful qualified context and abstention', (split, hash) => {
  const result = runRecallBenchmark(split);
  expect(result.rows.filter(row => !row.pass)).toEqual([]);
  expect(result.fixtureSha256).toBe(hash);
  expect(result.necessaryFactRecall).toBe(1);
  expect(result.factPrecision).toBeGreaterThanOrEqual(0.8);
  expect(result.factCharPrecision).toBeGreaterThanOrEqual(0.8);
  expect(result.qualifiedCoverage).toBe(1);
  expect(result.stableCases).toBe(result.cases);
});
