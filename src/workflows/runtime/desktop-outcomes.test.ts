import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, initWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, updateDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { enqueue } from '../db/repos/job-queue';
import { ToolRegistry } from '../../actions/tools/registry';
import { desktopListWindowsTool } from '../../actions/tools/desktop';
import { setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import type { SidecarManager } from '../../sidecar/manager';
import { AuthorityEngine } from '../../authority/engine';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { AuditTrail } from '../../authority/audit';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { createJarvisToolsInvokeRoute } from '../sandbox-api/routes/jarvis-tools';
import { SandboxApi } from '../sandbox-api/server';
import { buildEngineBundle, ENGINE_BUILD_PATHS } from '../runner/engine-runtime/build';
import { buildAllJarvisPieces, buildPiece } from '../runner/engine-runtime/build-pieces';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { createRunFlowHandler } from '../runner/handler';
import { Worker } from '../queue/worker';

let directory: string, dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-desktop-outcomes-'));
  dbPath = join(directory, 'workflow.db');
  initWorkflowDb(dbPath);
});
afterEach(() => {
  closeWorkflowDb();
  setSidecarManagerRef(null as unknown as SidecarManager);
  rmSync(directory, { recursive: true, force: true });
});

function toolAction(name: string, toolName: string, params: Record<string, unknown>, extra = {}): FlowTriggerNode {
  return { name, type: 'PIECE', displayName: name, settings: {
    pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke',
    input: { toolName, params, ...extra },
  } };
}

