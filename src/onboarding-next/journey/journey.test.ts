import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJourneyProvider, createSettingsJourneyPersistence, reconcileJourney } from './index.ts';
import { journeySettingsKey } from './settings.ts';
import type { Acknowledgement, JourneyResult, JourneySnapshot, LegacyStatus, Navigation, Scope } from './types.ts';

const fresh: LegacyStatus = {
  setup_completed: false, setup_skipped_profile: false, profile_completed: false,
  tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null,
};
const owner = { actorId: 'test-actor', projectId: 'test-project' };
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function ready(result: JourneyResult): JourneySnapshot {
  expect(result.availability).toBe('ready');
  if (result.availability !== 'ready') throw new Error(result.reason);
  return result.snapshot;
}

function fixture(legacy: LegacyStatus = fresh) {
  const dir = mkdtempSync(join(tmpdir(), 'on-b-01-'));
  const path = join(dir, 'settings.sqlite');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => {
    const db = new Database(path);
    db.exec('PRAGMA busy_timeout = 3000');
    cleanup.push(() => db.close());
    return db;
  };
  const db = open();
  // Same table definition as the vault; no daemon, model or real user data.
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))');
  const make = (scope: Scope | null = owner, connection = db, readLegacy = () => legacy) => createJourneyProvider({
    authorize: () => scope,
    persistence: createSettingsJourneyPersistence({ databaseForScope: () => connection, readLegacy }),
  });
  const provider = make();
  const raw = (scope = owner) => (db.query('SELECT value FROM settings WHERE key = ?').get(journeySettingsKey(scope)) as { value: string } | null)?.value ?? null;
  const writeRaw = (value: string, scope = owner) => db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [journeySettingsKey(scope), value]);
  return { db, path, open, make, provider, raw, writeRaw };
}

async function nav(p: ReturnType<typeof createJourneyProvider>, command: Navigation, snapshot?: JourneySnapshot) {
  const s = snapshot ?? ready(await p.read());
  return p.transition({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: crypto.randomUUID(), command });
}
async function ack(p: ReturnType<typeof createJourneyProvider>, command: Acknowledgement) {
  const s = ready(await p.read());
  return p.acknowledge({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: crypto.randomUUID(), command });
}
async function activation(p: ReturnType<typeof createJourneyProvider>) {
  ready(await p.read());
  ready(await nav(p, { type: 'navigate', stepId: 'explain' }));
  ready(await ack(p, { type: 'setup_completed' }));
  ready(await nav(p, { type: 'navigate', stepId: 'google' }));
  ready(await nav(p, { type: 'navigate', stepId: 'interview' }));
  ready(await ack(p, { type: 'interview_finished', state: 'done' }));
  ready(await nav(p, { type: 'navigate', stepId: 'tour' }));
  ready(await ack(p, { type: 'tour_finished', state: 'done' }));
}
async function startBuild(p: ReturnType<typeof createJourneyProvider>, jobId: string) {
  const buildRequestId = `request-${jobId}`;
  ready(await ack(p, { type: 'reserve_build', buildRequestId }));
  return ready(await ack(p, { type: 'build_started', buildRequestId, jobId }));
}

