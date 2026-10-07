import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { closeDb, getDb, initDatabase } from '../vault/schema';
import { ensureWorkflowSchema } from '../workflows/db';
import { ensureOutcomeSchema } from '../vault/outcome-schema';
import { createFlow, setPublishedVersion } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, updateRun } from '../workflows/db/repos/flow-run';
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
const query = () => ({ start: Date.UTC(2026, 9, 5), end: Date.UTC(2026, 9, 12), timezone: 'UTC' });
const ready = <T>(r: BriefReadResult<T>): T => { expect(r.state).toBe('ready'); return (r as { data: T }).data; };
const read = async () => ready<BriefOutcome[]>(await provider.read(query()));
const summary = async () => ready<OutcomeSummary>(await provider.summary({ timezone: 'UTC' }));
function effect(runId: string, status: string, extra: object = {}) {
  const record = { id: 'effect-1', runId, status, finishedAt: now, ...extra };
  getDb().run('INSERT OR REPLACE INTO workflow_effect(id,run_id,status,record) VALUES(?,?,?,?)', ['effect-1', runId, status, JSON.stringify(record)]);
}

test('no evidence is empty; scores, run duration and flow defaults never invent time or goal counts', async () => {
  getGoalApplication().createGoal('90 minutes saved and six of ten', 'objective');
  expect((await provider.read(query())).state).toBe('empty');
  expect((await provider.summary({ timezone: 'UTC' })).state).toBe('empty');
  const w = work(); getDb().run('UPDATE flow SET time_saved_per_run=90 WHERE id=?', [w.flow.id]);
  const view = await summary();
  expect(view.week).toBeNull(); expect(view.today).toBeNull(); expect(view.goalDeltas).toEqual([]);
  expect(view.completedWork?.value).toBe(1); expect(view.coverage).toMatchObject({ timed: 0, untimed: 1, complete: false });
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
  expect(view.days.filter(d => d.time !== null)).toHaveLength(1); expect(view.days.reduce((n, d) => n + (d.time?.value ?? 0), 0)).toBe(20);
});
test('time corrections replace benefit in the original completion window; exact recovery survives restart', async () => {
  const w = work(), first = time(w), original = provider.recordTime(w.item.id, first);
  now += 86_400_000;
  const correction = time(w, 1, 'corrected'); correction.baseline.minutes = 10;
  provider.recordTime(w.item.id, correction);
  closeDb(); initDatabase(file, { quiet: true }); ensureWorkflowSchema(); provider = new Outcomes(getDb());
  expect(provider.recordTime(w.item.id, first)).toEqual(original); expect(provider.timeReceipt(w.item.id, first.requestId)).toEqual(original);
  const view = await summary(); expect(view.week?.value).toBe(5); expect(view.today).toBeNull();
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
  const view = await summary(); expect(view.completedWork).toBeNull(); expect(view.week).toBeNull();
  expect(view.goalDeltas.find(g => g.goalId === parent.id)).toMatchObject({ change: { value: -2 }, attribution: 'observed_change_only', rollup: 'independent' });
  expect(view.goalDeltas.find(g => g.goalId === child.id)?.change?.value).toBe(1);
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
  updateRun(w.run!.id, { status: 'FAILED' }); expect((await provider.summary({ timezone: 'UTC' })).state).toBe('empty');
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
