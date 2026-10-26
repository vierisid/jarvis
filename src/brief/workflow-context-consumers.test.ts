// F-21's projection against the D-19 Runs and D-20 Context validators as they
// are on main, so a field, state or binding drift between them fails here.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from '../workflows/db';
import { createFlow, deleteFlow } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion, updateDraftVersion } from '../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness';
import { cancelFlowRun } from '../workflows/db/repos/run-cancellation';
import { updateRun } from '../workflows/db/repos/flow-run';
import { DefaultWorkerHandlers } from '../workflows/sandbox-api/worker-handlers';
import { SandboxRegistry } from '../workflows/sandbox-api/sandbox-registry';
import { WorkflowContext } from './workflow-context';
import * as runs from '../../ui/src/brief/workflows/runs/model';
import * as contexts from '../../ui/src/brief/workflows/context/model';

let directory: string, provider: WorkflowContext, flowId: string, versionId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f21-consumers-'));
  initWorkflowDb(join(directory, 'fixture.db')); configureWorkflowReadiness({ tool: () => null });
  provider = new WorkflowContext(getWorkflowDb(), DEFAULT_IDS.project, () => true);
  flowId = createFlow().id;
  versionId = lockVersion(createDraftVersion({ flowId, displayName: 'Fixture', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } }).id).id;
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

test('accepted run, history, worker-recorded detail and both context bases pass the D-19/D-20 validators', async () => {
  const scope = { scopeId: DEFAULT_IDS.project, flowId, versionId };
  const result = provider.start(flowId, { brief: { scopeId: scope.scopeId, versionId, requestId: 'probe' }, payload: {} });
  expect(runs.validSummary(result.run, scope)).toBe(true);
  const registry = new SandboxRegistry();
  registry.register({ sandboxId: 'probe', runId: result.run.runId, projectId: scope.scopeId, engineToken: 'fixture', expiresAt: Date.now() + 60_000, terminatedAt: null });
  await new DefaultWorkerHandlers({ registry }).updateRunProgress('probe', {
    flowRun: { id: result.run.runId, flowId, flowVersionId: versionId, projectId: scope.scopeId, status: 'SUCCEEDED' },
    step: { name: 'trigger', path: [], output: { type: 'EMPTY', status: 'SUCCEEDED', input: {}, output: { count: 4, message: '<script>fixture</script>' } } },
  });
  const page = provider.list(flowId);
  if (page.status !== 'ready') throw Error('history not ready');
  runs.validatePage(page.data, scope);
  const selection = provider.selection(flowId, versionId, result.run.runId);
  runs.validateDetail(selection.run!, scope, result.run.runId, versionId);
  expect(selection.run!.steps[0]!.status).toBe('succeeded');
  contexts.validateContext(selection.context, scope, { basis: 'recorded', runId: result.run.runId, versionId });
  contexts.validateContext(provider.selection(flowId, versionId).context, scope, { basis: 'configured' });
  expect(JSON.stringify(selection)).not.toContain('<script>');
  deleteFlow(flowId);
  expect(provider.request(flowId, 'probe')).toEqual(result);
});

test('stopped, failed and uncertain runs use only states the Runs view accepts', () => {
  const scope = { scopeId: DEFAULT_IDS.project, flowId, versionId };
  const start = (requestId: string) => provider.start(flowId, { brief: { scopeId: scope.scopeId, versionId, requestId }, payload: {} }).run.runId;
  const inFlight = start('in-flight'); updateRun(inFlight, { status: 'RUNNING' }); cancelFlowRun(inFlight);
  const failed = start('failed'); updateRun(failed, { status: 'TIMEOUT' });
  const page = provider.list(flowId);
  if (page.status !== 'ready') throw Error('history not ready');
  runs.validatePage(page.data, scope);
  for (const id of [inFlight, failed]) runs.validateDetail(provider.detail(flowId, id), scope, id, versionId);
  expect(provider.detail(flowId, inFlight).status).toBe('uncertain');
});

test('the mixed-source context cap holds at the D-20 bound', () => {
  for (const count of [199, 200]) {
    const v = createDraftVersion({ flowId, displayName: 'Bounds', trigger: { name: 'trigger', type: 'EMPTY', settings: { input: { auth: 'inline-fixture' } } } });
    updateDraftVersion(v.id, { connectionIds: Array.from({ length: count }, (_, i) => `ref-${i}`) }); lockVersion(v.id);
    const scope = { scopeId: DEFAULT_IDS.project, flowId, versionId: v.id };
    if (count === 200) expect(() => provider.selection(flowId, v.id)).toThrow('context_capacity');
    else contexts.validateContext(provider.selection(flowId, v.id).context, scope, { basis: 'configured' });
  }
});
