import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { DEFAULT_IDS } from '../../workflows/db/schema';
import { createBuildJobsProvider, createSqliteBuildStore, initializeBuildJobStore } from './index';
import { fixture, input } from './fixtures';
import { realJourney } from './journey-fixture';
import type { Result } from './types';
const journeyPath = '../journey/index.ts';
const status = (r: Result) => { if (r.availability !== 'ready' || !('status' in r)) throw new Error(JSON.stringify(r)); return r.status; };

test.skipIf(!existsSync(join(import.meta.dir, journeyPath)))('real B01: concurrent requests reserve one job; failure unlocks a new request without reattaching the old one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'on-b08-journey-'));
  try {
    initWorkflowDb(join(directory, 'vault.db')); initializeBuildJobStore(getWorkflowDb());
    const owner = { actorId: 'owner', projectId: DEFAULT_IDS.project }, f = fixture(createSqliteBuildStore(getWorkflowDb()), owner);
    f.services.journey = await realJourney(owner);
    const snapshot = (await f.services.journey.read()).snapshot!;
    const makeInput = (key: string) => ({ ...input(key), journeyId: snapshot.journeyId });
    const provider = createBuildJobsProvider({ enabled: true, authorize: () => owner, servicesFor: () => f.services });
    const replies = await Promise.all([provider.submit(null, makeInput('one')), provider.submit(null, makeInput('two'))]);
    expect(replies.filter(r => r.availability === 'ready')).toHaveLength(1);
    const accepted = status(replies.find(r => r.availability === 'ready')!);
    expect(getWorkflowDb().query('SELECT * FROM onboarding_build_job').all()).toHaveLength(1);
    f.services.draft!.compose = async () => ({ availability: 'unavailable', reason: 'composition_failed' });
    expect(status(await provider.run(null, { schemaVersion: 1, jobId: accepted.jobId }))).toMatchObject({ outcome: 'failed', journeySync: 'settled' });
    expect((await f.services.journey.read()).snapshot).toMatchObject({ jobId: null, buildRequestId: null });
    const next = status(await provider.submit(null, makeInput('new-request')));
    expect(next.jobId).not.toBe(accepted.jobId);
    expect(status(await provider.submit(null, makeInput(accepted.requestId)))).toMatchObject({ jobId: accepted.jobId, outcome: 'failed' });
    expect((await f.services.journey.read()).snapshot!.jobId).toBe(next.jobId);
  } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
});

for (const next of ['new-request', 'explore'] as const) test.skipIf(!existsSync(join(import.meta.dir, journeyPath)))(
  `real B01: cancel a reservation after failed acceptance and changed validation, then ${next}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'on-b08-reservation-')), path = join(directory, 'vault.db');
    try {
      initWorkflowDb(path); initializeBuildJobStore(getWorkflowDb());
      const owner = { actorId: 'owner', projectId: DEFAULT_IDS.project }, f = fixture(createSqliteBuildStore(getWorkflowDb()), owner);
      f.services.journey = await realJourney(owner);
      const journeyId = (await f.services.journey.read()).snapshot!.journeyId;
      const value = { ...input(), journeyId };
      const bind = () => createBuildJobsProvider({ enabled: true, authorize: () => owner, servicesFor: () => f.services });
      let provider = bind();
      getWorkflowDb().exec("CREATE TRIGGER fail_event BEFORE INSERT ON onboarding_build_event BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
      expect(await provider.submit(null, value)).toMatchObject({ reason: 'storage_unavailable' });
      getWorkflowDb().exec('DROP TRIGGER fail_event');
      const validate = f.services.validate!;
      f.services.validate = async s => s.request.requestId === value.submission.request.requestId
        ? { availability: 'ready', state: 'needs_input' } : validate(s);
      expect(await provider.submit(null, value)).toMatchObject({ reason: 'needs_input' });
      const ref = { schemaVersion: 1, requestId: value.submission.request.requestId };
      expect(await provider.cancel(null, ref)).toMatchObject({ availability: 'ready', requestCancellation: {
        requestId: ref.requestId, journeyId, jobId: null, cancellation: 'acknowledged', resolution: 'none', journeySync: 'settled',
      } });
      expect((await f.services.journey.read()).snapshot).toMatchObject({ jobId: null, buildRequestId: null,
        buildHistory: [{ buildRequestId: ref.requestId, jobId: null, outcome: 'cancelled' }] });
      closeWorkflowDb(); initWorkflowDb(path); initializeBuildJobStore(getWorkflowDb());
      f.services.store = createSqliteBuildStore(getWorkflowDb()); provider = bind();
      expect(await provider.read(null, ref)).toMatchObject({ requestCancellation: { cancellation: 'acknowledged' } });
      expect(await provider.submit(null, value)).toMatchObject({ reason: 'request_cancelled' });
      expect(getWorkflowDb().query('SELECT * FROM onboarding_build_job').all()).toHaveLength(0);
      if (next === 'new-request') {
        expect(status(await provider.submit(null, { ...input('new-request'), journeyId })).outcome).toBe('queued');
      } else {
        const s = (await f.services.journey.read()).snapshot!;
        const response = await (f.services.journey as any).transition({ journeyId, expectedRevision: s.revision,
          requestId: 'explore-after-cancellation', command: { type: 'explore' } });
        expect(response).toMatchObject({ availability: 'ready', snapshot: { completion: 'explored' } });
      }
      expect(f.calls()).toBe(0);
    } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
  });