function fixture(connected = false, result: unknown = 'Desktop windows') {
  let dispatches = 0;
  const sidecar = { id: 'desktop-1', name: 'Test desktop', connected, capabilities: ['desktop'], os: 'windows' };
  setSidecarManagerRef({ listSidecars: () => [sidecar], dispatchRPC: async () => { dispatches++; return result; } } as unknown as SidecarManager);
  const registry = new ToolRegistry();
  registry.register(desktopListWindowsTool);
  const downstream: unknown[] = [];
  registry.register({ name: 'write_file', category: 'file-ops', description: 'Synthetic effect', parameters: {},
    execute: async args => { downstream.push(args); return 'receipt'; } });
  const flow = createFlow();
  const action = toolAction('action', 'desktop_list_windows', { target: sidecar.id });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Desktop outcome',
    trigger: { name: 'trigger', type: 'EMPTY', nextAction: action } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager(), emergency = new EmergencyController();
  const services = buildSandboxServiceBackends({ toolRegistry: registry, authorityEngine: authority,
    approvalManager: approvals, emergencyController: emergency, auditTrail: new AuditTrail(),
    credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'action', executionPath: [] };
  const call = (extra: Record<string, unknown> = {}) => createJarvisToolsInvokeRoute(services)({
    req: new Request('http://127.0.0.1/v1/jarvis/tools/invoke', { method: 'POST',
      headers: { 'X-Jarvis-Step-Name': 'action', 'X-Jarvis-Execution-Path': '[]' },
      body: JSON.stringify({ toolName: 'desktop_list_windows', params: { target: sidecar.id }, ...extra }),
    }), claims: { runId: run.id, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {},
  });
  return { flow, run, version, action, services, context, call, sidecar, authority, emergency, approvals,
    dispatches: () => dispatches, downstream };
}

describe('desktop outcome API and durable receipts', () => {
  test('required offline desktop action returns blocked, never a success receipt', async () => {
    const f = fixture();
    const response = await f.call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ toolName: 'desktop_list_windows', result: null,
      outcome: { status: 'blocked', code: 'SIDECAR_OFFLINE', effect: 'not_started' } });
    expect(f.dispatches()).toBe(0);
    expect(listWorkflowEffects(f.run.id)).toMatchObject([{ status: 'blocked', runId: f.run.id,
      versionId: f.version.id, stepName: 'action', target: { sidecarId: f.sidecar.id },
      outcome: { status: 'blocked', code: 'SIDECAR_OFFLINE' } }]);
  });

  test('explicit availability probe returns blocked as graph data', async () => {
    const f = fixture();
    const response = await f.call({ requireSuccess: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: null, outcome: { status: 'blocked' } });
    expect(listWorkflowEffects(f.run.id)[0]?.status).toBe('blocked');
    expect(f.dispatches()).toBe(0);
  });

  test('requires a boolean probe declaration', async () => {
    const f = fixture();
    expect((await f.call({ requireSuccess: 'false' })).status).toBe(400);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(0);
  });

  test('successful action keeps the existing result and adds explicit success', async () => {
    const f = fixture(true);
    const response = await f.call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ toolName: 'desktop_list_windows', result: 'Desktop windows', outcome: { status: 'succeeded' } });
    expect(listWorkflowEffects(f.run.id)[0]?.status).toBe('succeeded');
  });

  for (const [result, status, code, http] of [
    ['detached', 'unknown', 'SIDECAR_TIMEOUT', 502],
    [{ success: false }, 'error', 'SIDECAR_ACTION_FAILED', 422],
  ] as const) test(`${status} persists across restart and cannot dispatch again`, async () => {
    const f = fixture(true, result);
    const first = await f.call();
    expect(first.status).toBe(http);
    const body = await first.json();
    expect(body).toMatchObject({ outcome: { status, code, effect: 'may_have_occurred' } });
    closeWorkflowDb(); initWorkflowDb(dbPath);
    const second = await f.call();
    expect(second.status).toBe(http);
    expect(await second.json()).toEqual(body);
    expect(f.dispatches()).toBe(1);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(1);
    expect(listWorkflowEffects(f.run.id)[0]?.status).toBe(status === 'error' ? 'failed' : status);
  });

  test('offline receipt remains blocked after restart even if the machine reconnects', async () => {
    const f = fixture();
    await f.call();
    closeWorkflowDb(); initWorkflowDb(dbPath);
    f.sidecar.connected = true;
    expect((await f.call()).status).toBe(409);
    expect(f.dispatches()).toBe(0);
  });

  for (const state of ['denied', 'pause', 'kill'] as const) test(`probe does not bypass ${state}`, async () => {
    const f = fixture(true);
    if (state === 'denied') f.authority.addOverride({ action: 'read_data', allowed: false });
    else f.emergency[state]();
    await expect(f.call({ requireSuccess: false })).rejects.toThrow(/denied|paused|killed/i);
    expect(f.dispatches()).toBe(0);
  });

  test('a probe cannot turn a canceled run into a handled outcome', async () => {
    const f = fixture(true);
    cancelFlowRun(f.run.id);
    await expect(f.call({ requireSuccess: false })).rejects.toThrow(/cancel/i);
    expect(f.dispatches()).toBe(0);
    expect(listWorkflowEffects(f.run.id)[0]?.outcome).toBeUndefined();
  });

  test('probe still pauses for approval and reports offline after approval', async () => {
    const f = fixture();
    f.authority.setGovernedCategories(['read_data']);
    const pending = await f.call({ requireSuccess: false });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ approval: { approvalId: expect.any(String) } });
    f.approvals.approve(f.approvals.getPending()[0]!.id, 'test');
    const response = await f.call({ requireSuccess: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: { status: 'blocked' } });
    expect(f.dispatches()).toBe(0);
    expect(f.approvals.getRequest(listWorkflowEffects(f.run.id)[0]!.approvalId!)?.status).toBe('approved');
  });

  test('default assertion preserves approval identity across a piece upgrade', async () => {
    const f = fixture(true);
    f.authority.setGovernedCategories(['read_data']);
    // The old piece omits requireSuccess; the new piece sends true.
    expect((await f.call()).status).toBe(202);
    const effect = listWorkflowEffects(f.run.id)[0]!;
    closeWorkflowDb(); initWorkflowDb(dbPath);
    f.approvals.approve(effect.approvalId!, 'after-upgrade');
    expect((await f.call({ requireSuccess: true })).status).toBe(200);
    expect((await f.call({ requireSuccess: false })).status).toBe(200);
    expect(f.dispatches()).toBe(1);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(1);
    expect(listWorkflowEffects(f.run.id)[0]?.id).toBe(effect.id);
  });
});

