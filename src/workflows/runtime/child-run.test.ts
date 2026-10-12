import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { getChildRun, listChildRuns } from '../db/repos/child-run';
import { listWaitpointsByFlowRun, getWaitpoint } from '../db/repos/waitpoint';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { AuthorityEngine } from '../../authority/engine';
import { ApprovalManager } from '../../authority/approval';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { resumeCompletedChildRuns } from './child-run-scheduler';
import { createJarvisWorkflowsStartRoute } from '../sandbox-api/routes/jarvis-workflows';

beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());
function fixture(governed = false) {
  const target = createFlow();
  createDraftVersion({ flowId: target.id, displayName: 'Child', trigger: { name: 'trigger', type: 'EMPTY' } });
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
  return { run, start, approvals, services };
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
