import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, input } from './fixtures.test';
import { createDraftCompletionGuard, createDraftResultProvider } from './index';
import { closeWorkflowDb } from '../../workflows/db';
import { createDraftVersion } from '../../workflows/db/repos/flow-version';
import type { Scope } from './types';
afterEach(closeWorkflowDb);
const journeyPath = '../journey/index.ts';
const journeyTest = test.skipIf(!existsSync(join(import.meta.dir, journeyPath)));

async function prepared(path?: string) {
  const { createJourneyProvider, createSettingsJourneyPersistence } = await import(journeyPath);
  const f = fixture(path);
  f.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const control: { owner: Scope | null; beforeAuthorize?: () => void; beforeJobRead?: () => void } = { owner: f.owner };
  const guard = createDraftCompletionGuard({ reader: f.services.reader, readJob: () => {
    control.beforeJobRead?.();
    return { availability: 'ready', status: f.job };
  } });
  const make = (validateFinish: typeof guard | null = guard) => createJourneyProvider({
    authorize: async () => { await Promise.resolve(); control.beforeAuthorize?.(); return control.owner; },
    validateFinish: validateFinish ?? undefined, persistence: createSettingsJourneyPersistence({
      databaseForScope: () => f.db, readLegacy: () => ({ setup_completed: true, setup_skipped_profile: false,
        profile_completed: true, tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null }),
    }),
  });
  const journey = make();
  for (const command of [{ type: 'tour_finished', state: 'done' }, { type: 'reserve_build', buildRequestId: f.job.requestId },
    { type: 'build_started', buildRequestId: f.job.requestId, jobId: f.job.jobId }] as const) {
    const s = (await journey.read()).snapshot!;
    expect((await journey.acknowledge({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: command.type, command })).availability).toBe('ready');
  }
  f.job.journeyId = (await journey.read()).snapshot!.journeyId; f.services.journey = journey;
  const provider = createDraftResultProvider({ enabled: true, authorize: () => f.owner, servicesFor: () => f.services });
  const result = await provider.read(null, input);
  if (result.availability !== 'ready' || result.state !== 'saved' || !result.continuation) throw Error(JSON.stringify(result));
  return { ...f, control, make, guard, journey, provider, result, request: result.continuation.input };
}

