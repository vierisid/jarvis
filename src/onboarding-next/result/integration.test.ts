import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { DEFAULT_IDS } from '../../workflows/db/schema';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { createDraftResultProvider, createSqliteResultReader, type Result, type Services } from './index';
import { fixture, input } from './fixtures.test';
const journeyPath = '../journey/index.ts', buildPath = '../build-jobs/index.ts', intentPath = '../activation-intent/index.ts', draftPath = '../compose-draft/index.ts';
const present = (path: string) => existsSync(join(import.meta.dir, path));
const saved = (r: Result) => { if (r.availability !== 'ready' || r.state !== 'saved') throw Error(JSON.stringify(r)); return r; };
afterEach(closeWorkflowDb);
async function journeyFor(owner: { actorId: string; projectId: string }) {
  const { createJourneyProvider, createSettingsJourneyPersistence } = await import(journeyPath);
  getWorkflowDb().exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const journey = createJourneyProvider({ authorize: () => owner, persistence: createSettingsJourneyPersistence({
    databaseForScope: () => getWorkflowDb(), readLegacy: () => ({ setup_completed: true, setup_skipped_profile: false,
      profile_completed: true, tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null }),
  }) });
  const s = (await journey.read()).snapshot;
  if (s.stepId === 'tour') await journey.acknowledge({ journeyId: s.journeyId, expectedRevision: s.revision,
    requestId: 'complete-tour', command: { type: 'tour_finished', state: 'done' } });
  return journey;
}
test.skipIf(!present(journeyPath))('actual B01 acknowledgement, explicit finish, lost reply and later reopen', async () => {
  const f = fixture(), journey = await journeyFor(f.owner);
  for (const command of [{ type: 'reserve_build', buildRequestId: f.job.requestId },
    { type: 'build_started', buildRequestId: f.job.requestId, jobId: f.job.jobId }]) {
    const s = (await journey.read()).snapshot;
    expect((await journey.acknowledge({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: command.type, command })).availability).toBe('ready');
  }
  f.job.journeyId = (await journey.read()).snapshot.journeyId; f.services.journey = journey;
  const p = createDraftResultProvider({ enabled: true, authorize: () => f.owner, servicesFor: () => f.services });
  const first = saved(await p.read(null, input)); expect(first.continuation).not.toBeNull();
  expect((await journey.read()).snapshot.completion).toBe('active');
  const finished = await journey.transition(first.continuation!.input);
  expect(finished.snapshot).toMatchObject({ completion: 'completed', draft: { flowId: f.flow.id, versionId: f.version.id } });
  expect((await journey.transition(first.continuation!.input)).replayed).toBe(true);
  const reopened = saved(await p.read(null, first.recovery.input));
  expect(reopened.continuation).toBeNull(); expect(reopened.journey.completion).toBe('completed'); expect(reopened.reference).toEqual(first.reference);
});
for (const failure of ['lost_reply', 'job_write_failure', 'cancel_after_save', 'cancel_before_save'] as const) {
  test.skipIf(![journeyPath, buildPath, intentPath, draftPath].every(present))(`actual B01/B07/B08/B09: ${failure}, refresh and exact result recovery`, async () => {
    const { createActivationIntentProvider } = await import(intentPath);
    const { createComposeDraftProvider, createSqliteDraftStore, initializeComposeDraftStore } = await import(draftPath);
    const { createBuildJobsProvider, createSqliteBuildStore, initializeBuildJobStore } = await import(buildPath);
    const dir = mkdtempSync(join(tmpdir(), 'on-b10-combined-')), path = join(dir, 'vault.db');
    try {
      initWorkflowDb(path); initializeComposeDraftStore(getWorkflowDb()); initializeBuildJobStore(getWorkflowDb());
      const owner = { actorId: 'owner', projectId: DEFAULT_IDS.project }, catalog = sampleCatalog();
      configureWorkflowReadiness({ pieces: catalog }); let calls = 0, now = Date.now();
      const validation = createActivationIntentProvider({ enabled: true, authorize: () => owner, servicesFor: () => ({ id: 'intent',
        access: async () => 'ready', resolve: async () => ({ availability: 'unavailable' }), assess: async () => ({ schemaVersion: 1, issues: [] }) }) });
      const draft = createComposeDraftProvider({ enabled: true, authorize: () => owner, servicesFor: () => ({ id: 'draft',
        store: draftStore, access: async () => true, validate: (s: unknown) => validation.validate(null, s), resolveContext: async () => ({}),
        composer: () => ({ pieceRegistry: catalog, maxAttempts: 1, llm: { chat: async () => { calls++; return { text: JSON.stringify({
          displayName: 'Meeting follow-up', trigger: { name: 'trigger', type: 'EMPTY', nextAction: { name: 'draft', type: 'PIECE',
            settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: 'Prepare the meeting follow-up.' } } } },
        }) }; } } }),
      }) });
      let draftStore = createSqliteDraftStore(getWorkflowDb());
      const journey = await journeyFor(owner);
      const value = { schemaVersion: 1, journeyId: (await journey.read()).snapshot.journeyId, intentId: '', submission: {
        action: 'create', request: { schemaVersion: 1, intentVersion: 1, requestId: 'build-request', prompt: 'Draft a meeting follow-up for review.', contextRefs: [] }, answers: {},
      } };
      value.intentId = (await validation.validate(null, value.submission)).intent.intentId;
      let ref: { schemaVersion: 1; jobId: string };
      const buildServices = { id: 'build', store: createSqliteBuildStore(getWorkflowDb(), { now: () => now }), journey, access: async () => true,
        validate: (s: unknown) => validation.validate(null, s), draft: {
          reconcile: (i: unknown) => draft.reconcile(null, i), compose: async (i: unknown, c: unknown) => {
            if (failure === 'cancel_before_save') await build.cancel(null, ref);
            const r = await draft.compose(null, i, c);
            if (failure === 'cancel_after_save') await build.cancel(null, ref);
            if (failure === 'lost_reply') throw Error('lost after save');
            if (failure === 'job_write_failure') getWorkflowDb().exec("CREATE TRIGGER fail_job BEFORE UPDATE ON onboarding_build_job BEGIN SELECT RAISE(ABORT, 'storage failed'); END");
            return r;
          },
        } };
      let build = createBuildJobsProvider({ enabled: true, authorize: () => owner, servicesFor: () => buildServices });
      const accepted = await build.submit(null, value); ref = { schemaVersion: 1, jobId: accepted.status.jobId };
      await build.run(null, ref);
      if (failure === 'job_write_failure') getWorkflowDb().exec('DROP TRIGGER fail_job');
      // Do not rerun the worker before B10: exercise the saved-but-unacknowledged gap.
      closeWorkflowDb(); initWorkflowDb(path); configureWorkflowReadiness({ pieces: catalog });
      buildServices.store = createSqliteBuildStore(getWorkflowDb(), { now: () => now }); draftStore = createSqliteDraftStore(getWorkflowDb());
      build = createBuildJobsProvider({ enabled: true, authorize: () => owner, servicesFor: () => buildServices });
      const services: Services = { id: 'result', access: async () => true, reader: createSqliteResultReader(getWorkflowDb()), journey,
        build: { read: i => build.read(null, i) } };
      const p = createDraftResultProvider({ enabled: true, authorize: () => owner, servicesFor: () => services });
      const r = await p.read(null, ref);
      if (failure === 'cancel_before_save') {
        expect(r).toMatchObject({ state: 'pending', outcome: 'working', cancellation: 'requested' });
        now += 30001; await build.run(null, ref);
        expect(await p.read(null, ref)).toMatchObject({ state: 'no_draft', outcome: 'cancelled' }); expect(calls).toBe(0);
        expect(getWorkflowDb().query('SELECT * FROM flow').all()).toHaveLength(0);
      } else {
        const result = saved(r); expect(result.journey.sync).toBe('settled');
        expect(result.outcome).toBe(['job_write_failure', 'cancel_after_save'].includes(failure) ? 'working' : 'succeeded');
        expect(saved(await p.read(null, { schemaVersion: 1, requestId: value.submission.request.requestId })).reference).toEqual(result.reference);
        expect(saved(await p.read(null, result.recovery.input)).graph).toEqual(result.graph);
        expect(getWorkflowDb().query('SELECT status, published_version_id FROM flow').all()).toEqual([{ status: 'DISABLED', published_version_id: null }]);
        expect(getWorkflowDb().query('SELECT * FROM flow_version').all()).toHaveLength(1); expect(calls).toBe(1);
      }
      expect(getWorkflowDb().query('SELECT * FROM flow_run').all()).toHaveLength(0);
    } finally { closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); }
  });
}
