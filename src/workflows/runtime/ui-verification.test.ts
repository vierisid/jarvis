import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, initWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { ToolRegistry, type ToolDefinition } from '../../actions/tools/registry';
import { desktopLaunchAppTool } from '../../actions/tools/desktop';
import { browserSnapshotTool, browserNavigateTool, browserClickTool, browserTypeTool, browserHoverTool } from '../../actions/tools/builtin';
import { setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import type { SidecarManager } from '../../sidecar/manager';
import { SidecarRPCError } from '../../sidecar/rpc';
import { AuthorityEngine } from '../../authority/engine';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { AuditTrail } from '../../authority/audit';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { createJarvisToolsInvokeRoute } from '../sandbox-api/routes/jarvis-tools';

let directory: string, dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-q09-'));
  dbPath = join(directory, 'workflow.db'); initWorkflowDb(dbPath);
});
afterEach(() => {
  closeWorkflowDb(); setSidecarManagerRef(null as unknown as SidecarManager);
  rmSync(directory, { recursive: true, force: true });
});

function fixture(tool: ToolDefinition, params: Record<string, unknown>, result: unknown, os = 'linux') {
  const machines = ['a', 'b'].map(id => ({ id, name: id, connected: true, os, session: `session-${id}`,
    capabilities: ['desktop', 'browser'], features: ['browser_elem_gen', 'browser_action_outcomes'] }));
  const calls: { id: string; method: string; params: Record<string, unknown> }[] = [];
  setSidecarManagerRef({ listSidecars: () => machines,
    getConnectionSessionId: (id: string) => machines.find(m => m.id === id && m.connected)?.session ?? null,
    dispatchRPC: async (id: string, method: string, args: Record<string, unknown>) => {
      calls.push({ id, method, params: args }); if (result instanceof Error) throw result; return result;
    } } as unknown as SidecarManager);
  const registry = new ToolRegistry(); registry.register(tool);
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'UI verification', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'action', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-tool',
      pieceVersion: '0.0.1', actionName: 'invoke', input: { toolName: tool.name, params } } } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const approvals = new ApprovalManager();
  const services = buildSandboxServiceBackends({ toolRegistry: registry,
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: ['access_browser'], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    approvalManager: approvals, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  const call = () => createJarvisToolsInvokeRoute(services)({ req: new Request('http://127.0.0.1/v1/jarvis/tools/invoke', {
    method: 'POST', headers: { 'X-Jarvis-Step-Name': 'action', 'X-Jarvis-Execution-Path': '[]' },
    body: JSON.stringify({ toolName: tool.name, params }),
  }), claims: { runId: run.id, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {} });
  const execute = async () => {
    let response = await call();
    if (response.status === 202) {
      for (const request of approvals.getPending()) approvals.approve(request.id, 'fixture');
      response = await call();
    }
    return response;
  };
  return { call, execute, approvals, calls, machines, run };
}

for (const tool of [browserSnapshotTool]) {
  for (const [label, result, verified] of [
    ['document identity', { text: 'Error: is page content, not an outcome', page_url: 'https://example.test/redirected', loader_id: 'doc-1' }, true],
    ['legacy string', 'https://example.test/looks-successful', false],
    ['missing document', { text: 'ok', page_url: 'https://example.test/' }, false],
    ['forged identity', { text: 'ok', page_url: ['https://example.test/'], loader_id: 'doc-1' }, false],
  ] as const) test(`${tool.name}: ${label}`, async () => {
    const f = fixture(tool, tool === browserNavigateTool ? { url: 'https://example.test/requested' } : {}, result);
    const response = await f.execute(); expect(response.status).toBe(200);
    const { outcome } = await response.json();
    expect(outcome.verification).toEqual(verified
      ? { status: 'verified', postcondition: 'page_observed', pageUrl: 'https://example.test/redirected', documentId: 'doc-1' }
      : { status: 'unverified', reason: 'page_identity_missing' });
    expect(listWorkflowEffects(f.run.id)[0]?.outcome).toEqual(outcome);
    expect(f.calls[0]?.params.page_identity).toBe(true);
    closeWorkflowDb(); initWorkflowDb(dbPath);
    f.machines.reverse(); f.machines.find(m => m.id === 'a')!.connected = false;
    expect((await (await f.call()).json()).outcome).toEqual(outcome);
    expect(f.calls.map(c => c.id)).toEqual(['a']);
  });
}

for (const tool of [browserNavigateTool, browserClickTool, browserHoverTool, browserTypeTool, desktopLaunchAppTool]) {
  test(`${tool.name}: direct workflow UI effects remain prohibited`, async () => {
    const f = fixture(tool, {}, 'ok');
    await expect(f.call()).rejects.toThrow('opaque code/UI effects');
    expect(f.calls).toEqual([]);
  });
}

for (const [error, status, http] of [
  [new SidecarRPCError('BROWSER_ACTION_UNCERTAIN', 'focus lost after clearing'), 'unknown', 502],
  [new Error('socket disconnected'), 'unknown', 502],
] as const) test(`browser ${error.message}: durable failure, no replay`, async () => {
  const f = fixture(browserSnapshotTool, {}, error);
  const response = await f.execute(); expect(response.status).toBe(http);
  const body = await response.json();
  expect(body.outcome).toMatchObject({ status, effect: 'may_have_occurred' });
  closeWorkflowDb(); initWorkflowDb(dbPath);
  expect(await (await f.call()).json()).toEqual(body);
  expect(f.calls).toHaveLength(1);
});

for (const change of ['offline', 'reconnect', 'capability']) test(`browser ${change} while awaiting approval cannot retarget`, async () => {
  const f = fixture(browserSnapshotTool, {}, 'snapshot');
  expect((await f.call()).status).toBe(202);
  const a = f.machines[0]!;
  if (change === 'offline') a.connected = false;
  if (change === 'reconnect') a.session = 'replacement-session';
  if (change === 'capability') a.capabilities = ['desktop'];
  f.machines.reverse();
  for (const request of f.approvals.getPending()) f.approvals.approve(request.id, 'fixture');
  const response = await f.call(); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ outcome: { status: 'blocked', effect: 'not_started' } });
  expect(f.calls).toEqual([]);
});
