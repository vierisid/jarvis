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
const status = (r: Result) => { if (r.availability !== 'ready') throw new Error(JSON.stringify(r)); return r.status; };

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
