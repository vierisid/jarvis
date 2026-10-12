/** Exercise the actual staged D-19/D-20 validators without importing their UI
 * stack into F-21. Requires these Git objects (git fetch origin). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strict as assert } from 'node:assert';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../src/workflows/db';
import { createFlow } from '../src/workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../src/workflows/db/repos/flow-version';
import { updateRun } from '../src/workflows/db/repos/flow-run';
import { configureWorkflowReadiness } from '../src/workflows/db/repos/flow-readiness';
import { WorkflowContext } from '../src/brief/workflow-context';
const sources = [
  ['runs', 'dbce047b453ff8309cd2c3f3195922bfe42d051c', 'ui/src/brief/workflows/runs/model.ts'],
  ['context', '9c174b760105b41fecec5df5403f0edb1dad19fd', 'ui/src/brief/workflows/context/model.ts'],
] as const;
const directory = mkdtempSync(join(tmpdir(), 'f21-consumers-'));
try {
  for (const [name, revision, path] of sources) writeFileSync(join(directory, `${name}.ts`), execFileSync('git', ['show', `${revision}:${path}`]));
  const runs = await import(pathToFileURL(join(directory, 'runs.ts')).href);
  const contexts = await import(pathToFileURL(join(directory, 'context.ts')).href);
  initWorkflowDb(join(directory, 'fixture.db')); configureWorkflowReadiness({ tool: () => null });
  const provider = new WorkflowContext(getWorkflowDb(), DEFAULT_IDS.project, () => true), flowId = createFlow().id;
  const versionId = lockVersion(createDraftVersion({ flowId, displayName: 'Fixture', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } }).id).id;
  const scope = { scopeId: DEFAULT_IDS.project, flowId, versionId };
  const result = provider.start(flowId, { brief: { scopeId: scope.scopeId, versionId, requestId: 'probe' }, payload: {} });
  assert(runs.validSummary(result.run, scope));
  updateRun(result.run.runId, { status: 'SUCCEEDED', steps: { trigger: { status: 'SUCCEEDED', input: {}, output: { count: 4, message: '<script>fixture</script>' } } } });
  const page = provider.list(flowId); assert(page.status === 'ready'); runs.validatePage(page.data, scope);
  const selection = provider.selection(flowId, versionId, result.run.runId);
  runs.validateDetail(selection.run, scope, result.run.runId, versionId);
  contexts.validateContext(selection.context, scope, { basis: 'recorded', runId: result.run.runId, versionId });
  contexts.validateContext(provider.selection(flowId, versionId).context, scope, { basis: 'configured' });
  assert(!JSON.stringify(selection).includes('<script>'));
  assert.equal(provider.request(flowId, 'probe').run.runId, result.run.runId);
  console.log(JSON.stringify({ status: 'passed', sources, checks: ['accepted run', 'history', 'recorded detail', 'recorded context', 'configured context', 'redaction', 'request recovery'], productionHostBound: false }, null, 2));
} finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
