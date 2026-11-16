import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { closeDb, getDb, initDatabase } from '../vault/schema';
import { ensureWorkflowSchema } from '../workflows/db';
import { ensureOutcomeSchema } from '../vault/outcome-schema';
import { createFlow, deleteFlow, setPublishedVersion } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../workflows/db/repos/flow-run';
import { createWaitpoint } from '../workflows/db/repos/waitpoint';
import { createWorkItem, decideWorkItem, checkWorkResult } from '../goals/work-items';
import { startWorkItemRun } from '../goals/workflow-bridge';
import { getGoalApplication } from '../goals/application-service';
import { Outcomes, type OutcomeSummary } from './outcomes';
import { outcomeCalendar } from './outcome-windows';
import type { BriefOutcome, BriefReadResult } from './contracts';

const realNow = Date.now, HOUR = 3_600_000;
let now: number, dir: string, file: string, provider: Outcomes;
beforeEach(() => {
  now = Date.UTC(2026, 9, 7, 9); Date.now = () => now;
  dir = mkdtempSync(join(tmpdir(), 'jarvis-f16-')); file = join(dir, 'vault.db');
  initDatabase(file, { quiet: true }); ensureWorkflowSchema(); provider = new Outcomes(getDb());
});
afterEach(() => { getGoalApplication().stopDelivery(); closeDb(); Date.now = realNow; rmSync(dir, { recursive: true, force: true }); });
const result = { verdict: 'passed', summary: 'Report checked', evidence: [{ ref: 'owner:report', description: 'Checked against the source' }] };
function work(manual = false, goalId?: string) {
  const created = now, flow = createFlow(), version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Report', trigger: { name: 'trigger', type: 'EMPTY' } }).id);
  setPublishedVersion(flow.id, version.id);
  const item = createWorkItem({ title: 'Check report', ...(goalId ? { goalId } : {}),
    ...(manual ? {} : { mode: 'workflow', workflowId: flow.id, workflowVersionId: version.id }) });
  decideWorkItem(item.id, { outcome: 'accepted', reason: 'Owner chose this work' });
  const run = manual ? null : startWorkItemRun(item.id, flow.id);
  now += HOUR;
  if (run) updateRun(run.id, { status: 'SUCCEEDED', finishTime: now });
  const checked = checkWorkResult(item.id, result);
  return { item, run, flow, version, checked, created };
}
function time(w: ReturnType<typeof work>, revision = 0, requestId = 'time1') {
  return { requestId, revision, resultCheckId: w.checked.resultCheck!.id,
    baseline: { minutes: 30, evidence: { id: 'manual-report-stopwatch', revision: 'v1' } },
    intervention: { intervals: [{ start: w.created, end: w.created + 5 * 60_000 }], evidence: { id: 'review-stopwatch', revision: 'v1' } } };
}
/** With sources readable, no counted work is a known zero, not an unknown. */
async function nothing() {
  const view = ready<OutcomeSummary>(await provider.summary({ timezone: 'UTC' }));
  expect(view.outcomes).toEqual([]); expect(view.week).toMatchObject({ value: 0, qualification: 'estimated' }); expect(view.today?.value).toBe(0);
}
const query = () => ({ start: Date.UTC(2026, 9, 5), end: Date.UTC(2026, 9, 12), timezone: 'UTC' });
const ready = <T>(r: BriefReadResult<T>): T => { expect(r.state).toBe('ready'); return (r as { data: T }).data; };
const read = async () => ready<BriefOutcome[]>(await provider.read(query()));
const summary = async () => ready<OutcomeSummary>(await provider.summary({ timezone: 'UTC' }));
function effect(runId: string, status: string, extra: object = {}) {
  const record = { id: 'effect-1', runId, status, finishedAt: now, ...extra };
  getDb().run('INSERT OR REPLACE INTO workflow_effect(id,run_id,status,record) VALUES(?,?,?,?)', ['effect-1', runId, status, JSON.stringify(record)]);
}

test('no evidence is empty; goal titles and unrun workflows never invent time or goal counts', async () => {
  getGoalApplication().createGoal('90 minutes saved and six of ten', 'objective');
  expect((await provider.read(query())).state).toBe('empty');
  await nothing();
  const w = work(); getDb().run('UPDATE flow SET time_saved_per_run=90 WHERE id=?', [w.flow.id]);
  getDb().run("UPDATE flow_run SET status='FAILED' WHERE id=?", [w.run!.id]);
  await nothing();
});

