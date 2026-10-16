import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { closeWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftResultProvider } from './index';
import { fixture, input } from './fixtures.test';
import type { Dependencies, Result, Services } from './types';
const saved = (r: Result) => { if (r.availability !== 'ready' || r.state !== 'saved') throw Error(JSON.stringify(r)); return r; };
const provider = (f: ReturnType<typeof fixture>, patch: Partial<Dependencies<null>> = {}) => createDraftResultProvider({
  enabled: true, authorize: () => f.owner, servicesFor: () => f.services, ...patch,
});
afterEach(closeWorkflowDb);

test('inert, default-off and missing bindings never read or initialize services', async () => {
  let calls = 0; const p = createDraftResultProvider({ authorize() { calls++; return null; }, servicesFor() { calls++; return null; } });
  expect(calls).toBe(0); expect(await p.read(null, input)).toMatchObject({ availability: 'unsupported', reason: 'disabled' }); expect(calls).toBe(0);
  const f = fixture(); expect(await provider(f, { servicesFor: () => null }).read(null, input)).toMatchObject({ reason: 'binding_missing' });
  f.services.build = undefined; expect(await provider(f).read(null, input)).toMatchObject({ reason: 'provider_unavailable' });
});
test('saved result repairs acknowledgement but Continue is explicit and retains exact identity', async () => {
  const f = fixture(), p = provider(f), r = saved(await p.read(null, { ...input, selectedNodeId: 'draft' }));
  expect(r).toMatchObject({ selectedNodeId: 'draft', workflow: { room: 'workflow', selection: { flowId: f.flow.id, versionId: f.version.id } },
    continuation: { operation: 'journey.transition', input: { command: { type: 'finish' }, expectedRevision: 5 } },
    journey: { sync: 'settled', completion: 'active' } });
  expect(f.writes).toHaveLength(1); expect(f.journey.completion).toBe('active');
  expect(saved(await p.read(null, r.recovery.input)).flowId).toBe(f.flow.id); expect(f.writes).toHaveLength(1);
  expect(saved(await p.read(null, { ...input, selectedNodeId: 'missing' })).selectedNodeId).toBeNull();
});
test('reopening after dashboard continuation preserves completion and does not finish again', async () => {
  const f = fixture(), p = provider(f); await p.read(null, input);
  f.journey.completion = 'completed'; f.journey.stepId = 'exited';
  const r = saved(await p.read(null, input)); expect(r.continuation).toBeNull(); expect(r.journey.completion).toBe('completed'); expect(f.writes).toHaveLength(1);
});
for (const outcome of ['working', 'failed', 'cancelled'] as const) test(`saved draft wins a ${outcome} / cancellation race without rewriting job outcome`, async () => {
  const f = fixture(); f.job.outcome = outcome; f.job.artifact = null; f.job.resolution = 'unknown'; f.job.cancellation = 'requested';
  expect(saved(await provider(f).read(null, input))).toMatchObject({ outcome, cancellation: 'requested', flowId: f.flow.id });
});
test('new provider after a vault restart recovers the same durable result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-b10-restart-'));
  try {
    const path = join(dir, 'test.db'), f = fixture(path), first = saved(await provider(f).read(null, input));
    closeWorkflowDb(); initWorkflowDb(path); f.rebind();
    const second = saved(await provider(f).read(null, first.recovery.input));
    expect(second.recovery).toEqual(first.recovery); expect(second.graph).toEqual(first.graph);
    // Readiness services were reset on restart; cached readiness must not survive.
    expect(second.readiness.ready).toBe(false);
  } finally { closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); }
});
for (const [outcome, resolution, state] of [['working', 'unknown', 'pending'], ['cancelled', 'none', 'no_draft'], ['failed', 'unknown', 'pending']] as const) {
  test(`no receipt: ${outcome}/${resolution} is ${state}`, async () => {
    const f = fixture(); f.db.exec('DELETE FROM onboarding_draft_receipt'); f.job.artifact = null; f.job.outcome = outcome; f.job.resolution = resolution;
    expect(await provider(f).read(null, input)).toMatchObject({ availability: 'ready', state, outcome }); expect(f.writes).toHaveLength(0);
  });
}
test('a cached job success is insufficient if its receipt has disappeared', async () => {
  const f = fixture(); f.db.exec('DELETE FROM onboarding_draft_receipt');
  expect(await provider(f).read(null, input)).toMatchObject({ reason: 'incomplete_result' }); expect(f.writes).toHaveLength(0);
});
for (const cancellation of ['requested', 'acknowledged'] as const) test(`B08 no-job cancellation (${cancellation}) remains no-job`, async () => {
  const f = fixture(); f.services.build!.read = async () => ({ availability: 'ready', requestCancellation: { schemaVersion: 1,
    revision: cancellation === 'requested' ? 1 : 2, scopeId: f.job.scopeId, journeyId: f.job.journeyId, requestId: f.job.requestId,
    jobId: null, cancellation, resolution: 'none', journeySync: 'pending' } });
  expect(await provider(f).read(null, { schemaVersion: 1, requestId: f.job.requestId })).toMatchObject({ state: 'no_draft', jobId: null,
    outcome: cancellation === 'requested' ? null : 'cancelled' }); expect(f.writes).toHaveLength(0);
});
test('stale pinned version and graph revision cannot open a mismatching inspector', async () => {
  const f = fixture(), p = provider(f), r = saved(await p.read(null, input));
  expect(await p.read(null, { ...r.recovery.input, expected: { ...r.recovery.input.expected!, versionId: 'wrong' } })).toMatchObject({ reason: 'version_changed' });
  f.db.run("UPDATE flow_version SET display_name = 'Changed' WHERE id = ?", [f.version.id]);
  expect(await p.read(null, { ...r.recovery.input, expected: { ...r.recovery.input.expected!, contentRevision: r.contentRevision } })).toMatchObject({ reason: 'result_changed' });
  expect(saved(await p.read(null, r.recovery.input)).title).toBe('Changed');
});
for (const key of ['jobId', 'requestId', 'journeyId', 'requestDigest', 'scopeId', 'artifact'] as const) test(`malformed or mismatched ${key} is refused`, async () => {
  const f = fixture(); (f.job as any)[key] = key === 'artifact' ? { ...f.job.artifact, flowId: 'wrong' } : 'wrong';
  if (key === 'journeyId') (f.job as any)[key] = null;
  expect((await provider(f).read(null, input)).availability).toBe('unavailable'); expect(f.writes).toHaveLength(0);
});
test('a job owned by another scope is refused even before any draft is saved', async () => {
  const f = fixture(); f.db.exec('DELETE FROM onboarding_draft_receipt'); f.job.artifact = null; f.job.outcome = 'working'; f.job.resolution = 'unknown';
  f.job.scopeId = createHash('sha256').update(JSON.stringify([f.owner.actorId, 'another-project'])).digest('hex');
  expect(await provider(f).read(null, input)).toEqual({ availability: 'unavailable', reason: 'identity_mismatch' }); expect(f.writes).toHaveLength(0);
});
for (const raw of [{}, { ...input, schemaVersion: 2 }, { ...input, projectId: 'evil' }, { ...input, requestId: 'also' },
  { ...input, selectedNodeId: '../evil' }, { ...input, expected: {} }]) test('validates version, lookup, selection and client authority', async () => {
  const f = fixture(); expect((await provider(f).read(null, raw)).availability).not.toBe('ready'); expect(f.writes).toHaveLength(0);
});
test('authorization revoked or scope replaced across a pending job read leaks no graph', async () => {
  for (const change of ['revoke', 'actor', 'project']) {
    const f = fixture(); let active = f.owner as typeof f.owner | null;
    f.services.build!.read = async () => { active = change === 'revoke' ? null : { ...f.owner, [change === 'actor' ? 'actorId' : 'projectId']: 'other' };
      return { availability: 'ready', status: f.job }; };
    expect(await provider(f, { authorize: () => active }).read(null, input)).toEqual({ availability: 'unavailable', reason: 'unauthorized' });
    closeWorkflowDb();
  }
});
test('service generation or reader replaced across awaits fails closed', async () => {
  const f = fixture(); f.services.build!.read = async () => { f.services.id = 'new'; return { availability: 'ready', status: f.job }; };
  expect(await provider(f).read(null, input)).toMatchObject({ reason: 'binding_missing' });
});
test('failed, timed-out or missing build readers never use the cached journey draft', async () => {
  const f = fixture(); f.services.build!.read = async () => { throw new Error('PRIVATE TOKEN'); };
  expect(await provider(f).read(null, input)).toEqual({ availability: 'unavailable', reason: 'provider_unavailable' });
  f.services.build!.read = () => new Promise(() => {});
  expect(await provider(f, { readTimeoutMs: 5 }).read(null, input)).toMatchObject({ reason: 'provider_unavailable' });
});
test('progress outage does not hide the saved draft or claim onboarding complete', async () => {
  const f = fixture(); f.services.journey!.acknowledge = async () => { throw Error('PRIVATE'); };
  expect(saved(await provider(f).read(null, input))).toMatchObject({ journey: { sync: 'pending', completion: null }, continuation: null });
  f.services.journey = undefined;
  expect(saved(await provider(f).read(null, input)).journey.sync).toBe('unavailable');
});
test('lost acknowledgement response is recovered on refresh without changing the draft', async () => {
  const f = fixture(), ack = f.services.journey!.acknowledge;
  f.services.journey!.acknowledge = async i => { await ack(i); throw Error('lost'); };
  const p = provider(f); expect(saved(await p.read(null, input)).journey.sync).toBe('pending');
  expect(saved(await p.read(null, input)).journey.sync).toBe('settled'); expect(f.writes).toHaveLength(1);
});
test('stale journey or replay cannot generate a finish command', async () => {
  const f = fixture(); f.journey.jobId = 'other';
  expect(saved(await provider(f).read(null, input)).continuation).toBeNull(); expect(f.writes).toHaveLength(0);
  f.journey.jobId = f.job.jobId; f.journey.draft = { flowId: f.flow.id, versionId: f.version.id }; f.journey.stepId = 'tour';
  expect(saved(await provider(f).read(null, input)).continuation).toBeNull();
});
test('refreshes graph after async journey read; deletion while waiting never returns a stale result', async () => {
  const f = fixture(); f.services.journey!.read = async () => {
    f.db.run('DELETE FROM flow_version WHERE id = ?', [f.version.id]); return { availability: 'unavailable' };
  };
  expect(await provider(f).read(null, input)).toMatchObject({ reason: 'artifact_unavailable' }); expect(f.writes).toHaveLength(0);
});

test('accepts B08 opaque request IDs including Unicode and URL punctuation without changing the key', async () => {
  const f = fixture(), requestId = 'request / α ? & # 1';
  f.db.run('UPDATE onboarding_draft_receipt SET request_id = ?', [requestId]);
  f.job.requestId = requestId; f.job.artifact!.requestId = requestId; f.journey.buildRequestId = requestId;
  expect(saved(await provider(f).read(null, { schemaVersion: 1, requestId })).requestId).toBe(requestId);
});
for (const name of ['_draft', `step_${'a'.repeat(220)}`]) test(`accepts engine-valid node identifiers: ${name.slice(0, 20)}`, async () => {
  const f = fixture(), graph = structuredClone(f.version.trigger); graph.nextAction!.name = name;
  f.db.run('UPDATE flow_version SET trigger = ? WHERE id = ?', [JSON.stringify(graph), f.version.id]);
  expect(saved(await provider(f).read(null, { ...input, selectedNodeId: name })).selectedNodeId).toBe(name);
});
