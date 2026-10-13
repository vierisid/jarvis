import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { createCapture, deleteCapturesBefore } from '../vault/awareness.ts';
import { getOpportunityObservations, pruneOpportunityObservations } from '../vault/opportunity-observations.ts';
import { assessJobHypotheses, classifyJobSignals, OPPORTUNITY_WINDOW_MS } from './job-hypotheses.ts';
import { groupRoutineEpisodes } from './routine-episodes.ts';
import { assessOpportunities, getOpportunity, refreshOpportunity } from './opportunities.ts';
import { caseCaptures, EVALUATION_NOW, evaluateRoutines, proportion, type RoutineCase } from './evaluation/routine-evaluation.ts';
import type { JobSignal } from './opportunity-types.ts';

const fixture: RoutineCase = { id: 'meeting', usefulRoutine: 'meeting_followup', steps: [
  { app: 'Notes', text: 'Meeting notes' },
  { app: 'Notes', text: 'Meeting notes extracting action items' },
  { app: 'Editor', text: 'Meeting action list draft' },
] };
const signals = (f: RoutineCase = fixture) => caseCaptures(f).flatMap(classifyJobSignals);
const assess = (input = signals(), known = new Set<string>()) => assessJobHypotheses(input, [], known, EVALUATION_NOW);
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(closeDb);

test('six families and both fixture splits report precision and misses with real denominators', () => {
  for (const split of ['development', 'holdout'] as const) {
    const report = evaluateRoutines(split);
    expect(report.falseProposals).toBe(0);
    expect(report.proposalPrecision.denominator).toBeGreaterThanOrEqual(6);
    expect(report.proposalPrecision.numerator).toBe(report.proposalPrecision.denominator);
    expect(report.missedUsefulRoutines.denominator).toBe(report.usefulCases);
    expect(report.missedUsefulRoutines.numerator).toBeGreaterThan(0);
    expect(report.missedUsefulRoutines.rate!).toBeLessThanOrEqual(0.4);
    expect(new Set(report.cases.flatMap(c => c.proposed)).size).toBe(6);
    expect(report.totalCases).toBe(report.usefulCases + report.negativeCases);
  }
  expect(proportion(0, 0)).toEqual({ numerator: 0, denominator: 0, rate: null, wilson95: null });
  expect(proportion(8, 8).wilson95![0]).toBeLessThan(0.7);
  expect(proportion(0, 10).wilson95![1]).toBeGreaterThan(0.27);
});

test('structured hypotheses reference every role and never certify execution, readiness or goal progress', () => {
  const proposal = assess().proposals[0]!;
  expect(proposal.kind).toBe('meeting_followup');
  expect(proposal.routine?.episodes).toHaveLength(3);
  expect(proposal.routine?.episodes[0]).toEqual({
    source: { captureId: 'meeting-0-0', observedAt: caseCaptures(fixture)[0]!.timestamp, cue: 'meeting notes or transcript' },
    operation: { captureId: 'meeting-0-1', observedAt: caseCaptures(fixture)[1]!.timestamp, cue: 'extracting actions or owners' },
    output: { captureId: 'meeting-0-2', observedAt: caseCaptures(fixture)[2]!.timestamp, cue: 'meeting follow-up draft' },
  });
  expect(proposal.feasibility.status).toBe('unverified');
  expect(proposal.recurrence).toMatchObject({ episodes: 3, distinctDays: 3, basis: 'observed_activity' });
  expect(proposal.uncertainty.join(' ')).toContain('do not prove completed repetitions');
  expect(proposal.goalCandidates).toEqual([]);
  expect(assess(signals(), new Set(['job-v1:meeting_followup'])).abstention).toBe('already_proposed');
});

test('static repeated screenshots, including all phases on one page, never make an episode', () => {
  const text = fixture.steps.map(s => s.text).join('\n');
  const repeated = signals({ ...fixture, steps: Array.from({ length: 100 }, () => ({ app: 'Browser', text })) });
  expect(assess(repeated).proposals).toEqual([]);
  expect(groupRoutineEpisodes(repeated, EVALUATION_NOW)).toEqual([]);
  expect(assess([...signals(), ...signals()].reverse()).proposals[0]!.recurrence.episodes).toBe(3);
});

test('phases cannot be joined across devices, out of order, equal timestamps or long gaps', () => {
  for (const f of [
    { ...fixture, devices: ['one', 'two', 'three'] },
    { ...fixture, steps: [...fixture.steps].reverse() },
    { ...fixture, stepGapMinutes: 30 },
    { ...fixture, stepGapMinutes: 0 },
  ]) expect(assess(signals(f)).proposals).toEqual([]);
  expect(assess(signals({ ...fixture, stepGapMinutes: 29 })).proposals).toHaveLength(1);
  const duplicateDevices = signals().flatMap(s => [s, { ...s, captureId: `${s.captureId}-other`, routine: { ...s.routine!, sidecarId: 'other' } }]);
  expect(assess(duplicateDevices).proposals[0]!.recurrence.episodes).toBe(3);
});

