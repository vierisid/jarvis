import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, getFlowVersion, setSampleDataEntry, updateDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, ensureRunExecutionConfig, getFlowRun, updateRun } from '../db/repos/flow-run';
import { ToolRegistry } from '../../actions/tools/registry';
import { desktopListWindowsTool, desktopScreenshotTool } from '../../actions/tools/desktop';
import { getSidecarManager, setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { getRunMachineBinding } from '../db/repos/run-machine-binding';
import { withWorkflowMachineBinding } from './machine-binding';
import { resolveToolTarget } from '../../actions/tools/sidecar-route';
import { isNoLocalTools, setNoLocalTools } from '../../actions/tools/local-tools-guard';
import { SidecarManager } from '../../sidecar/manager';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxApi } from '../sandbox-api/server';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildAllJarvisPieces } from '../runner/engine-runtime/build-pieces';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { createRunFlowHandler } from '../runner/handler';
import { Worker } from '../queue/worker';
import { enqueue } from '../db/repos/job-queue';
import { resumeResolvedWorkflowEffects } from './effect-approval-scheduler';
import { createWorkflowRoutes } from '../api/routes';

const originalManager = getSidecarManager();
const originalNoLocal = isNoLocalTools();
beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => { setSidecarManagerRef(originalManager!); setNoLocalTools(originalNoLocal); closeWorkflowDb(); });

function fixture() {
  const machines = ['a', 'b'].map(id => ({ id, name: `Computer ${id}`, connected: true,
    capabilities: ['desktop', 'screenshot', 'filesystem'], session: `session-${id}` }));
  const calls: string[] = [];
  const manager = { listSidecars: () => machines,
    getConnectionSessionId: (id: string) => machines.find(s => s.id === id && s.connected)?.session ?? null,
    dispatchRPC: async (id: string) => { calls.push(id); return '[]'; },
  };
  setSidecarManagerRef(manager as any);
  const flow = createFlow({});
  const action = (name: string, nextAction?: any): any => ({ name, type: 'PIECE', settings: {
    pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke', input: {},
  }, ...(nextAction ? { nextAction } : {}) });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Machine binding',
    trigger: { name: 'trigger', type: 'EMPTY', nextAction: action('first', action('second', action('third'))) } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const registry = new ToolRegistry();
  registry.register(desktopListWindowsTool);
  registry.register(desktopScreenshotTool);
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const options = { toolRegistry: registry, credentialResolver: new CredentialResolver(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any,
    authorityEngine: authority, auditTrail: new AuditTrail(), emergencyController: new EmergencyController(),
    approvalManager: approvals, eventBuffer: new WorkflowEventBuffer() };
  const backend = () => buildSandboxServiceBackends(options);
  const invoke = (stepName: string, params = {}, toolName = 'desktop_list_windows', runId = run.id) =>
    backend().toolsInvoke!({ toolName, params }, { runId, projectId: DEFAULT_IDS.project, stepName, executionPath: [] });
  return { machines, manager, calls, run, flow, version, registry, authority, approvals, invoke, backend, options };
}

test('disconnect between steps blocks desktop dispatch instead of selecting another computer', async () => {
  const f = fixture();
  await f.invoke('first');
  f.machines[0]!.connected = false;
  await expect(f.invoke('second')).rejects.toThrow(/bound|binding|offline/i);
  expect(f.calls).toEqual(['a']);
  expect(getFlowRun(f.run.id)?.machineBinding).toMatchObject({ sidecarId: 'a', sessionId: 'session-a', selectedBy: 'implicit' });
  expect(listWorkflowEffects(f.run.id)).toMatchObject([
    { status: 'succeeded' }, { status: 'blocked', outcome: { effect: 'not_started', code: 'WORKFLOW_MACHINE_OFFLINE' } },
  ]);
});

test('reconnecting the same machine cannot reuse approval for its old session', async () => {
  const f = fixture();
  f.authority.setGovernedCategories(['read_data']);
  const pending = await f.invoke('first');
  f.machines[0]!.session = 'new-session-a';
  f.approvals.approve(pending.approval!.approvalId, 'test');
  await expect(f.invoke('first')).rejects.toThrow(/session/i);
  expect(f.calls).toEqual([]);
  expect(listWorkflowEffects(f.run.id)[0]?.outcome).toMatchObject({ code: 'WORKFLOW_SESSION_CHANGED', effect: 'not_started' });
});

test('a missing later capability cannot move a run to another computer', async () => {
  const f = fixture();
  f.machines[0]!.capabilities = ['desktop'];
  await f.invoke('first');
  await expect(f.invoke('second', {}, 'desktop_screenshot')).rejects.toThrow(/capability|screenshot/i);
  expect(f.calls).toEqual(['a']);
});

test('an explicit different target cannot silently retarget an existing run', async () => {
  const f = fixture();
  await f.invoke('first');
  await expect(f.invoke('second', { target: 'b' })).rejects.toThrow(/retarget|bound|binding/i);
  expect(f.calls).toEqual(['a']);
  expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('succeeded');
});

test('a deliberate first target pins later unbound steps and canonicalizes its name', async () => {
  const f = fixture();
  await f.invoke('first', { target: 'Computer b' });
  f.machines.reverse();
  await f.invoke('second');
  expect(f.calls).toEqual(['b', 'b']);
  expect(getRunMachineBinding(f.run.id)).toMatchObject({ sidecarId: 'b', selectedBy: 'explicit' });
});

test('ambiguous names are rejected without selecting or dispatching', async () => {
  const f = fixture();
  await expect(f.invoke('first', { target: 'Computer' })).rejects.toThrow(/ambiguous/);
  expect(getRunMachineBinding(f.run.id)).toBeNull();
  expect(f.calls).toEqual([]);
});

test('revocation cannot reinterpret a frozen ID as another machine name', async () => {
  const f = fixture();
  await f.invoke('first');
  f.machines.shift(); f.machines[0]!.name = 'a';
  await expect(f.invoke('second')).rejects.toThrow(/offline|enrolled/);
  expect(f.calls).toEqual(['a']);
});

test('concurrent runs keep independent bindings and repeated steps retain their receipts', async () => {
  const f = fixture();
  const other = createFlowRun({ flowId: f.flow.id, flowVersionId: f.version.id, status: 'RUNNING' });
  await Promise.all([f.invoke('first', { target: 'a' }), f.invoke('first', { target: 'b' }, 'desktop_list_windows', other.id)]);
  await f.invoke('second', {}, 'desktop_list_windows', other.id);
  f.machines[0]!.connected = false;
  await f.invoke('first', { target: 'a' }); // Historical result, no new dispatch.
  await expect(f.invoke('second')).rejects.toThrow(/offline/);
  expect(f.calls).toEqual(['a', 'b', 'b']);
  expect(getRunMachineBinding(other.id)?.sidecarId).toBe('b');
});

test('concurrent first steps cannot establish two bindings for one run', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.invoke('first', { target: 'a' }), f.invoke('second', { target: 'b' })]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(f.calls).toEqual(['a']);
  expect(getRunMachineBinding(f.run.id)?.sidecarId).toBe('a');
});

