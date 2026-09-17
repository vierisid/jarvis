import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, updateDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { listDelegations } from '../db/repos/delegation';
import { enqueue } from '../db/repos/job-queue';
import { ToolRegistry } from '../../actions/tools/registry';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { resumeResolvedWorkflowEffects } from './effect-approval-scheduler';
import { createJarvisAgentDelegateRoute } from '../sandbox-api/routes/jarvis-agent';
import { SandboxApi } from '../sandbox-api/server';
import { buildEngineBundle, findCachedBundle } from '../runner/engine-runtime/build';
import { buildAllJarvisPieces } from '../runner/engine-runtime/build-pieces';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { createRunFlowHandler } from '../runner/handler';
import { Worker } from '../queue/worker';

let directory: string, dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-delegated-approval-'));
  dbPath = join(directory, 'workflow.db');
  initWorkflowDb(dbPath);
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

const PIECE = '@jarvispieces/piece-jarvis-agent';
const ROLE = { id: 'workflow-default', name: 'Workflow role', description: '', responsibilities: [], tools: ['file-ops'] };
const ARGS = { path: '/tmp/synthetic', content: 'hello' };

/** The run and version live in the database; everything in memory can be rebuilt on the same ids. */
function createRun(input: Record<string, unknown> = {}) {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Delegated routine', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'delegate', type: 'PIECE', displayName: 'delegate', settings: { pieceName: PIECE, pieceVersion: '0.0.1',
      actionName: 'delegate', input: { goal: 'Save the note', maxIterations: 4, ...input } } } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  return { flow, version, run };
}

/** Real backends, boundary, Authority and SQLite; only the model and the tool are scripted. */
function backends(ids: ReturnType<typeof createRun>, opts: { neverCalls?: boolean } = {}) {
  let effects = 0, llmCalls = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'write_file', category: 'file-ops', description: 'Synthetic write', parameters: {},
    execute: async () => { effects++; return 'saved'; } });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: ['write_data'] as any, overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const child = () => {
    const history: Array<{ role: string; content: unknown }> = [];
    return { id: 'child', agent: { role: ROLE, authority: { allowed_tools: ['file-ops'], max_authority_level: 10 } },
      setTask() {}, activate() {}, idle() {}, addMessage: (role: string, content: unknown) => history.push({ role, content }),
      getMessages: () => history };
  };
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    toolRegistry: registry, authorityEngine: authority, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    approvalManager: approvals,
    agentOrchestrator: { getPrimary: () => ({ id: 'primary' }), spawnSubAgent: child, terminateAgent: () => {} } as any,
    agentSpecialists: new Map([[ROLE.id, ROLE]]) as any,
    agentScopedRegistry: () => registry,
    llmManager: { chatTier: async (_tier: string, _origin: string, messages: Array<{ role: string }>) => {
      llmCalls++;
      // Ask for the write once; wrap up once the write has an answer.
      const answered = messages[messages.length - 1]!.role === 'tool';
      if (answered || opts.neverCalls) return { content: 'Saved the note', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } };
      return { content: '', finish_reason: 'tool_use', tool_calls: [{ id: 'call-1', name: 'write_file', arguments: ARGS }],
        usage: { input_tokens: 1, output_tokens: 1 } };
    } } as any,
    channelService: {} as any, wsService: {} as any });
  const context = { runId: ids.run.id, projectId: DEFAULT_IDS.project, stepName: 'delegate', executionPath: [] as Array<[string, number]> };
  const delegate = (extra: Record<string, unknown> = {}) => services.agentDelegate!({ goal: 'Save the note', maxIterations: 4, ...extra }, context);
  const route = (body: Record<string, unknown> = {}) => createJarvisAgentDelegateRoute(services)({
    req: new Request('http://127.0.0.1/v1/jarvis/agent/delegate', { method: 'POST',
      headers: { 'X-Jarvis-Step-Name': 'delegate', 'X-Jarvis-Execution-Path': '[]' },
      body: JSON.stringify({ goal: 'Save the note', maxIterations: 4, ...body }) }),
    claims: { runId: ids.run.id, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {} });
  return { services, approvals, delegate, route, effects: () => effects, llmCalls: () => llmCalls };
}

const audit = () => (getWorkflowDb().query('SELECT agent_id, tool_name, authority_decision, executed FROM audit_trail ORDER BY rowid')
  .all() as Array<Record<string, unknown>>).map(row => [row.agent_id, row.tool_name, row.authority_decision, Boolean(row.executed)]);

