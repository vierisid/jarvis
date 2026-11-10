import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { ToolRegistry } from '../../actions/tools/registry';
import { desktopLaunchAppTool, desktopTypeTool, desktopClickTool } from '../../actions/tools/desktop';
import { getSidecarManager, setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import { AuthorityEngine } from '../../authority/engine';
import { ApprovalManager } from '../../authority/approval';
import { EmergencyController } from '../../authority/emergency';
import { AuditTrail } from '../../authority/audit';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { createJarvisToolsInvokeRoute } from '../sandbox-api/routes/jarvis-tools';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { workflowToolDeclarationRefusal, WORKFLOW_REVIEWED_UI_TOOLS, UNSUPPORTED_WORKFLOW_TOOLS } from './workflow-ui-tools';
import { compileWorkflow } from './workflow-readiness';
import { PieceCatalog } from './piece-catalog';

const originalManager = getSidecarManager();
beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => { setSidecarManagerRef(originalManager!); closeWorkflowDb(); });
const catalog = new PieceCatalog([{ name: '@jarvispieces/piece-jarvis-tool', displayName: 'Tool', description: '',
  actions: { invoke: { name: 'invoke', displayName: 'Invoke', description: '' } } }]);
const graph = (toolName: string, params = {}): any => ({ name: 'trigger', type: 'EMPTY', nextAction: {
  name: 'action', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1',
    actionName: 'invoke', input: { toolName, params } } } });

