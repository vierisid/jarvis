import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { getChildRun, listChildRuns } from '../db/repos/child-run';
import { listWaitpointsByFlowRun, getWaitpoint } from '../db/repos/waitpoint';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { listWorkflowEffects, saveWorkflowEffect } from '../db/repos/workflow-effect';
import { configureWorkflowReadiness } from '../db/repos/flow-readiness';
import { AuthorityEngine } from '../../authority/engine';
import { ApprovalManager } from '../../authority/approval';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { resumeCompletedChildRuns } from './child-run-scheduler';
import { createJarvisWorkflowsStartRoute } from '../sandbox-api/routes/jarvis-workflows';
import { PieceCatalog } from './piece-catalog';
import { createRunFlowHandler } from '../runner/handler';
import { Worker } from '../queue/worker';
import { assertActionSucceeded } from '../../actions/action-outcome';

beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());
function fixture(governed = false, childTrigger: FlowTriggerNode = { name: 'trigger', type: 'EMPTY' }) {
  const target = createFlow();
  createDraftVersion({ flowId: target.id, displayName: 'Child', trigger: childTrigger });
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Parent', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'child', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-trigger', pieceVersion: '0.0.1',
      actionName: 'run_workflow', input: { flow: target.id, waitForCompletion: true } } } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: governed ? ['spawn_agent'] : [],
    overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    authorityEngine: authority, approvalManager: approvals, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  const start = () => services.workflowsStart!({ flowId: target.id, waitForCompletion: true },
    { runId: run.id, projectId: run.projectId, stepName: 'child', executionPath: [] });
  return { run, start, approvals, services, authority };
}

test('completion before the parent parks is retained, and resume claim plus job is atomic', async () => {
  const f = fixture();
  const result = await f.start();
  updateRun(result.runId!, { status: 'SUCCEEDED', finishTime: Date.now() });
  expect(resumeCompletedChildRuns()).toBe(0);
  updateRun(f.run.id, { status: 'PAUSED' });
  getWorkflowDb().run(`CREATE TEMP TRIGGER reject_resume BEFORE INSERT ON workflow_job
    WHEN json_extract(NEW.payload, '$.executionType')='RESUME' BEGIN SELECT RAISE(ABORT, 'synthetic queue failure'); END`);
  expect(() => resumeCompletedChildRuns()).toThrow('synthetic queue failure');
  expect(getWaitpoint(result.waitpointId!)!.resumedAt).toBeNull();
  getWorkflowDb().run('DROP TRIGGER reject_resume');
  expect(resumeCompletedChildRuns()).toBe(1);
  expect(resumeCompletedChildRuns()).toBe(0);
  expect(getFlowRun(f.run.id)!.status).toBe('PAUSED'); // only the worker may complete it
  updateRun(f.run.id, { status: 'RUNNING' });
  const replay = await f.start();
  expect(replay.runId).toBe(result.runId);
  expect(replay.child!.outcome).toEqual({ status: 'succeeded' });
  expect(listChildRuns(f.run.id)).toHaveLength(1);
});

test('child creation rolls back its run, queue job and waitpoint if linkage cannot commit', async () => {
  const f = fixture();
  getWorkflowDb().run(`CREATE TEMP TRIGGER reject_link BEFORE INSERT ON workflow_child_run
    BEGIN SELECT RAISE(ABORT, 'synthetic link failure'); END`);
  await expect(f.start()).rejects.toThrow('synthetic link failure');
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(1);
  expect(getWorkflowDb().query('SELECT id FROM workflow_job').all()).toHaveLength(0);
  expect(listWaitpointsByFlowRun(f.run.id)).toHaveLength(0);
  expect(listChildRuns(f.run.id)).toHaveLength(0);
});

test('a deleted child is unknown, never completed or dispatched again', async () => {
  const f = fixture();
  const result = await f.start();
  getWorkflowDb().run('DELETE FROM flow_run WHERE id=?', [result.runId!]);
  updateRun(f.run.id, { status: 'PAUSED' });
  expect(resumeCompletedChildRuns()).toBe(1);
  updateRun(f.run.id, { status: 'RUNNING' });
  const replay = await f.start();
  expect(replay.runId).toBe(result.runId);
  expect(replay.child).toMatchObject({ status: 'MISSING', outcome: { status: 'unknown' } });
  expect(listChildRuns(f.run.id)).toHaveLength(1);
});