describe('versioned journey and legacy compatibility', () => {
  test('factories have no startup effects, and repeated reads retain one durable identity', async () => {
    const f = fixture();
    expect(f.raw()).toBeNull();
    const first = ready(await f.provider.read());
    expect(first).toMatchObject({ schemaVersion: 1, revision: 0, stepId: 'welcome', setupState: 'pending', interviewState: 'connecting' });
    expect(ready(await f.make(owner, f.open()).read())).toEqual(first);
    expect(JSON.parse(f.raw()!).snapshot).toEqual(first);
  });

  test.each([
    { ...fresh, setup_completed: true, profile_completed: true, tutorial_completed: true },
    { ...fresh, setup_completed: true, setup_skipped_profile: true, tutorial_dismissed: true },
  ])('completed and skipped legacy users are not reenrolled: %j', async legacy => {
    const f = fixture(legacy);
    expect(ready(await f.provider.read())).toMatchObject({ stepId: 'exited', completion: 'legacy_completed', activationState: 'legacy_completed' });
    const replay = ready(await nav(f.provider, { type: 'replay_tutorial' }));
    expect(replay.completion).toBe('legacy_completed');
    expect(ready(await ack(f.provider, { type: 'tour_finished', state: 'done' }))).toMatchObject({ stepId: 'exited', completion: 'legacy_completed' });
  });

  test.each([
    [fresh, 'welcome'],
    [{ ...fresh, setup_completed: true }, 'interview'],
    [{ ...fresh, setup_completed: true, setup_skipped_profile: true, tutorial_progress_step: 'brief:v1:memory' }, 'tour'],
  ] as const)('maps incomplete legacy records conservatively', async (legacy, expected) => {
    const s = ready(await fixture(legacy).provider.read());
    expect(s.stepId).toBe(expected);
    expect(s.completion).toBe('active');
    expect(s.tourStepId).toBeNull();
    expect(s.legacyTourStepId).toBe(legacy.tutorial_progress_step);
  });

  test('unreachable legacy status never writes incomplete progress', async () => {
    const f = fixture();
    const p = f.make(owner, f.db, () => { throw new Error('sensitive provider detail'); });
    expect(await p.read()).toEqual({ availability: 'unavailable', reason: 'storage_unavailable' });
    expect(f.raw()).toBeNull();
  });

  test.each([{}, { ...fresh, setup_completed: undefined }, { ...fresh, tutorial_progress_step: 5 }])('malformed status never creates a new journey', async value => {
    const f = fixture();
    expect((await f.make(owner, f.db, () => value as LegacyStatus).read()).availability).toBe('unavailable');
    expect(f.raw()).toBeNull();
  });

  test.each(['{broken', 'null', '{}'])('unreadable stored JSON is not treated as missing: %s', async raw => {
    const f = fixture(); f.writeRaw(raw);
    expect((await f.provider.read()).availability).toBe('unavailable');
    expect(f.raw()).toBe(raw);
  });

  test('future fields survive transitions and future schema/state values are read-only', async () => {
    const f = fixture();
    const original = ready(await f.provider.read());
    const record = JSON.parse(f.raw()!);
    record.futureEnvelope = { enabled: true };
    record.snapshot.futureField = { nested: ['keep'] };
    f.writeRaw(JSON.stringify(record));
    ready(await nav(f.provider, { type: 'navigate', stepId: 'explain' }));
    const updated = JSON.parse(f.raw()!);
    expect(updated.futureEnvelope).toEqual(record.futureEnvelope);
    expect(updated.snapshot.futureField).toEqual(record.snapshot.futureField);
    for (const patch of [{ schemaVersion: 2 }, { stepId: 'future-room' }, { interviewState: 'future-state' }]) {
      const raw = JSON.stringify({ ...record, snapshot: { ...record.snapshot, ...patch } });
      f.writeRaw(raw);
      expect((await f.provider.read()).availability).toBe('unsupported');
      expect((await nav(f.provider, { type: 'navigate', stepId: 'explain' }, original)).availability).toBe('unsupported');
      expect(f.raw()).toBe(raw);
    }
  });
});