test('another device cannot bridge a stale partial episode', () => {
  const input = signals().flatMap(s => {
    const stage = s.routine!.stage;
    if (stage === 'source') return [s, ...[20, 40, 60, 80].map(minute => ({ ...s,
      captureId: `${s.captureId}-bridge-${minute}`, observedAt: s.observedAt + minute * 60_000,
      routine: { ...s.routine!, sidecarId: 'other-device' },
    }))];
    return [{ ...s, observedAt: s.observedAt + 88 * 60_000 }];
  });
  expect(groupRoutineEpisodes(input, EVALUATION_NOW)).toEqual([]);
  expect(assess(input).proposals).toEqual([]);
});

test('continuous activity across midnight is one episode even when all phases repeat', () => {
  const input = signals({ ...fixture, continuous: true });
  expect(new Set(input.map(s => new Date(s.observedAt).getUTCDate())).size).toBeGreaterThan(1);
  expect(groupRoutineEpisodes(input, EVALUATION_NOW)).toHaveLength(1);
  expect(assess(input).abstention).toBe('insufficient_recurrence');
});

test('legacy, malformed, stale and future observations never acquire structured evidence', () => {
  const input = signals();
  for (const replacement of [undefined, { policy: 'unknown' }, { policy: 'routine-cues-v2', stage: 'source', sidecarId: 23 }]) {
    expect(assess(input.map(s => ({ ...s, routine: replacement as JobSignal['routine'] }))).proposals).toEqual([]);
  }
  for (const timestamp of [NaN, Infinity, EVALUATION_NOW + 1, EVALUATION_NOW - OPPORTUNITY_WINDOW_MS - 1]) {
    expect(assess(input.map(s => ({ ...s, observedAt: timestamp }))).proposals).toEqual([]);
  }
});

test('privacy, reading, app-only and input overflow abstain before producing retainable cues', () => {
  const base = { captureId: 'x', timestamp: EVALUATION_NOW, ocrText: 'Meeting notes extracting action items' };
  for (const overrides of [
    { excluded: true }, { app: 'Bitwarden' }, { windowTitle: 'Private browsing' },
    { windowTitle: 'Research paper' }, { windowTitle: 'Tutorial' },
    { ocrText: 'x'.repeat(2001) }, { windowTitle: 'x'.repeat(241) },
    { app: 'x'.repeat(101) }, { sidecarId: 'x'.repeat(201) },
    { app: 'Meeting notes extracting action items', ocrText: 'Inbox' },
  ]) expect(classifyJobSignals({ ...base, ...overrides })).toEqual([]);
});

test('durable evidence survives capture cleanup/restart without retaining new raw text; metadata-only is excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q11-routine-'));
  const dbPath = join(dir, 'vault.db');
  try {
    initDatabase(dbPath, { quiet: true });
    const shift = Date.now() - EVALUATION_NOW;
    for (const c of caseCaptures(fixture)) createCapture({ timestamp: c.timestamp + shift, pixelChangePct: 0.5,
      appName: c.app!, ocrText: `${c.ocrText}\nSENSITIVE-FIXTURE`, sidecarId: c.sidecarId! });
    createCapture({ timestamp: Date.now(), pixelChangePct: 0.5, windowTitle: 'Overdue invoices', retentionTier: 'metadata_only' });
    expect(getOpportunityObservations()).toHaveLength(9);
    const retained = JSON.stringify(getDb().query('SELECT * FROM opportunity_observations').all());
    expect(retained).not.toContain('SENSITIVE-FIXTURE');
    expect(retained).not.toContain('extracting action items');
    deleteCapturesBefore(Date.now(), 'full');
    closeDb();
    initDatabase(dbPath, { quiet: true });
    const proposal = assessOpportunities().proposals[0]!;
    expect(proposal.routine?.episodes).toHaveLength(3);
    const suggestion = refreshOpportunity()!;
    expect(getOpportunity(suggestion.id)?.hypothesis.routine).toEqual(proposal.routine);
    expect(refreshOpportunity()).toBeNull();
    pruneOpportunityObservations(Date.now() + OPPORTUNITY_WINDOW_MS);
    expect(getOpportunityObservations()).toEqual([]);
  } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
});

test('pre-Q11 schemas upgrade without backfill, and old writers/readers remain usable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q11-upgrade-'));
  try {
    const path = join(dir, 'vault.db');
    const db = initDatabase(path, { quiet: true });
    db.run('ALTER TABLE opportunity_observations DROP COLUMN routine_evidence');
    const now = Date.now();
    for (let i = 1; i <= 3; i++) db.query(`INSERT INTO opportunity_observations VALUES (?, ?, ?, ?, ?)`).run(
      `legacy-${i}`, 'invoice_review', now - i * 86_400_000, 'Accounting', 'unpaid or overdue invoices');
    closeDb();
    initDatabase(path, { quiet: true });
    expect(getOpportunityObservations()).toHaveLength(3);
    expect(assessOpportunities().proposals).toEqual([]);
    getDb().query(`INSERT INTO opportunity_observations (capture_id,kind,observed_at,app,cue) VALUES (?,?,?,?,?)`)
      .run('old-writer', 'invoice_review', now, 'Accounting', 'unpaid or overdue invoices');
    expect(getDb().query('SELECT capture_id, kind, observed_at, app, cue FROM opportunity_observations').all()).toHaveLength(4);
    getDb().query('UPDATE opportunity_observations SET routine_evidence = ?').run('invalid-json');
    expect(assessOpportunities().proposals).toEqual([]);
  } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
});
