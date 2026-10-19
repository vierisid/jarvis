import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTourProvider, TOUR_STEPS } from './index.ts';
import { owner } from './test-fixture.ts';
import type { JourneyPort, TourCommand, TourResult, TourSnapshot } from './types.ts';
const modulePath = '../journey/index.ts';
const present = existsSync(join(import.meta.dir, modulePath));
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
export function ready(result: TourResult): TourSnapshot {
  expect(result.availability).toBe('ready');
  if (result.availability !== 'ready') throw Error(result.reason);
  return result.snapshot;
}
async function fixture(legacy: Record<string, unknown> = {}) {
  const { createJourneyProvider, createSettingsJourneyPersistence } = await import(modulePath);
  const dir = mkdtempSync(join(tmpdir(), 'on-b-06-')); const path = join(dir, 'tour.sqlite');
  const connections: Database[] = []; cleanups.push(() => { connections.forEach(db => db.close()); rmSync(dir, { recursive: true, force: true }); });
  const open = () => { const db = new Database(path); db.exec('PRAGMA busy_timeout = 3000'); connections.push(db); return db; };
  const db = open(); db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))');
  for (const name of ['profile', 'connections', 'drafts', 'theme', 'cfg.onboarding']) db.run('INSERT INTO settings(key,value) VALUES(?,?)', [name, JSON.stringify({ untouched: name })]);
  const original = db.query("SELECT * FROM settings WHERE key NOT LIKE 'onboarding-next.%' ORDER BY key").all();
  const make = (connection = open(), scope = owner) => createJourneyProvider({ authorize: () => scope,
    persistence: createSettingsJourneyPersistence({ databaseForScope: () => connection, readLegacy: () => ({
      setup_completed: true, setup_skipped_profile: true, profile_completed: false,
      tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null, ...legacy,
    }) }) }) as JourneyPort;
  const port = make(db);
  const tour = (p = port, roomStatus: () => 'ready' | 'unsupported' = () => 'ready') => createTourProvider({ enabled: true, authorize: () => owner, journeyFor: () => p, roomStatus });
  const untouched = () => expect(db.query("SELECT * FROM settings WHERE key NOT LIKE 'onboarding-next.%' ORDER BY key").all()).toEqual(original);
  return { port, make, tour, db, untouched };
}
const nav = (s: TourSnapshot, action: 'next' | 'back' | 'skip' | 'finish', requestId: string = crypto.randomUUID()): TourCommand => ({
  type: 'navigate', sessionId: s.sessionId, revision: s.revision, from: s.stepId!, action, requestId,
});

