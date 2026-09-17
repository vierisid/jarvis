import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { ToolRegistry } from '../../actions/tools/registry';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { DeferredExecutor } from '../../authority/deferred-executor';
import { applyApprovalDecision } from '../../daemon/approval-decision';
import { listWorkflowEffects, saveWorkflowEffect } from '../db/repos/workflow-effect';
import { getWorkflowDb } from '../db';
import { updateRun } from '../db/repos/flow-run';
import { updateDraftVersion, setSampleDataEntry, setSampleInputEntry } from '../db/repos/flow-version';
import { resumeResolvedWorkflowEffects } from './effect-approval-scheduler';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { WorkflowCancellationError } from './cancellation';
import { checkpointExecution } from '../../actions/execution-scope';
import { SandboxApi } from '../sandbox-api/server';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildAllJarvisPieces } from '../runner/engine-runtime/build-pieces';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { createRunFlowHandler } from '../runner/handler';
import { Worker } from '../queue/worker';
import { enqueue } from '../db/repos/job-queue';
import { getFlowRun } from '../db/repos/flow-run';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowRoutes } from '../api/routes';
import { createJarvisContextVaultSearchRoute } from '../sandbox-api/routes/jarvis-context';
import { getSidecarManager, setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from './service-backends';
import { WebSocketService } from '../../daemon/ws-service';
import { noOpCodeSandbox } from '../activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const PIECE_FOR_ROUTE = { tool: 'tool', notify: 'notify', agent: 'agent', workflow: 'trigger',
  context: 'context', llm: 'ask' } as const;
const ACTION_FOR_ROUTE = { tool: 'invoke', notify: 'notify', agent: 'delegate', workflow: 'run_workflow',
  context: 'vault_search', llm: 'ask' } as const;

function fixture(route: 'tool' | 'notify' | 'agent' | 'workflow' | 'context' | 'llm' = 'tool') {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Governed routine', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: {
      pieceName: `@jarvispieces/piece-jarvis-${PIECE_FOR_ROUTE[route]}`, pieceVersion: '0.0.1',
      actionName: ACTION_FOR_ROUTE[route], input: {},
    } },
  } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const calls: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({ name: 'write_file', category: 'file-ops', description: 'Synthetic write', parameters: {},
    execute: async args => { calls.push(args); return 'saved'; } });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const emergency = new EmergencyController();
  const approvals = new ApprovalManager();
  const deliveredApprovals: string[] = [];
  const options: BuildServiceBackendsOptions = { credentialResolver: new CredentialResolver(),
    llmManager: { chat: async (messages: Array<{ role: string; content: string }>) => {
      calls.push({ llm: messages[messages.length - 1]!.content });
      return { content: 'model reply' };
    } } as any, toolRegistry: registry, authorityEngine: authority,
    emergencyController: emergency, auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    approvalManager: approvals, onWorkflowApproval: request => { deliveredApprovals.push(request.id); },
    channelService: { getChannelStatus: () => ({}), getBroadcastRecipient: () => 'recipient-at-review',
      sendWorkflowNotification: async (...args: unknown[]) => { calls.push(args.slice(0, 3)); },
      tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as any,
    wsService: { broadcastNotificationToDashboard: (...args: unknown[]) => { calls.push(args); } } as any,
  };
  const backends = buildSandboxServiceBackends(options);
  const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'action', executionPath: [] };
  const invoke = (): Promise<any> => {
    if (route === 'context') return backends.contextProvider!.vaultSearch({ query: 'alice' }, context) as Promise<any>;
    if (route === 'llm') return backends.llmChat!({ prompt: 'summarise the vault' }, context) as Promise<any>;
    if (route === 'tool') {
      return backends.toolsInvoke!({ toolName: 'write_file', params: { path: '/tmp/synthetic', content: 'hello' } }, context);
    }
    return backends.notify!({ message: 'Synthetic notification', channels: ['dashboard'], priority: 'normal' }, context);
  };
  return { calls, authority, emergency, invoke, approvals, deliveredApprovals, backends, context, run, version, registry, options };
}