test('a slow committed result is retained after its machine disconnects', async () => {
  const f = fixture();
  let finish!: (value: string) => void;
  f.manager.dispatchRPC = id => { f.calls.push(id); return new Promise(resolve => { finish = resolve; }); };
  const first = f.invoke('first');
  f.machines[0]!.connected = false;
  finish('committed on a'); await first;
  await expect(f.invoke('second')).rejects.toThrow(/offline/);
  expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'succeeded', result: 'committed on a' });
  expect(f.calls).toEqual(['a']);
});

test('local selection remains local when a sidecar connects later', async () => {
  const f = fixture();
  f.machines.forEach(s => { s.connected = false; });
  const ctx = { runId: f.run.id, projectId: DEFAULT_IDS.project };
  expect(withWorkflowMachineBinding(ctx, () => resolveToolTarget(undefined, 'desktop', 'snapshot'))).toBeNull();
  f.machines[0]!.connected = true;
  expect(withWorkflowMachineBinding(ctx, () => resolveToolTarget(undefined, 'desktop', 'snapshot'))).toBeNull();
  expect(getRunMachineBinding(f.run.id)?.sidecarId).toBeNull();
});

test('hosted runs with no capable sidecar fail before any local fallback', async () => {
  const f = fixture(); setNoLocalTools(true);
  f.machines.forEach(s => { s.connected = false; });
  await expect(f.invoke('first')).rejects.toThrow(/local execution is disabled/);
  expect(f.calls).toEqual([]);
  expect(getRunMachineBinding(f.run.id)).toBeNull();
});

test('old machine receipts cannot acquire a replacement session after upgrade', async () => {
  const f = fixture();
  await f.invoke('first');
  getWorkflowDb().run('DELETE FROM workflow_run_machine_binding WHERE run_id=?', [f.run.id]);
  await expect(f.invoke('second')).rejects.toThrow(/no verifiable machine/);
  expect(f.calls).toEqual(['a']);
});

