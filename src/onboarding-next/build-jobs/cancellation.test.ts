import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { createBuildJobsProvider, createSqliteBuildStore, initializeBuildJobStore } from './index';
import { fixture, gate, input, scope } from './fixtures';
import type { Result, Scope } from './types';

let directory: string, path: string, now: number, owner: Scope;
let f: ReturnType<typeof fixture>, provider: ReturnType<typeof createBuildJobsProvider<null>>;
const ref = { schemaVersion: 1, requestId: 'request-1' };
const status = (r: Result) => { if (r.availability !== 'ready' || !('status' in r)) throw new Error(JSON.stringify(r)); return r.status; };
const bind = () => createBuildJobsProvider({ enabled: true, authorize: () => owner, servicesFor: () => f.services });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'on-b08-cancel-')); path = join(directory, 'vault.db'); now = Date.now(); owner = scope;
  initWorkflowDb(path); initializeBuildJobStore(getWorkflowDb());
  f = fixture(createSqliteBuildStore(getWorkflowDb(), { now: () => now })); provider = bind();
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });
async function reserveOnly() {
  await f.services.journey!.acknowledge({ journeyId: 'journey-1', expectedRevision: 0, requestId: 'reserve',
    command: { type: 'reserve_build', buildRequestId: ref.requestId } });
}

test('a cancellation fence rejects acceptance even after a submitter read the old reservation', async () => {
  const entered = gate(), release = gate(), read = f.services.journey!.read; let first = true;
  f.services.journey!.read = async () => {
    const result = await read();
    if (first && result.snapshot?.buildRequestId === ref.requestId) { first = false; entered.release(); await release.promise; }
    return result;
  };
  const delayed = provider.submit(null, input()); await entered.promise;
  try {
    expect(await bind().cancel(null, ref)).toMatchObject({ requestCancellation: { cancellation: 'acknowledged', jobId: null } });
  } finally { release.release(); }
  expect(await delayed).toMatchObject({ reason: 'request_cancelled' });
  expect(getWorkflowDb().query('SELECT * FROM onboarding_build_job').all()).toHaveLength(0);
  expect(f.snapshot()).toMatchObject({ buildRequestId: null, jobId: null }); expect(f.calls()).toBe(0);
});

for (const saved of [false, true]) test(`acceptance winning a cancellation race keeps the accepted job (saved=${saved})`, async () => {
  await reserveOnly();
  const entered = gate(), release = gate(), read = f.services.journey!.read; let first = true;
  f.services.journey!.read = async () => {
    const result = await read();
    if (first) { first = false; entered.release(); await release.promise; }
    return result;
  };
  const cancelling = provider.cancel(null, ref); await entered.promise;
  let jobId: string;
  try {
    jobId = status(await bind().submit(null, input())).jobId;
    if (saved) await bind().run(null, ref);
  } finally { release.release(); }
  expect(status(await cancelling)).toMatchObject({ jobId: jobId!, outcome: saved ? 'succeeded' : 'queued' });
  expect(status(await provider.run(null, ref))).toMatchObject({ outcome: saved ? 'succeeded' : 'cancelled', resolution: saved ? 'saved' : 'none' });
  expect(f.services.store.readCancellation(scope, ref.requestId)).toBeNull();
  expect(f.calls()).toBe(saved ? 1 : 0);
});

test('the acceptance transaction honors the fence across store restart', async () => {
  await reserveOnly();
  expect(await provider.cancel(null, ref)).toMatchObject({ requestCancellation: { cancellation: 'acknowledged' } });
  closeWorkflowDb(); initWorkflowDb(path); initializeBuildJobStore(getWorkflowDb());
  f.services.store = createSqliteBuildStore(getWorkflowDb(), { now: () => now }); provider = bind();
  expect(() => f.services.store.accept(scope, input())).toThrow('request_cancelled');
  // An already-running older acceptance path also cannot bypass the database fence.
  expect(() => getWorkflowDb().run(`INSERT INTO onboarding_build_job
    (id, actor_id, project_id, request_id, record) VALUES (?, ?, ?, ?, ?)`,
    ['late-job', scope.actorId, scope.projectId, ref.requestId, '{}'])).toThrow('request_cancelled');
  const changed = input(); changed.submission.request.prompt = 'A different task';
  expect(await provider.submit(null, changed)).toMatchObject({ reason: 'request_cancelled' });
  expect(await provider.cancel(null, ref)).toMatchObject({ requestCancellation: { cancellation: 'acknowledged' } });
  expect(f.acknowledgements.filter(c => c.type === 'build_finished_without_draft')).toHaveLength(1);
  expect(f.calls()).toBe(0);
});