describe('workflow effect boundary', () => {
  test('inline expressions cannot call the host fetch function', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('synthetic'); }) as unknown as typeof fetch;
    try {
      await expect(noOpCodeSandbox.runScript({ script: 'fetch("https://example.invalid/")', scriptContext: {}, functions: {} })).rejects.toThrow();
      expect(calls).toBe(0);
    } finally { globalThis.fetch = original; }
  });

  test('urgent dashboard-only notifications do not broadcast to external recipients', async () => {
    const f = fixture('notify');
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    (ws as any).wsServer.broadcast = () => { f.calls.push('dashboard'); };
    ws.setChannelService({ broadcastToAll: async () => { f.calls.push('unapproved-recipient'); } } as any);
    f.options.wsService = ws;
    const result = await f.backends.notify!({ message: 'hello', channels: ['dashboard'], priority: 'high' }, f.context);
    expect(result.delivered).toEqual(['dashboard']);
    expect(f.calls).toEqual(['dashboard']);
  });

  test('legacy urgent proactive notifications retain their explicit broadcast behavior', () => {
    const calls: string[] = [];
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    (ws as any).wsServer.broadcast = () => { calls.push('dashboard'); };
    ws.setChannelService({ broadcastToAll: async (text: string) => { calls.push(text); } } as any);
    ws.broadcastNotification('legacy', 'urgent');
    expect(calls).toEqual(['dashboard', '[URGENT] legacy']);
  });

  const CATEGORY_FOR_ROUTE = { tool: 'write_data', notify: 'send_message',
    context: 'read_data', llm: 'read_data' } as const;
  for (const route of ['tool', 'notify', 'context', 'llm'] as const) {
    test(`${route}: Authority denial prevents the effect`, async () => {
      const f = fixture(route);
      f.authority.addOverride({ action: CATEGORY_FOR_ROUTE[route], allowed: false });
      await expect(f.invoke()).rejects.toThrow(/denied/i);
      expect(f.calls).toHaveLength(0);
    });
    for (const state of ['pause', 'kill'] as const) test(`${route}: ${state} prevents the effect`, async () => {
      const f = fixture(route);
      f.emergency[state]();
      await expect(f.invoke()).rejects.toThrow(/paused|killed/i);
      expect(f.calls).toHaveLength(0);
    });
  }

  test('context reads and prompts are recorded as durable effects, not passed straight through', async () => {
    const ctx = fixture('context');
    expect(await ctx.invoke()).toEqual({ result: [] });
    expect(listWorkflowEffects(ctx.run.id)[0]).toMatchObject({ status: 'succeeded', route: 'context:vault_search',
      toolName: 'workflow_vault_search', actionCategory: 'read_data',
      arguments: { query: 'alice' }, target: { store: 'vault' } });

    const llm = fixture('llm');
    expect(await llm.invoke()).toMatchObject({ text: 'model reply' });
    expect(llm.calls).toEqual([{ llm: 'summarise the vault' }]);
    expect(listWorkflowEffects(llm.run.id)[0]).toMatchObject({ status: 'succeeded', route: 'llm',
      toolName: 'workflow_ask', actionCategory: 'read_data',
      arguments: { prompt: 'summarise the vault' }, target: { destination: 'llm-provider' } });
  });

  test('a governed read_data category pauses both halves of the exfiltration path', async () => {
    for (const route of ['context', 'llm'] as const) {
      const f = fixture(route);
      f.authority.setGovernedCategories(['read_data']);
      const pending = await f.invoke();
      expect(pending.approval).toBeDefined();
      // Nothing was read and no prompt reached the provider while it waits.
      expect(f.calls).toHaveLength(0);
      expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'pending', decision: 'approval_required' });
      expect(f.deliveredApprovals).toHaveLength(1);
    }
  });

  test('a pending context read answers 202 while a resolved one keeps its bare array shape', async () => {
    const f = fixture('context');
    f.authority.setGovernedCategories(['read_data']);
    const route = createJarvisContextVaultSearchRoute({ contextProvider: f.backends.contextProvider! });
    const call = () => route({
      req: new Request('http://127.0.0.1/v1/jarvis/context/vault-search', {
        method: 'POST', body: JSON.stringify({ query: 'alice' }),
        headers: { 'X-Jarvis-Step-Name': 'action', 'X-Jarvis-Execution-Path': '[]' },
      }),
      claims: { runId: f.run.id, projectId: DEFAULT_IDS.project, sandboxId: 'sbx' } as any,
      params: {},
    });

    const parked = await call();
    expect(parked.status).toBe(202);
    expect(await parked.json()).toMatchObject({ approval: { effectId: expect.any(String) } });

    const effect = listWorkflowEffects(f.run.id)[0]!;
    f.approvals.approve(effect.approvalId!, 'test');
    const resolved = await call();
    expect(resolved.status).toBe(200);
    // The success shape is still the bare array the action declares in outputSample.
    expect(await resolved.json()).toEqual([]);
  });

  test('allowed effect executes once and returns its durable result on replay', async () => {
    const f = fixture();
    expect(await f.invoke()).toMatchObject({ result: 'saved' });
    expect(await f.invoke()).toMatchObject({ result: 'saved' });
    expect(f.calls).toHaveLength(1);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'succeeded', stepName: 'action',
      arguments: { path: '/tmp/synthetic', content: 'hello' }, versionId: f.version.id });
  });

  for (const route of ['tool', 'notify'] as const) test(`${route}: real approval, durable pause and single dispatch`, async () => {
    const f = fixture(route);
    f.authority.setGovernedCategories([route === 'tool' ? 'write_data' : 'send_message']);
    const pending = await f.invoke();
    expect(pending.approval).toBeDefined();
    expect(f.calls).toHaveLength(0);
    expect(f.deliveredApprovals).toEqual([pending.approval!.approvalId]);
    expect((await f.invoke()).approval).toEqual(pending.approval);
    expect(f.approvals.getPending()).toHaveLength(1);
    expect(f.approvals.demoteAllPendingInline()).toBe(0);
    const deferred = new DeferredExecutor(f.approvals, new AuditTrail());
    deferred.setToolRegistry(f.registry);
    const decision = await applyApprovalDecision('approve', pending.approval!.approvalId, 'test-user', {
      approvalManager: f.approvals, deferredExecutor: deferred });
    expect(decision).toMatchObject({ status: 'approved', executed: false });
    expect(await deferred.executeApproved(pending.approval!.approvalId)).toContain('Workflow-owned');
    expect(f.calls).toHaveLength(0);
    expect(resumeResolvedWorkflowEffects()).toBe(0); // engine has not parked yet
    updateRun(f.run.id, { status: 'PAUSED' });
    expect(resumeResolvedWorkflowEffects()).toBe(1);
    expect(resumeResolvedWorkflowEffects()).toBe(0);
    updateRun(f.run.id, { status: 'RUNNING' });
    await f.invoke(); await f.invoke();
    expect(f.calls).toHaveLength(1);
    expect(f.approvals.getRequest(pending.approval!.approvalId)!.status).toBe('executed');
  });

  for (const outcome of ['denied', 'expired', 'pause', 'kill', 'policy-change', 'canceled'] as const) {
    test(`approved effect rechecks ${outcome} before dispatch`, async () => {
      const f = fixture(); f.authority.setGovernedCategories(['write_data']);
      const reply = await f.invoke(), id = reply.approval!.approvalId;
      if (outcome === 'denied') f.approvals.deny(id, 'test');
      else if (outcome === 'expired') f.approvals.expireOld(-1);
      else {
        f.approvals.approve(id, 'test');
        if (outcome === 'pause' || outcome === 'kill') f.emergency[outcome]();
        if (outcome === 'policy-change') f.authority.addOverride({ action: 'write_data', allowed: false });
        if (outcome === 'canceled') updateRun(f.run.id, { status: 'STOPPED' });
      }
      await expect(f.invoke()).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    });
  }

  test('approval cannot authorize changed parameters or an edited version', async () => {
    const f = fixture(); f.authority.setGovernedCategories(['write_data']);
    const reply = await f.invoke(); f.approvals.approve(reply.approval!.approvalId, 'test');
    await expect(f.backends.toolsInvoke!({ toolName: 'write_file', params: { path: '/different', content: 'hello' } }, f.context)).rejects.toThrow(/changed/);
    updateDraftVersion(f.version.id, { trigger: { ...f.version.trigger, displayName: 'edited after review' } });
    await expect(f.invoke()).rejects.toThrow(/changed/);
    expect(f.calls).toHaveLength(0);
  });

  test('builtin target is pinned to the reviewed sidecar, not a later default', async () => {
    const previous = getSidecarManager();
    let inventory = [{ id: 'computer-a', name: 'A', connected: true, capabilities: ['filesystem'] }];
    setSidecarManagerRef({ listSidecars: () => inventory, getConnectionSessionId: (id: string) => `session-${id}` } as any);
    try {
      const f = fixture(); f.authority.setGovernedCategories(['write_data']);
      const pending = await f.invoke();
      inventory = [{ id: 'computer-b', name: 'B', connected: true, capabilities: ['filesystem'] }, ...inventory];
      f.approvals.approve(pending.approval!.approvalId, 'test');
      await f.invoke();
      expect(f.calls[0]).toMatchObject({ target: 'computer-a' });
      expect(listWorkflowEffects(f.run.id)[0]!.target).toMatchObject({ sidecarId: 'computer-a' });
    } finally { setSidecarManagerRef(previous as any); }
  });

  test('a new sidecar cannot redirect an approved local write', async () => {
    const previous = getSidecarManager();
    let inventory: unknown[] = [];
    setSidecarManagerRef({ listSidecars: () => inventory } as any);
    try {
      const f = fixture(); f.authority.setGovernedCategories(['write_data']);
      const pending = await f.invoke();
      inventory = [{ id: 'computer-b', name: 'B', connected: true, capabilities: ['filesystem'] }];
      f.approvals.approve(pending.approval!.approvalId, 'test');
      await f.invoke();
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).not.toHaveProperty('target');
      expect(listWorkflowEffects(f.run.id)[0]!.target).toMatchObject({ selection: 'local-host', sidecarId: null });
    } finally { setSidecarManagerRef(previous as any); }
  });

  test('missing identity and a different project never dispatch', async () => {
    const f = fixture();
    for (const context of [{ ...f.context, projectId: 'another' }, { ...f.context, stepName: undefined },
      { ...f.context, executionPath: [['absent-loop', 1]] as [string, number][] }]) {
      await expect(f.backends.toolsInvoke!({ toolName: 'write_file', params: {} }, context)).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
  });

  test('a refused capability is audited, not silently rejected', async () => {
    const f = fixture();
    f.registry.register({ name: 'run_command', category: 'terminal', description: 'Synthetic shell', parameters: {},
      execute: async () => 'ran' });
    await expect(f.backends.toolsInvoke!({ toolName: 'run_command', params: { command: 'id' } }, f.context))
      .rejects.toThrow(/opaque code\/UI effects/);
    expect(f.calls).toHaveLength(0);
    // The refusal happens before any effect record exists, so the audit row is
    // the only trace of it. It records the tool's real category, not read_data.
    const rows = new AuditTrail().query({ agentId: `workflow:${f.run.id}` });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_name: 'run_command', action_category: 'execute_command',
      authority_decision: 'denied', executed: 0 });
  });

  test('unmapped tools do not default to read_data', async () => {
    const f = fixture();
    f.registry.register({ name: 'mystery_sender', description: 'Unknown effect', category: 'general', parameters: {},
      execute: async () => { f.calls.push('bad'); } });
    await expect(f.backends.toolsInvoke!({ toolName: 'mystery_sender', params: {} }, f.context)).rejects.toThrow(/Unsupported/);
    expect(f.calls).toHaveLength(0);
  });

  for (const missing of ['authorityEngine', 'emergencyController', 'auditTrail'] as const) test(`missing ${missing} fails closed`, async () => {
    const f = fixture();
    const services = buildSandboxServiceBackends({ ...f.options, [missing]: undefined });
    await expect(services.toolsInvoke!({ toolName: 'write_file', params: {} }, f.context)).rejects.toThrow(/unavailable/);
    expect(f.calls).toHaveLength(0);
  });

  test('notification approval freezes expanded channels and recipient identities', async () => {
    const f = fixture('notify');
    f.options.channelService.getChannelStatus = () => ({ telegram: true } as any);
    f.authority.setGovernedCategories(['send_message']);
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    (ws as any).wsServer.broadcast = () => { f.calls.push('dashboard'); };
    ws.setChannelService({ broadcastToAll: async () => { f.calls.push('unapproved-recipient'); } } as any);
    f.options.wsService = ws;
    const req = { message: 'hello', channels: ['auto'], priority: 'high' as const };
    const pending = await f.backends.notify!(req, f.context);
    expect(f.calls).toHaveLength(0);
    f.options.channelService.getBroadcastRecipient = () => 'new-recipient';
    f.options.channelService.getChannelStatus = () => ({ discord: true } as any);
    f.approvals.approve(pending.approval!.approvalId, 'test');
    const result = await f.backends.notify!(req, f.context);
    expect(result.delivered).toEqual(['dashboard', 'telegram']);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toEqual(['telegram', 'recipient-at-review', 'hello']);
    expect(listWorkflowEffects(f.run.id)[0]!.target).toMatchObject({ recipients: { telegram: 'recipient-at-review' } });
  });

  test('emergency during notification fan-out blocks later channels and records partial delivery', async () => {
    const f = fixture('notify');
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    (ws as any).wsServer.broadcast = () => { f.calls.push('dashboard'); f.emergency.pause(); };
    ws.setChannelService({ broadcastToAll: async () => { f.calls.push('unapproved-recipient'); } } as any);
    f.options.wsService = ws;
    const reply = await f.backends.notify!({ message: 'hello', channels: ['dashboard', 'telegram'], priority: 'high' }, f.context);
    expect(reply.delivered).toEqual(['dashboard']);
    expect(reply.failed[0]).toMatchObject({ channel: 'telegram' });
    expect(reply.failed[0]!.error).toContain('paused');
    expect(f.calls).toEqual(['dashboard']);
    expect(listWorkflowEffects(f.run.id)[0]!.result).toEqual(reply);
  });

  test('trusted typed adapter uses its declared business category and target', async () => {
    const f = fixture();
    f.registry.register({ name: 'send_invoice_email', category: 'integration', description: 'Typed email', parameters: {},
      workflowEffect: { category: 'send_email', target: params => ({ recipient: params.to }) },
      execute: async args => { f.calls.push(args); return 'sent'; } });
    f.authority.addOverride({ action: 'send_email', allowed: false });
    await expect(f.backends.toolsInvoke!({ toolName: 'send_invoice_email', params: { to: 'billing@example.test' } }, f.context)).rejects.toThrow(/denied/);
    expect(f.calls).toHaveLength(0);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ actionCategory: 'send_email', target: { recipient: 'billing@example.test' }, status: 'blocked' });
  });

  for (const tool of ['run_command', 'browser_click', 'browser_evaluate']) test(`${tool} cannot hide undeclared business effects`, async () => {
    const f = fixture();
    f.registry.register({ name: tool, description: 'Opaque effect', category: 'browser', parameters: {}, execute: async () => { f.calls.push('unsafe'); } });
    await expect(f.backends.toolsInvoke!({ toolName: tool, params: {} }, f.context)).rejects.toThrow(/opaque/);
    expect(f.calls).toHaveLength(0);
  });

  test('a canceled run refuses through the shared cancellation fence', async () => {
    const f = fixture();
    cancelFlowRun(f.run.id);
    // The boundary defers to runtime/cancellation rather than reading job rows,
    // so it refuses on the same fence the daemon's other dispatch points use.
    await expect(f.invoke()).rejects.toThrow(WorkflowCancellationError);
    expect(f.calls).toHaveLength(0);
  });

  test('the ambient execution scope carries Authority state, not just cancellation', async () => {
    const f = fixture();
    let refusal: string | null = null;
    // Deep dispatch points (TTS chunks, channel adapters) only have
    // `checkpointExecution()`. Inside a governed effect that has to refuse on
    // emergency state too, or a pause mid-fan-out would go unnoticed.
    f.registry.unregister('write_file');
    f.registry.register({ name: 'write_file', category: 'file-ops', description: 'Synthetic write', parameters: {},
      execute: async () => {
        f.emergency.pause();
        try { checkpointExecution(); } catch (error) { refusal = (error as Error).message; throw error; }
        f.calls.push('dispatched-after-pause');
        return 'saved';
      } });
    await expect(f.backends.toolsInvoke!({ toolName: 'write_file',
      params: { path: '/tmp/synthetic', content: 'hello' } }, f.context)).rejects.toThrow(/paused/i);
    expect(refusal).toMatch(/paused/i);
    expect(f.calls).toHaveLength(0);
  });

  test('concurrent callers cannot dispatch the same effect twice', async () => {
    const f = fixture();
    let release!: () => void;
    f.registry.get('write_file')!.execute = async () => { f.calls.push('dispatch'); await new Promise<void>(resolve => { release = resolve; }); return 'done'; };
    const first = f.invoke();
    await expect(f.invoke()).rejects.toThrow(/in flight|uncertain/);
    release(); await first;
    expect(f.calls).toHaveLength(1);
  });

  test('slow approval delivery cannot overwrite a completed concurrent invocation', async () => {
    const f = fixture(); f.authority.setGovernedCategories(['write_data']);
    let finishDelivery!: () => void;
    const backends = buildSandboxServiceBackends({ ...f.options,
      onWorkflowApproval: () => new Promise<void>(resolve => { finishDelivery = resolve; }),
    });
    const first = backends.toolsInvoke!({ toolName: 'write_file', params: { path: '/tmp/synthetic', content: 'hello' } }, f.context);
    f.approvals.approve(f.approvals.getPending()[0]!.id, 'test');
    await f.invoke();
    finishDelivery();
    expect(await first).toMatchObject({ result: 'saved' });
    expect(f.calls).toHaveLength(1);
    expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('succeeded');
  });

  test('a failed dispatch never retries automatically', async () => {
    const f = fixture();
    f.registry.get('write_file')!.execute = async () => { f.calls.push('attempt'); throw new Error('remote timeout'); };
    await expect(f.invoke()).rejects.toThrow('remote timeout');
    await expect(f.invoke()).rejects.toThrow(/partial effects/);
    expect(f.calls).toHaveLength(1);
    expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('failed');
    expect(new AuditTrail().query({ agentId: `workflow:${f.run.id}` }).every(entry => entry.executed === 0)).toBe(true);
  });

  test('Authority waitpoints cannot be resumed through generic webhooks, and effects are inspectable', async () => {
    const f = fixture(); f.authority.setGovernedCategories(['write_data']);
    const pending = await f.invoke(); updateRun(f.run.id, { status: 'PAUSED' });
    const routes = createWorkflowRoutes();
    const request = Object.assign(new Request('http://localhost/'), { params: { id: pending.approval!.waitpointId } });
    const response = await routes['/api/webhooks/waitpoints/:id']!.POST!(request);
    expect(response.status).toBe(403);
    const inspection = await routes['/api/workflow-runs/:runId/effects']!.GET!(Object.assign(new Request('http://localhost/'), { params: { runId: f.run.id } }));
    const body = await inspection.json() as any;
    expect(body.effects[0]).toMatchObject({ approvalId: pending.approval!.approvalId, status: 'pending' });
    expect(f.calls).toHaveLength(0);
  });

  test('delegated agents retain their governed tool path under the workflow gate', async () => {
    const f = fixture('agent');
    const role = { id: 'workflow-default', name: 'Workflow role', description: '', responsibilities: [], tools: ['file-ops'] };
    let requests = 0, spawns = 0;
    const options = { ...f.options,
      agentSpecialists: new Map([[role.id, role]]) as any,
      agentOrchestrator: { getPrimary: () => ({ id: 'primary' }), terminateAgent: () => {}, spawnSubAgent: () => {
        spawns++;
        return { id: 'child', agent: { role, authority: { allowed_tools: ['file-ops'], max_authority_level: 10 } },
          setTask: () => {}, activate: () => {}, addMessage: () => {}, getMessages: () => [], idle: () => {} };
      } } as any,
      llmManager: { chatTier: async () => {
        requests++;
        return { content: requests === 1 ? '' : 'Finished checking', finish_reason: requests === 1 ? 'tool_use' : 'end_turn',
          tool_calls: requests === 1 ? [{ id: 'call', name: 'write_file', arguments: {} }] : [],
          usage: { input_tokens: 1, output_tokens: 1 } };
      } } as any,
    };
    f.authority.addOverride({ action: 'write_data', allowed: false });
    const service = buildSandboxServiceBackends(options);
    const reply = await service.agentDelegate!({ goal: 'Check a write', maxIterations: 2 }, f.context);
    expect(spawns).toBe(1);
    expect(reply.status).toBe('completed');
    expect(reply.toolCalls[0]!.result).toContain('AUTHORITY DENIED');
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ route: 'agent', target: { role: 'workflow-default' } });
  });

  test('a child workflow start obeys emergency and Authority before enqueue', async () => {
    const f = fixture('workflow');
    const child = createFlow(); createDraftVersion({ flowId: child.id, displayName: 'child' });
    f.authority.addOverride({ action: 'spawn_agent', allowed: false });
    await expect(f.backends.workflowsStart!({ flowId: child.id }, f.context)).rejects.toThrow(/denied/);
    expect((getWorkflowDb().query('SELECT id FROM workflow_job').all())).toHaveLength(0);
  });

  test('approved effect and dispatch result survive a database restart', async () => {
    closeWorkflowDb();
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-authority-'));
    const path = join(directory, 'test.db');
    try {
      initWorkflowDb(path);
      const f = fixture(); f.authority.setGovernedCategories(['write_data']);
      const reply = await f.invoke();
      closeWorkflowDb(); initWorkflowDb(path);
      expect(new ApprovalManager().demoteAllPendingInline()).toBe(0);
      new ApprovalManager().approve(reply.approval!.approvalId, 'after-restart');
      await f.invoke();
      closeWorkflowDb(); initWorkflowDb(path);
      expect(await f.invoke()).toMatchObject({ result: 'saved' });
      expect(f.calls).toHaveLength(1);
      expect(listWorkflowEffects(f.run.id)[0]!.approvalId).toBe(reply.approval!.approvalId);
    } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('a crash during dispatch leaves a durable uncertain outcome', async () => {
    closeWorkflowDb();
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-uncertain-'));
    const path = join(directory, 'test.db');
    try {
      initWorkflowDb(path);
      const f = fixture(); f.authority.setGovernedCategories(['write_data']);
      const reply = await f.invoke(); f.approvals.approve(reply.approval!.approvalId, 'test');
      const effect = listWorkflowEffects(f.run.id)[0]!;
      saveWorkflowEffect({ ...effect, status: 'dispatching' });
      closeWorkflowDb(); initWorkflowDb(path);
      await expect(f.invoke()).rejects.toThrow(/uncertain/);
      expect(f.calls).toHaveLength(0);
    } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
  });

  for (const state of ['allowed', 'denied', 'paused'] as const) test(`real engine rejects inline effects before dispatch when ${state}`, async () => {
    const f = fixture();
    let requests = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { requests++; return new Response('synthetic'); } });
    const expression = `{{fetch("http://127.0.0.1:${server.port}/synthetic")}}`;
    const action = f.version.trigger.nextAction!;
    action.settings!.input = { toolName: 'write_file', params: { path: '/tmp/synthetic', content: expression } };
    updateDraftVersion(f.version.id, { trigger: { ...f.version.trigger, nextAction: state === 'denied'
      ? { name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: expression }, firstLoopAction: action } : action } });
    if (state === 'denied') f.authority.addOverride({ action: 'write_data', allowed: false });
    if (state === 'paused') f.emergency.pause();
    const api = new SandboxApi({ services: f.backends });
    await api.start({ port: 0 });
    const bundle = await buildEngineBundle(); await buildAllJarvisPieces();
    const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({
      executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }),
    }) } });
    try {
      // The fixture parks the run RUNNING so direct boundary calls resolve their
      // identity. A worker-driven BEGIN owns that transition itself and refuses a
      // run that is not QUEUED, so hand it back before enqueueing.
      updateRun(f.run.id, { status: 'QUEUED' });
      enqueue({ jobType: 'RUN_FLOW', flowRunId: f.run.id, maxAttempts: 1, payload: { runId: f.run.id } });
      await worker.drain();
      expect(getFlowRun(f.run.id)!.status).toBe('FAILED');
      expect(getFlowRun(f.run.id)!.failedStep?.errorMessage).toContain('Unsupported workflow expression');
      expect(requests).toBe(0); expect(f.calls).toHaveLength(0);
      expect(listWorkflowEffects(f.run.id)).toHaveLength(0);
    } finally { await runtime.shutdown(); await api.stop(); server.stop(true); }
  }, 60_000);

  test('approved step preview retains scope and sample inputs after restart and job cleanup', async () => {
    closeWorkflowDb();
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-preview-approval-'));
    const path = join(directory, 'test.db');
    initWorkflowDb(path);
    const f = fixture();
    const action = f.version.trigger.nextAction!;
    action.settings!.input = { toolName: 'write_file', params: { path: '/wrong', content: 'production' } };
    action.nextAction = { ...action, name: 'after', nextAction: undefined };
    updateDraftVersion(f.version.id, { trigger: { ...f.version.trigger,
      nextAction: { ...action, name: 'before', nextAction: action } } });
    f.authority.setGovernedCategories(['write_data']);
    const api = new SandboxApi({ services: f.backends });
    await api.start({ port: 0 });
    const bundle = await buildEngineBundle();
    await buildAllJarvisPieces();
    const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
    const makeWorker = () => new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({
      executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }),
    }) } });
    try {
      // The fixture parks the run RUNNING so direct boundary calls resolve their
      // identity. A worker-driven BEGIN owns that transition itself and refuses a
      // run that is not QUEUED, so hand it back before enqueueing.
      updateRun(f.run.id, { status: 'QUEUED' });
      enqueue({ jobType: 'RUN_FLOW', flowRunId: f.run.id, maxAttempts: 1, payload: {
        runId: f.run.id, stepNameToTest: 'action', sampleData: { before: { text: 'reviewed sample' } },
        sampleInputOverride: { action: { toolName: 'write_file', params: { path: '/preview', content: '{{before.text}}' } } },
      } });
      await makeWorker().drain();
      expect(getFlowRun(f.run.id)!.status).toBe('PAUSED');
      expect(f.calls).toHaveLength(0);
      const effect = listWorkflowEffects(f.run.id)[0]!;
      expect(effect.arguments).toMatchObject({ path: '/preview', content: 'reviewed sample' });
      // Continuation must not depend on retained queue history or live sample settings.
      getWorkflowDb().run("DELETE FROM workflow_job WHERE flow_run_id=?", [f.run.id]);
      setSampleDataEntry(f.version.id, 'before', { text: 'later sample' });
      setSampleInputEntry(f.version.id, 'action', { toolName: 'write_file', params: { path: '/later' } });
      closeWorkflowDb(); initWorkflowDb(path);
      new ApprovalManager().approve(effect.approvalId!, 'after-restart');
      expect(resumeResolvedWorkflowEffects()).toBe(1);
      await makeWorker().drain();
      expect(getFlowRun(f.run.id)!.status).toBe('SUCCEEDED');
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ path: '/preview', content: 'reviewed sample' });
      expect(listWorkflowEffects(f.run.id).map(item => item.stepName)).toEqual(['action']);
    } finally {
      await runtime.shutdown(); await api.stop(); closeWorkflowDb();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  for (const route of ['tool', 'notify'] as const) test(`${route}: real engine and worker pause, resume and preserve loop identity`, async () => {
    const f = fixture(route);
    const action = f.version.trigger.nextAction!;
    action.settings!.input = route === 'tool' ? { toolName: 'write_file', params: { path: '/tmp/synthetic', content: 'hello' } }
      : { message: 'hello', channels: ['dashboard'], priority: 'normal' };
    updateDraftVersion(f.version.id, { trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
      name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.items}}' }, firstLoopAction: action,
    } } });
    f.authority.setGovernedCategories([route === 'tool' ? 'write_data' : 'send_message']);
    const api = new SandboxApi({ services: f.backends });
    await api.start({ port: 0 });
    const bundle = await buildEngineBundle();
    await buildAllJarvisPieces();
    const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({
      executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }),
    }) } });
    try {
      // The fixture parks the run RUNNING so direct boundary calls resolve their
      // identity. A worker-driven BEGIN owns that transition itself and refuses a
      // run that is not QUEUED, so hand it back before enqueueing.
      updateRun(f.run.id, { status: 'QUEUED' });
      enqueue({ jobType: 'RUN_FLOW', flowRunId: f.run.id, maxAttempts: 1, payload: { runId: f.run.id, payload: { items: [1, 2] } } });
      await worker.drain();
      expect(getFlowRun(f.run.id)!.status).toBe('PAUSED');
      expect(getFlowRun(f.run.id)!.finishTime).toBeNull();
      expect(f.calls).toHaveLength(0);
      f.approvals.approve(f.approvals.getPending()[0]!.id, 'test');
      expect(resumeResolvedWorkflowEffects()).toBe(1);
      await worker.drain();
      expect(getFlowRun(f.run.id)!.status).toBe('PAUSED');
      expect(f.calls).toHaveLength(1);
      expect(f.approvals.getPending()).toHaveLength(1);
      f.approvals.approve(f.approvals.getPending()[0]!.id, 'test');
      expect(resumeResolvedWorkflowEffects()).toBe(1);
      await worker.drain();
      expect(getFlowRun(f.run.id)!.status).toBe('SUCCEEDED');
      expect(f.calls).toHaveLength(2);
      expect(listWorkflowEffects(f.run.id).map(effect => effect.executionPath)).toEqual([[['loop', 0]], [['loop', 1]]]);
    } finally { await runtime.shutdown(); await api.stop(); }
  }, 60_000);
});
