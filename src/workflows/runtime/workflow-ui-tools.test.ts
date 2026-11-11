import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { initDatabase } from '../../vault/schema';
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
beforeEach(() => { initDatabase(':memory:'); initWorkflowDb(':memory:'); });
afterEach(() => { setSidecarManagerRef(originalManager!); closeWorkflowDb(); });
const catalog = new PieceCatalog([{ name: '@jarvispieces/piece-jarvis-tool', displayName: 'Tool', description: '',
  actions: { invoke: { name: 'invoke', displayName: 'Invoke', description: '' } } }]);
const graph = (toolName: string, params = {}): any => ({ name: 'trigger', type: 'EMPTY', nextAction: {
  name: 'action', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1',
    actionName: 'invoke', input: { toolName, params } } } });

function fixture(tool = desktopLaunchAppTool, params: Record<string, unknown> = { target: 'pc', executable: 'notepad.exe' }, reply: unknown = { success: true, window_visible: true, pid: 123, window_title: 'Untitled - Notepad' },
  graphParams: Record<string, unknown> = params) {
  const machines = [{ id: 'pc', name: 'PC', os: 'windows', connected: true, session: 'first', capabilities: ['desktop', 'browser'],
    features: ['browser_elem_gen', 'browser_action_outcomes'] }];
  const calls: Array<{ method: string; args: any }> = [];
  setSidecarManagerRef({ listSidecars: () => machines, getConnectionSessionId: () => machines[0]!.session,
    dispatchRPC: async (_id: string, method: string, args: unknown) => { calls.push({ method, args });
      return reply; } } as any);
  const registry = new ToolRegistry(); registry.register(tool);
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Notepad audit', trigger: graph(tool.name, graphParams) });
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
  // The id comes from run data (#1314 m8): a written one names nothing.
  const f = fixture(desktopClickTool, { target: 'pc', element_id: 42, action: 'set_value', value: 'A poem' }, undefined,
    { target: 'pc', element_id: '{{snapshot.element}}', action: 'set_value', value: 'A poem' });
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
  // Each forged call left an audit row naming the run, not executed.
  expect(new AuditTrail().query({ agentId: `workflow:${f.run.id}` }).filter(r => r.tool_name === 'desktop_launch_app' && r.executed === 0)).toHaveLength(2);
  expect((await f.call()).status).toBe(202);
});

test('a key press that would reach another computer is refused at composition and activation (#1314)', () => {
  const studio = { id: 'studio', name: 'Studio', capabilities: ['browser'] };
  const issues = (params: Record<string, unknown>, machines: any[]) => compileWorkflow(graph('browser_press_key', params),
    { pieces: catalog, phase: 'composition', machines: () => machines }).issues.filter(i => i.code === 'WORKFLOW_TOOL_UNSUPPORTED');
  expect(issues({ key: 'Enter' }, [studio])).toHaveLength(1);
  expect(issues({ key: 'Enter', target: 'Studio' }, [])).toHaveLength(1);
  expect(issues({ key: 'Enter' }, [{ ...studio, capabilities: ['desktop'] }])).toEqual([]);
  expect(issues({ key: 'Enter' }, [])[0]?.message).toBeUndefined();
  expect(issues({ key: 'Enter' }, [studio])[0]!.message).toContain('browser_type with submit');
});


test('the card shows every value, the computer, and which values run data chose (#1314 M1)', async () => {
  const f = fixture(desktopLaunchAppTool, { target: 'pc', executable: 'notepad.exe', args: 'C:\\notes\\"q".txt' }, undefined,
    { target: 'pc', executable: 'notepad.exe', args: '{{trigger.body.file}}' });
  expect((await f.call()).status).toBe(202);
  const card = f.approvals.getPending()[0]!;
  const context = JSON.parse(card.context!);
  expect(context.intent).toContain('On "PC (pc)": open an app');
  expect(context.intent).toContain('executable="notepad.exe"');
  expect(context.intent).toContain('args="C:\\\\notes\\\\\\"q\\".txt" (from run data)');
  expect(context.uiCard).toMatchObject({ computer: 'PC (pc)', values: [
    { name: 'args', source: 'run_data' }, { name: 'executable', value: '"notepad.exe"', source: 'workflow' }] });
});

test('a value the card would cut is refused before any card (#1314 M1, #1040)', async () => {
  const long = 'x'.repeat(700);
  const f = fixture(desktopLaunchAppTool, { target: 'pc', executable: 'notepad.exe', args: long }, undefined,
    { target: 'pc', executable: 'notepad.exe', args: '{{trigger.body.file}}' });
  await expect(Promise.resolve(f.call())).rejects.toMatchObject({ outcome: { code: 'CARD_CANNOT_SHOW', effect: 'not_started' } });
  expect(f.approvals.getPending()).toHaveLength(0); expect(f.calls).toHaveLength(0);
});

test('a hidden character in a value is shown escaped, never dropped (#1314 M1)', async () => {
  const f = fixture(desktopLaunchAppTool, { target: 'pc', executable: 'note\u202epad.exe' });
  expect((await f.call()).status).toBe(202);
  expect(JSON.parse(f.approvals.getPending()[0]!.context!).intent).toContain('executable="note\\u202Epad.exe"');
});