describe('desktop outcomes through the real engine and outer worker', () => {
  for (const probe of [false, true]) test(probe ? 'availability probe selects the offline branch' : 'required offline action stops downstream execution', async () => {
    const f = fixture();
    const fallback = toolAction('offline_handler', 'write_file', { path: '/synthetic', content: '{{action.outcome.code}}' });
    const forbidden = toolAction('online_action', 'write_file', { path: '/synthetic', content: 'should not run' });
    if (probe) {
      f.action.settings!.input = { toolName: 'desktop_list_windows', params: { target: f.sidecar.id }, requireSuccess: false };
      f.action.nextAction = { name: 'availability', type: 'ROUTER', settings: { executionType: 'EXECUTE_FIRST_MATCH', branches: [
        { branchName: 'offline', branchType: 'CONDITION', conditions: [[{ firstValue: '{{action.outcome.status}}',
          operator: 'TEXT_EXACTLY_MATCHES', secondValue: 'blocked', caseSensitive: true }]] },
        { branchName: 'online', branchType: 'FALLBACK' },
      ] }, children: [fallback, forbidden] };
    } else f.action.nextAction = forbidden;
    updateDraftVersion(f.version.id, { trigger: { ...f.version.trigger, nextAction: f.action } });
    updateRun(f.run.id, { status: 'QUEUED' });
    const api = new SandboxApi({ services: f.services });
    await api.start({ port: 0 });
    const bundle = await buildEngineBundle();
    await buildAllJarvisPieces();
    const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({
      executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }),
    }) } });
    try {
      enqueue({ jobType: 'RUN_FLOW', flowRunId: f.run.id, maxAttempts: 1, payload: { runId: f.run.id } });
      await worker.drain();
      expect(getFlowRun(f.run.id)?.status).toBe(probe ? 'SUCCEEDED' : 'FAILED');
      if (probe) expect(f.downstream).toEqual([{ path: '/synthetic', content: 'SIDECAR_OFFLINE' }]);
      else {
        expect(f.downstream).toHaveLength(0);
        expect(getFlowRun(f.run.id)?.failedStep?.errorMessage).toContain('offline');
      }
      expect(f.dispatches()).toBe(0);
      expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'blocked', outcome: { code: 'SIDECAR_OFFLINE' } });
    } finally { await runtime.shutdown(); await api.stop(); }
  }, 60_000);
});

describe('compiled tool piece required-effect assertion', () => {
  async function invoke(reply: unknown, props: Record<string, unknown> = {}) {
    const built = await buildPiece(join(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/jarvis/tool'));
    const action = (await import(built.bundlePath)).jarvisToolPiece.getAction('invoke');
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async () => Response.json(reply) });
    try {
      return await action.run({ propsValue: { toolName: 'desktop_list_windows', params: {}, ...props },
        server: { apiUrl: `http://127.0.0.1:${server.port}`, token: 'test' }, step: { name: 'action', executionPath: [] },
        run: { waitForWaitpoint: () => { throw new Error('waiting for approval'); } },
      });
    } finally { server.stop(true); }
  }

  for (const status of ['blocked', 'error', 'unknown'] as const) {
    test(`HTTP 200 cannot satisfy a required action with ${status}`, async () => {
      await expect(invoke({ result: null, toolName: 'desktop_list_windows',
        outcome: { status, code: 'TEST_FAILURE', message: 'not completed', effect: 'may_have_occurred' },
      })).rejects.toThrow('not completed');
    });
    test(`explicit probe retains ${status} for graph handling`, async () => {
      const reply = { result: null, toolName: 'desktop_list_windows',
        outcome: { status, code: 'TEST_FAILURE', message: 'not completed', effect: 'may_have_occurred' } };
      expect(await invoke(reply, { requireSuccess: false })).toEqual(reply);
    });
  }

  for (const outcome of [undefined, null, { status: 'success' }, { status: 'blocked' }]) {
    test(`missing or malformed outcome fails closed: ${JSON.stringify(outcome)}`, async () => {
      await expect(invoke({ result: 'legacy result', toolName: 'desktop_list_windows', outcome }, { requireSuccess: false }))
        .rejects.toThrow('lacks an action outcome');
    });
  }

  test('approval pauses before the piece expects an action outcome', async () => {
    await expect(invoke({ result: null, toolName: 'desktop_list_windows',
      approval: { effectId: 'effect', approvalId: 'approval', waitpointId: 'wait' } }))
      .rejects.toThrow('waiting for approval');
  });
});