// Founder decision (reverses #805): enabling a workflow is enough. Every successful
// production root run counts, with the owner's minutes or an estimate from its steps.
const step = (name: string, pieceName: string, extra: object = {}) => ({ name, type: 'PIECE', settings: { pieceName, actionName: 'a', input: {} }, ...extra });
function runFlow(opts: { minutes?: number; steps?: object | null; runs?: number; projectId?: string } = {}) {
  const flow = createFlow(opts.projectId ? { projectId: opts.projectId } : {});
  const version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Daily', trigger: { name: 'trigger', type: 'EMPTY' } }).id);
  setPublishedVersion(flow.id, version.id);
  if (opts.minutes !== undefined) getDb().run('UPDATE flow SET time_saved_per_run=? WHERE id=?', [opts.minutes, flow.id]);
  const runs = Array.from({ length: opts.runs ?? 1 }, () => {
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    return updateRun(run.id, { status: 'SUCCEEDED', finishTime: now - 60_000 });
  });
  // Written after the runs exist: the steps shape the estimate, and this test is not about piece readiness.
  const graph = { name: 'trigger', type: 'EMPTY', ...(opts.steps === null ? {} : { nextAction: opts.steps ?? step('step_1', '@jarvispieces/piece-jarvis-report') }) };
  getDb().run('UPDATE flow_version SET trigger=? WHERE id=?', [JSON.stringify(graph), version.id]);
  return { flow, version, runs };
}
test('an enabled workflow successful production run counts as estimated time, with no check or time record', async () => {
  runFlow({ runs: 3 });
  const view = await summary();
  expect(view.today).toMatchObject({ value: 30, unit: 'minutes', qualification: 'estimated' });
  expect(view.week?.value).toBe(30); expect(view.days.find(d => d.current)?.time?.value).toBe(30);
  expect(view.todayBasis).toBe("3 runs x about 10 min. Estimated from the workflow's steps.");
  expect(view.days.find(d => d.current)?.basis).toBe(view.todayBasis);
  expect(view.outcomes).toEqual([]); expect(view.completedWork).toBeNull();
});
test('the estimate follows the steps and has a floor of one minute', async () => {
  runFlow({ steps: step('s1', '@jarvispieces/piece-jarvis-notify') });
  expect((await summary()).week?.value).toBe(1);
  runFlow({ steps: null });
  expect((await summary()).week?.value).toBe(2);
  runFlow({ steps: step('s1', '@activepieces/piece-gmail', { nextAction: step('s2', '@jarvispieces/piece-jarvis-ask', { nextAction: step('s3', '@activepieces/piece-json') }) }) });
  expect((await summary()).week?.value).toBe(2 + 8);
});
test('owner-set minutes per run replace the estimate, and zero is a real answer', async () => {
  const a = runFlow({ minutes: 12, runs: 2 });
  const view = await summary();
  expect(view.week?.value).toBe(24); expect(view.week?.qualification).toBe('estimated');
  expect(view.weekBasis).toBe('2 runs x 12 min. You set the minutes per run.');
  getDb().run('UPDATE flow SET time_saved_per_run=0 WHERE id=?', [a.flow.id]);
  expect((await summary()).week?.value).toBe(0);
});
for (const [name, patch] of [['failed', "status='FAILED'"], ['test-environment', "environment='TESTING'"], ['single-step test', "step_name_to_test='trigger'"],
  ['sample-data', "execution_config='{\"sampleData\":{}}'"], ['stepNameToTest in config', "execution_config='{\"stepNameToTest\":\"trigger\"}'"], ['sample-input', "execution_config='{\"sampleInputOverride\":{}}'"]] as const)
  test(`a ${name} run never counts as time saved`, async () => {
    const f = runFlow(); getDb().run(`UPDATE flow_run SET ${patch} WHERE id=?`, [f.runs[0]!.id]);
    await nothing();
  });