test('UI previews cannot carry old sample assumptions to a newly selected machine', async () => {
  const f = fixture();
  f.version.trigger.nextAction!.nextAction!.settings!.input = { params: { pid: '{{ first.pid }}' } };
  updateDraftVersion(f.version.id, { trigger: f.version.trigger });
  ensureRunExecutionConfig(f.run.id, { stepNameToTest: 'second', sampleData: { first: { element_id: 17, pid: 1234 } } });
  await expect(f.invoke('second', { target: 'b' })).rejects.toThrow(/test outputs.*provenance/);
  withWorkflowMachineBinding({ runId: f.run.id, projectId: DEFAULT_IDS.project }, () => resolveToolTarget('b', 'filesystem', 'read_file'));
  await expect(f.invoke('second', { target: 'b' })).rejects.toThrow(/test outputs.*provenance/);
  expect(f.calls).toEqual([]);
  expect(f.approvals.getPending()).toHaveLength(0);
});

for (const input of [
  { params: {} },
  { params: { title: 'first.pid' } },
  { params: { title: '{{ "first.pid" }}' } },
  { params: { pid: '{{ 100 + 23 }}' } },
]) test(`literal UI previews ignore unrelated samples: ${JSON.stringify(input)}`, async () => {
  const f = fixture();
  f.version.trigger.nextAction!.nextAction!.settings!.input = input;
  updateDraftVersion(f.version.id, { trigger: f.version.trigger });
  ensureRunExecutionConfig(f.run.id, { stepNameToTest: 'second', sampleData: { first: { pid: 123 }, second: { old: true } } });
  await f.invoke('second');
  expect(f.calls).toEqual(['a']);
});

test('a literal preview input override replaces the saved UI dependency', async () => {
  const f = fixture();
  f.version.trigger.nextAction!.nextAction!.settings!.input = { params: { pid: '{{ first.pid }}' } };
  updateDraftVersion(f.version.id, { trigger: f.version.trigger });
  ensureRunExecutionConfig(f.run.id, { stepNameToTest: 'second', sampleData: { first: { pid: 123 } },
    sampleInputOverride: { second: { toolName: 'desktop_list_windows', params: {} } } });
  await f.invoke('second');
  expect(f.calls).toEqual(['a']);
});

for (const source of ['first.pid', 'first[third.key]', 'true ? first.pid : 0',
  'flattenNestedKeys(first.windows, ["pid"])', '({ value: [first?.pid] })']) {
  test(`preview overrides cannot reuse unqualified samples: ${source}`, async () => {
    const f = fixture();
    ensureRunExecutionConfig(f.run.id, { stepNameToTest: 'second', sampleData: { first: { pid: 123 }, third: { key: 'pid' } },
      sampleInputOverride: { second: { params: { nested: [{ value: `{{ ${source} }}` }] } } } });
    await expect(f.invoke('second')).rejects.toThrow(/test outputs.*provenance/);
    expect(f.calls).toEqual([]);
  });
}

test('a preview uses its current trigger payload rather than the trigger sample', async () => {
  const f = fixture();
  f.version.trigger.nextAction!.nextAction!.settings!.input = { params: { target: '{{ trigger.target }}' } };
  updateDraftVersion(f.version.id, { trigger: f.version.trigger });
  ensureRunExecutionConfig(f.run.id, { stepNameToTest: 'second', sampleData: { trigger: { target: 'b' } } });
  await f.invoke('second', { target: 'a' });
  expect(f.calls).toEqual(['a']);
});

for (const [previewStep, source] of [['second', 'first.windows'], ['second', 'trigger.windows'], ['loop', 'first.windows']]) test(`loop preview inputs retain sample provenance: ${previewStep} / ${source}`, async () => {
  const f = fixture();
  const inner = f.version.trigger.nextAction!.nextAction!;
  inner.settings!.input = { params: { pid: '{{ loop.item.pid }}' } };
  f.version.trigger.nextAction!.nextAction = { name: 'loop', type: 'LOOP_ON_ITEMS',
    settings: { items: `{{ ${source} }}` }, firstLoopAction: inner };
  updateDraftVersion(f.version.id, { trigger: f.version.trigger });
  ensureRunExecutionConfig(f.run.id, { stepNameToTest: previewStep, sampleData: {
    first: { windows: [{ pid: 123 }] }, trigger: { windows: [{ pid: 456 }] },
  } });
  await expect(f.invoke('second')).rejects.toThrow(/test outputs.*provenance/);
  expect(f.calls).toEqual([]);
});

