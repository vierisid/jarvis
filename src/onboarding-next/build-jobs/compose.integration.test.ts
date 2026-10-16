import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { DEFAULT_IDS } from '../../workflows/db/schema';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { createBuildJobsProvider, createSqliteBuildStore, initializeBuildJobStore } from './index';
import { gate, input } from './fixtures';
import { realJourney } from './journey-fixture';
import type { Result, Services } from './types';
const intentPath = '../activation-intent/index.ts', draftPath = '../compose-draft/index.ts';
const present = [intentPath, draftPath, '../journey/index.ts'].every(p => existsSync(join(import.meta.dir, p)));
const status = (r: Result) => { if (r.availability !== 'ready' || !('status' in r)) throw new Error(JSON.stringify(r)); return r.status; };
for (const failure of ['lost_reply', 'cancel_before_save', 'job_write_failure'] as const) {
  test.skipIf(!present)(`real B01/B07/B09: ${failure} preserves one authorized durable result`, async () => {
    const { createActivationIntentProvider } = await import(intentPath), { createComposeDraftProvider, createSqliteDraftStore, initializeComposeDraftStore } = await import(draftPath);
    const directory = mkdtempSync(join(tmpdir(), 'on-b08-compose-')), dbPath = join(directory, 'vault.db');
    try {
      initWorkflowDb(dbPath); initializeBuildJobStore(getWorkflowDb()); initializeComposeDraftStore(getWorkflowDb());
      const owner = { actorId: 'owner', projectId: DEFAULT_IDS.project }, catalog = sampleCatalog();
      configureWorkflowReadiness({ pieces: catalog }); let calls = 0, now = Date.now();
      const entered = gate(), release = gate();
      const validation = createActivationIntentProvider({ enabled: true, authorize: () => owner, servicesFor: () => ({ id: 'intent-binding',
        access: async () => 'ready', resolve: async () => ({ availability: 'unavailable' }), assess: async () => ({ schemaVersion: 1, issues: [] }),
      }) });
      let draftStore = createSqliteDraftStore(getWorkflowDb());
      const draft = createComposeDraftProvider({ enabled: true, authorize: () => owner, servicesFor: () => ({ id: 'draft-binding', store: draftStore,
        access: async () => true, validate: (s: unknown, signal?: AbortSignal) => validation.validate(null, s, signal), resolveContext: async () => ({}),
        composer: () => ({ pieceRegistry: catalog, maxAttempts: 1, llm: { async chat() {
          calls++; entered.release(); if (failure === 'cancel_before_save') await release.promise;
          return { text: JSON.stringify({ displayName: 'Review meeting draft', trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
            name: 'draft', type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: 'Draft a meeting follow-up for review.' } },
          } } }) };
        } } }),
      }) });
      const journey = await realJourney(owner), value = { ...input(), journeyId: (await journey.read()).snapshot!.journeyId };
      value.intentId = (await validation.validate(null, value.submission)).intent.intentId;
      const services: Services = { id: 'build-binding', store: createSqliteBuildStore(getWorkflowDb(), { now: () => now }), journey,
        access: async () => true, validate: s => validation.validate(null, s), draft: {
          reconcile: i => draft.reconcile(null, i), compose: async (i, c) => {
            const result = await draft.compose(null, i, c);
            if (failure === 'lost_reply') throw new Error('lost response after commit');
            if (failure === 'job_write_failure') getWorkflowDb().exec("CREATE TRIGGER fail_job BEFORE UPDATE ON onboarding_build_job BEGIN SELECT RAISE(ABORT, 'unavailable'); END;");
            return result;
          },
        } };
      const bind = () => createBuildJobsProvider({ enabled: true, authorize: () => owner, servicesFor: () => services });
      let provider = bind();
      const queued = status(await provider.submit(null, value)); expect(status(await provider.submit(null, value)).jobId).toBe(queued.jobId);
      const ref = { schemaVersion: 1, jobId: queued.jobId }, running = provider.run(null, ref);
      if (failure === 'cancel_before_save') {
        await entered.promise; await provider.cancel(null, ref);
        expect(status(await bind().run(null, ref))).toMatchObject({ outcome: 'cancelled', resolution: 'none' }); release.release();
        await running;
      } else if (failure === 'job_write_failure') {
        expect((await running).availability).toBe('unavailable'); getWorkflowDb().exec('DROP TRIGGER fail_job');
      } else expect(status(await running).outcome).toBe('succeeded');
      closeWorkflowDb(); initWorkflowDb(dbPath); configureWorkflowReadiness({ pieces: catalog }); now += 30001;
      services.store = createSqliteBuildStore(getWorkflowDb(), { now: () => now }); draftStore = createSqliteDraftStore(getWorkflowDb()); provider = bind();
      const recovered = status(await provider.run(null, ref));
      expect(recovered).toMatchObject({ outcome: failure === 'cancel_before_save' ? 'cancelled' : 'succeeded', journeySync: 'settled' });
      const flows = getWorkflowDb().query<{ status: string; published_version_id: string | null }, []>('SELECT status, published_version_id FROM flow').all();
      expect(flows).toEqual(failure === 'cancel_before_save' ? [] : [{ status: 'DISABLED', published_version_id: null }]);
      expect(getWorkflowDb().query('SELECT * FROM flow_version').all()).toHaveLength(flows.length);
      expect(getWorkflowDb().query('SELECT * FROM flow_run').all()).toHaveLength(0);
      expect(calls).toBe(1);
      expect(status(await provider.submit(null, value)).jobId).toBe(queued.jobId);
    } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
  });
}