test('child runs never count separately from their root run', async () => {
  const f = runFlow();
  const child = createFlowRun({ flowId: f.flow.id, flowVersionId: f.version.id, parentRunId: f.runs[0]!.id });
  updateRun(child.id, { status: 'SUCCEEDED', finishTime: now - 1000 });
  expect((await summary()).week?.value).toBe(10);
});
test('a checked work item with a time record wins for its run and is not counted twice', async () => {
  const w = work(); getDb().run('UPDATE flow SET time_saved_per_run=50 WHERE id=?', [w.flow.id]);
  provider.recordTime(w.item.id, time(w));
  let view = await summary();
  expect(view.week).toMatchObject({ value: 25, qualification: 'user_reported' }); expect(view.weekBasis).toBe('1 checked work item with minutes you reported.');
  // A second, ordinary run of the same workflow still counts its own estimate.
  const extra = createFlowRun({ flowId: w.flow.id, flowVersionId: w.version.id });
  updateRun(extra.id, { status: 'SUCCEEDED', finishTime: now - 1000 });
  view = await summary();
  expect(view.week).toMatchObject({ value: 75, qualification: 'estimated' });
  expect(view.weekBasis).toBe('1 run x 50 min. You set the minutes per run. 1 checked work item with minutes you reported.');
});
test('a checked work item without a time record counts its run as an estimate', async () => {
  const w = work(); expect((await summary()).week).toMatchObject({ value: 1, qualification: 'estimated' }); expect(w.run).not.toBeNull();
});
test('estimated time lands in the local day of the run finish, by timezone', async () => {
  // 23:30 UTC on 6 Oct is already 7 Oct in Rome, so it counts for Tuesday there and Monday in UTC.
  const f = runFlow({ minutes: 7 });
  updateRun(f.runs[0]!.id, { finishTime: Date.UTC(2026, 9, 6, 23, 30) });
  const dayOf = (view: OutcomeSummary) => view.days.filter(d => d.time?.value).map(d => [d.id, d.time!.value]);
  expect(dayOf(await summary())).toEqual([['2026-10-06', 7]]);
  expect(dayOf(ready<OutcomeSummary>(await provider.summary({ timezone: 'Europe/Rome' })))).toEqual([['2026-10-07', 7]]);
  updateRun(f.runs[0]!.id, { finishTime: Date.UTC(2026, 9, 4, 23, 59) });
  await nothing();
});
test('manual checked work counts once but cannot manufacture an automation time claim', async () => {
  const w = work(true); expect((await read())[0]).toMatchObject({ workItemId: w.item.id, runId: null, timeBack: null });
  expect(() => provider.recordTime(w.item.id, time(w))).toThrow('eligible checked workflow');
});
test('explicit baseline minus observed intervention, without double subtracting overlapping intervals', async () => {
  const w = work(), c = time(w); c.intervention.intervals.push({ start: w.created + 2 * 60_000, end: w.created + 10 * 60_000 });
  const receipt = provider.recordTime(w.item.id, c); expect(receipt.revision).toBe(1);
  const view = await summary(); expect(view.week).toMatchObject({ value: 20, baseline: 30, unit: 'minutes', qualification: 'user_reported' });
  expect(view.coverage).toMatchObject({ complete: true, timed: 1 }); expect(view.today?.value).toBe(20);
  expect(view.days.filter(d => d.time?.value)).toHaveLength(1); expect(view.days.reduce((n, d) => n + (d.time?.value ?? 0), 0)).toBe(20);
});
test('time corrections replace benefit in the original completion window; exact recovery survives restart', async () => {
  const w = work(), first = time(w), original = provider.recordTime(w.item.id, first);
  now += 86_400_000;
  const correction = time(w, 1, 'corrected'); correction.baseline.minutes = 10;
  provider.recordTime(w.item.id, correction);
  closeDb(); initDatabase(file, { quiet: true }); ensureWorkflowSchema(); provider = new Outcomes(getDb());
  expect(provider.currentTime(w.item.id)).toMatchObject({ revision: 2, baseline: { minutes: 10 }, intervention: correction.intervention });
  expect(provider.recordTime(w.item.id, first)).toEqual(original); expect(provider.timeReceipt(w.item.id, first.requestId)).toEqual(original);
  const view = await summary(); expect(view.week?.value).toBe(5); expect(view.today?.value).toBe(0);
  expect(view.days.find(d => d.id === '2026-10-07')?.time?.value).toBe(5);
  expect(getDb().query('SELECT * FROM outcome_time_record').all()).toHaveLength(2);
});
test('negative time corrections retain overhead and measured zero is distinct from unknown', async () => {
  const w = work(), c = time(w); c.baseline.minutes = 2; provider.recordTime(w.item.id, c);
  expect((await summary()).week?.value).toBe(-3);
  const zero = time(w, 1, 'zero'); zero.baseline.minutes = 5; provider.recordTime(w.item.id, zero);
  expect((await summary()).week?.value).toBe(0);
});
test('stale revisions, changed retries, invalid intervals and injected fields cannot rewrite time evidence', () => {
  const w = work(), c = time(w); provider.recordTime(w.item.id, c);
  for (const bad of [{ ...c, requestId: 'stale' }, { ...c, baseline: { ...c.baseline, minutes: 100 } },
    { ...c, requestId: 'bad', revision: 1, qualification: 'measured' },
    { ...c, requestId: 'bad', revision: 1, intervention: { ...c.intervention, intervals: [{ start: now, end: now + 1 }] } },
    { ...c, requestId: 'bad', revision: 1, intervention: { ...c.intervention, intervals: [{ start: w.created - 1, end: now }] } },
  ]) expect(() => provider.recordTime(w.item.id, bad)).toThrow();
  expect(getDb().query('SELECT * FROM outcome_time_record').all()).toHaveLength(1);
});
test('outer rollback leaves no time receipt and additive migration preserves old commitments', () => {
  const w = work(); expect(() => getDb().transaction(() => { provider.recordTime(w.item.id, time(w)); throw Error('rollback'); })()).toThrow('rollback');
  expect(provider.timeReceipt(w.item.id, 'time1')).toBeNull();
  const db = new Database(':memory:'); try {
    db.run('CREATE TABLE commitments(id TEXT PRIMARY KEY)'); db.run("INSERT INTO commitments VALUES('legacy')");
    ensureOutcomeSchema(db); ensureOutcomeSchema(db); expect(db.query('SELECT * FROM commitments').all()).toEqual([{ id: 'legacy' }]);
    expect(db.query('SELECT * FROM outcome_time_record').all()).toEqual([]);
  } finally { db.close(); }
});
for (const status of ['pending', 'dispatching', 'failed', 'blocked', 'unknown']) test(`effect ${status} invalidates a checked success`, async () => {
  const w = work(); provider.recordTime(w.item.id, time(w)); effect(w.run!.id, status);
  expect(await provider.read(query())).toMatchObject({ state: 'empty', coverage: { eligible: 0, excluded: { uncertain_effect: 1 } } });
});
test('succeeded effects need matching durable identities and completion time', async () => {
  const w = work(); effect(w.run!.id, 'succeeded'); expect(await read()).toHaveLength(1);
  effect(w.run!.id, 'succeeded', { runId: 'other-run' }); expect((await provider.read(query())).state).toBe('empty');
  effect(w.run!.id, 'succeeded', { finishedAt: now + 1 }); expect((await provider.read(query())).state).toBe('empty');
});
for (const patch of ["status='FAILED'", "environment='TESTING'", "step_name_to_test='trigger'", "execution_config='{\"sampleData\":{}}'"])
  test(`current run evidence excludes ${patch}`, async () => {
    const w = work(); getDb().run(`UPDATE flow_run SET ${patch} WHERE id=?`, [w.run!.id]);
    expect((await provider.read(query())).state).toBe('empty');
  });