describe('delegated approvals through the workflow effect boundary', () => {
  test('a governed tool parks the delegation before any effect, bound to run, step, tool and arguments', async () => {
    const ids = createRun();
    const f = backends(ids);
    const reply = await f.delegate();
    expect(reply.status).toBe('approval_required');
    expect(reply.approval).toMatchObject({ effectId: expect.any(String), approvalId: expect.any(String), waitpointId: expect.any(String) });
    expect(f.effects()).toBe(0);
    expect(f.llmCalls()).toBe(1);

    const effects = listWorkflowEffects(ids.run.id);
    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatchObject({ route: 'agent', status: 'succeeded', result: { dispatch: 'authorized' }, target: { role: 'workflow-default' } });
    expect(effects[1]).toMatchObject({ route: 'agent-tool:1', status: 'pending', toolName: 'write_file', actionCategory: 'write_data',
      decision: 'approval_required', stepName: 'delegate', versionId: ids.version.id, arguments: ARGS,
      target: { tool: 'write_file', sequence: 1 }, approvalId: reply.approval!.approvalId, waitpointId: reply.approval!.waitpointId });
    const [pending] = f.approvals.getPending();
    expect(f.approvals.getPending()).toHaveLength(1);
    expect(pending).toMatchObject({ tool_name: 'write_file', execution_mode: 'workflow', action_category: 'write_data' });
    // Frozen arguments, canonical key order; the approval is bound to exactly these.
    expect(JSON.parse(pending!.tool_arguments)).toEqual(ARGS);
    expect(JSON.parse(pending!.context)).toMatchObject({ effectId: reply.approval!.effectId, runId: ids.run.id, stepName: 'delegate',
      versionId: ids.version.id, target: { tool: 'write_file', sequence: 1 } });

    const [checkpoint] = listDelegations(ids.run.id);
    expect(checkpoint).toMatchObject({ status: 'paused', runId: ids.run.id, stepName: 'delegate', roleId: 'workflow-default',
      goal: 'Save the note', sequence: 1,
      pending: { toolCall: { id: 'call-1', name: 'write_file', arguments: ARGS }, sequence: 1, remaining: [], iteration: 0, approval: reply.approval } });
    expect(checkpoint!.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(audit()).toEqual([
      [`workflow:${ids.run.id}`, 'workflow_delegate', 'allowed', true],
      [`workflow:${ids.run.id}`, 'write_file', 'approval_required', false],
      ['child', 'write_file', 'approval_required', false],
    ]);
  });

  test('approval resumes the delegation: the tool runs once and the conversation finishes', async () => {
    const ids = createRun();
    const f = backends(ids);
    const parked = await f.delegate();
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate();
    expect(done).toMatchObject({ status: 'completed', finalMessage: 'Saved the note', outcome: { status: 'succeeded' } });
    expect(done.toolCalls).toHaveLength(1);
    expect(done.toolCalls[0]).toMatchObject({ name: 'write_file', args: JSON.stringify(ARGS) });
    expect(done.toolCalls[0]!.result).toContain('saved');
    expect(done.toolCalls[0]!.error).toBeUndefined();
    expect(f.effects()).toBe(1);
    expect(f.llmCalls()).toBe(2);
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'succeeded', result: 'saved' });
    expect(f.approvals.getRequest(parked.approval!.approvalId)).toMatchObject({ status: 'executed' });
    expect(listDelegations(ids.run.id)[0]).toMatchObject({ status: 'completed', messages: [], result: { status: 'completed' } });
    // The boundary audits the dispatch it made under the approval; the gate wrote nothing new.
    expect(audit().at(-1)).toEqual([`workflow:${ids.run.id}`, 'write_file', 'approval_required', true]);
    expect(audit()).toHaveLength(4);

    // The engine running the step again gets the record, not a new conversation.
    expect(await f.delegate()).toEqual(done);
    expect(f.effects()).toBe(1);
    expect(f.llmCalls()).toBe(2);
  });

  test('a declined approval resumes with a denial the agent acts on, and the declared outcome says so', async () => {
    const ids = createRun();
    const f = backends(ids);
    const parked = await f.delegate({ requiredTools: ['write_file'] });
    f.approvals.deny(parked.approval!.approvalId, 'test');
    const done = await f.delegate({ requiredTools: ['write_file'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toMatch(/^\[APPROVAL DENIED\] write_file: Workflow approval denied/);
    expect(done.outcome).toMatchObject({ status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED', effect: 'may_have_occurred',
      message: expect.stringContaining('write_file') });
    expect(f.effects()).toBe(0);
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'blocked', decision: 'denied' });
  });

  test('the parked delegation survives a restart and resumes in a new process', async () => {
    const ids = createRun();
    const before = backends(ids);
    const parked = await before.delegate();
    closeWorkflowDb();
    initWorkflowDb(dbPath);
    const after = backends(ids);
    after.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await after.delegate();
    expect(done).toMatchObject({ status: 'completed', finalMessage: 'Saved the note', outcome: { status: 'succeeded' } });
    expect(after.effects()).toBe(1);
    expect(before.effects()).toBe(0);
    // Only the wrap-up turn ran in the new process; the earlier turn came from the checkpoint.
    expect(after.llmCalls()).toBe(1);
  });

  test('an edited version cannot resume a parked delegation', async () => {
    const ids = createRun();
    const f = backends(ids);
    const parked = await f.delegate();
    f.approvals.approve(parked.approval!.approvalId, 'test');
    updateDraftVersion(ids.version.id, { trigger: { ...ids.version.trigger, displayName: 'edited' } as any });
    await expect(f.delegate()).rejects.toThrow(/changed/);
    expect(f.effects()).toBe(0);
  });

  test('a changed goal cannot resume a parked delegation', async () => {
    const ids = createRun();
    const f = backends(ids);
    const parked = await f.delegate();
    f.approvals.approve(parked.approval!.approvalId, 'test');
    await expect(f.delegate({ goal: 'Save a different note' })).rejects.toThrow(/changed/);
    expect(f.effects()).toBe(0);
  });

  test('the route maps the declared outcome to status codes and validates the declaration', async () => {
    const quiet = createRun();
    const g = backends(quiet, { neverCalls: true });
    expect((await g.route({ requiredTools: 'write_file' })).status).toBe(400);
    expect((await g.route({ requireSuccess: 'no' })).status).toBe(400);
    const unmet = await g.route({ requiredTools: ['write_file'] });
    expect(unmet.status).toBe(422);
    expect(await unmet.json()).toMatchObject({ status: 'completed', finalMessage: 'Saved the note',
      outcome: { status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED' } });
    const handled = await g.route({ requiredTools: ['write_file'], requireSuccess: false });
    expect(handled.status).toBe(200);
    expect(await handled.json()).toMatchObject({ outcome: { code: 'REQUIRED_TOOL_NOT_COMPLETED' } });
    expect(g.effects()).toBe(0);

    const governed = createRun();
    const h = backends(governed);
    const first = await h.route({ requiredTools: ['write_file'] });
    expect(first.status).toBe(202);
    const body = await first.json() as { approval: { approvalId: string } };
    h.approvals.approve(body.approval.approvalId, 'test');
    const second = await h.route({ requiredTools: ['write_file'] });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'completed', outcome: { status: 'succeeded' } });
    expect(h.effects()).toBe(1);
  });
});

describe('delegated approvals through the real engine', () => {
  const skip = findCachedBundle() === null && process.env.JARVIS_TEST_ENGINE_BUILD !== '1';

  test.skipIf(skip)('the piece parks the run, the decision resumes it, and the outcome is declared', async () => {
    const ids = createRun({ requiredTools: 'write_file' });
    const f = backends(ids);
    updateRun(ids.run.id, { status: 'QUEUED' });
    const api = new SandboxApi({ services: f.services });
    await api.start({ port: 0 });
    const bundle = await buildEngineBundle();
    await buildAllJarvisPieces();
    const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({
      executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }),
    }) } });
    try {
      enqueue({ jobType: 'RUN_FLOW', flowRunId: ids.run.id, maxAttempts: 1, payload: { runId: ids.run.id } });
      await worker.drain();
      expect(getFlowRun(ids.run.id)!.status).toBe('PAUSED');
      expect(f.effects()).toBe(0);
      expect(f.approvals.getPending()).toHaveLength(1);
      expect(listDelegations(ids.run.id)[0]).toMatchObject({ status: 'paused' });

      f.approvals.approve(f.approvals.getPending()[0]!.id, 'test');
      expect(resumeResolvedWorkflowEffects()).toBe(1);
      await worker.drain();
      expect(getFlowRun(ids.run.id)!.status).toBe('SUCCEEDED');
      expect(f.effects()).toBe(1);
      expect(listWorkflowEffects(ids.run.id).map(effect => [effect.route, effect.status])).toEqual([['agent', 'succeeded'], ['agent-tool:1', 'succeeded']]);
      expect(listDelegations(ids.run.id)[0]).toMatchObject({ status: 'completed',
        result: { status: 'completed', finalMessage: 'Saved the note', outcome: { status: 'succeeded' } } });
    } finally { await runtime.shutdown(); await api.stop(); }
  }, 60_000);
});
