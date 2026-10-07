import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { ensureGoalMeasurementSchema } from '../vault/goal-measurement-schema';
import * as vault from '../vault/goals';
import { getGoalApplication } from './application-service';
import { GoalMeasurementConflict, readMeasurementReceipt, type GoalMeasurementCommand } from './measurements';
import { projectMeasuredGoal, GoalMeasurements } from '../brief/goal-measurements';
import type { GoalEvent } from './events';

let directory: string, database: string, id: string, events: GoalEvent[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f15-')); database = join(directory, 'vault.db');
  initDatabase(database, { quiet: true });
  id = getGoalApplication().createGoal('Sign ten partners', 'objective', { status: 'active' }).id;
  events = []; getGoalApplication().setEventCallback(event => { events.push(event); });
});
afterEach(() => { getGoalApplication().stopDelivery(); closeDb(); rmSync(directory, { recursive: true, force: true }); });
function command(overrides: Partial<GoalMeasurementCommand> = {}): GoalMeasurementCommand {
  return { requestId: 'm1', revision: 0, measurement: { unit: 'signed partners', baseline: 0, target: 10, value: 6,
    measuredAt: Date.now() - 10000, evidence: { id: 'owner:partner-ledger', revision: 'v1' } }, ...overrides };
}
const save = (input = command(), goalId = id) => getGoalApplication().recordMeasurement(goalId, input);
const goal = () => vault.getGoal(id)!;