test('pending waitpoints and cancellation remain excluded even after a passed check', async () => {
  const w = work(); createWaitpoint({ flowRunId: w.run!.id, projectId: w.run!.projectId, stepName: 'review', type: 'MANUAL' });
  expect((await provider.read(query())).state).toBe('empty');
  getDb().run('DELETE FROM waitpoint');
  getDb().run('INSERT INTO workflow_run_cancellation VALUES(?,?,?,?)', [w.run!.id, now, 'RUNNING', 1]);
  expect((await provider.read(query())).state).toBe('empty');
});
test('nested runs cannot count independently or hide uncertainty from their parent', async () => {
  const w = work(); const child = createFlowRun({ flowId: w.flow.id, flowVersionId: w.version.id, parentRunId: w.run!.id });
  updateRun(child.id, { status: 'SUCCEEDED', finishTime: now }); effect(child.id, 'unknown');
  expect((await provider.read(query())).state).toBe('empty');
  effect(child.id, 'succeeded'); expect(await read()).toHaveLength(1);
  getDb().run('UPDATE flow_run SET parent_run_id=? WHERE id=?', [child.id, w.run!.id]);
  expect((await provider.read(query())).state).toBe('empty');
});
test('unique run bindings and windowed reads prevent duplicate benefit through another goal link', async () => {
  const w = work(); provider.recordTime(w.item.id, time(w));
  const goal = getGoalApplication().createGoal('Another goal', 'objective'); now += 86_400_000;
  const second = createWorkItem({ title: 'Same run, another goal', goalId: goal.id, mode: 'workflow', workflowId: w.flow.id, workflowVersionId: w.version.id });
  decideWorkItem(second.id, { outcome: 'accepted', reason: 'Link the report' });
  expect(() => getDb().run('UPDATE commitment_work SET run_id=? WHERE work_id=?', [w.run!.id, second.id])).toThrow('UNIQUE');
  expect(await read()).toHaveLength(1);
  expect((await provider.read(outcomeCalendar(now, 'UTC').today))).toMatchObject({ state: 'empty', coverage: { eligible: 0 } });
  expect((await summary()).week?.value).toBe(25); expect((await summary()).week?.value).toBe(25);
  getDb().run("UPDATE commitments SET status='failed' WHERE id=?", [w.item.id]); expect((await provider.read(query())).state).toBe('empty');
});
test('half-open windows do not repeat work at an exact boundary', async () => {
  const w = work(), t = w.checked.resultCheck!.checkedAt;
  expect((await provider.read({ start: t - 1, end: t, timezone: 'UTC' })).state).toBe('empty');
  expect(ready(await provider.read({ start: t, end: t + 1, timezone: 'UTC' }))).toHaveLength(1);
});
test('timezone midnight, DST spring/fall and Monday week boundaries are calendar based', () => {
  const spring = outcomeCalendar(Date.UTC(2026, 2, 29, 12), 'Europe/Berlin');
  const fall = outcomeCalendar(Date.UTC(2026, 9, 25, 12), 'Europe/Berlin');
  expect(spring.today.end - spring.today.start).toBe(23 * HOUR); expect(fall.today.end - fall.today.start).toBe(25 * HOUR);
  expect(spring.days[0]!.id).toBe('2026-03-23'); expect(fall.days[0]!.id).toBe('2026-10-19');
  expect(outcomeCalendar(Date.UTC(2026, 9, 7, 23), 'Pacific/Auckland').days.some(d => d.id === '2026-10-08')).toBe(true);
  const midnight = outcomeCalendar(Date.UTC(2026, 9, 7, 22), 'Europe/Berlin'); expect(midnight.today.start).toBe(Date.UTC(2026, 9, 7, 22));
});
function measurement(goalId: string, value: number, at: number, revision: number, unit = 'partners') {
  getGoalApplication().recordMeasurement(goalId, { requestId: `m${revision}`, revision,
    measurement: { unit, baseline: 0, target: 10, value, measuredAt: at, evidence: { id: `ledger:${goalId}`, revision: String(revision) } } });
}
test('goal deltas are actual signed observations, independent of work and parent/child totals', async () => {
  const parent = getGoalApplication().createGoal('Parent', 'objective'), child = getGoalApplication().createGoal('Child', 'key_result', { parent_id: parent.id });
  const start = query().start;
  measurement(parent.id, 5, start - 1, 0); measurement(parent.id, 6, start + 1, 1); measurement(parent.id, 3, start + 2, 2);
  measurement(child.id, 1, start - 1, 0); measurement(child.id, 2, start + 1, 1);
  const view = await summary(); expect(view.completedWork).toBeNull(); expect(view.week?.value).toBe(0);
  expect(view.goalDeltas.find(g => g.goalId === parent.id)).toMatchObject({ change: { value: -2 }, attribution: 'observed_change_only', rollup: 'independent' });
  expect(view.goalDeltas.find(g => g.goalId === child.id)?.change?.value).toBe(1);
});
test('goal deltas keep the recorded qualification and refuse an unqualified observation', async () => {
  const g = getGoalApplication().createGoal('Goal', 'objective'), start = query().start;
  measurement(g.id, 5, start - 1, 0); measurement(g.id, 7, start + 1, 1);
  expect((await summary()).goalDeltas[0]?.change).toMatchObject({ value: 2, qualification: 'user_reported' });
  const row = getDb().query<{ receipt: string }, [string]>('SELECT receipt FROM goal_measurement_receipt WHERE goal_id=? AND request_id=\'m1\'').get(g.id)!;
  const receipt = JSON.parse(row.receipt); receipt.measurement.qualification = 'estimated';
  getDb().run('UPDATE goal_measurement_receipt SET receipt=? WHERE goal_id=? AND request_id=\'m1\'', [JSON.stringify(receipt), g.id]);
  await expect(provider.summary({ timezone: 'UTC' })).rejects.toThrow('Goal evidence is incomplete');
});
test('a switch between typed values and counted observations is a changed definition, not a delta', async () => {
  const g = getGoalApplication().createGoal('Goal', 'objective'), start = query().start;
  measurement(g.id, 6, start - 1, 0); measurement(g.id, 3, start + 1, 1);
  expect((await summary()).goalDeltas[0]?.change?.value).toBe(-3);
  const row = getDb().query<{ receipt: string }, [string]>('SELECT receipt FROM goal_measurement_receipt WHERE goal_id=? AND request_id=\'m1\'').get(g.id)!;
  const receipt = JSON.parse(row.receipt); receipt.measurement.basis = 'observations';
  getDb().run('UPDATE goal_measurement_receipt SET receipt=? WHERE goal_id=? AND request_id=\'m1\'', [JSON.stringify(receipt), g.id]);
  const view = await summary();
  expect(view.goalDeltas[0]).toMatchObject({ change: null, reason: 'definition_changed' }); expect(view.coverage.complete).toBe(false);
});
test('Q-17 counted entries: a typed total switched to counting is a changed definition, counted deltas use the latest entry', async () => {
  const app = getGoalApplication(), start = query().start;
  const entry = (goalId: string, subject: string, n: number) => app.recordObservation(goalId, { requestId: `e${n}`,
    entry: { kind: 'counted', subject, observedAt: now, source: { id: `contract:${subject}`, revision: 'v1' }, corrects: null } });
  const switched = app.createGoal('Switched', 'objective');
  measurement(switched.id, 6, start - 1, 0);
  app.defineCountedMeasurement(switched.id, { requestId: 'define', revision: 1, definition: { unit: 'partners', baseline: 0, target: 10 } });
  ['Acme', 'Globex', 'Initech'].forEach((subject, i) => entry(switched.id, subject, i));
  const view = await summary();
  expect(view.goalDeltas.find(g => g.goalId === switched.id)).toMatchObject({ change: null, reason: 'definition_changed' });
  expect(view.coverage.complete).toBe(false);
  // A counted goal with entries before and inside the window: all entries share one
  // clock millisecond here, so the latest must follow insertion, not request ids.
  const counted = app.createGoal('Counted', 'objective');
  app.defineCountedMeasurement(counted.id, { requestId: 'define', revision: 0, definition: { unit: 'partners', baseline: 0, target: 10 } });
  const saved = now; now = start - 1; entry(counted.id, 'Acme', 10); now = saved;
  ['Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark'].forEach((subject, i) => entry(counted.id, subject, 11 + i));
  expect((await summary()).goalDeltas.find(g => g.goalId === counted.id)?.change).toMatchObject({ value: 5, baseline: 1, unit: 'partners' });
});
test('missing opening measurements and changed definitions omit the delta, with incomplete coverage', async () => {
  const g = getGoalApplication().createGoal('Goal', 'objective'); measurement(g.id, 6, query().start + 1, 0);
  expect((await summary()).goalDeltas[0]).toMatchObject({ change: null, reason: 'missing_opening' });
  const other = getGoalApplication().createGoal('Other', 'objective'); measurement(other.id, 5, query().start - 1, 0); measurement(other.id, 6, query().start + 1, 1, 'contracts');
  expect((await summary()).goalDeltas.find(g => g.goalId === other.id)).toMatchObject({ change: null, reason: 'definition_changed' });
  expect((await summary()).coverage.complete).toBe(false);
});
test('bad queries and replaced databases are unavailable, never fabricated empty success', async () => {
  for (const q of [{ ...query(), end: query().start }, { ...query(), timezone: '+02:00' }, { ...query(), start: NaN }, { ...query(), extra: true }])
    await expect(provider.read(q)).rejects.toThrow();
  closeDb(); initDatabase(file, { quiet: true }); expect(provider.readiness()).toBe('unavailable');
  await expect(provider.read(query())).rejects.toThrow('unavailable');
});