test('a desktop element id written into a workflow is refused at composition and at run time (#1314 m8)', async () => {
  const params = { target: 'pc', element_id: 42, action: 'set_value', value: 'A poem' };
  expect(compileWorkflow(graph('desktop_click', params), { pieces: catalog, phase: 'composition' }).issues)
    .toContainEqual(expect.objectContaining({ code: 'WORKFLOW_TOOL_UNSUPPORTED', path: 'settings.input.params.element_id' }));
  expect(compileWorkflow(graph('desktop_click', { ...params, element_id: '{{snapshot.element}}', action: 'get_value' }), { pieces: catalog, phase: 'composition' }).issues)
    .toContainEqual(expect.objectContaining({ code: 'WORKFLOW_TOOL_UNSUPPORTED', path: 'settings.input.params.action' }));
  const f = fixture(desktopClickTool, params);
  const response = await f.call();
  expect(response.status).toBe(409);
  expect((await response.json()).outcome).toMatchObject({ code: 'WORKFLOW_TOOL_UNSUPPORTED', effect: 'not_started' });
  expect(f.approvals.getPending()).toHaveLength(0); expect(f.calls).toHaveLength(0);
});

test('a call keeps the text its step writes around a template (#1314 review)', async () => {
  const graphParams = { target: 'pc', executable: 'C:\\Apps\\{{trigger.body.app}}.exe' };
  for (const [executable, ok] of [['C:\\Apps\\notepad.exe', true], ['C:\\Windows\\cmd.exe', false], ['C:\\Apps\\x.exe.bat', false]] as const) {
    const f = fixture(desktopLaunchAppTool, { target: 'pc', executable }, undefined, graphParams);
    const reply = await Promise.resolve(f.call()).catch(error => error);
    if (ok) expect((reply as Response).status).toBe(202);
    else expect(reply).toMatchObject({ outcome: { code: 'WORKFLOW_STEP_INPUT_MISMATCH', effect: 'not_started' } });
  }
});

test('a direct computer step with no written computer on an unpinned flow raises no card (#1314 M2)', async () => {
  const f = fixture(desktopLaunchAppTool, { executable: 'notepad.exe' });
  const response = await f.call();
  expect(response.status).toBe(409);
  expect((await response.json()).outcome).toMatchObject({ code: 'WORKFLOW_MACHINE_UNPINNED', effect: 'not_started' });
  expect(f.approvals.getPending()).toHaveLength(0); expect(f.calls).toHaveLength(0);
});


test('a step with a template at both ends still keeps the text between them (#1314 review)', async () => {
  const graphParams = { target: 'pc', executable: '{{trigger.body.dir}}\\Apps\\{{trigger.body.app}}' };
  for (const [executable, ok] of [['C:\\Apps\\notepad.exe', true], ['C:\\Windows\\cmd.exe', false]] as const) {
    const f = fixture(desktopLaunchAppTool, { target: 'pc', executable }, undefined, graphParams);
    const reply = await Promise.resolve(f.call()).catch(error => error);
    if (ok) expect((reply as Response).status).toBe(202);
    else expect(reply).toMatchObject({ outcome: { code: 'WORKFLOW_STEP_INPUT_MISMATCH' } });
  }
  // An unclosed brace is literal text: only exactly it is accepted.
  const f = fixture(desktopLaunchAppTool, { target: 'pc', executable: 'a{{ba{{b' }, undefined, { target: 'pc', executable: 'a{{b' });
  await expect(Promise.resolve(f.call())).rejects.toMatchObject({ outcome: { code: 'WORKFLOW_STEP_INPUT_MISMATCH' } });
});

test('turning desktop control off closes a waiting desktop card, and the step runs nothing (#1314 m6)', async () => {
  const { setDesktopEnabledSource } = await import('../../actions/tools/desktop-guard');
  const { switchedOffCard } = await import('./workflow-ui-tools');
  const f = fixture();
  expect((await f.call()).status).toBe(202);
  const card = f.approvals.getPending()[0]!;
  try {
    setDesktopEnabledSource(() => false);
    // The daemon's own matcher, over a registry holding the tool (#1314 review).
    const closed = f.approvals.closeWorkflowCards(switchedOffCard({ get: (n: string) => n === desktopLaunchAppTool.name ? desktopLaunchAppTool : undefined }), 'switched-off');
    expect(closed.map(r => r.id)).toEqual([card.id]);
    expect(f.approvals.getRequest(card.id)?.status).toBe('expired');
    expect(f.approvals.approve(card.id, 'dashboard')).toBeNull();
    setDesktopEnabledSource(null);
    const response = await Promise.resolve(f.call()).catch(error => error);
    const outcome = response instanceof Response ? (await response.json()).outcome : response.outcome;
    expect(outcome).toMatchObject({ code: 'APPROVAL_EXPIRED', effect: 'not_started' });
    expect(f.calls).toHaveLength(0);
  } finally { setDesktopEnabledSource(null); }
});