test('a legacy 0.6 score never becomes six partners, including a numeric title', async () => {
  getGoalApplication().scoreGoal(id, 0.6, 'Owner assessment');
  expect(projectMeasuredGoal(goal())).toMatchObject({ score: 0.6, measurement: null, measurementRevision: 0,
    measurementDefinition: null, progress: { value: 0.6, basis: 'legacy_score', rollup: 'independent' } });
  expect((await new GoalMeasurements(getDb()).read({ goalId: id }))).toMatchObject({ state: 'ready', data: { measurement: null } });
});
test('six of ten persists as an absolute user report, with matching score, history and evidence', async () => {
  const input = command(), receipt = save(input);
  expect(receipt).toMatchObject({ goalId: id, score: 0.6, measurement: { value: 6, revision: 1, qualification: 'user_reported' } });
  const view = projectMeasuredGoal(goal());
  expect(view).toMatchObject({ score: 0.6, progress: { value: 0.6, basis: 'measurement' }, measurement: {
    value: 6, unit: 'signed partners', baseline: 0, target: 10, asOf: input.measurement.measuredAt,
    qualification: 'user_reported', provenance: [{ kind: 'source', id: 'owner:partner-ledger', revision: 'v1' }],
  } });
  expect((await new GoalMeasurements(getDb()).read({ goalId: id }))).toMatchObject({ state: 'ready', data: view });
  expect(vault.getRootGoals()[0]!.measurement).toEqual(goal().measurement);
  expect(vault.getGoalTree(id)[0]!.measurement).toEqual(goal().measurement);
  expect(vault.getProgressHistory(id)).toMatchObject([{ id: receipt.progressId, score_before: 0, score_after: 0.6, source: 'user_measurement' }]);
  expect(events.filter(e => e.type === 'goal_measurement_recorded')).toHaveLength(1);
});
test('configured unknown remains unknown, while observed zero is a real measurement', () => {
  getGoalApplication().scoreGoal(id, 0.6, 'Legacy assessment');
  const unknown = command(); unknown.measurement = { ...unknown.measurement, value: null, measuredAt: null, evidence: null };
  expect(save(unknown)).toMatchObject({ score: 0.6, progressId: null });
  expect(projectMeasuredGoal(goal())).toMatchObject({ measurement: null, progress: { value: null, basis: 'unknown' }, measurementDefinition: { target: 10 } });
  const zero = command({ revision: 1, requestId: 'zero' }); zero.measurement.value = 0;
  save(zero);
  expect(projectMeasuredGoal(goal())).toMatchObject({ score: 0, measurement: { value: 0 }, progress: { value: 0, basis: 'measurement' } });
});
test('exact replay survives restart and newer measurements without rewriting history or score', () => {
  const first = command(), receipt = save(first);
  const next = command({ requestId: 'm2', revision: 1 }); next.measurement = { ...next.measurement, value: 7, measuredAt: first.measurement.measuredAt! + 1, evidence: { id: 'owner:partner-ledger', revision: 'v2' } };
  save(next); closeDb(); initDatabase(database, { quiet: true });
  expect(save(first)).toEqual(receipt);
  expect(readMeasurementReceipt(getDb(), id, 'm1')).toEqual(receipt);
  expect(goal().score).toBe(0.7); expect(vault.getProgressHistory(id)).toHaveLength(2);
});
test('same request with a different payload, stale revisions and duplicate evidence cannot write', () => {
  const first = command(); save(first); const before = goal();
  for (const next of [
    { ...first, measurement: { ...first.measurement, value: 9 } },
    { ...first, requestId: 'stale' },
    { ...first, requestId: 'stale-fresh-evidence', measurement: { ...first.measurement, value: 9, measuredAt: first.measurement.measuredAt! + 100, evidence: { id: 'ledger', revision: 'v2' } } },
    { ...first, requestId: 'duplicate-evidence', revision: 1, measurement: { ...first.measurement, value: 9, measuredAt: first.measurement.measuredAt! + 100 } },
  ]) expect(() => save(next)).toThrow(GoalMeasurementConflict);
  expect(goal()).toEqual(before); expect(vault.getProgressHistory(id)).toHaveLength(1);
});
test('earlier and equal measurement times cannot supersede a later report or erase its value', () => {
  const first = command(); save(first);
  for (const measuredAt of [first.measurement.measuredAt!, first.measurement.measuredAt! - 1, null]) {
    const next = command({ requestId: 'old', revision: 1 });
    next.measurement = { ...next.measurement, measuredAt, value: measuredAt === null ? null : 9, evidence: measuredAt === null ? null : { id: 'ledger', revision: 'new' } };
    expect(() => save(next)).toThrow(GoalMeasurementConflict);
  }
  expect(goal().score).toBe(0.6); expect(vault.getProgressHistory(id)).toHaveLength(1);
});
test('a fresh negative correction lowers absolute progress once, without negative deltas being added', () => {
  const first = command(); save(first);
  const correction = command({ requestId: 'correct', revision: 1 });
  correction.measurement = { ...correction.measurement, value: 4, measuredAt: first.measurement.measuredAt! + 1, evidence: { id: 'owner:partner-ledger', revision: 'corrected' } };
  const receipt = save(correction); expect(save(correction)).toEqual(receipt);
  expect(goal().score).toBe(0.4); expect(goal().measurement!.value).toBe(4);
  expect(vault.getProgressHistory(id)).toContainEqual(expect.objectContaining({ score_before: 0.6, score_after: 0.4 }));
  expect(vault.getProgressHistory(id)).toHaveLength(2);
});
for (const [baseline, target, value, score] of [[5, 15, 6, 0.1], [100, 0, 60, 0.4], [0, 10, 12, 1], [0, 10, -2, 0]]) {
  test(`absolute mapping ${baseline} -> ${target} at ${value} preserves the count and clamps only score`, () => {
    const input = command(); input.measurement = { ...input.measurement, baseline: baseline!, target: target!, value: value! };
    save(input); expect(goal().score).toBe(score!); expect(goal().measurement!.value).toBe(value!);
  });
}
test('child reports, shared evidence, corrections and deletion never add to a parent total', () => {
  const first = command(); save(first);
  const child = getGoalApplication().createGoal('Child', 'key_result', { parent_id: id });
  save({ ...first, measurement: { ...first.measurement, value: 3 } }, child.id);
  expect(goal().score).toBe(0.6); expect(goal().measurement!.value).toBe(6);
  const correction = { ...first, requestId: 'child-correction', revision: 1,
    measurement: { ...first.measurement, value: 2, measuredAt: first.measurement.measuredAt! + 1, evidence: { id: 'owner:partner-ledger', revision: 'v2' } } };
  save(correction, child.id); expect(goal().score).toBe(0.6);
  getGoalApplication().deleteGoal(child.id); expect(goal().measurement!.value).toBe(6);
  expect(getDb().query('SELECT * FROM goal_measurement WHERE goal_id = ?').all(child.id)).toEqual([]);
  expect(getDb().query('SELECT * FROM goal_measurement_receipt WHERE goal_id = ?').all(child.id)).toEqual([]);
});
test('measurement-backed goals reject legacy manual/tool/work-result scoring, not ordinary goal edits', () => {
  save();
  expect(() => getGoalApplication().scoreGoal(id, 0.9, 'Unsupported estimate')).toThrow('new measurement');
  expect(() => getGoalApplication().recordScore(id, 0.9, 'Checked work', 'work_item:x')).toThrow('new measurement');
  expect(() => vault.updateGoalScore(id, 0.9, 'Bypass')).toThrow('new measurement');
  getGoalApplication().updateGoal(id, { title: 'Renamed goal' });
  getGoalApplication().updateStatus(id, 'completed');
  expect(goal().score).toBe(0.6); expect(goal().measurement!.value).toBe(6);
});
test('validation refuses malformed, inferred and future-dated claims atomically', () => {
  const good = command(), before = goal();
  for (const bad of [ {}, [], { ...good, extra: true }, { ...good, revision: -1 }, { ...good, requestId: '' },
    ...[{ unit: '' }, { unit: ' partners' }, { unit: 'a\nb' }, { target: 0 }, { value: NaN }, { target: Infinity }, { value: '6' },
      { measuredAt: Date.now() + 60000 }, { measuredAt: 1.5 }, { evidence: null }, { evidence: { id: 'x', revision: '' } },
      { qualification: 'measured' }, { value: null }, { value: null, measuredAt: null, evidence: null, score: 0.9 },
    ].map(patch => ({ ...good, measurement: { ...good.measurement, ...patch } }))
  ]) expect(() => save(bad as any)).toThrow();
  expect(goal()).toEqual(before); expect(vault.getProgressHistory(id)).toHaveLength(0); expect(events).toHaveLength(0);
});
test('event persistence failure rolls back snapshot, score, history and idempotency receipt', () => {
  getDb().run("CREATE TRIGGER fail_measurement_event BEFORE INSERT ON goal_events BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END");
  expect(() => save()).toThrow('synthetic event failure');
  expect(goal().measurement).toBeNull(); expect(goal().score).toBe(0);
  expect(vault.getProgressHistory(id)).toHaveLength(0); expect(readMeasurementReceipt(getDb(), id, 'm1')).toBeNull(); expect(events).toHaveLength(0);
});
test('outer transaction rollback leaves no measurement, events or score', () => {
  expect(() => getGoalApplication().transaction(() => { save(); throw Error('later failure'); })).toThrow('later failure');
  expect(goal().measurement).toBeNull(); expect(vault.getProgressHistory(id)).toHaveLength(0); expect(events).toHaveLength(0);
});
test('old schema migration is additive and repeatable without inferring any goal counts', () => {
  const db = new Database(':memory:');
  try {
    db.run('CREATE TABLE goals (id TEXT PRIMARY KEY, score REAL)'); db.run("INSERT INTO goals VALUES ('legacy', 0.6)");
    ensureGoalMeasurementSchema(db); ensureGoalMeasurementSchema(db);
    expect(db.query('SELECT * FROM goals').get()).toEqual({ id: 'legacy', score: 0.6 });
    expect(db.query('SELECT * FROM goal_measurement').all()).toEqual([]);
  } finally { db.close(); }
});
test('replaced vault connections make old providers unavailable', async () => {
  const provider = new GoalMeasurements(getDb()); closeDb(); initDatabase(database, { quiet: true });
  expect(provider.readiness()).toBe('unavailable'); expect(() => provider.record(id, command())).toThrow('unavailable');
});
test('two independent writers cannot commit different measurements from the same revision', async () => {
  const first = command(), second = { ...first, requestId: 'competitor', measurement: { ...first.measurement, value: 8 } };
  const go = join(directory, 'go');
  const program = `import { initDatabase, closeDb } from './src/vault/schema'; import { getGoalApplication } from './src/goals/application-service'; import { existsSync } from 'node:fs';
    initDatabase(process.env.F15_DB!, { quiet: true }); await Bun.write(process.env.F15_READY!, 'ready');
    while (!existsSync(process.env.F15_GO!)) await Bun.sleep(5);
    try { getGoalApplication().recordMeasurement(process.env.F15_GOAL!, JSON.parse(process.env.F15_COMMAND!)); console.log('saved'); }
    catch (e) { console.log((e as Error).message); process.exitCode = 2; } finally { closeDb(); }`;
  const children: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = [];
  try {
    // Boot migrations serialize; only the application transactions race.
    for (const [index, input] of [first, second].entries()) {
      const ready = join(directory, `ready${index}`);
      const child = Bun.spawn([process.execPath, '-e', program], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, F15_DB: database, F15_GOAL: id,
          F15_COMMAND: JSON.stringify(input), F15_READY: ready, F15_GO: go }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      children.push(child); const until = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < until && child.exitCode === null) await Bun.sleep(10);
      if (child.exitCode !== null) throw Error(await new Response(child.stderr).text());
      expect(existsSync(ready)).toBe(true);
    }
    await Bun.write(go, 'go');
    const exits = await Promise.all(children.map(async child => ({ code: await child.exited, output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
    expect(exits.filter(e => e.code === 0), JSON.stringify(exits)).toHaveLength(1);
    expect(exits.filter(e => e.code === 2)[0]!.output).toContain('Measurement changed');
    expect(vault.getProgressHistory(id)).toHaveLength(1); expect(goal().measurement!.revision).toBe(1);
  } finally { for (const child of children) { child.kill(); await child.exited; } }
}, 20_000);

test('event sink failure after commit preserves a recoverable receipt and later event delivery', () => {
  const input = command(); getGoalApplication().setEventCallback(() => { throw Error('sink offline'); });
  const receipt = save(input);
  expect(goal().score).toBe(0.6); expect(readMeasurementReceipt(getDb(), id, input.requestId)).toEqual(receipt);
  const delivered: GoalEvent[] = [];
  getGoalApplication().setEventCallback(event => { delivered.push(event); }); getGoalApplication().flushEvents();
  expect(delivered.filter(event => event.type === 'goal_measurement_recorded')).toHaveLength(1);
  expect(save(input)).toEqual(receipt); expect(vault.getProgressHistory(id)).toHaveLength(1);
});

test('health refresh cannot reuse the previous canonical goal revision within one clock tick', () => {
  let before = goal(); const realNow = Date.now, fixed = before.updated_at;
  Date.now = () => fixed;
  try {
    for (const [index, value] of [1, 6, 2].entries()) {
      const input = command({ requestId: `clock-${index}`, revision: index });
      input.measurement = { ...input.measurement, value, measuredAt: fixed - 10 + index, evidence: { id: 'ledger', revision: String(index) } };
      save(input); const after = goal(); expect(after.updated_at).toBeGreaterThan(before.updated_at);
      before = after;
    }
    expect(goal().score).toBe(0.2); expect(vault.getProgressHistory(id)).toHaveLength(3);
  } finally { Date.now = realNow; }
});