test('cancel after approval but before nested dispatch records blocked and clears the card', async () => {
  const f = fixture(true);
  const result = await f.start();
  const id = result.approval!.approvalId;
  expect(f.approvals.approve(id, 'test')).not.toBeNull();
  expect(cancelFlowRun(f.run.id).accepted).toBe(true);
  expect(f.approvals.getRequest(id)).toMatchObject({ status: 'executed', execution_outcome: 'blocked' });
  expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'blocked', outcome: { effect: 'not_started' } });
  expect(listChildRuns(f.run.id)).toHaveLength(0);
  expect(listWaitpointsByFlowRun(f.run.id, false)).toHaveLength(0);
});

test('canceling a parent before its required child starts closes both queue jobs', async () => {
  const f = fixture();
  const result = await f.start();
  expect(cancelFlowRun(f.run.id).accepted).toBe(true);
  expect(getFlowRun(result.runId!)!.status).toBe('STOPPED');
  expect(getFlowRun(result.runId!)!.cancellation!.inFlightMayHaveCompleted).toBe(false);
  expect(getChildRun(result.child!.effectId)).toMatchObject({ parentRunId: f.run.id, childRunId: result.runId, status: 'STOPPED' });
  expect(resumeCompletedChildRuns()).toBe(0);
});

test('a stop reason is kept on the parent only, and its required child still stops with it', async () => {
  const f = fixture();
  const result = await f.start();
  expect(cancelFlowRun(f.run.id, { reason: 'The workflow was turned off, so this run was stopped.', reasonLabel: 'Workflow turned off' }).accepted).toBe(true);
  expect(getFlowRun(f.run.id)).toMatchObject({ status: 'STOPPED',
    failedStep: { name: '<lifecycle>', displayName: 'Workflow turned off', errorMessage: 'The workflow was turned off, so this run was stopped.' } });
  const child = getFlowRun(result.runId!)!;
  expect(child.status).toBe('STOPPED');
  expect(child.failedStep ?? null).toBeNull();
  expect(listWaitpointsByFlowRun(f.run.id, false)).toHaveLength(0);
});

test('malformed required-child mode is rejected before the backend runs', async () => {
  let calls = 0;
  const route = createJarvisWorkflowsStartRoute({ workflowsStart: async () => { calls++; return { runId: 'never' }; } });
  const response = await route({ req: new Request('http://localhost/v1/jarvis/workflows/start', {
    method: 'POST', body: JSON.stringify({ flowId: 'child', waitForCompletion: 'true' }),
  }), claims: {} as any, params: {} });
  expect(response.status).toBe(400);
  expect(calls).toBe(0);
});

for (const ending of ['failed', 'deleted'] as const) test(`a ${ending} parent cannot abandon required child work`, async () => {
  const f = fixture();
  const result = await f.start();
  if (ending === 'failed') updateRun(f.run.id, { status: 'FAILED', finishTime: Date.now() });
  else getWorkflowDb().run('DELETE FROM flow_run WHERE id=?', [f.run.id]);
  expect(resumeCompletedChildRuns()).toBe(0);
  expect(getFlowRun(result.runId!)!.status).toBe('STOPPED');
  if (ending === 'failed') expect(listWaitpointsByFlowRun(f.run.id, false)).toHaveLength(0);
});