describe('revision checks, retry identities and scope', () => {
  test('two tabs/connections race: one wins; stale writer receives the latest snapshot', async () => {
    const f = fixture();
    const first = ready(await f.provider.read());
    const other = f.make(owner, f.open());
    const results = await Promise.all([
      nav(f.provider, { type: 'navigate', stepId: 'explain' }, first),
      nav(other, { type: 'navigate', stepId: 'explain' }, first),
    ]);
    expect(results.map(r => r.availability).sort()).toEqual(['ready', 'unavailable']);
    expect(results.find(r => r.availability === 'unavailable')).toMatchObject({ reason: 'revision_conflict', snapshot: { revision: 1 } });
    expect(ready(await other.read()).revision).toBe(1);
  });

  test('independent OS processes cannot both commit the same revision', async () => {
    const f = fixture(); const s = ready(await f.provider.read());
    const worker = new URL('./fixtures/race-worker.ts', import.meta.url).pathname;
    const run = async (id: string) => {
      const child = Bun.spawn([process.execPath, worker, f.path, s.journeyId, id], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      return JSON.parse(stdout) as JourneyResult;
    };
    const results = await Promise.all([run('process-a'), run('process-b')]);
    expect(results.filter(r => r.availability === 'ready')).toHaveLength(1);
    expect(results.filter(r => r.availability === 'unavailable' && r.reason === 'revision_conflict')).toHaveLength(1);
    expect(ready(await f.provider.read()).revision).toBe(1);
  });

  test('lost acknowledgement retry works after restart and later progress, changed key body conflicts', async () => {
    const f = fixture(); const first = ready(await f.provider.read());
    const request = { journeyId: first.journeyId, expectedRevision: 0, requestId: 'lost-ack', command: { type: 'navigate', stepId: 'explain' } } as const;
    ready(await f.provider.transition(request));
    ready(await ack(f.provider, { type: 'setup_completed' }));
    const resumed = f.make(owner, f.open());
    expect(await resumed.transition(request)).toMatchObject({ availability: 'ready', appliedRevision: 1, replayed: true, snapshot: { revision: 2 } });
    expect(await resumed.transition({ ...request, command: { type: 'navigate', stepId: 'welcome' } })).toMatchObject({ reason: 'request_conflict' });
    expect(JSON.parse(f.raw()!).receipts).toHaveLength(2);
  });

  test('unauthorized readers never touch persistence; actor/project isolation rejects copied identities', async () => {
    const f = fixture();
    expect(await f.make(null).read()).toEqual({ availability: 'unavailable', reason: 'unauthorized' });
    expect(f.raw()).toBeNull();
    const first = ready(await f.provider.read());
    for (const scope of [{ ...owner, actorId: 'other' }, { ...owner, projectId: 'other' }]) {
      const p = f.make(scope);
      expect(ready(await p.read()).journeyId).not.toBe(first.journeyId);
      expect(await nav(p, { type: 'navigate', stepId: 'explain' }, first)).toMatchObject({ reason: 'journey_conflict' });
      f.writeRaw(f.raw()!, scope);
      expect((await p.read()).availability).toBe('unavailable');
    }
    expect(ready(await f.provider.read()).revision).toBe(0);
  });

  test('client-supplied ownership and acknowledgements are rejected', async () => {
    const f = fixture(); const s = ready(await f.provider.read());
    const base = { journeyId: s.journeyId, expectedRevision: 0, requestId: 'bad-command' };
    for (const body of [
      { ...base, actorId: 'another', command: { type: 'navigate', stepId: 'explain' } },
      { ...base, command: { type: 'setup_completed' } },
      { ...base, command: { type: 'draft_saved', jobId: 'job', flowId: 'flow', versionId: 'version' } },
      { ...base, command: { type: '__proto__' } },
      { ...base, command: { type: 'navigate', stepId: 'result' } },
      { ...base, expectedRevision: 0.5, command: { type: 'explore' } },
    ]) expect((await f.provider.transition(body as never)).availability).toBe('unavailable');
    expect(ready(await f.provider.read())).toEqual(s);
  });

  test('mutation without a body cannot initialize a journey', async () => {
    const f = fixture();
    expect((await f.provider.transition(undefined as never)).availability).toBe('unavailable');
    expect(f.raw()).toBeNull();
  });

  test('a failed write rolls back; the same request can be retried', async () => {
    const f = fixture(); const s = ready(await f.provider.read());
    const persistence = createSettingsJourneyPersistence({ databaseForScope: () => f.db, readLegacy: () => fresh });
    const p = createJourneyProvider({ authorize: () => owner, persistence: {
      transaction(scope, operation) {
        return persistence.transaction(scope, tx => operation({ ...tx, write(record) {
          tx.write(record); throw new Error('lost DB commit');
        } }));
      },
    } });
    const request = { journeyId: s.journeyId, expectedRevision: 0, requestId: 'retry', command: { type: 'navigate', stepId: 'explain' } } as const;
    expect((await p.transition(request)).availability).toBe('unavailable');
    expect(ready(await f.provider.read())).toEqual(s);
    expect(ready(await f.provider.transition(request)).revision).toBe(1);
  });

  test('cross-tab reconciliation ignores old snapshots and retains progress on outages without allowing writes', async () => {
    const f = fixture(); const old = await f.provider.read();
    const newer = await nav(f.provider, { type: 'navigate', stepId: 'explain' });
    expect(reconcileJourney(newer, old).snapshot?.revision).toBe(1);
    expect(reconcileJourney(newer, { availability: 'unavailable', reason: 'offline' })).toMatchObject({ availability: 'unavailable', snapshot: newer.snapshot });
    expect(reconcileJourney(null, { availability: 'unavailable', reason: 'offline' }).snapshot).toBeUndefined();
    const foreign = await f.make({ ...owner, actorId: 'second-user' }).read();
    expect(reconcileJourney(newer, foreign)).toEqual({ availability: 'unavailable', reason: 'scope_changed' });
  });
});

describe('acknowledgement boundaries and scoped tutorial replay', () => {
  test.each(['failed', 'cancelled'] as const)('a persisted %s build can return to activation without losing its identity', async outcome => {
    const f = fixture(); await activation(f.provider);
    // A pre-reservation v1 record must remain recoverable after upgrading.
    const record = JSON.parse(f.raw()!);
    Object.assign(record.snapshot, { stepId: 'build', activationState: 'building', jobId: 'old-job' });
    delete record.snapshot.buildRequestId;
    delete record.snapshot.buildHistory;
    f.writeRaw(JSON.stringify(record));
    const recovered = ready(await ack(f.provider, {
      type: 'build_finished_without_draft', buildRequestId: null, jobId: 'old-job', outcome,
    }));
    expect(recovered).toMatchObject({ stepId: 'activation', activationState: 'pending', jobId: null,
      buildHistory: [{ buildRequestId: null, jobId: 'old-job', outcome }] });
    expect(ready(await f.make(owner, f.open()).read())).toEqual(recovered);
    expect(ready(await nav(f.provider, { type: 'explore' })).completion).toBe('explored');
  });

  test('a durable reservation blocks Explore in a second tab until delayed job acceptance is reconciled', async () => {
    const f = fixture(); await activation(f.provider);
    const stale = ready(await f.provider.read());
    ready(await ack(f.provider, { type: 'reserve_build', buildRequestId: 'request-1' }));
    const otherTab = f.make(owner, f.open());
    expect(await nav(otherTab, { type: 'explore' }, stale)).toMatchObject({ reason: 'revision_conflict' });
    expect(await nav(otherTab, { type: 'explore' })).toMatchObject({ reason: 'invalid_transition' });
    expect(ready(await otherTab.read())).toMatchObject({ stepId: 'build', buildRequestId: 'request-1', jobId: null });
    // ON-B-08 has accepted the reserved request; its acknowledgement arrives after a restart.
    const accepted = ready(await ack(otherTab, { type: 'build_started', buildRequestId: 'request-1', jobId: 'accepted-job' }));
    expect(accepted).toMatchObject({ stepId: 'build', completion: 'active', jobId: 'accepted-job' });
    expect(ready(await ack(otherTab, { type: 'draft_saved', jobId: 'accepted-job', flowId: 'flow', versionId: 'version' })).stepId).toBe('result');
  });

  test.each(['failed', 'cancelled'] as const)('%s recovery allows a new request but rejects stale and reused attempt identities', async outcome => {
    const f = fixture(); await activation(f.provider); await startBuild(f.provider, 'first-job');
    const s = ready(await f.provider.read());
    const release = { journeyId: s.journeyId, expectedRevision: s.revision, requestId: 'release', command: {
      type: 'build_finished_without_draft', buildRequestId: 'request-first-job', jobId: 'first-job', outcome,
    } } as const;
    ready(await f.provider.acknowledge(release));
    expect(await ack(f.provider, { type: 'reserve_build', buildRequestId: 'request-first-job' })).toMatchObject({ reason: 'invalid_transition' });
    ready(await ack(f.provider, { type: 'reserve_build', buildRequestId: 'new-request' }));
    expect(await ack(f.provider, { type: 'build_started', buildRequestId: 'request-first-job', jobId: 'first-job' })).toMatchObject({ reason: 'invalid_transition' });
    expect(await ack(f.provider, { type: 'build_started', buildRequestId: 'new-request', jobId: 'first-job' })).toMatchObject({ reason: 'invalid_transition' });
    ready(await ack(f.provider, { type: 'build_started', buildRequestId: 'new-request', jobId: 'new-job' }));
    const current = ready(await f.provider.read());
    // A retry of an applied receipt returns current state, never releases the new attempt.
    expect(await f.provider.acknowledge(release)).toMatchObject({ replayed: true, snapshot: current });
    expect(await ack(f.provider, release.command)).toMatchObject({ reason: 'invalid_transition' });
    ready(await ack(f.provider, { type: 'draft_saved', jobId: 'new-job', flowId: 'new-flow', versionId: 'new-version' }));
    const finished = ready(await nav(f.provider, { type: 'finish' }));
    expect(finished.buildHistory).toEqual([{ buildRequestId: 'request-first-job', jobId: 'first-job', outcome }]);
    expect(finished.draft).toEqual({ flowId: 'new-flow', versionId: 'new-version' });
  });

  test('Explore winning the revision race prevents reservation and unreserved job acknowledgement', async () => {
    const f = fixture(); await activation(f.provider);
    const s = ready(await f.provider.read());
    ready(await nav(f.provider, { type: 'explore' }));
    const reserve = { journeyId: s.journeyId, expectedRevision: s.revision, requestId: 'reserve',
      command: { type: 'reserve_build', buildRequestId: 'not-accepted' } } as const;
    expect(await f.provider.acknowledge(reserve)).toMatchObject({ reason: 'revision_conflict' });
    expect(await ack(f.provider, reserve.command)).toMatchObject({ reason: 'invalid_transition' });
    expect(await ack(f.provider, { type: 'build_started', buildRequestId: 'not-accepted', jobId: 'foreign-job' })).toMatchObject({ reason: 'invalid_transition' });
    expect(ready(await f.provider.read())).toMatchObject({ completion: 'explored', buildRequestId: null, jobId: null });
  });

  test('two reservations race atomically and the winner survives a lost reply and restart', async () => {
    const f = fixture(); await activation(f.provider);
    const s = ready(await f.provider.read());
    const requests = ['a', 'b'].map(id => ({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: id,
      command: { type: 'reserve_build', buildRequestId: `build-${id}` } } as const));
    const results = await Promise.all([f.provider.acknowledge(requests[0]!), f.make(owner, f.open()).acknowledge(requests[1]!)]);
    expect(results.filter(r => r.availability === 'ready')).toHaveLength(1);
    expect(results.filter(r => r.availability === 'unavailable' && r.reason === 'revision_conflict')).toHaveLength(1);
    const winner = requests[results.findIndex(r => r.availability === 'ready')]!;
    const restarted = f.make(owner, f.open());
    expect(await restarted.acknowledge(winner)).toMatchObject({ replayed: true, snapshot: { buildRequestId: winner.command.buildRequestId, jobId: null } });
    expect(await nav(restarted, { type: 'navigate', stepId: 'activation' })).toMatchObject({ reason: 'invalid_transition' });
  });

  test('an unaccepted reservation can be released after authoritative reconciliation', async () => {
    const f = fixture(); await activation(f.provider);
    ready(await ack(f.provider, { type: 'reserve_build', buildRequestId: 'unaccepted-request' }));
    const release = { type: 'build_finished_without_draft', buildRequestId: 'unaccepted-request', jobId: null, outcome: 'cancelled' } as const;
    ready(await ack(f.provider, release));
    const after = ready(await f.make(owner, f.open()).read());
    expect(after).toMatchObject({ stepId: 'activation', buildRequestId: null, jobId: null,
      buildHistory: [{ buildRequestId: 'unaccepted-request', jobId: null, outcome: 'cancelled' }] });
    expect(await ack(f.provider, { type: 'build_started', buildRequestId: 'unaccepted-request', jobId: 'late-job' })).toMatchObject({ reason: 'invalid_transition' });
    expect(ready(await nav(f.provider, { type: 'explore' })).completion).toBe('explored');
  });

  test('retrying an old reservation receipt after recovery does not reserve or reopen the journey', async () => {
    const f = fixture(); await activation(f.provider);
    const s = ready(await f.provider.read());
    const reserve = { journeyId: s.journeyId, expectedRevision: s.revision, requestId: 'reservation-retry',
      command: { type: 'reserve_build', buildRequestId: 'cancelled-request' } } as const;
    ready(await f.provider.acknowledge(reserve));
    ready(await ack(f.provider, { type: 'build_finished_without_draft', buildRequestId: 'cancelled-request', jobId: null, outcome: 'cancelled' }));
    ready(await nav(f.provider, { type: 'explore' }));
    const current = ready(await f.provider.read());
    expect(await f.make(owner, f.open()).acknowledge(reserve)).toMatchObject({ replayed: true, snapshot: current });
    expect(current).toMatchObject({ completion: 'explored', buildRequestId: null });
    expect(ready(await f.provider.read())).toEqual(current);
  });

  test('recovery during tutorial replay changes only the return location and permits another reservation', async () => {
    const f = fixture(); await activation(f.provider); await startBuild(f.provider, 'cancelled-job');
    ready(await nav(f.provider, { type: 'replay_tutorial' }));
    ready(await ack(f.provider, { type: 'tour_progress', stepId: 'memory' }));
    expect(ready(await ack(f.provider, { type: 'build_finished_without_draft', buildRequestId: 'request-cancelled-job', jobId: 'cancelled-job', outcome: 'cancelled' }))).toMatchObject({
      stepId: 'tour', tourStepId: 'memory', replayReturnStepId: 'activation', buildRequestId: null,
    });
    ready(await ack(f.provider, { type: 'reserve_build', buildRequestId: 'second-request' }));
    expect(ready(await ack(f.provider, { type: 'tour_finished', state: 'done' }))).toMatchObject({ stepId: 'build', buildRequestId: 'second-request', jobId: null });
    expect(ready(await ack(f.provider, { type: 'build_started', buildRequestId: 'second-request', jobId: 'second-job' })).jobId).toBe('second-job');
  });

  test('recovery rejects foreign identities, nonterminal observations, public commands and a committed draft', async () => {
    const f = fixture(); await activation(f.provider); await startBuild(f.provider, 'current-job');
    const release = { type: 'build_finished_without_draft', buildRequestId: 'request-current-job', jobId: 'current-job', outcome: 'cancelled' } as const;
    for (const patch of [{ jobId: null }, { jobId: 'foreign' }, { buildRequestId: 'foreign' }, { buildRequestId: null },
      { outcome: 'requested' }, { outcome: 'disconnected' }, { outcome: 'working' }, { outcome: 'succeeded' }]) {
      expect((await ack(f.provider, { ...release, ...patch } as never)).availability).toBe('unavailable');
    }
    const s = ready(await f.provider.read());
    for (const command of [release, { type: 'reserve_build', buildRequestId: 'public-request' },
      { type: 'build_started', buildRequestId: 'request-current-job', jobId: 'current-job' }]) {
      expect((await f.provider.transition({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: 'public', command } as never)).availability).toBe('unavailable');
    }
    expect(ready(await f.provider.read())).toEqual(s);
    ready(await ack(f.provider, { type: 'draft_saved', jobId: 'current-job', flowId: 'saved-flow', versionId: 'saved-version' }));
    ready(await nav(f.provider, { type: 'replay_tutorial' }));
    const saved = ready(await f.provider.read());
    expect(await ack(f.provider, release)).toMatchObject({ reason: 'invalid_transition' });
    expect(ready(await f.provider.read())).toEqual(saved);
    expect(saved.draft).toEqual({ flowId: 'saved-flow', versionId: 'saved-version' });
  });

  test('reservation history preserves additive fields and refuses malformed or future outcomes without rewriting', async () => {
    const f = fixture(); await activation(f.provider); await startBuild(f.provider, 'first-job');
    ready(await ack(f.provider, { type: 'build_finished_without_draft', buildRequestId: 'request-first-job', jobId: 'first-job', outcome: 'failed' }));
    const record = JSON.parse(f.raw()!);
    record.snapshot.buildHistory[0].futureDetail = { retain: true };
    f.writeRaw(JSON.stringify(record));
    ready(await ack(f.provider, { type: 'reserve_build', buildRequestId: 'second-request' }));
    expect(JSON.parse(f.raw()!).snapshot.buildHistory[0].futureDetail).toEqual({ retain: true });
    for (const patch of [{ buildRequestId: 42 }, { buildHistory: {} },
      { buildHistory: [{ buildRequestId: null, jobId: null, outcome: 'failed' }] },
      { buildHistory: [{ buildRequestId: 'future-request', jobId: 'future-job', outcome: 'future-outcome' }] }]) {
      const raw = JSON.stringify({ ...record, snapshot: { ...record.snapshot, ...patch } });
      f.writeRaw(raw);
      expect((await f.provider.read()).availability).not.toBe('ready');
      expect(f.raw()).toBe(raw);
    }
  });

  test('setup acknowledgement is required before Google; interview acknowledgement before tour', async () => {
    const f = fixture();
    ready(await nav(f.provider, { type: 'navigate', stepId: 'explain' }));
    expect((await nav(f.provider, { type: 'navigate', stepId: 'google' })).availability).toBe('unavailable');
    ready(await nav(f.provider, { type: 'navigate', stepId: 'legacy-provider-setup' }));
    ready(await ack(f.provider, { type: 'setup_completed' }));
    ready(await nav(f.provider, { type: 'navigate', stepId: 'google' }));
    ready(await nav(f.provider, { type: 'navigate', stepId: 'interview' }));
    expect((await nav(f.provider, { type: 'navigate', stepId: 'tour' })).availability).toBe('unavailable');
    ready(await ack(f.provider, { type: 'interview_finished', state: 'skipped' }));
    expect(ready(await nav(f.provider, { type: 'navigate', stepId: 'tour' })).interviewState).toBe('skipped');
  });

  test('tour completion leaves activation visible; Explore first finishes without a workflow', async () => {
    const f = fixture(); await activation(f.provider);
    expect(ready(await f.provider.read())).toMatchObject({ stepId: 'activation', completion: 'active', jobId: null });
    expect(ready(await nav(f.provider, { type: 'explore' }))).toMatchObject({ stepId: 'exited', completion: 'explored', jobId: null, draft: null });
    ready(await nav(f.provider, { type: 'replay_tutorial' }));
    expect(ready(await ack(f.provider, { type: 'tour_finished', state: 'skipped' }))).toMatchObject({ stepId: 'exited', completion: 'explored' });
  });

  test('pending job survives replay/restart, including a result arriving during replay', async () => {
    const f = fixture(); await activation(f.provider);
    await startBuild(f.provider, 'job-1');
    expect((await nav(f.provider, { type: 'explore' })).availability).toBe('unavailable');
    ready(await nav(f.provider, { type: 'replay_tutorial' }));
    ready(await nav(f.provider, { type: 'replay_tutorial' }));
    const restarted = f.make(owner, f.open());
    expect(ready(await restarted.read())).toMatchObject({ jobId: 'job-1', stepId: 'tour', replayReturnStepId: 'build', activationState: 'building' });
    expect((await ack(restarted, { type: 'draft_saved', jobId: 'foreign-job', flowId: 'bad', versionId: 'bad' })).availability).toBe('unavailable');
    ready(await ack(restarted, { type: 'draft_saved', jobId: 'job-1', flowId: 'flow-1', versionId: 'version-1' }));
    expect(ready(await ack(restarted, { type: 'tour_finished', state: 'done' }))).toMatchObject({ stepId: 'result', jobId: 'job-1', draft: { flowId: 'flow-1', versionId: 'version-1' } });
    expect(ready(await nav(restarted, { type: 'finish' })).completion).toBe('completed');
  });

  test('an accepted job acknowledgement can arrive after tutorial replay starts', async () => {
    const f = fixture(); await activation(f.provider);
    ready(await ack(f.provider, { type: 'reserve_build', buildRequestId: 'reserved-request' }));
    ready(await nav(f.provider, { type: 'replay_tutorial' }));
    expect(ready(await ack(f.provider, { type: 'build_started', buildRequestId: 'reserved-request', jobId: 'accepted-job' }))).toMatchObject({
      stepId: 'tour', replayReturnStepId: 'build', jobId: 'accepted-job',
    });
    expect(ready(await ack(f.provider, { type: 'tour_finished', state: 'done' })).stepId).toBe('build');
  });

  test('tutorial reset preserves completed setup, profile/connection settings and exact draft; disabling provider leaves legacy readable', async () => {
    const f = fixture({ ...fresh, tutorial_progress_step: 'brief:v1:memory' });
    const settings = { 'cfg.onboarding': '{"setup_completed_at":123,"unknownLegacy":true}', 'cfg.user': '{"name":"Fixture"}', 'cfg.channels': '{"connected":true}' };
    for (const [key, value] of Object.entries(settings)) f.db.run('INSERT INTO settings (key,value) VALUES (?,?)', [key, value]);
    await activation(f.provider);
    await startBuild(f.provider, 'saved-job');
    ready(await ack(f.provider, { type: 'draft_saved', jobId: 'saved-job', flowId: 'saved-flow', versionId: 'saved-version' }));
    ready(await nav(f.provider, { type: 'finish' }));
    const before = ready(await f.provider.read());
    expect(ready(await nav(f.provider, { type: 'replay_tutorial' })).legacyTourStepId).toBeNull();
    ready(await ack(f.provider, { type: 'tour_progress', stepId: 'memory' }));
    expect(ready(await f.make(owner, f.open()).read()).tourStepId).toBe('memory');
    const after = ready(await ack(f.provider, { type: 'tour_finished', state: 'done' }));
    for (const field of ['setupState', 'interviewState', 'activationState', 'completion', 'jobId', 'draft', 'stepId']) expect(after[field]).toEqual(before[field]);
    // Rollback is simply no more calls to the provider. Legacy readers still see exactly their rows.
    for (const [key, value] of Object.entries(settings)) expect(f.db.query('SELECT value FROM settings WHERE key = ?').get(key)).toEqual({ value });
    expect(f.db.query('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 4 });
  });
});