test('a router preview checks the input of the child that actually dispatches', async () => {
  const f = fixture();
  const inner = f.version.trigger.nextAction!.nextAction!;
  inner.settings!.input = { params: { pid: '{{ first.pid }}' } };
  f.version.trigger.nextAction!.nextAction = { name: 'router', type: 'ROUTER', settings: {}, children: [inner] };
  updateDraftVersion(f.version.id, { trigger: f.version.trigger });
  ensureRunExecutionConfig(f.run.id, { stepNameToTest: 'router', sampleData: { first: { pid: 123 } } });
  await expect(f.invoke('second')).rejects.toThrow(/test outputs.*provenance/);
  expect(f.calls).toEqual([]);
});

test('API previews can repeat after auto-capture and with unrelated saved outputs', async () => {
  const f = fixture();
  const step: any = { name: 'first', type: 'PIECE', settings: {
    pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke',
    input: { toolName: 'desktop_list_windows', params: {} },
  } };
  updateDraftVersion(f.version.id, { trigger: { name: 'trigger', type: 'EMPTY', nextAction: step } });
  const routes = createWorkflowRoutes();
  const api = new SandboxApi({ services: f.backend() }); await api.start({ port: 0 });
  const bundle = await buildEngineBundle(); await buildAllJarvisPieces();
  const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
  const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }) }) } });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt === 2) setSampleDataEntry(f.version.id, 'trigger', { unrelated: 'business data', target: 'b' });
      if (attempt === 3) {
        step.settings.input.params = { target: '{{ trigger.target }}' };
        updateDraftVersion(f.version.id, { trigger: { name: 'trigger', type: 'EMPTY', nextAction: step } });
      }
      const req = Object.assign(new Request(`http://localhost/api/workflows/${f.flow.id}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepNameToTest: 'first', environment: 'TESTING', payload: { target: 'a' } }),
      }), { params: { id: f.flow.id } });
      const response = await routes['/api/workflows/:id/run']!.POST!(req);
      expect(response.status).toBe(202);
      const run = await response.json() as { id: string };
      await worker.drain();
      expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
      expect(listWorkflowEffects(run.id)[0]?.status).toBe('succeeded');
      expect(getFlowVersion(f.version.id)?.sampleData?.first).toBeDefined();
    }
    expect(f.calls).toEqual(['a', 'a', 'a', 'a']);
    // The same real API/engine path must still refuse an input that consumes
    // the earlier step's captured output in a new run.
    step.nextAction = { ...step, name: 'second', settings: { ...step.settings,
      input: { toolName: 'desktop_list_windows', params: { target: '{{ first.result }}' } },
    } };
    updateDraftVersion(f.version.id, { trigger: { name: 'trigger', type: 'EMPTY', nextAction: step } });
    const req = Object.assign(new Request(`http://localhost/api/workflows/${f.flow.id}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepNameToTest: 'second', environment: 'TESTING' }),
    }), { params: { id: f.flow.id } });
    const response = await routes['/api/workflows/:id/run']!.POST!(req);
    expect(response.status).toBe(202);
    const run = await response.json() as { id: string };
    await worker.drain();
    expect(getFlowRun(run.id)?.status).toBe('FAILED');
    expect(getFlowRun(run.id)?.failedStep?.errorMessage).toContain('provenance');
    expect(f.calls).toHaveLength(4);
  } finally { await runtime.shutdown(); await api.stop(); }
}, 60_000);

test('a pause on the same connection retains the binding and fresh runs can choose a new target', async () => {
  const f = fixture();
  await f.invoke('first');
  const binding = getRunMachineBinding(f.run.id);
  updateRun(f.run.id, { status: 'PAUSED' }); updateRun(f.run.id, { status: 'RUNNING' });
  await f.invoke('second');
  expect(getRunMachineBinding(f.run.id)).toEqual(binding);
  const replacement = createFlowRun({ flowId: f.flow.id, flowVersionId: f.version.id, status: 'RUNNING' });
  f.authority.setGovernedCategories(['read_data']);
  const pending = await f.invoke('first', { target: 'b' }, 'desktop_list_windows', replacement.id);
  expect(pending.approval).toBeDefined();
  expect(f.calls).toEqual(['a', 'a']);
  f.approvals.approve(pending.approval!.approvalId, 'new target reviewed');
  await f.invoke('first', { target: 'b' }, 'desktop_list_windows', replacement.id);
  expect(f.calls).toEqual(['a', 'a', 'b']);
});

