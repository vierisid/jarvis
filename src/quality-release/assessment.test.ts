import { expect, test } from 'bun:test';
import { assessProductQuality, hash } from './assessment';
import { DISPOSITIONS, JOURNEYS, CONDITIONS, QUALITY_CHECKS, PREREQUISITES, SAFETY_KEYS } from './contract';
import { CANDIDATE, fixture, NOW } from './test-fixture';
import { rate } from './measurements';
const assess = (f: ReturnType<typeof fixture>) => assessProductQuality(f.record, CANDIDATE, NOW, f.artifacts);

test('complete synthetic protocol fixture passes without deployment authority or live certification', () => {
  const result = assess(fixture());
  expect(result.status).toBe('passed'); expect(result.deploymentAuthorized).toBe(false);
  expect(result.profiles).toHaveLength(2);
  for (const p of result.profiles) {
    expect(p.counts.passed).toBe(29); expect(p.supportedJobs).toHaveLength(3);
    expect(p.liveConnector.disposition).toBe('not_run'); expect(p.quality[0]!.measurement).toHaveProperty('ci95');
  }
});
for (const card of PREREQUISITES) test(`missing ${card} cannot pass`, () => {
  const f = fixture(); f.record.prerequisites = f.record.prerequisites.filter(r => r.card !== card);
  expect(assess(f).blockers).toContain(`prerequisite_not_passed:${card}`);
});
for (const condition of CONDITIONS) for (const journey of JOURNEYS) test(`missing ${journey}/${condition} stays in denominator`, () => {
  const f = fixture(); const p = f.record.profiles[0]!;
  p.journeys = p.journeys.filter(r => r.journey !== journey || r.condition !== condition);
  const result = assess(f); expect(result.status).toBe('blocked');
  expect(result.profiles[0]!.counts.not_run).toBe(1); expect(result.profiles[0]!.counts.passed).toBe(28);
  expect(result.profiles[0]!.supportedJobs).toEqual([]);
});
for (const status of DISPOSITIONS.filter(s => s !== 'passed')) test(`${status} is never upgraded to passed`, () => {
  const f = fixture(); f.record.profiles[1]!.journeys[0]!.disposition = status; f.seal();
  expect(assess(f).profiles[1]!.journeys[0]!.disposition).toBe(status); expect(assess(f).status).toBe('blocked');
});
for (const key of SAFETY_KEYS) test(`nonzero ${key} fails even a blocked row`, () => {
  const f = fixture(), row = f.record.profiles[0]!.journeys[0]!;
  row.safety![key] = 1; row.disposition = 'blocked'; f.seal();
  expect(assess(f).profiles[0]!.journeys[0]!.disposition).toBe('failed');
});
for (const edit of [
  (f: ReturnType<typeof fixture>) => { f.record.candidate = 'e'.repeat(40); },
  (f: ReturnType<typeof fixture>) => { f.record.profiles.pop(); },
  (f: ReturnType<typeof fixture>) => { f.record.profiles[1]!.runtime.hosting = 'e'.repeat(40); },
  (f: ReturnType<typeof fixture>) => { f.record.profiles[0]!.runtime.sidecar = null; },
  (f: ReturnType<typeof fixture>) => { f.record.profiles[0]!.runtime.profileRevision = null; },
  (f: ReturnType<typeof fixture>) => { f.record.profiles[0]!.journeys[0]!.proof!.reviewed = false; },
  (f: ReturnType<typeof fixture>) => { f.record.profiles[0]!.journeys[0]!.proof!.kind = 'live_sandbox'; },
  (f: ReturnType<typeof fixture>) => { f.record.profiles[0]!.journeys[0]!.proof!.finishedAt = '2027-01-01T00:00:00Z'; },
  (f: ReturnType<typeof fixture>) => { f.record.profiles[0]!.journeys[0]!.safety = null; },
  (f: ReturnType<typeof fixture>) => { f.record.rubric.status = 'proposed'; },
  (f: ReturnType<typeof fixture>) => { f.record.rubric.approved = false; },
  (f: ReturnType<typeof fixture>) => { f.record.rubric.budgetsAgreed = false; },
  (f: ReturnType<typeof fixture>) => { f.record.rubric.frozenAt = '2026-10-11T00:00:00Z'; },
]) test(`reject stale or incomplete identity ${edit.toString()}`, () => {
  const f = fixture(); edit(f); f.seal(); expect(assess(f).status).toBe('blocked');
});
for (const check of QUALITY_CHECKS) test(`missing ${check} never green`, () => {
  const f = fixture(); f.record.profiles[0]!.quality = f.record.profiles[0]!.quality.filter(r => r.check !== check);
  expect(assess(f).status).toBe('blocked');
});
for (const edit of [
  (r: any) => { r.measured--; }, (r: any) => { r.supportedTasks = 39; }, (r: any) => { r.negativeTasks = 19; },
  (r: any) => { r.rubricHash = 'f'.repeat(64); }, (r: any) => { r.verdict = 'not_met'; },
  (r: any) => { r.proof.kind = 'deterministic'; }, (r: any) => { r.measurement.numerator = 10; },
  (r: any) => { r.measurement.denominator = 41; }, (r: any) => { r.measurement = null; },
]) test(`incomplete or failing measurement: ${edit.toString()}`, () => {
  const f = fixture(); edit(f.record.profiles[0]!.quality[0]); f.seal(); expect(assess(f).status).toBe('blocked');
});
for (const value of [null, [], {}, { schemaVersion: 1 }, 'SECRET token']) test('malformed record fails closed without source text', () => {
  const result = assessProductQuality(value, CANDIDATE, NOW);
  expect(result.status).toBe('blocked'); expect(JSON.stringify(result)).not.toContain('SECRET');
});
test('duplicate and unknown rows are refused instead of collapsed', () => {
  const f = fixture(); f.record.profiles[0]!.journeys.push(f.record.profiles[0]!.journeys[0]!);
  expect(assess(f).blockers).toContain('invalid_release_record');
  f.record.profiles[0]!.journeys.pop(); (f.record.profiles[0]!.journeys[0] as any).condition = 'unrecognized';
  expect(assess(f).blockers).toContain('invalid_release_record');
});
test('missing/changed artifact bytes and changed summaries block positive receipts', () => {
  const f = fixture(), row = f.record.profiles[0]!.journeys[0]!;
  f.artifacts.delete(row.proof!.artifact); expect(assess(f).status).toBe('blocked');
  f.seal(); f.artifacts.set(row.proof!.artifact, { secret: 'PRIVATE' });
  expect(assess(f).status).toBe('blocked'); expect(JSON.stringify(assess(f))).not.toContain('PRIVATE');
  f.seal(); row.safety!.duplicateEffects = 2; expect(assess(f).status).toBe('blocked');
});
test('an absent artifact store cannot pass', () => {
  expect(assessProductQuality(fixture().record, CANDIDATE, NOW).status).toBe('blocked');
});
test('proposed Q01 artifact cannot be promoted by a frozen manifest', () => {
  const f = fixture(); f.q01.status = 'proposed';
  f.record.rubric.q01Hash = hash(f.q01); f.artifacts.set(hash(f.q01), f.q01);
  expect(assess(f).blockers).toContain('q01_frozen_rubric_required');
});
test('public output omits extra input payload and free-form artifact content', () => {
  const f = fixture(); (f.record as any).secret = 'PRIVATE'; (f.record.profiles[0]!.journeys[0]!.safety as any).prompt = 'PRIVATE';
  f.seal(); const result = assess(f); expect(result.status).toBe('passed'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
test('Wilson rates preserve denominator, uncertainty and unmeasured zero samples', () => {
  expect(rate(0, 0).rate).toBeNull(); expect(rate(40, 40).ci95![0]).toBeLessThan(.95);
  expect(rate(0, 20).ci95![1]).toBeGreaterThan(.05);
});

test('changing the declared founder jobs invalidates previous evidence', () => {
  const f = fixture(); f.record.profiles[0]!.jobs.push('another-job');
  expect(assess(f).profiles[0]!.status).toBe('blocked');
});
test('frozen sample increases are enforced, not replaced by roadmap minima', () => {
  const f = fixture(); f.q01.sample.minSupportedTasks = 50;
  f.record.rubric.q01Hash = hash(f.q01); f.artifacts.set(hash(f.q01), f.q01);
  for (const p of f.record.profiles) for (const r of p.quality) r.rubricHash = hash({ q01: hash(f.q01), supplement: f.record.rubric.supplementHash });
  f.seal(); expect(assess(f).profiles[0]!.quality.every(r => r.disposition === 'blocked')).toBe(true);
});
test('lower-bound decision cannot be quietly scored by point estimate', () => {
  const f = fixture(); f.q01.decision = 'lower-bound'; f.record.rubric.q01Hash = hash(f.q01); f.artifacts.set(hash(f.q01), f.q01);
  for (const p of f.record.profiles) for (const r of p.quality) r.rubricHash = hash({ q01: hash(f.q01), supplement: f.record.rubric.supplementHash });
  f.seal(); expect(assess(f).profiles[0]!.quality.find(r => r.check === 'repaired-intent')!.disposition).toBe('failed');
});
for (const check of ['negative-proposals', 'median-corrections', 'median-correction-time', 'request-budget', 'token-budget', 'latency-budget', 'grounded-inputs']) test(`bad numeric ${check} cannot hide behind met`, () => {
  const f = fixture(); const r = f.record.profiles[0]!.quality.find(r => r.check === check)!;
  const m = r.measurement!;
  if (m.kind === 'rate') m.numerator = m.denominator;
  else if (m.kind === 'count') m.value = 1;
  else m.p50 = m.p90 = m.p95 = m.max = 1000000;
  f.seal(); expect(assess(f).profiles[0]!.quality.find(r => r.check === check)!.disposition).toBe('failed');
});
test('task dispositions retain provider failures and refuse disappearing scheduled work', () => {
  const f = fixture(); const r = f.record.profiles[0]!.quality[0]!;
  r.taskDispositions = { passed: 59, provider_error: 1 }; f.seal();
  expect(assess(f).profiles[0]!.quality[0]!.taskDispositions.provider_error).toBe(1);
  r.taskDispositions = { passed: 59 }; f.seal(); expect(assess(f).blockers).toContain('invalid_release_record');
});
test('missing artifact fields fail closed without throwing', () => {
  const f = fixture(), row = f.record.profiles[0]!.journeys[0]!;
  const saved = { unknown: true }; row.proof!.artifact = hash(saved); f.artifacts.set(hash(saved), saved);
  expect(assess(f).profiles[0]!.journeys[0]!.disposition).toBe('blocked');
});

for (const key of SAFETY_KEYS) test(`heldout safety ${key} cannot be masked by deterministic passes`, () => {
  const f = fixture(); f.record.profiles[0]!.quality[0]!.safety![key] = 1; f.seal();
  expect(assess(f).profiles[0]!.quality[0]!.disposition).toBe('failed'); expect(assess(f).status).toBe('blocked');
});
test('missed abstentions fail even when all rate and effort thresholds meet', () => {
  const f = fixture(); f.record.profiles[0]!.quality[0]!.taskDispositions = { passed: 59, missed_abstention: 1 }; f.seal();
  expect(assess(f).profiles[0]!.quality[0]!.disposition).toBe('failed');
});
test('missing heldout safety remains unverified', () => {
  const f = fixture(); f.record.profiles[0]!.quality[0]!.safety = null; f.seal();
  expect(assess(f).profiles[0]!.quality[0]!.disposition).toBe('blocked');
});
test('observed live connector failure blocks release without upgrading optional not_run checks', () => {
  const f = fixture(); f.record.profiles[0]!.liveConnector.disposition = 'failed';
  expect(assess(f).status).toBe('blocked'); expect(assess(f).profiles[0]!.supportedJobs).toEqual([]);
  expect(assess(f).profiles[1]!.liveConnector.disposition).toBe('not_run');
});
test('renaming a profile cannot reuse receipts under another budget entry', () => {
  const f = fixture(); f.record.profiles[0]!.id = 'another-budget';
  expect(assess(f).profiles[0]!.status).toBe('blocked');
});