test('missing F15 sources fail readiness rather than falling back to scores', async () => {
  getDb().run('DROP TABLE goal_measurement_receipt'); expect(provider.readiness()).toBe('unavailable');
  await expect(provider.summary({ timezone: 'UTC' })).rejects.toThrow('unavailable');
});
test('time evidence alone cannot hide a later invalidated run or a failed work result', async () => {
  const w = work(); provider.recordTime(w.item.id, time(w));
  updateRun(w.run!.id, { status: 'FAILED' }); await nothing();
  expect(provider.timeReceipt(w.item.id, 'time1')).not.toBeNull();
});

test('a skipped local date has no work and cannot mark two days current', () => {
  const c = outcomeCalendar(Date.UTC(2011, 11, 30, 12), 'Pacific/Apia');
  const skipped = c.days.find(d => d.id === '2011-12-30')!;
  expect(skipped.start).toBe(skipped.end); expect(c.date).toBe('2011-12-31');
  expect(c.days.filter(d => d.id === c.date)).toHaveLength(1);
});

test('daily and weekly goal deltas have distinct observed openings', async () => {
  const g = getGoalApplication().createGoal('Daily goal', 'objective');
  measurement(g.id, 1, query().start - 1, 0); measurement(g.id, 3, query().start + 1, 1);
  measurement(g.id, 5, Date.UTC(2026, 9, 7, 8), 2);
  const view = await summary(); expect(view.goalDeltas[0]!.change?.value).toBe(4);
  expect(view.todayGoalDeltas[0]!.change?.value).toBe(2);
});