test('a fresh process recovers the bound machine and blocks a different connected computer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-binding-restart-'));
  const dbPath = join(dir, 'workflow.db');
  closeWorkflowDb(); initWorkflowDb(dbPath);
  try {
    const f = fixture(); await f.invoke('first');
    closeWorkflowDb();
    const child = Bun.spawn([process.execPath, '-e', `
      import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from './src/workflows/db';
      import { getFlowRun } from './src/workflows/db/repos/flow-run';
      import { setSidecarManagerRef, resolveToolTarget } from './src/actions/tools/sidecar-route';
      import { withWorkflowMachineBinding } from './src/workflows/runtime/machine-binding';
      initWorkflowDb(${JSON.stringify(dbPath)});
      setSidecarManagerRef({ listSidecars: () => [{id:'b',name:'B',connected:true,capabilities:['desktop']}], getConnectionSessionId: () => 'new-b' });
      try { withWorkflowMachineBinding({runId:${JSON.stringify(f.run.id)},projectId:DEFAULT_IDS.project}, () => resolveToolTarget(undefined,'desktop','snapshot')); process.exitCode=2; }
      catch (e) { console.log('BINDING_RESULT='+JSON.stringify({binding:getFlowRun(${JSON.stringify(f.run.id)}).machineBinding, outcome:e.outcome})); }
      finally { closeWorkflowDb(); }
    `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe('');
    const result = JSON.parse(output.split('BINDING_RESULT=')[1]!.trim());
    expect(result).toMatchObject({ binding: { sidecarId: 'a', sessionId: 'session-a' },
      outcome: { status: 'blocked', code: 'WORKFLOW_MACHINE_OFFLINE', effect: 'not_started' } });
  } finally { closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); }
});

test('the real manager fences RPC and notification sends by the exact socket generation', async () => {
  const f = fixture();
  const manager = new SidecarManager(tmpdir());
  manager.listSidecars = () => f.machines as any;
  const sent: string[] = [];
  const socket = (id: string) => ({ send: (raw: string) => {
    const request = JSON.parse(raw); sent.push(id);
    queueMicrotask(() => (manager as any).rpcTracker.resolve(request.id, 'done'));
  }, close: () => {}, ping: () => {} }) as any;
  setSidecarManagerRef(manager);
  const ctx = { runId: f.run.id, projectId: DEFAULT_IDS.project };
  try {
    manager.handleSidecarConnect(socket('a'), 'a');
    manager.handleSidecarConnect(socket('b'), 'b');
    const original = manager.getConnectionSessionId('a');
    expect(original).toBeTruthy();
    await withWorkflowMachineBinding(ctx, () => manager.dispatchRPC('a', 'list_windows'));
    manager.handleSidecarDisconnect('a');
    await expect(withWorkflowMachineBinding(ctx, () => manager.dispatchRPC('b', 'click_element'))).rejects.toThrow(/retarget/);
    manager.handleSidecarConnect(socket('a'), 'a');
    expect(manager.getConnectionSessionId('a')).not.toBe(original);
    await expect(withWorkflowMachineBinding(ctx, () => manager.dispatchRPC('a', 'click_element'))).rejects.toThrow(/session/);
    expect(() => withWorkflowMachineBinding(ctx, () => manager.dispatchNotify('a', 'click_element'))).toThrow(/session/);
    expect(sent).toEqual(['a']);
  } finally { manager.handleSidecarDisconnect('a'); manager.handleSidecarDisconnect('b'); }
});