describe.skipIf(!present)('actual B01 durable tutorial progress', () => {
  test('refresh at every room, Back, Memory quick check, Pebble, and finish retain activation and user records', async () => {
    const f = await fixture(); let p = f.tour(); let s = ready(await p.request(null, { type: 'read' }));
    for (const at of TOUR_STEPS) {
      p = f.tour(f.make()); s = ready(await p.request(null, { type: 'read' })); expect(s.stepId).toBe(at);
      if (at === 'memory') {
        s = ready(await p.request(null, nav(s, 'back'))); expect(s.stepId).toBe('goals');
        s = ready(await p.request(null, nav(s, 'next'))); expect(s.stepId).toBe('memory');
        expect(ready(await f.tour(f.make()).request(null, { type: 'read' })).stepId).toBe('memory');
      }
      s = ready(await p.request(null, nav(s, at === 'pebble' ? 'finish' : 'next')));
    }
    expect(s).toMatchObject({ active: false, stepId: null, journey: { stepId: 'activation', tourState: 'done', completion: 'active', activationState: 'pending' } });
    expect(ready(await f.tour(f.make()).request(null, { type: 'read' }))).toEqual(s); f.untouched();
  });
  test.each(['brief:v1:context', 'brief:v1:memory', 'memory'])('migrates supported Memory hint %s on explicit navigation', async hint => {
    const f = await fixture({ tutorial_progress_step: hint }); const p = f.tour();
    const s = ready(await p.request(null, { type: 'read' })); expect(s.stepId).toBe('memory'); expect(s.revision).toBe(0);
    const after = ready(await p.request(null, nav(s, 'next'))); expect(after.journey.tourStepId).toBe('connected-workspace');
    expect(ready(await f.tour(f.make()).request(null, { type: 'read' }))).toEqual(after); f.untouched();
  });
  test.each([{ tutorial_completed: true }, { tutorial_dismissed: true }])('completed legacy tour is not replayed by reads; explicit replay retains completion: %j', async legacy => {
    const f = await fixture({ ...legacy, tutorial_progress_step: 'brief:v1:context' }); const p = f.tour();
    const before = ready(await p.request(null, { type: 'read' })); expect(before.active).toBe(false); expect(before.journey.completion).toBe('legacy_completed');
    const replay = ready(await p.request(null, { type: 'replay', sessionId: before.sessionId, revision: before.revision, requestId: 'replay' }));
    expect(replay.stepId).toBe('today'); expect(replay.journey.completion).toBe('legacy_completed');
    const done = ready(await p.request(null, nav(replay, 'skip'))); expect(done.journey.stepId).toBe('exited'); expect(done.journey.completion).toBe('legacy_completed'); f.untouched();
  });
  test('skip then replay returns to activation without clearing other state', async () => {
    const f = await fixture(); const p = f.tour();
    const skipped = ready(await p.request(null, nav(ready(await p.request(null, { type: 'read' })), 'skip')));
    expect(skipped.journey).toMatchObject({ stepId: 'activation', completion: 'active', tourState: 'skipped' });
    const replay = ready(await p.request(null, { type: 'replay', sessionId: skipped.sessionId, revision: skipped.revision, requestId: 'replay' }));
    expect(replay.stepId).toBe('today');
    expect(ready(await p.request(null, nav(replay, 'skip')))).toMatchObject({ journey: { stepId: 'activation', completion: 'active' } }); f.untouched();
  });
  test('two tabs cannot overwrite progress, replay old navigation, or conflict with a newer peer replay', async () => {
    const f = await fixture(); const a = f.tour(), b = f.tour(f.make());
    const s = ready(await a.request(null, { type: 'read' })); const next = nav(s, 'next', 'next'); const skip = nav(s, 'skip', 'skip');
    const results = await Promise.all([a.request(null, next), b.request(null, skip)]);
    expect(results.filter(r => r.availability === 'ready')).toHaveLength(1);
    expect(results.filter(r => r.availability === 'unavailable')).toEqual([{ availability: 'unavailable', reason: 'revision_conflict' }]);
    const current = ready(await a.request(null, { type: 'read' }));
    const replay = ready(await b.request(null, { type: 'replay', sessionId: s.sessionId, revision: current.revision, requestId: 'peer-replay' }));
    expect(ready(await a.request(null, results[0]!.availability === 'ready' ? next : skip))).toEqual(replay);
    expect((await a.request(null, results[0]!.availability === 'ready' ? skip : next)).availability).toBe('unavailable'); f.untouched();
  });
  test('lost acknowledgement after commit replays on a new connection with no duplicate transition', async () => {
    const f = await fixture(); const normal = f.port.acknowledge.bind(f.port); let lose = true;
    f.port.acknowledge = async t => { const result = await normal(t); if (lose) { lose = false; throw Error('lost reply'); } return result; };
    const p = f.tour(), s = ready(await p.request(null, { type: 'read' })), c = nav(s, 'next', 'stable');
    expect(await p.request(null, c)).toEqual({ availability: 'unavailable', reason: 'storage_unavailable' });
    const retry = await f.tour(f.make(), () => 'unsupported').request(null, c);
    expect(retry).toMatchObject({ availability: 'ready', replayed: true, snapshot: { revision: 1, stepId: 'workflows' } });
    expect(ready(await f.tour(f.make()).request(null, { type: 'read' })).revision).toBe(1); f.untouched();
  });
  test('changed request body conflicts and foreign journey IDs cannot navigate', async () => {
    const f = await fixture(), p = f.tour(), s = ready(await p.request(null, { type: 'read' }));
    ready(await p.request(null, nav(s, 'next', 'stable')));
    expect(await p.request(null, nav(s, 'skip', 'stable'))).toEqual({ availability: 'unavailable', reason: 'request_conflict' });
    expect(await p.request(null, { ...nav(s, 'skip'), sessionId: 'foreign' })).toEqual({ availability: 'unavailable', reason: 'journey_conflict' }); f.untouched();
  });
  test('failed persistence leaves previous step available after reopening', async () => {
    const f = await fixture(), p = f.tour(), s = ready(await p.request(null, { type: 'read' }));
    f.db.exec("CREATE TRIGGER refuse_tour BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect((await p.request(null, nav(s, 'next'))).availability).toBe('unavailable');
    expect(ready(await f.tour(f.make()).request(null, { type: 'read' }))).toEqual(s);
    f.db.exec('DROP TRIGGER refuse_tour'); ready(await p.request(null, nav(s, 'next'))); f.untouched();
  });
  test('replay around a saved draft preserves its exact flow/version and result destination', async () => {
    const f = await fixture(), p = f.tour();
    ready(await p.request(null, nav(ready(await p.request(null, { type: 'read' })), 'skip')));
    for (const command of [{ type: 'reserve_build', buildRequestId: 'build-request' },
      { type: 'build_started', buildRequestId: 'build-request', jobId: 'job' },
      { type: 'draft_saved', jobId: 'job', flowId: 'flow', versionId: 'version' }]) {
      const r = await f.port.read(); if (r.availability !== 'ready') throw Error();
      await (f.port.acknowledge as any)({ journeyId: r.snapshot.journeyId, expectedRevision: r.snapshot.revision, requestId: crypto.randomUUID(), command });
    }
    const result = ready(await p.request(null, { type: 'read' }));
    const replay = ready(await p.request(null, { type: 'replay', sessionId: result.sessionId, revision: result.revision, requestId: 'replay-draft' }));
    const done = ready(await p.request(null, nav(replay, 'skip')));
    expect(done.journey).toMatchObject({ stepId: 'result', jobId: 'job', draft: { flowId: 'flow', versionId: 'version' }, activationState: 'draft_saved', completion: 'active' }); f.untouched();
  });

});