test('outcome projections never expose captured run output or effect payloads', async () => {
  const w = work(); provider.recordTime(w.item.id, time(w));
  updateRun(w.run!.id, { steps: { report: { output: 'CAPTURED-PROMPT-INJECTION', input: 'PRIVATE-RUN-INPUT' } } });
  effect(w.run!.id, 'succeeded', { arguments: { token: 'PRIVATE-EFFECT-ARGUMENT' }, result: 'PRIVATE-EFFECT-OUTPUT', target: { secret: 'PRIVATE-TARGET' } });
  const projected = JSON.stringify(await summary());
  expect(projected).toContain('checked work items');
  for (const payload of ['CAPTURED-PROMPT-INJECTION', 'PRIVATE-RUN-INPUT', 'PRIVATE-EFFECT-ARGUMENT', 'PRIVATE-EFFECT-OUTPUT', 'PRIVATE-TARGET']) expect(projected).not.toContain(payload);
});


// Use the production launch backend so the retained receipt has its real shape.
async function nestedWork(depth = 1) {
  const { configureWorkflowReadiness } = await import('../workflows/db/repos/flow-readiness');
  const { PieceCatalog } = await import('../workflows/runtime/piece-catalog');
  configureWorkflowReadiness({ pieces: new PieceCatalog([{
    name: '@jarvispieces/piece-jarvis-trigger', version: '0.0.1', displayName: 'Workflow', description: 'Fixture metadata',
    actions: { run_workflow: { name: 'run_workflow', displayName: 'Run workflow', description: 'Launch child', requireAuth: false } },
  }]) });
  const { buildSandboxServiceBackends } = await import('../workflows/runtime/service-backends');
  const { AuthorityEngine } = await import('../authority/engine');
  const { EmergencyController } = await import('../authority/emergency');
  const { AuditTrail } = await import('../authority/audit');
  const { CredentialResolver } = await import('../workflows/credentials/adapter');
  const { WorkflowEventBuffer } = await import('../workflows/runtime/event-buffer');
  const backend = buildSandboxServiceBackends({
    credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any,
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
  });
  const create = (launch: boolean) => {
    const flow = createFlow(), version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Nested report', trigger: {
      name: 'trigger', type: 'EMPTY', ...(launch ? { nextAction: { name: 'child', type: 'PIECE', settings: {
        pieceName: '@jarvispieces/piece-jarvis-trigger', pieceVersion: '0.0.1', actionName: 'run_workflow', input: {},
      } } } : {}),
    } }).id);
    setPublishedVersion(flow.id, version.id); return { flow, version };
  };
  const created = now, root = create(true);
  const item = createWorkItem({ title: 'Parent work', mode: 'workflow', workflowId: root.flow.id, workflowVersionId: root.version.id });
  decideWorkItem(item.id, { outcome: 'accepted', reason: 'Requested nested report' });
  const run = startWorkItemRun(item.id, root.flow.id), children = [];
  let parent = run;
  for (let i = 0; i < depth; i++) {
    updateRun(parent.id, { status: 'RUNNING' });
    const child = create(i + 1 < depth);
    const launched = await backend.workflowsStart!({ flowId: child.flow.id }, { runId: parent.id, projectId: parent.projectId, stepName: 'child', executionPath: [] });
    const childRun = getFlowRun(launched.runId!)!;
    children.push({ ...child, run: childRun }); parent = childRun;
  }
  now += HOUR;
  return { ...root, item, run, created, children };
}
for (const status of ['FAILED', 'QUEUED', 'SUCCEEDED'] as const) test(`F16 review R1: deleting a ${status} child's workflow cannot qualify its parent`, async () => {
  const w = await nestedWork(), child = w.children[0]!;
  updateRun(child.run.id, { status, finishTime: status === 'QUEUED' ? null : now });
  updateRun(w.run.id, { status: 'SUCCEEDED', finishTime: now });
  const checked = checkWorkResult(w.item.id, result), command = time({ ...w, checked });
  if (status === 'SUCCEEDED') {
    provider.recordTime(w.item.id, command); expect((await summary()).week?.value).toBe(25);
  } else expect((await provider.read(query())).state).toBe('empty');
  deleteFlow(child.flow.id);
  expect(getFlowRun(child.run.id)).toBeNull(); expect(getFlowRun(w.run.id)).not.toBeNull();
  expect(await provider.read(query())).toMatchObject({ state: 'unavailable', coverage: { eligible: 0, excluded: { run_coverage_incomplete: 1 } } });
  // The checked evidence is invalid, so none of it counts. The root run itself still
  // succeeded, so it counts as an estimate and never as the owner's reported time.
  const after = ready<OutcomeSummary>(await provider.summary({ timezone: 'UTC' }));
  expect(after.completedWork).toBeNull(); expect(after.week).toMatchObject({ qualification: 'estimated' });
  expect(() => provider.recordTime(w.item.id, { ...command, revision: status === 'SUCCEEDED' ? 1 : 0, requestId: 'after-delete' })).toThrow('eligible checked workflow');
  closeDb(); initDatabase(file, { quiet: true }); ensureWorkflowSchema(); provider = new Outcomes(getDb());
  expect((await provider.read(query())).state).toBe('unavailable');
  if (status === 'SUCCEEDED') expect(provider.timeReceipt(w.item.id, command.requestId)).not.toBeNull();
});
test('F16 review R1: a deleted grandchild leaves the surviving family incomplete', async () => {
  const w = await nestedWork(2);
  for (const child of w.children) updateRun(child.run.id, { status: 'SUCCEEDED', finishTime: now });
  updateRun(w.run.id, { status: 'SUCCEEDED', finishTime: now });
  const checked = checkWorkResult(w.item.id, result); provider.recordTime(w.item.id, time({ ...w, checked }));
  expect((await summary()).week?.value).toBe(25);
  deleteFlow(w.children[1]!.flow.id);
  expect((await provider.read(query())).state).toBe('unavailable');
});