function fixture(tool = desktopLaunchAppTool, params: Record<string, unknown> = { target: 'pc', executable: 'notepad.exe' }, reply: unknown = { success: true, window_visible: true, pid: 123, window_title: 'Untitled - Notepad' }) {
  const machines = [{ id: 'pc', name: 'PC', os: 'windows', connected: true, session: 'first', capabilities: ['desktop', 'browser'],
    features: ['browser_elem_gen', 'browser_action_outcomes'] }];
  const calls: Array<{ method: string; args: any }> = [];
  setSidecarManagerRef({ listSidecars: () => machines, getConnectionSessionId: () => machines[0]!.session,
    dispatchRPC: async (_id: string, method: string, args: unknown) => { calls.push({ method, args });
      return reply; } } as any);
  const registry = new ToolRegistry(); registry.register(tool);
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Notepad audit', trigger: graph(tool.name, params) });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const approvals = new ApprovalManager();
  const build = (manager = approvals, level = 10) => buildSandboxServiceBackends({ toolRegistry: registry,
    authorityEngine: new AuthorityEngine({ default_level: level, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    approvalManager: manager, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  const call = (services = build()) => createJarvisToolsInvokeRoute(services)({ req: new Request('http://local/v1/jarvis/tools/invoke', {
    method: 'POST', headers: { 'X-Jarvis-Step-Name': 'action', 'X-Jarvis-Execution-Path': '[]' },
    body: JSON.stringify({ toolName: tool.name, params }),
  }), claims: { runId: run.id, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {} });
  return { call, build, approvals, calls, machines, run };
}

test('Notepad launch waits for a click even at full Authority, then executes once with a window receipt', async () => {
  const f = fixture();
  expect((await f.call()).status).toBe(202); expect(f.calls).toHaveLength(0);
  const approval = f.approvals.getPending()[0]!;
  expect(JSON.parse(approval.context!).confirm).toBe('always');
  f.approvals.approve(approval.id, 'dashboard');
  const result = await f.call(); expect(result.status).toBe(200);
  expect((await result.json()).outcome).toMatchObject({ status: 'succeeded', verification: { status: 'verified' } });
  expect(f.calls).toHaveLength(1);
  expect((await f.call()).status).toBe(200); expect(f.calls).toHaveLength(1);
  expect(f.approvals.getPending()).toHaveLength(0);
});

test('a direct desktop step can request approval above its autonomous level', async () => {
  const f = fixture(); const services = f.build(f.approvals, 3);
  expect((await f.call(services)).status).toBe(202); expect(f.calls).toHaveLength(0);
  f.approvals.approve(f.approvals.getPending()[0]!.id, 'dashboard');
  expect((await f.call(services)).status).toBe(200); expect(f.calls).toHaveLength(1);
});

for (const change of ['offline', 'reconnect', 'restart'] as const) test(`pending desktop review refuses ${change}`, async () => {
  const f = fixture(); expect((await f.call()).status).toBe(202);
  f.approvals.approve(f.approvals.getPending()[0]!.id, 'dashboard');
  if (change === 'offline') f.machines[0]!.connected = false;
  if (change === 'reconnect') f.machines[0]!.session = 'replacement';
  const result = await f.call(change === 'restart' ? f.build(new ApprovalManager()) : undefined);
  expect(result.status).toBe(409); expect(f.calls).toHaveLength(0);
  expect((await result.json()).outcome.effect).toBe('not_started');
});

test('focused-window typing returns a typed refusal with no approval or dispatch', async () => {
  const f = fixture(desktopTypeTool, { target: 'pc', text: 'A poem' });
  const result = await f.call(); expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({ outcome: { code: 'WORKFLOW_TOOL_UNSUPPORTED', effect: 'not_started' } });
  expect(f.calls).toHaveLength(0); expect(f.approvals.getPending()).toHaveLength(0);
});

for (const change of ['denied', 'capability_lost'] as const) test(`desktop review refuses ${change} without dispatch`, async () => {
  const f = fixture(); expect((await f.call()).status).toBe(202);
  const id = f.approvals.getPending()[0]!.id;
  if (change === 'denied') f.approvals.deny(id, 'dashboard');
  else { f.approvals.approve(id, 'dashboard'); f.machines[0]!.capabilities = []; }
  if (change === 'denied') await expect(f.call()).rejects.toMatchObject({ outcome: { code: 'APPROVAL_DENIED', effect: 'not_started' } });
  else expect((await f.call()).status).toBe(409);
  expect(f.calls).toHaveLength(0);
});

test('an element-bound value write is reviewed and dispatched once', async () => {
  const f = fixture(desktopClickTool, { target: 'pc', element_id: 42, action: 'set_value', value: 'A poem' });
  expect((await f.call()).status).toBe(202);
  f.approvals.approve(f.approvals.getPending()[0]!.id, 'dashboard');
  expect((await f.call()).status).toBe(200); expect(f.calls).toHaveLength(1);
  expect(listWorkflowEffects(f.run.id)[0]?.status).toBe('succeeded');
});

for (const toolName of UNSUPPORTED_WORKFLOW_TOOLS) test(`${toolName} is rejected before composition or activation`, () => {
  for (const phase of ['composition', 'activation'] as const) {
    expect(compileWorkflow(graph(toolName), { pieces: catalog, phase, tool: () => ({ params: [] }) }).issues)
      .toContainEqual(expect.objectContaining({ code: 'WORKFLOW_TOOL_UNSUPPORTED', node: 'action' }));
  }
});

test('reviewed tool support requires its real guard, and unadapted tools are not advertised as supported', () => {
  for (const name of WORKFLOW_REVIEWED_UI_TOOLS) {
    expect(workflowToolDeclarationRefusal({ ...desktopLaunchAppTool, name, captureApprovalGuard: undefined })).not.toBeNull();
  }
  expect(workflowToolDeclarationRefusal(desktopLaunchAppTool)).toBeNull();
  expect(workflowToolDeclarationRefusal({ ...desktopLaunchAppTool, name: 'unadapted', captureApprovalGuard: undefined })).toContain('no supported');
  expect(compileWorkflow(graph('desktop_launch_app'), { pieces: catalog, phase: 'activation',
    tool: () => ({ params: [], workflowRefusal: 'The live approval guard is missing.' }) }).issues)
    .toContainEqual(expect.objectContaining({ code: 'WORKFLOW_TOOL_UNSUPPORTED', message: 'The live approval guard is missing.' }));
});

test('a call naming a reviewed step with params its step does not state raises no card (#1314)', async () => {
  const f = fixture();
  const forged = (params: Record<string, unknown>) => createJarvisToolsInvokeRoute(f.build())({ req: new Request('http://local/v1/jarvis/tools/invoke', {
    method: 'POST', headers: { 'X-Jarvis-Step-Name': 'action', 'X-Jarvis-Execution-Path': '[]' },
    body: JSON.stringify({ toolName: 'desktop_launch_app', params }),
  }), claims: { runId: f.run.id, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {} });
  for (const params of [{ target: 'pc', executable: 'cmd.exe' }, { target: 'pc', executable: 'notepad.exe', args: '/c calc' }]) {
    await expect(forged(params)).rejects.toMatchObject({ outcome: { code: 'WORKFLOW_STEP_INPUT_MISMATCH', effect: 'not_started' } });
  }
  expect(f.approvals.getPending()).toHaveLength(0); expect(f.calls).toHaveLength(0);
  expect((await f.call()).status).toBe(202);
});