for (const change of ['deleted', 'locked', 'replaced', 'enabled', 'published', 'ownership', 'receipt', 'job', 'digest'] as const) {
  journeyTest(`a previously issued Continue refuses a ${change} draft association without writing completion`, async () => {
    const f = await prepared(), before = (await f.journey.read()).snapshot;
    if (change === 'deleted') f.db.run('DELETE FROM flow_version WHERE id = ?', [f.version.id]);
    if (change === 'locked') f.db.run("UPDATE flow_version SET state = 'LOCKED' WHERE id = ?", [f.version.id]);
    if (change === 'replaced') {
      const replacement = createDraftVersion({ flowId: f.flow.id, displayName: 'Replacement' });
      f.db.run('UPDATE flow_version SET updated = ? WHERE id = ?', [f.version.updated + 1000, replacement.id]);
    }
    if (change === 'enabled') f.db.run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [f.flow.id]);
    if (change === 'published') f.db.run('UPDATE flow SET published_version_id = ? WHERE id = ?', [f.version.id, f.flow.id]);
    if (change === 'ownership') f.db.run("UPDATE flow SET project_id = 'foreign' WHERE id = ?", [f.flow.id]);
    if (change === 'receipt') f.db.exec('DELETE FROM onboarding_draft_receipt');
    if (change === 'job') f.job.artifact!.compositionRecordId = 'another-composition';
    if (change === 'digest') f.job.requestDigest = 'a'.repeat(64);
    const record = f.db.query('SELECT value FROM settings').get();
    expect(await f.journey.transition(f.request)).toMatchObject({ availability: 'unavailable', reason: 'result_unavailable' });
    expect((await f.journey.read()).snapshot).toEqual(before);
    expect(f.db.query('SELECT value FROM settings').get()).toEqual(record);
  });
}
journeyTest('deletion during asynchronous authorization is checked inside the completion transaction', async () => {
  const f = await prepared();
  f.control.beforeAuthorize = () => f.db.run('DELETE FROM flow_version WHERE id = ?', [f.version.id]);
  expect(await f.journey.transition(f.request)).toMatchObject({ availability: 'unavailable', reason: 'result_unavailable' });
  expect((await f.journey.read()).snapshot.completion).toBe('active');
});
journeyTest('fresh authorization and job scope remain required for completion', async () => {
  const f = await prepared();
  f.control.owner = null;
  expect(await f.journey.transition(f.request)).toMatchObject({ availability: 'unavailable', reason: 'unauthorized' });
  f.control.owner = f.owner; f.job.scopeId = 'a'.repeat(64);
  expect(await f.journey.transition(f.request)).toMatchObject({ availability: 'unavailable', reason: 'result_unavailable' });
  expect((await f.journey.read()).snapshot.completion).toBe('active');
});
journeyTest('an absent completion binding offers no Continue and cannot be bypassed by a direct finish', async () => {
  const f = await prepared(), unbound = f.make(null);
  f.services.journey = unbound;
  expect(await f.provider.read(null, input)).toMatchObject({ state: 'saved', continuation: null });
  expect(await unbound.transition(f.request)).toMatchObject({ availability: 'unavailable', reason: 'result_unavailable' });
});
journeyTest('guard failures and asynchronous or different-database guards fail closed', async () => {
  const f = await prepared();
  for (const guard of [() => false, () => { throw Error('PRIVATE'); },
    (() => Promise.resolve(true)) as unknown as typeof f.guard,
    ((scope, journey) => f.guard(scope, journey, {})) as typeof f.guard]) {
    expect(await f.make(guard).transition(f.request)).toMatchObject({ availability: 'unavailable', reason: 'result_unavailable' });
  }
  expect(f.guard(f.owner, (await f.journey.read()).snapshot, f.db)).toBe(false);
});
journeyTest('saved drafts with missing inputs can finish; lost replies replay without a new completion', async () => {
  const f = await prepared(), graph = structuredClone(f.version.trigger);
  graph.nextAction!.settings!.input = {};
  f.db.run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(graph), f.version.id]);
  expect(await f.provider.read(null, input)).toMatchObject({ readiness: { ready: false } });
  const done = await f.journey.transition(f.request);
  expect(done).toMatchObject({ availability: 'ready', replayed: false, snapshot: { completion: 'completed' } });
  f.db.run('DELETE FROM flow_version WHERE id = ?', [f.version.id]);
  expect(await f.make().transition(f.request)).toMatchObject({ availability: 'ready', replayed: true, snapshot: done.snapshot });
  expect(f.db.query('SELECT * FROM flow_run').all()).toHaveLength(0);
});
journeyTest('a stale continuation keeps the journey revision conflict', async () => {
  const f = await prepared();
  expect((await f.journey.transition({ ...f.request, requestId: 'replay', command: { type: 'replay_tutorial' } })).availability).toBe('ready');
  expect(await f.journey.transition(f.request)).toMatchObject({ availability: 'unavailable', reason: 'revision_conflict' });
});
journeyTest('the exact draft check and finish share a write transaction that fences another connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-b10-completion-'));
  let other: Database | undefined;
  try {
    const path = join(dir, 'vault.db'), f = await prepared(path);
    other = new Database(path); other.exec('PRAGMA busy_timeout = 1');
    let attempted = false;
    f.control.beforeJobRead = () => {
      attempted = true;
      expect(f.db.inTransaction).toBe(true);
      expect(() => other!.run('DELETE FROM flow_version WHERE id = ?', [f.version.id])).toThrow(/locked/);
    };
    expect(await f.journey.transition(f.request)).toMatchObject({ availability: 'ready', snapshot: { completion: 'completed' } });
    expect(attempted).toBe(true);
    expect(f.db.query('SELECT id FROM flow_version WHERE id = ?').get(f.version.id)).not.toBeNull();
  } finally { other?.close(); closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); }
});