for (const invalid of ['missing-result', 'wrong-parent', 'wrong-flow', 'wrong-version'] as const)
  test(`F16 review R1: an inconsistent child launch receipt is unavailable (${invalid})`, async () => {
    const { listWorkflowEffects, saveWorkflowEffect } = await import('../workflows/db/repos/workflow-effect');
    const w = await nestedWork(), child = w.children[0]!;
    updateRun(child.run.id, { status: 'SUCCEEDED', finishTime: now });
    updateRun(w.run.id, { status: 'SUCCEEDED', finishTime: now });
    checkWorkResult(w.item.id, result);
    expect(await read()).toHaveLength(1);
    const receipt = listWorkflowEffects(w.run.id)[0]!;
    if (invalid === 'missing-result') receipt.result = null;
    if (invalid === 'wrong-parent') receipt.result = { runId: w.run.id };
    if (invalid === 'wrong-flow') receipt.target.flowId = w.flow.id;
    if (invalid === 'wrong-version') receipt.target.versionId = w.version.id;
    saveWorkflowEffect(receipt);
    expect((await provider.read(query())).state).toBe('unavailable');
  });

test('estimates stop at 60 minutes per workflow per day; owner-set minutes are never capped', async () => {
  const f = runFlow({ steps: null, runs: 100 });
  let view = await summary();
  expect(view.week?.value).toBe(60); expect(view.today?.value).toBe(60);
  expect(view.todayBasis).toBe("100 runs x about 1 min. Estimated from the workflow's steps. Estimates are capped at 60 min per workflow per day.");
  const other = runFlow({ steps: null, runs: 5 });
  expect((await summary()).week?.value).toBe(65); expect(other.runs).toHaveLength(5);
  getDb().run('UPDATE flow SET time_saved_per_run=3 WHERE id=?', [f.flow.id]);
  view = await summary(); expect(view.week?.value).toBe(300 + 5); expect(view.todayBasis).not.toContain('capped');
});
test('a day with no successful runs is a known zero, a future day stays unknown', async () => {
  runFlow({ minutes: 4 });
  const view = await summary();
  expect(view.days.map(d => [d.id, d.future, d.time?.value ?? null])).toEqual([
    ['2026-10-05', false, 0], ['2026-10-06', false, 0], ['2026-10-07', false, 4], ['2026-10-08', true, null],
    ['2026-10-09', true, null], ['2026-10-10', true, null], ['2026-10-11', true, null]]);
  expect(view.days[0]!.basis).toBe('No time saved.');
});

