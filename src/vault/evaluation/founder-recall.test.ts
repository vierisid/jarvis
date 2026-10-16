import { expect, test } from 'bun:test';
import { compareFounderReports, evaluateFounderCase, loadFounderCorpus, loadRecallEngine, rate,
  runFounderRecallBenchmark, summarizeFounderRows } from './founder-recall.ts';

test('founder development cases pass through canonical writers, retrieval and packing in every order', async () => {
  const report = await runFounderRecallBenchmark('development');
  expect(report.rows.filter(row => !row.pass)).toEqual([]);
  expect(report.summary.casePass).toMatchObject({ numerator: 12, denominator: 12 });
  expect(report.summary.stableCases.rate).toBe(1);
  expect(report.summary.wrongPersonFacts).toBe(0);
  expect(report.summary.qualificationRetention.rate).toBe(1);
  expect(report.summary.tokenBudget.rate).toBe(1);
  for (const row of report.rows) {
    const first = report.rows.find(r => r.id === row.id && r.query === row.query && r.order === 0)!;
    expect(row.found).toEqual(first.found); // Fact AND evidence IDs survive insertion shuffles.
    expect(row.contextSha256).toBe(first.contextSha256);
    expect(row.tokens).toBe(first.tokens);
  }
  expect(compareFounderReports(report, structuredClone(report)).pass).toBe(true);
  const differentCorpus = structuredClone(report);
  differentCorpus.corpusSha256 = 'different';
  expect(() => compareFounderReports(report, differentCorpus)).toThrow('Unmatched');
  const differentScoring = structuredClone(report);
  differentScoring.scoring = 'founder-recall-scoring-v1';
  expect(() => compareFounderReports(report, differentScoring)).toThrow('Unmatched');
  const missingObservation = structuredClone(report);
  missingObservation.rows.pop();
  expect(() => compareFounderReports(report, missingObservation)).toThrow('Unmatched');
  const worse = structuredClone(report);
  worse.rows[0]!.qualified = false;
  worse.rows[0]!.pass = false;
  worse.summary = summarizeFounderRows(worse.rows);
  expect(compareFounderReports(report, worse)).toMatchObject({ pass: false });
  expect(compareFounderReports(report, worse).regressions).toHaveLength(1);
}, 20_000);

test('the evaluator rejects missing qualifications, wrong-person context, omitted answers and exceeded budgets', async () => {
  const { corpus } = loadFounderCorpus('development');
  const engine = await loadRecallEngine();
  const fixture = corpus.cases.find(c => c.id === 'dev-similar-surname')!;
  const run = (transform?: (context: string) => string) => evaluateFounderCase(engine, fixture, corpus, 0, transform)[0]!;
  const clock = Date.now, uuid = crypto.randomUUID;
  let wrongLine = '';
  evaluateFounderCase(engine, { ...fixture, queries: ['Nina Solis email'], expectOmission: false }, corpus, 0, context => {
    wrongLine = context.split('\n').find(line => line.startsWith('  - '))!;
    return context;
  });
  expect(wrongLine).toContain('wrong');
  const wrong = run(context => `${context}\n${wrongLine}`);
  expect(wrong.pass).toBe(false);
  expect(wrong.wrongPerson).toEqual(['wrong-email']);
  const stripped = run(context => context.replace(/ \| \{[^\n]+/g, ''));
  expect(stripped.pass).toBe(false);
  expect(stripped.qualified).toBe(false);
  const noRules = run(context => context.slice(engine.format.MEMORY_USE_RULES.length));
  expect(noRules.qualified).toBe(false);
  expect(run(() => '').missing).toEqual(['email']);
  expect(run(context => `${context}${' overflow'.repeat(15_000)}`).budgetPassed).toBe(false);
  expect(Date.now).toBe(clock);
  expect(crypto.randomUUID).toBe(uuid);
});

test('failed fixture evaluation restores its global clock and UUID sources', async () => {
  const { corpus } = loadFounderCorpus('development');
  const engine = await loadRecallEngine();
  const clock = Date.now, uuid = crypto.randomUUID;
  expect(() => evaluateFounderCase(engine, { ...corpus.cases[0]!, required: ['nonexistent'] }, corpus, 0)).toThrow('Unknown expected key');
  expect(Date.now).toBe(clock);
  expect(crypto.randomUUID).toBe(uuid);
  expect(rate(0, 0)).toMatchObject({ numerator: 0, denominator: 0, rate: null, wilson95: null });
});

test('each rendered fact must remain under its canonical subject heading', async () => {
  const { corpus } = loadFounderCorpus('development');
  const engine = await loadRecallEngine();
  const fixture = corpus.cases.find(c => c.id === 'dev-similar-surname')!;
  const header = '**Mira Solis** (person)';
  for (const replacement of ['**Nina Solis** (person)', '**Unknown person** (person)', '**Mira Solis** (project)', '']) {
    const row = evaluateFounderCase(engine, fixture, corpus, 0, context => context.replace(header, replacement))[0]!;
    expect(row.pass).toBe(false);
    expect(row.wrongPerson).toContain('email');
    expect(row.qualified).toBe(false);
  }
  // A correct occurrence must not hide a duplicate under a different subject.
  const duplicate = evaluateFounderCase(engine, fixture, corpus, 0, context =>
    `${context}\n\n**Nina Solis** (person)\n${context.split('\n').find(line => line.startsWith('  - '))}`)[0]!;
  expect(duplicate.pass).toBe(false);
  expect(duplicate.wrongPerson).toContain('email');
  const damaged = evaluateFounderCase(engine, fixture, corpus, 0, context =>
    `${context}\n\n${header}\n${context.split('\n').find(line => line.startsWith('  - '))?.replace('email:', 'phone:')}`)[0]!;
  expect(damaged.pass).toBe(false);
  expect(damaged.unqualified).toContain('email');
});

test.each(['value', 'evidence'] as const)('empty-record text inside a forbidden fact remains visible to scoring (%s)', async field => {
  const { corpus } = loadFounderCorpus('development');
  const engine = await loadRecallEngine();
  const fixture = structuredClone(corpus.cases.find(c => c.id === 'dev-similar-surname')!);
  const wrong = fixture.entities.find(e => e.key === 'other')!.facts[0]!;
  if (field === 'value') wrong.object += ' No current facts recorded.';
  else wrong.options = { ...wrong.options, quote: 'No current facts recorded.' };
  let wrongLine = '';
  evaluateFounderCase(engine, { ...fixture, queries: ['Nina Solis email'] }, corpus, 0, context => {
    wrongLine = context.split('\n').find(line => line.startsWith('  - '))!;
    return context;
  });
  expect(wrongLine).toContain('No current facts recorded.');
  const row = evaluateFounderCase(engine, fixture, corpus, 0, context =>
    `${context}\n\n**Nina Solis** (person)\n${wrongLine}`)[0]!;
  expect(row.pass).toBe(false);
  expect(row.wrongPerson).toEqual(['wrong-email']);
  expect(row.found.map(f => f.key)).toContain('wrong-email');
  expect(row.omissions.map(f => f.key)).not.toContain('wrong-email');
});

test('the exact empty-record marker still passes sparse-memory scoring', async () => {
  const { corpus } = loadFounderCorpus('development');
  const engine = await loadRecallEngine();
  const fixture = corpus.cases.find(c => c.id === 'dev-missing-contact')!;
  expect(evaluateFounderCase(engine, fixture, corpus, 0)[0]!.pass).toBe(true);
});