for (const applied of [false, true]) test(`worker restart recovers a lost cancellation acknowledgement (applied=${applied})`, async () => {
  await reserveOnly();
  const ack = f.services.journey!.acknowledge; let unavailable = true;
  f.services.journey!.acknowledge = async value => {
    if (value.command.type === 'build_finished_without_draft' && unavailable) {
      if (applied) await ack(value);
      throw new Error('lost acknowledgement');
    }
    return ack(value);
  };
  f.services.validate = undefined; f.services.draft = undefined;
  expect(await provider.cancel(null, ref)).toMatchObject({ requestCancellation: {
    revision: 1, cancellation: 'requested', resolution: 'none', journeySync: 'pending',
  } });
  expect(await provider.read(null, ref)).toMatchObject({ requestCancellation: { journeySync: 'pending' } });
  expect(await provider.runNext(null)).toBeNull();
  closeWorkflowDb(); initWorkflowDb(path); initializeBuildJobStore(getWorkflowDb());
  f.services.store = createSqliteBuildStore(getWorkflowDb(), { now: () => now }); provider = bind();
  now += 1001; unavailable = false;
  expect(await provider.runNext(null)).toMatchObject({ requestCancellation: { revision: 2, cancellation: 'acknowledged', journeySync: 'settled' } });
  expect(await provider.runNext(null)).toBeNull();
  expect(f.snapshot()).toMatchObject({ buildRequestId: null, jobId: null,
    buildHistory: [{ buildRequestId: ref.requestId, jobId: null, outcome: 'cancelled' }] });
  expect(f.calls()).toBe(0);
});

test('replaying a lost cancellation acknowledgement leaves a newer reservation untouched', async () => {
  await reserveOnly();
  const ack = f.services.journey!.acknowledge;
  f.services.journey!.acknowledge = async value => { const r = await ack(value);
    if (value.command.type === 'build_finished_without_draft') throw new Error('lost'); return r; };
  expect(await provider.cancel(null, ref)).toMatchObject({ requestCancellation: { journeySync: 'pending' } });
  const next = status(await provider.submit(null, input('new-request')));
  expect(await provider.cancel(null, ref)).toMatchObject({ requestCancellation: { journeySync: 'settled' } });
  expect(f.snapshot()).toMatchObject({ buildRequestId: 'new-request', jobId: next.jobId }); expect(f.calls()).toBe(0);
});

test('a failed fence write cannot release the reservation or acknowledge cancellation', async () => {
  await reserveOnly();
  getWorkflowDb().exec("CREATE TRIGGER fail_cancellation BEFORE INSERT ON onboarding_build_cancellation BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
  expect(await provider.cancel(null, ref)).toMatchObject({ availability: 'unavailable', reason: 'storage_unavailable' });
  expect(f.snapshot()).toMatchObject({ buildRequestId: ref.requestId, jobId: null });
  expect(f.acknowledgements.map(c => c.type)).toEqual(['reserve_build']);
  expect(f.services.store.readCancellation(scope, ref.requestId)).toBeNull();
  getWorkflowDb().exec('DROP TRIGGER fail_cancellation');
  expect(status(await provider.submit(null, input())).outcome).toBe('queued');
});

test('unknown keys and other scopes cannot cancel or fence the current reservation', async () => {
  await reserveOnly();
  expect(await provider.cancel(null, { ...ref, requestId: 'unknown' })).toMatchObject({ reason: 'not_found' });
  expect(await provider.cancel(null, { schemaVersion: 1, jobId: 'unknown' })).toMatchObject({ reason: 'not_found' });
  for (const changed of [{ ...scope, actorId: 'other' }, { ...scope, projectId: 'other' }]) {
    owner = changed;
    expect((await provider.cancel(null, ref)).availability).toBe('unavailable');
    expect(f.services.store.readCancellation(owner, ref.requestId)).toBeNull();
  }
  expect(f.services.store.readCancellation(scope, ref.requestId)).toBeNull();
  expect(f.snapshot()).toMatchObject({ buildRequestId: ref.requestId, jobId: null });
  expect(f.acknowledgements.map(c => c.type)).toEqual(['reserve_build']);
});
