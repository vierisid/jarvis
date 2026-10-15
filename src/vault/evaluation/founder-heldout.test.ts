import { expect, test } from 'bun:test';
import { runFounderRecallBenchmark } from './founder-recall.ts';

// Added after the first matched heldout run, without changing the frozen ranker
// or corpus. This is now a regression suite, not a fresh independent evaluation.
test('frozen founder heldout retains qualified answers, abstention and identity across insertion orders', async () => {
  const report = await runFounderRecallBenchmark('heldout');
  expect(report.corpusSha256).toBe('15e7dcf5b9565f96adbbfa15714014a3c387fccd96d0756a42cb1b5d6f1d8e87');
  expect(report.rows.filter(row => !row.pass)).toEqual([]);
  expect(report.summary.casePass).toMatchObject({ numerator: 20, denominator: 20 });
  expect(report.summary.relevantFactInclusion).toMatchObject({ numerator: 23, denominator: 23 });
  expect(report.summary.bindingAccuracy).toMatchObject({ numerator: 8, denominator: 8 });
  expect(report.summary.stableCases.rate).toBe(1);
  for (const row of report.rows) {
    const first = report.rows.find(r => r.id === row.id && r.query === row.query && r.order === 0)!;
    expect(row.found).toEqual(first.found);
    expect(row.contextSha256).toBe(first.contextSha256);
    expect(row.tokens).toBe(first.tokens);
  }
}, 20_000);