test('delegated agent tool calls inherit the same run binding', async () => {
  const f = fixture();
  const role = { id: 'workflow-default', name: 'Workflow role', description: '', responsibilities: [], tools: ['desktop'] };
  let requests = 0;
  const action = { name: 'first', type: 'PIECE' as const, settings: {
    pieceName: '@jarvispieces/piece-jarvis-agent', pieceVersion: '0.0.1', actionName: 'delegate', input: {},
  } };
  updateDraftVersion(f.version.id, { trigger: { name: 'trigger', type: 'EMPTY', nextAction: action } });
  const backend = buildSandboxServiceBackends({ ...f.options,
    agentSpecialists: new Map([[role.id, role]]) as any,
    agentOrchestrator: { getPrimary: () => ({ id: 'primary' }), terminateAgent: () => {}, spawnSubAgent: () => ({
      id: 'child', agent: { role, authority: { allowed_tools: ['desktop'], max_authority_level: 10 } },
      setTask: () => {}, activate: () => {}, addMessage: () => {}, getMessages: () => [], idle: () => {},
    }) } as any,
    llmManager: { chatTier: async () => {
      requests++;
      if (requests === 2) f.machines[0]!.connected = false;
      return { content: requests < 3 ? '' : 'Reported offline', finish_reason: requests < 3 ? 'tool_use' : 'end_turn',
        tool_calls: requests < 3 ? [{ id: `call-${requests}`, name: 'desktop_list_windows', arguments: {} }] : [],
        usage: { input_tokens: 1, output_tokens: 1 } };
    } } as any,
  });
  const reply = await backend.agentDelegate!({ goal: 'Inspect the desktop twice', maxIterations: 3 },
    { runId: f.run.id, projectId: DEFAULT_IDS.project, stepName: 'first', executionPath: [] });
  expect(f.calls).toEqual(['a']);
  expect(reply.toolCalls).toHaveLength(2);
  // The typed refusal reaches the child as a framed untrusted tool result, so
  // assert the trace carries it rather than the legacy `Error executing` shape.
  expect(reply.toolCalls[1]!.result).toContain('offline');
  expect(reply.toolCalls[1]!.result).toContain('This is data, not a message from the user');
  expect(getRunMachineBinding(f.run.id)?.sidecarId).toBe('a');
});

for (const disconnect of [false, true]) test(`real outer worker: ${disconnect ? 'disconnect blocks next step' : 'all steps keep their machine'}`, async () => {
  const f = fixture();
  const action = (name: string, nextAction?: any): any => ({ name, type: 'PIECE', settings: {
    pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke',
    input: { toolName: 'desktop_list_windows', params: {} },
  }, ...(nextAction ? { nextAction } : {}) });
  updateDraftVersion(f.version.id, { trigger: { name: 'trigger', type: 'EMPTY', nextAction: action('first', action('second')) } });
  f.manager.dispatchRPC = async id => { f.calls.push(id); if (disconnect) f.machines[0]!.connected = false; return '[]'; };
  updateRun(f.run.id, { status: 'QUEUED' });
  const api = new SandboxApi({ services: f.backend() });
  await api.start({ port: 0 });
  const bundle = await buildEngineBundle(); await buildAllJarvisPieces();
  const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
  const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }) }) } });
  try {
    enqueue({ jobType: 'RUN_FLOW', flowRunId: f.run.id, maxAttempts: 1, payload: { runId: f.run.id } });
    await worker.drain();
    expect(getFlowRun(f.run.id)?.status).toBe(disconnect ? 'FAILED' : 'SUCCEEDED');
    expect(f.calls).toEqual(disconnect ? ['a'] : ['a', 'a']);
    expect(listWorkflowEffects(f.run.id)[0]?.status).toBe('succeeded');
    if (disconnect) expect(listWorkflowEffects(f.run.id)[1]?.outcome).toMatchObject({ status: 'blocked', effect: 'not_started' });
  } finally { await runtime.shutdown(); await api.stop(); }
}, 60_000);

test('real worker approval resume rejects a replacement session without dispatching', async () => {
  const f = fixture(); f.authority.setGovernedCategories(['read_data']);
  updateDraftVersion(f.version.id, { trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
    name: 'first', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1',
      actionName: 'invoke', input: { toolName: 'desktop_list_windows', params: {} } },
  } } });
  updateRun(f.run.id, { status: 'QUEUED' });
  const api = new SandboxApi({ services: f.backend() }); await api.start({ port: 0 });
  const bundle = await buildEngineBundle(); await buildAllJarvisPieces();
  const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
  const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }) }) } });
  try {
    enqueue({ jobType: 'RUN_FLOW', flowRunId: f.run.id, maxAttempts: 1, payload: { runId: f.run.id } });
    await worker.drain(); expect(getFlowRun(f.run.id)?.status).toBe('PAUSED');
    const effect = listWorkflowEffects(f.run.id)[0]!;
    f.machines[0]!.session = 'reconnected';
    f.approvals.approve(effect.approvalId!, 'test');
    resumeResolvedWorkflowEffects(); await worker.drain();
    expect(getFlowRun(f.run.id)?.status).toBe('FAILED');
    expect(f.calls).toEqual([]);
    expect(listWorkflowEffects(f.run.id)[0]?.outcome).toMatchObject({ code: 'WORKFLOW_SESSION_CHANGED' });
  } finally { await runtime.shutdown(); await api.stop(); }
}, 60_000);