test('runs of a workflow in another project never count here', async () => {
  runFlow({ minutes: 9, projectId: 'jrv_proj_other' });
  await nothing();
  runFlow({ minutes: 4 });
  expect((await summary()).week?.value).toBe(4);
  expect(ready<OutcomeSummary>(await new Outcomes(getDb(), 'jrv_proj_other').summary({ timezone: 'UTC' })).week?.value).toBe(9);
});
// The engine keeps each step as `{ output: envelope }` and a loop's rounds under the envelope's `output.iterations`.
const recorded = (status: string, extra: object = {}) => ({ output: { type: 'PIECE', status, ...extra } });
const loopRounds = (...statuses: string[]) => ({ output: { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED', output: { index: statuses.length,
  iterations: statuses.map(status => ({ step_2: { type: 'PIECE', status } })) } } });
test('a run that succeeded only by continuing past a failed step is not counted, and the basis says so', async () => {
  const f = runFlow({ minutes: 5, runs: 4 });
  updateRun(f.runs[0]!.id, { steps: { step_1: recorded('FAILED', { errorMessage: 'boom' }), step_2: recorded('SUCCEEDED') } });
  updateRun(f.runs[1]!.id, { steps: { loop: loopRounds('SUCCEEDED', 'FAILED') } });
  // Output that only quotes a failure is not one: the run did its work.
  updateRun(f.runs[2]!.id, { steps: { step_1: recorded('SUCCEEDED', { output: { build: { status: 'FAILED' } } }) } });
  updateRun(f.runs[3]!.id, { steps: { loop: loopRounds('SUCCEEDED', 'SUCCEEDED'), step_3: recorded('SUCCEEDED', { output: { note: '"status":"FAILED"' } }) } });
  const view = await summary();
  expect(view.week?.value).toBe(10);
  expect(view.weekBasis).toBe('2 runs x 5 min. You set the minutes per run. 2 runs that continued past a failure are not counted.');
  expect(view.todayBasis).toBe(view.weekBasis);
  updateRun(f.runs[2]!.id, { steps: { step_1: recorded('FAILED') } });
  updateRun(f.runs[3]!.id, { steps: { loop: loopRounds('FAILED') } });
  const none = await summary();
  expect(none.week?.value).toBe(0); expect(none.weekBasis).toBe('No time saved. 4 runs that continued past a failure are not counted.');
});
test('a root run whose child run did not succeed is not counted until it does', async () => {
  const f = runFlow({ minutes: 6 });
  const child = createFlowRun({ flowId: f.flow.id, flowVersionId: f.version.id, parentRunId: f.runs[0]!.id });
  updateRun(child.id, { status: 'FAILED', finishTime: now - 1000 });
  expect((await summary()).week?.value).toBe(0);
  updateRun(child.id, { status: 'SUCCEEDED' });
  expect((await summary()).week?.value).toBe(6);
});
test('an every-minute schedule for the whole week is read as groups, not a run at a time', async () => {
  const flows = [runFlow({ steps: null }), runFlow({ steps: null }), runFlow({ minutes: 1 })];
  // 3 x 9,000 runs, one every 20 s back to Monday 07:00: more than a read of single runs could take.
  for (const f of flows) getDb().run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9000)
    INSERT INTO flow_run (id, flow_id, flow_version_id, project_id, status, environment, execution_config, finish_time, created, updated)
    SELECT ?1 || i, ?2, ?3, f.project_id, 'SUCCEEDED', 'PRODUCTION', '{}', ?4 - i * 20000, 0, 0 FROM n, flow f WHERE f.id = ?2`,
    [`bulk-${f.flow.id}-`, f.flow.id, f.version.id, now]);
  const view = await summary();
  // Two estimated workflows capped at 60 min on each of Monday to Wednesday; the owner-set minute is never capped.
  expect(view.week?.value).toBe(2 * 3 * 60 + 9001);
  expect(view.today?.value).toBe(2 * 60 + 9 * HOUR / 20000 + 1);
  const plan = getDb().query("EXPLAIN QUERY PLAN SELECT 1 FROM flow_run INDEXED BY idx_flow_run_finished WHERE project_id='p' AND status='SUCCEEDED' AND parent_run_id IS NULL AND finish_time >= 0 AND finish_time < 1").all() as { detail: string }[];
  expect(plan.map(p => p.detail).join()).toContain('USING INDEX idx_flow_run_finished (project_id=? AND finish_time>? AND finish_time<?)');
});