/** Real dispatch/approval/outer-worker paths, with a lost engine pause upload. */
async function failedChildWithApproval(approved = false) {
  const leaf = createFlow();
  createDraftVersion({ flowId: leaf.id, displayName: 'Leaf', trigger: { name: 'trigger', type: 'EMPTY' } });
  configureWorkflowReadiness({ pieces: new PieceCatalog([{ name: '@jarvispieces/piece-jarvis-trigger',
    displayName: 'Trigger', description: '', actions: { run_workflow: { name: 'run_workflow', displayName: 'Run workflow',
      description: '', inputSchema: { fields: [
        { name: 'flow', label: 'Flow', type: 'flow_ref', required: true },
        { name: 'waitForCompletion', label: 'Wait', type: 'boolean', required: false },
      ] } } } }]) });
  const f = fixture(false, { name: 'trigger', type: 'EMPTY', nextAction: { name: 'child', type: 'PIECE', settings: {
    pieceName: '@jarvispieces/piece-jarvis-trigger', pieceVersion: '0.0.1', actionName: 'run_workflow',
    input: { flow: leaf.id, waitForCompletion: true },
  } } });
  const child = await f.start();
  updateRun(f.run.id, { status: 'PAUSED' });
  f.authority.updateConfig({ ...f.authority.getConfig(), governed_categories: ['spawn_agent'] });
  const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: {
    async execute(ctx) {
      const reply = await f.services.workflowsStart!({ flowId: leaf.id, waitForCompletion: true },
        { runId: ctx.run.id, projectId: ctx.run.projectId, stepName: 'child', executionPath: [] });
      expect(reply.approval).toBeDefined();
      if (approved) f.approvals.approve(reply.approval!.approvalId, 'test');
      throw new Error('Engine transport failed before PAUSED upload');
    },
  } }) } });
  await worker.drain();
  const failed = getFlowRun(child.runId!)!;
  expect(failed.status).toBe('FAILED');
  expect(failed.failedStep!.errorMessage).toContain('Engine transport failed');
  const effect = listWorkflowEffects(failed.id)[0]!;
  expect(effect.status).toBe('pending');
  expect(listWaitpointsByFlowRun(failed.id, false)).toHaveLength(1);
  return { ...f, child, failed, effect };
}

for (const approved of [false, true]) test(`terminal required children retire ${approved ? 'approved' : 'pending'} work before parent continuation`, async () => {
  const f = await failedChildWithApproval(approved);
  expect(resumeCompletedChildRuns()).toBe(1);
  expect(resumeCompletedChildRuns()).toBe(0);
  expect(getFlowRun(f.failed.id)).toEqual(f.failed);
  expect(f.approvals.getRequest(f.effect.approvalId!)).toMatchObject(approved
    ? { status: 'executed', execution_outcome: 'blocked' } : { status: 'denied' });
  expect(listWorkflowEffects(f.failed.id)[0]).toMatchObject({ status: 'blocked',
    outcome: { code: 'WORKFLOW_FINISHED', effect: 'not_started' } });
  expect(listWaitpointsByFlowRun(f.failed.id, false)).toHaveLength(0);
  expect(f.approvals.getPending()).toHaveLength(0);
  // The normal continuation still propagates the child's original failure.
  const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: {
    async execute() {
      const reply = await f.start();
      assertActionSucceeded(reply.child!.outcome!);
      return { steps: {}, stepsCount: 0 };
    },
  } }) } });
  await worker.drain();
  expect(getFlowRun(f.run.id)).toMatchObject({ status: 'FAILED' });
  expect(getFlowRun(f.run.id)!.failedStep!.errorMessage).toContain(f.failed.id);
  expect(listChildRuns(f.failed.id)).toHaveLength(0); // no approved leaf dispatch
  expect(resumeCompletedChildRuns()).toBe(0);
});

test('terminal child cleanup rolls back on failure and preserves dispatched effect evidence', async () => {
  const f = await failedChildWithApproval(true);
  const receipts = (['dispatching', 'unknown', 'succeeded', 'failed'] as const).map(status => ({
    ...f.effect, id: `${f.effect.id}-${status}`, route: status, status, approvalId: null, waitpointId: null,
  }));
  for (const receipt of receipts) saveWorkflowEffect(receipt);
  getWorkflowDb().run(`CREATE TEMP TRIGGER reject_cleanup BEFORE UPDATE ON approval_requests
    WHEN NEW.execution_outcome='blocked' BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END`);
  expect(() => resumeCompletedChildRuns()).toThrow('synthetic cleanup failure');
  expect(listWorkflowEffects(f.failed.id)[0]).toEqual(f.effect);
  expect(f.approvals.getRequest(f.effect.approvalId!)!.status).toBe('approved');
  expect(listWaitpointsByFlowRun(f.failed.id, false)).toHaveLength(1);
  expect(getWaitpoint(f.child.waitpointId!)!.resumedAt).toBeNull();
  getWorkflowDb().run('DROP TRIGGER reject_cleanup');
  expect(resumeCompletedChildRuns()).toBe(1);
  expect(listWorkflowEffects(f.failed.id).slice(1)).toEqual(receipts);
  expect(getFlowRun(f.failed.id)).toEqual(f.failed);
  expect(listChildRuns(f.run.id)[0]!.outcome).toMatchObject({ status: 'unknown' });
  expect(resumeCompletedChildRuns()).toBe(0);
});
