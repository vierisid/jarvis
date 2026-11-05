/** #1261: the dashboard reads a run's customer onboardings and the current state of their branches. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { saveWorkflowEffect, type WorkflowEffect } from '../db/repos/workflow-effect';
import { acquireOnboarding } from '../db/repos/customer-onboarding';
import { ONBOARDING_PIECE } from '../onboarding-accounts';
import { onboardingIdentity, runOnboardingOutcomes } from './onboarding-service';
import { createWorkflowRoutes } from '../api/routes';
import { workflowEffectId } from './effect-boundary';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-onboarding-outcomes-')); initWorkflowDb(join(dir, 'fixture.db')); });
afterEach(() => { closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); });

function fixture(customers: Array<{ id?: unknown; name?: unknown }>, projectId?: string) {
  const flow = createFlow(projectId ? { projectId } : {});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Onboarding fixture', trigger: { name: 'trigger', type: 'EMPTY' } as any });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'SUCCEEDED' });
  const effects = customers.map((customer, i) => {
    const effect: WorkflowEffect = { id: workflowEffectId(run.id, `onboard-${i}`, [], 'customer-onboarding'), runId: run.id, projectId: flow.project_id, flowId: flow.id, versionId: version.id, versionDigest: 'v',
      stepName: 'onboard', executionPath: [], route: 'customer-onboarding', toolName: 'workflow_customer_onboarding', actionCategory: 'write_data', requestDigest: 'r',
      arguments: { customer }, target: {}, provenance: { piece: ONBOARDING_PIECE }, decision: 'allowed', reason: '', status: 'succeeded', approvalId: null, waitpointId: null, createdAt: Date.now() };
    saveWorkflowEffect(effect);
    return effect;
  });
  return { flow, run, effects };
}

test('each customer of a run is listed with the branch states on record now', () => {
  const f = fixture([{ id: 'customer-1', name: 'Example Customer' }, { id: 'customer-2', name: 'Second' }]);
  const lease = acquireOnboarding(onboardingIdentity(f.flow.project_id, f.flow.id, 'customer-1'), 'config', f.run.id);
  lease.store.save('clickup', { status: 'succeeded', id: 't1', url: 'https://app.clickup.com/t/t1', detail: 'created' });
  lease.store.save('drive', { status: 'unknown', detail: 'Unconfirmed write requires review; creation will not be repeated.' });
  expect(runOnboardingOutcomes(f.flow.project_id, f.run.id)).toEqual([
    { effectId: f.effects[0]!.id, customer: { id: 'customer-1', name: 'Example Customer' }, running: true, branches: {
      clickup: { status: 'succeeded', url: 'https://app.clickup.com/t/t1', detail: 'created' },
      drive: { status: 'unknown', detail: 'Unconfirmed write requires review; creation will not be repeated.' } } },
    // No record yet for the second customer: nothing to resolve.
    { effectId: f.effects[1]!.id, customer: { id: 'customer-2', name: 'Second' }, running: false, branches: {} },
  ]);
  lease.release();
  expect(runOnboardingOutcomes(f.flow.project_id, f.run.id)![0]!.running).toBe(false);
});

test('an interrupted dispatch reads as dispatching, a customer without an id is left out, and provider detail is bounded', () => {
  const f = fixture([{ id: 'customer-1' }, { name: 'No id' }]);
  const lease = acquireOnboarding(onboardingIdentity(f.flow.project_id, f.flow.id, 'customer-1'), 'config', f.run.id);
  lease.store.save('clickup', { status: 'failed', detail: 'x'.repeat(5000) });
  lease.store.save('drive', { status: 'dispatching' });
  lease.release();
  const [only, ...rest] = runOnboardingOutcomes(f.flow.project_id, f.run.id)!;
  expect(rest).toEqual([]);
  expect(only!.customer).toEqual({ id: 'customer-1', name: null });
  expect(only!.branches.drive).toEqual({ status: 'dispatching' });
  expect(only!.branches.clickup!.detail!.length).toBe(500);
});

test('the dashboard route answers for its own project only', async () => {
  const mine = fixture([{ id: 'customer-1', name: 'Example' }]);
  const theirs = fixture([{ id: 'customer-1', name: 'Theirs' }], 'proj_other_1261');
  const get = async (runId: string) => {
    const res = await createWorkflowRoutes({})['/api/workflow-runs/:runId/onboarding']!.GET!(Object.assign(new Request('http://x/'), { params: { runId } }) as any);
    return { status: res.status, body: await res.json() };
  };
  expect(await get(mine.run.id)).toEqual({ status: 200, body: { runId: mine.run.id, onboardings: [
    { effectId: mine.effects[0]!.id, customer: { id: 'customer-1', name: 'Example' }, running: false, branches: {} }] } });
  expect(await get(theirs.run.id)).toEqual({ status: 404, body: { error: 'run not found' } });
});
