/** Operator resolution of an uncertain cross-run identity (HubSpot contact,
 * notification idempotencyKey): mark_done or release, audited and race-safe. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { saveWorkflowEffect, type WorkflowEffect } from '../db/repos/workflow-effect';
import { claimIdentity, completeIdentity, IdentityUnresolvedError } from '../db/repos/effect-identity';
import { decideRunRecovery, getRunRecovery } from './recovery';
import { workflowEffectId } from './effect-boundary';
import { createWorkflowRoutes } from '../api/routes';
import { createManageWorkflowTool } from '../../actions/tools/manage-workflow';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-identity-')); initWorkflowDb(join(dir, 'fixture.db')); });
afterEach(() => { closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); });

const IDENTITY = 'contact-identity-digest';
function fixture(effectStatus: Partial<WorkflowEffect> = { status: 'unknown',
  outcome: { status: 'unknown', code: 'DISPATCH_UNCERTAIN', message: 'lost reply', effect: 'may_have_occurred' } }, identity = IDENTITY) {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Identity fixture', trigger: { name: 'trigger', type: 'EMPTY' } as any });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const id = workflowEffectId(run.id, 'upsert', [], 'piece-dispatch');
  const effect: WorkflowEffect = { id, runId: run.id, projectId: flow.project_id, flowId: flow.id, versionId: version.id, versionDigest: 'v',
    stepName: 'upsert', executionPath: [], route: 'piece-dispatch', toolName: 'hubspot', actionCategory: 'write_data', requestDigest: 'r',
    arguments: {}, target: {}, provenance: {}, decision: 'allowed', reason: '', status: 'dispatching', approvalId: null, waitpointId: null, createdAt: Date.now() };
  saveWorkflowEffect(effect);
  expect(claimIdentity(identity, id, false)).toBe('claimed');
  saveWorkflowEffect({ ...effect, ...effectStatus });
  updateRun(run.id, { status: 'FAILED' });
  const choice = (action: 'mark_done' | 'release', requestId = 'request_0001') =>
    ({ action, requestId, revision: getRunRecovery(run.id)!.revision, effectId: id, note: 'Checked HubSpot' });
  return { flow, run, effectId: id, choice };
}
const row = () => getWorkflowDb().query('SELECT owner, completed FROM workflow_effect_identity WHERE identity=?').get(IDENTITY);

test('the uncertain identity fences a later item until resolved, and the projection says which effect holds it', () => {
  const f = fixture();
  expect(() => claimIdentity(IDENTITY, 'wfe_later', false)).toThrow(IdentityUnresolvedError);
  expect(() => claimIdentity(IDENTITY, 'wfe_later', false)).toThrow('mark_done if it happened, release if it did not');
  expect(getRunRecovery(f.run.id)!.effects).toMatchObject([{ effectId: f.effectId, status: 'unknown', identityUnresolved: true }]);
});

test('release frees the identity: the next item claims it and writes once', async () => {
  const f = fixture();
  const receipt = await decideRunRecovery(f.run.id, f.choice('release'), { via: 'dashboard' });
  expect(receipt).toMatchObject({ action: 'release', effectId: f.effectId, actor: 'user', via: 'dashboard',
    evidence: { outcome: 'identity_released', reason: 'Checked HubSpot' } });
  expect(typeof receipt.createdAt).toBe('number');
  expect(row()).toBeNull();
  expect(claimIdentity(IDENTITY, 'wfe_later', true)).toBe('claimed');
  expect(getRunRecovery(f.run.id)!.effects[0]!.identityUnresolved).toBeUndefined();
  expect(getRunRecovery(f.run.id)!.receipts).toEqual([receipt]);
});

test('mark_done completes the identity: a once key dedupes, a contact can be updated again', async () => {
  const f = fixture();
  await decideRunRecovery(f.run.id, f.choice('mark_done'));
  expect(row()).toEqual({ owner: f.effectId, completed: 1 });
  expect(claimIdentity(IDENTITY, 'wfe_later', true)).toBe('duplicate');
  expect(claimIdentity(IDENTITY, 'wfe_later', false)).toBe('claimed');
});

test('a repeated requestId returns the same receipt; a second resolution is refused', async () => {
  const f = fixture();
  const c = f.choice('release');
  const first = await decideRunRecovery(f.run.id, c);
  expect(await decideRunRecovery(f.run.id, c)).toEqual(first);
  await expect(decideRunRecovery(f.run.id, f.choice('mark_done', 'request_0002'))).rejects.toThrow('no unresolved identity');
});

for (const [name, state, message] of [
  ['still dispatching', { status: 'dispatching' }, 'still dispatching'],
  ['completed', { status: 'succeeded', result: { id: '1' } }, 'completed'],
  ['not started', { status: 'blocked', outcome: { status: 'blocked', code: 'X', message: 'refused', effect: 'not_started' } }, 'did not start'],
] as const) test(`refuses an identity whose effect is ${name}`, async () => {
  const f = fixture(state as Partial<WorkflowEffect>);
  for (const action of ['mark_done', 'release'] as const)
    await expect(decideRunRecovery(f.run.id, f.choice(action))).rejects.toMatchObject({ status: 409, message: expect.stringContaining(message) });
  expect(row()).toEqual({ owner: f.effectId, completed: 0 });
  expect(getRunRecovery(f.run.id)!.receipts).toEqual([]);
});

test('a completed identity cannot be resolved again', async () => {
  const f = fixture();
  completeIdentity(IDENTITY, f.effectId);
  await expect(decideRunRecovery(f.run.id, f.choice('release'))).rejects.toMatchObject({ status: 409 });
  expect(row()).toEqual({ owner: f.effectId, completed: 1 });
});

test('a still running run cannot be resolved', async () => {
  const f = fixture();
  const choice = f.choice('release');
  updateRun(f.run.id, { status: 'RUNNING' });
  await expect(decideRunRecovery(f.run.id, choice)).rejects.toMatchObject({ status: 409 });
  expect(row()).toEqual({ owner: f.effectId, completed: 0 });
});

test('concurrent mark_done and release: exactly one applies', async () => {
  const f = fixture();
  const results = await Promise.allSettled([decideRunRecovery(f.run.id, f.choice('mark_done')), decideRunRecovery(f.run.id, f.choice('release', 'request_0002'))]);
  expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(getRunRecovery(f.run.id)!.receipts).toHaveLength(1);
  const done = results[0]!.status === 'fulfilled';
  expect(row()).toEqual(done ? { owner: f.effectId, completed: 1 } : null);
});

test('route: scoped to the run, effect-scoped, validated and audited', async () => {
  const f = fixture();
  const route = (routes: ReturnType<typeof createWorkflowRoutes>, runId: string, effectId: string, body: unknown) =>
    routes['/api/workflow-runs/:runId/effects/:effectId/identity']!.POST!(Object.assign(
      new Request('http://fixture.test/', { method: 'POST', body: JSON.stringify(body) }), { params: { runId, effectId } }) as any);
  const { action: _a, effectId: _e, ...body } = f.choice('release');
  const routes = createWorkflowRoutes();
  expect((await route(routes, f.run.id, f.effectId, { ...body, resolution: 'execute' })).status).toBe(400);
  // Another project's caller cannot see or resolve it.
  expect((await route(createWorkflowRoutes({ callerProjectId: () => 'proj_other' }), f.run.id, f.effectId, { ...body, resolution: 'release' })).status).toBe(404);
  expect(row()).toEqual({ owner: f.effectId, completed: 0 });
  // An effect of another run is not this run's.
  const other = fixture(undefined, 'another-contact');
  expect((await route(routes, f.run.id, other.effectId, { ...body, resolution: 'release' })).status).toBe(404);
  const response = await route(routes, f.run.id, f.effectId, { ...body, resolution: 'release' });
  expect(response.status).toBe(200);
  expect(((await response.json()) as any).receipt).toMatchObject({ action: 'release', via: 'dashboard', actor: 'user' });
  expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM workflow_effect_identity WHERE owner=?').get(f.effectId)).toEqual({ n: 0 });
});

test('manage_workflow resolve_effect: always asks the person, project scoped, records the receipt', async () => {
  const f = fixture();
  const tool = createManageWorkflowTool();
  expect(tool.authorityGate?.({ action: 'resolve_effect', run_id: f.run.id, effect_id: f.effectId, resolution: 'mark_done' }))
    .toMatchObject({ actionCategory: 'write_data', confirm: 'always', intent: expect.stringContaining('Mark done') });
  await expect(createManageWorkflowTool({ callerProjectId: () => 'proj_other' }).execute({ action: 'resolve_effect', run_id: f.run.id, effect_id: f.effectId, resolution: 'release' }))
    .rejects.toThrow('run not found');
  await expect(tool.execute({ action: 'resolve_effect', run_id: f.run.id, effect_id: f.effectId, resolution: 'maybe' })).rejects.toThrow('mark_done or release');
  const got = await tool.execute({ action: 'get_run', run_id: f.run.id }) as string;
  expect(got).toContain('"identityUnresolved":true');
  const raw = await tool.execute({ action: 'resolve_effect', run_id: f.run.id, effect_id: f.effectId, resolution: 'mark_done', note: 'User saw the contact in HubSpot' }) as string;
  expect(raw).toContain('"via":"manage_workflow"'); expect(raw).toContain('identity_marked_done');
  expect(row()).toEqual({ owner: f.effectId, completed: 1 });
});
