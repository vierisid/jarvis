import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { deleteFlow } from '../db/repos/flow';
import { stopRunsOfDeletedFlow } from '../db/repos/flow-turn-off';
import { stopUnfinishedRunsForKill } from './emergency-hold';
import { signalRunEnded } from './cancellation-signals';
import { withRunCancellation } from './cancellation';
import { currentRunOwner } from '../../actions/run-owner-scope';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { ToolRegistry, type ToolDefinition, type ToolGate } from '../../actions/tools/registry';
import { AuthorityEngine, type AuthorityConfig } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { approvalIntentFields } from '../../authority/approval-delivery';
import { spendApproval } from '../../authority/approved-action-scope';
import { checkpointExecution } from '../../actions/execution-scope';
import { AgentOrchestrator } from '../../agents/orchestrator';
import { AgentTaskManager, RUN_STOPPED_REASON } from '../../agents/task-manager';
import { createManageAgentsTool, startPersistentAgent, type AgentToolDeps } from '../../actions/tools/agents';
import { createDelegateTool } from '../../actions/tools/delegate';
import type { RoleDefinition } from '../../roles/types';
import type { LLMManager } from '../../llm/manager';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';

/**
 * #988: a governed call a workflow-delegated sub-agent makes is parked on its
 * own card by the per-call boundary. Once that card is approved the call runs
 * inside the approval, as the deferred executor runs an approved card, so the
 * spawn sink it reaches does not ask a second time -- and only when the card
 * named what the call does, for the category it was approved as, spent by the
 * first lifecycle decision and gone when the call settles.
 */

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-delegated-call-scope-'));
  initWorkflowDb(join(directory, 'workflow.db'));
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

const PIECE = '@jarvispieces/piece-jarvis-agent';
const ROLE = { id: 'coordinator', name: 'Workflow role', description: '', responsibilities: [], tools: ['delegation'] as string[] };
const APPROVE_SPAWNS: AuthorityConfig['overrides'] = [{ action: 'spawn_agent', allowed: true, requires_approval: true }];

function role(id: string, tools: string[]): RoleDefinition {
  return { id, name: id.toUpperCase(), description: 'A role.', responsibilities: ['Things'], autonomous_actions: [],
    approval_required: [], tools, authority_level: 5 } as unknown as RoleDefinition;
}
/** The workflow's delegated role as a real role, for a delegation the real sink spawns. */
const COORDINATOR = { ...role(ROLE.id, ROLE.tools), name: ROLE.name };

/**
 * A workflow whose delegated agent makes one call, `name(args)`, from
 * `registry`. Spawns are governed for the workflow (so the delegation and the
 * call each take a card) and, through `inner`, for the primary at the sink.
 */
function setup(registry: ToolRegistry, name: string, args: Record<string, unknown>, approvals = new ApprovalManager(),
  opts: { childSpawnSpends?: boolean; orchestrator?: AgentOrchestrator } = {}) {
  const flow = createFlow({});
  const delegate: FlowTriggerNode = { name: 'delegate', type: 'PIECE', displayName: 'delegate', settings: { pieceName: PIECE,
    pieceVersion: '0.0.1', actionName: 'delegate', input: { goal: 'Coordinate', maxIterations: 3, role: ROLE.id } } };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Delegated routine', trigger: { name: 'trigger', type: 'EMPTY', nextAction: delegate } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const child = () => {
    // The real spawn sink spends the delegation's grant on this spawn
    // (`gateLifecycle`); `childSpawnSpends: false` leaves it unspent.
    if (opts.childSpawnSpends !== false) spendApproval('spawn_agent');
    const history: Array<{ role: string; content: unknown }> = [];
    return { id: 'child', agent: { role: ROLE, authority: { allowed_tools: ROLE.tools, max_authority_level: 10 } },
      setTask() {}, activate() {}, idle() {}, addMessage: (r: string, content: unknown) => history.push({ role: r, content }),
      getMessages: () => history };
  };
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    toolRegistry: registry,
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: ['spawn_agent', 'terminate_agent'] as never, overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), approvalManager: approvals,
    // One orchestrator, as in the daemon, when the call's own tools spawn from
    // it: the delegated agent is then a real agent the spawn sink can judge
    // (#1014). Otherwise a stand-in whose spawn only spends the grant.
    agentOrchestrator: opts.orchestrator ?? { getPrimary: () => ({ id: 'primary' }), getProfileFor: () => null, getTaintGating: () => null, spawnSubAgent: child, reapAgent: () => {} } as never,
    agentSpecialists: new Map([[ROLE.id, opts.orchestrator ? COORDINATOR : ROLE]]) as never,
    agentScopedRegistry: () => registry,
    llmManager: { chatTier: async (_tier: string, _origin: string, messages: Array<{ role: string }>) =>
      messages.some((m) => m.role === 'tool')
        ? { content: 'done', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }
        : { content: '', finish_reason: 'tool_use', tool_calls: [{ id: 'call-1', name, arguments: args }], usage: { input_tokens: 1, output_tokens: 1 } },
    } as never,
    channelService: {} as never, wsService: {} as never });
  const delegateNow = () => services.agentDelegate!({ goal: 'Coordinate', maxIterations: 3, role: ROLE.id },
    { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'delegate', executionPath: [] });
  /** Approve the delegation, and return the card the call is then parked on. */
  const park = async () => {
    const outer = await delegateNow();
    expect(outer.status).toBe('approval_required');
    approvals.approve(outer.approval!.approvalId, 'dashboard');
    const parked = await delegateNow();
    expect(parked.status).toBe('approval_required');
    const card = approvals.getRequest(parked.approval!.approvalId)!;
    expect(card.tool_name).toBe(name);
    return card;
  };
  /** `park`, then approve the call's card and resume; returns that card and the resumed reply. */
  const approveThrough = async () => {
    const card = await park();
    approvals.approve(card.id, 'dashboard');
    return { card, done: await delegateNow() };
  };
  return { approvals, run, park, delegateNow, approveThrough };
}

/** The primary the call's own tool spawns from, with spawns that need approval at the sink. */
function sink(approvals: ApprovalManager, opts: { spawnsNeedApproval?: boolean; taskRunsUntilStopped?: boolean; primaryTools?: string[] } = {}) {
  const orch = new AgentOrchestrator();
  orch.setAuthorityEngine(new AuthorityEngine({ default_level: 5, governed_categories: [],
    overrides: opts.spawnsNeedApproval === false ? [] : APPROVE_SPAWNS,
    context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
  orch.setApprovalManager(approvals);
  const audit = new AuditTrail();
  orch.setAuditTrail(audit);
  orch.setEmergencyController(new EmergencyController());
  const primary = orch.createPrimary(role('pa', opts.primaryTools ?? ['delegation']));
  const specialists = new Map([['spec', role('spec', ['browser'])]]);
  // Like the real loop: a model call (an await), then its dispatch fence.
  const taskManager = new AgentTaskManager((async (o: { signal?: AbortSignal }) => {
    if (opts.taskRunsUntilStopped) {
      await new Promise((r) => o.signal?.addEventListener('abort', r));
      return { success: false, canceled: true, response: 'stopped', toolsUsed: [], tokensUsed: { input: 1, output: 1 }, terminationReason: 'cancelled', messages: [] };
    }
    await new Promise((r) => setTimeout(r, 5));
    checkpointExecution();
    return { success: true, response: 'researched', toolsUsed: [], tokensUsed: { input: 1, output: 1 }, terminationReason: 'complete', messages: [] };
  }) as unknown as ConstructorParameters<typeof AgentTaskManager>[0]);
  const deps: AgentToolDeps = { orchestrator: orch, llmManager: {} as LLMManager, specialists, taskManager };
  const registry = new ToolRegistry();
  registry.register(createManageAgentsTool(deps));
  registry.register(createDelegateTool({ orchestrator: orch, specialists, llmManager: { chatTier: async () => ({ content: 'done',
    finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }) } as unknown as LLMManager }));
  orch.setToolRegistry(registry);
  const spawned = () => orch.getAllAgents().filter((a) => a.id !== primary.id);
  const spawnRows = () => audit.query({ action: 'spawn_agent' }).filter((r) => r.tool_name === 'spawn_agent(spec)');
  return { registry, spawned, spawnRows, taskManager, deps, audit, orch, primary };
}

describe('an approved workflow-delegated call is not asked again at the spawn sink (#988)', () => {
  test('an approved manage_agents spawn starts the agent on that card, with no second card', async () => {
    const approvals = new ApprovalManager();
    const s = sink(approvals);
    const f = setup(s.registry, 'manage_agents', { action: 'spawn', specialist: 'spec', task: 'research the thing' }, approvals, { orchestrator: s.orch });
    const { card, done } = await f.approveThrough();
    // The card the person approved said what it would start (it read "Manage agents").
    expect(approvalIntentFields(card).intent_action).toBe('Start a spec background agent on the task "research the thing"');
    expect(done.toolCalls[0]!.error).toBeUndefined();
    expect(s.spawned()).toHaveLength(1);
    expect(approvals.getPending()).toEqual([]);
    expect(s.spawnRows().map((r) => [r.authority_decision, r.executed, r.approval_id]))
      .toEqual([['approval_required', 1, card.id]]);
    // The task outlives the call, so it must not inherit the call's dispatch
    // fence: that fence refuses once the approval is executed, which killed
    // the task at its first model call.
    await new Promise((r) => setTimeout(r, 30));
    expect(s.taskManager.listTasks().map((t) => [t.status, t.result?.response])).toEqual([['completed', 'researched']]);
  });

  // Owner, #1018: a task started from a workflow dies with its run.
  test('a task the approved call started is cancelled when its run is stopped (#1018)', async () => {
    const approvals = new ApprovalManager();
    const s = sink(approvals, { taskRunsUntilStopped: true });
    const f = setup(s.registry, 'manage_agents', { action: 'spawn', specialist: 'spec', task: 'research the thing' }, approvals, { orchestrator: s.orch });
    const { done } = await f.approveThrough();
    expect(done.toolCalls[0]!.error).toBeUndefined();
    const [task] = s.taskManager.listTasks();
    expect(task).toMatchObject({ status: 'running', workflowRunId: f.run.id });
    expect(cancelFlowRun(f.run.id).accepted).toBe(true);
    for (let i = 0; i < 200 && s.taskManager.getTask(task!.id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 1));
    expect(s.taskManager.getTask(task!.id)).toMatchObject({ status: 'cancelled', cancelRequested: RUN_STOPPED_REASON });
  });

  test('a run that finishes on its own leaves the task it started running (#1018)', async () => {
    const approvals = new ApprovalManager();
    const s = sink(approvals, { taskRunsUntilStopped: true });
    const f = setup(s.registry, 'manage_agents', { action: 'spawn', specialist: 'spec', task: 'research the thing' }, approvals, { orchestrator: s.orch });
    await f.approveThrough();
    updateRun(f.run.id, { status: 'SUCCEEDED', finishTime: Date.now() });
    // A finished run cannot be stopped, so nothing reaches the task.
    expect(cancelFlowRun(f.run.id).accepted).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    const [task] = s.taskManager.listTasks();
    expect(task!.status).toBe('running');
    s.taskManager.cancel(task!.id);
  });

  /** The approved spawn's task, running until something cancels it. */
  async function ownedTask() {
    const approvals = new ApprovalManager();
    const s = sink(approvals, { taskRunsUntilStopped: true });
    const f = setup(s.registry, 'manage_agents', { action: 'spawn', specialist: 'spec', task: 'research the thing' }, approvals, { orchestrator: s.orch });
    await f.approveThrough();
    const [task] = s.taskManager.listTasks();
    expect(task).toMatchObject({ status: 'running', workflowRunId: f.run.id });
    const status = async () => {
      for (let i = 0; i < 200 && s.taskManager.getTask(task!.id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 1));
      return s.taskManager.getTask(task!.id)!;
    };
    return { s, f, task: task!, status };
  }

  test('deleting the workflow while its run executes cancels the task the run started (#1018)', async () => {
    const t = await ownedTask();
    expect(stopRunsOfDeletedFlow(t.f.run.flowId)).toBe(1);
    deleteFlow(t.f.run.flowId);
    expect(await t.status()).toMatchObject({ status: 'cancelled', cancelRequested: RUN_STOPPED_REASON });
  });

  test('Kill stops the run and cancels the task the run started (#1018, Q-08)', async () => {
    const t = await ownedTask();
    expect(stopUnfinishedRunsForKill()).toBe(1);
    expect(await t.status()).toMatchObject({ status: 'cancelled', cancelRequested: RUN_STOPPED_REASON });
  });

  test('a run that ended on its own releases its task: deleting the workflow later leaves it running (#1018)', async () => {
    const t = await ownedTask();
    updateRun(t.f.run.id, { status: 'SUCCEEDED', finishTime: Date.now() });
    signalRunEnded(t.f.run.id);
    stopRunsOfDeletedFlow(t.f.run.flowId);
    deleteFlow(t.f.run.flowId);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.s.taskManager.getTask(t.task.id)!.status).toBe('running');
    t.s.taskManager.cancel(t.task.id);
  });

  test('a run stops new tasks when stopped, gone, or turned off while live; once ended on its own it only reads as ended (#1018)', () => {
    const states = () => {
      const owner = withRunCancellation(f.run.id, () => currentRunOwner())!;
      return [owner.stopped(), owner.ended()];
    };
    const f = setup(new ToolRegistry(), 'manage_agents', {});
    expect(states()).toEqual([false, false]);
    getWorkflowDb().run("UPDATE flow SET status = 'DISABLED', disabled_at = ? WHERE id = ?", [Date.now() + 1, f.run.flowId]);
    expect(states()).toEqual([true, false]);
    updateRun(f.run.id, { status: 'SUCCEEDED', finishTime: Date.now() });
    expect(states()).toEqual([false, true]);
    getWorkflowDb().run('DELETE FROM flow_run WHERE id = ?', [f.run.id]);
    expect(states()).toEqual([true, false]);
  });

  // Q-06 lets a run executing at turn-off finish; it starts no new task (#1018 review).
  test('a run whose workflow was turned off while it executes starts no background task (#1018)', async () => {
    const approvals = new ApprovalManager();
    const s = sink(approvals, { taskRunsUntilStopped: true });
    const f = setup(s.registry, 'manage_agents', { action: 'spawn', specialist: 'spec', task: 'research the thing' }, approvals, { orchestrator: s.orch });
    getWorkflowDb().run("UPDATE flow SET status = 'DISABLED', disabled_at = ? WHERE id = ?", [Date.now() + 1, f.run.flowId]);
    const { done } = await f.approveThrough();
    expect(String(done.toolCalls[0]!.error ?? done.toolCalls[0]!.result)).toContain('turned off');
    expect(s.taskManager.listTasks()).toEqual([]);
  });

  // A stop takes only a real card at the sink (#963). This one is: a person
  // approved it for this call, naming the agent and the task it cancels.
  test('an approved manage_agents terminate stops the agent on that card, with no second card', async () => {
    const approvals = new ApprovalManager();
    const s = sink(approvals, { spawnsNeedApproval: false, taskRunsUntilStopped: true });
    const { spawned } = await startPersistentAgent(s.deps, { specialist: 'spec', task: 'draft the plan' });
    const f = setup(s.registry, 'manage_agents', { action: 'terminate', agent_id: spawned.agent.id }, approvals, { orchestrator: s.orch });
    const { card, done } = await f.approveThrough();
    expect(approvalIntentFields(card).intent_action).toBe('Stop the SPEC background agent and cancel its task "draft the plan"');
    expect(done.toolCalls[0]!.error).toBeUndefined();
    expect(s.spawned()).toHaveLength(0);
    expect(approvals.getPending()).toEqual([]);
    expect(s.audit.query({ action: 'terminate_agent' }).filter((r) => r.tool_name.startsWith('terminate_agent('))
      .map((r) => [r.authority_decision, r.executed, r.approval_id]))
      .toEqual([['approval_required', 1, card.id]]);
  });

  test('an approved delegate_task runs its specialist instead of being refused', async () => {
    const approvals = new ApprovalManager();
    const s = sink(approvals);
    const f = setup(s.registry, 'delegate_task', { specialist: 'spec', task: 'look', context: '' }, approvals, { orchestrator: s.orch });
    const { card, done } = await f.approveThrough();
    expect(approvalIntentFields(card).intent_action).toBe('Delegate to a spec specialist the task "look"');
    expect(String(done.toolCalls[0]!.result)).toContain('[SPEC completed]');
    expect(s.spawnRows().filter((r) => r.executed === 1).map((r) => r.approval_id)).toEqual([card.id]);
    expect(approvals.getPending()).toEqual([]);
  });
});

describe('what a workflow-delegated call starts has the delegated agent\'s authority, not the primary\'s (#1014)', () => {
  test('an approved manage_agents spawn is judged as the delegated agent and capped by it', async () => {
    const approvals = new ApprovalManager();
    // The primary could give the specialist its browser tools; the delegated
    // agent (tools: delegation) could not.
    const s = sink(approvals, { primaryTools: ['delegation', 'browser'] });
    const f = setup(s.registry, 'manage_agents', { action: 'spawn', specialist: 'spec' }, approvals, { orchestrator: s.orch });
    const { done } = await f.approveThrough();
    expect(done.toolCalls[0]!.error).toBeUndefined();
    const [spec] = s.spawned();
    expect(spec!.agent.role.id).toBe('spec');
    expect(spec!.agent.authority.allowed_tools).toEqual([]);
    // Below the delegated agent (level 4, under the level-5 primary).
    expect(spec!.agent.authority.max_authority_level).toBe(3);
    const [row] = s.spawnRows();
    expect(row!.agent_id).not.toBe(s.primary.id);
    expect(row!.agent_name).toBe(ROLE.name);
  });
});

describe('the approval a delegated call runs under covers that call only (#988)', () => {
  /** A synthetic delegation tool: its gate is read afresh on every call; `body` runs as its execute. */
  function probe(gate: () => ToolGate | null, body: () => unknown, category = 'delegation') {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = { name: 'start_helper', category, description: 'Synthetic spawn', parameters: {},
      authorityGate: () => gate(), execute: async () => { body(); return 'ok'; } };
    registry.register(tool);
    return registry;
  }
  const SPAWN = { actionCategory: 'spawn_agent', intent: 'Start a helper' } as const;
  const grantOf = (category: 'spawn_agent' | 'terminate_agent' = 'spawn_agent') => {
    const g = spendApproval(category);
    return g ? `${g.source}:${g.approvalId}` : null;
  };

  test('the first lifecycle decision spends it, and only for the category approved', async () => {
    const seen: Array<string | null> = [];
    const f = setup(probe(() => SPAWN, () => { seen.push(grantOf('terminate_agent'), grantOf(), grantOf()); }), 'start_helper', {});
    const { card } = await f.approveThrough();
    expect(seen).toEqual([null, `approval:${card.id}`, null]);
  });

  test('nothing the call leaves running can use it once the call has settled', async () => {
    let later: Promise<string | null> = Promise.resolve('unset');
    const f = setup(probe(() => SPAWN, () => { later = new Promise((r) => setTimeout(() => r(grantOf()), 5)); }), 'start_helper', {});
    await f.approveThrough();
    expect(await later).toBeNull();
  });

  test('a card that did not name the act buys nothing at the sink', async () => {
    const seen: Array<string | null> = [];
    const f = setup(probe(() => null, () => { seen.push(grantOf()); }), 'start_helper', {});
    const { card } = await f.approveThrough();
    expect(approvalIntentFields(card).intent_action).toBe('Start helper');
    expect(seen).toEqual([null]);
  });

  // The call runs inside the delegation's scope. That grant was for starting
  // the sub-agent; the call is a different act with a card of its own.
  test('a call never runs on the delegation\'s approval, even one its spawn left unspent', async () => {
    const seen: Array<string | null> = [];
    const f = setup(probe(() => null, () => { seen.push(grantOf()); }), 'start_helper', {}, new ApprovalManager(), { childSpawnSpends: false });
    await f.approveThrough();
    expect(seen).toEqual([null]);
  });

  // A call the sub-agent's gate allows outright never reaches the boundary:
  // the runner runs it directly, inside the delegation's scope.
  test('a call the sub-agent runs without a card never sees the delegation\'s approval either', async () => {
    const seen: Array<string | null> = [];
    const f = setup(probe(() => null, () => { seen.push(grantOf()); }, 'information'),
      'start_helper', {}, new ApprovalManager(), { childSpawnSpends: false });
    const outer = await f.delegateNow();
    f.approvals.approve(outer.approval!.approvalId, 'dashboard');
    const done = await f.delegateNow();
    // Run directly: no card of its own was raised.
    expect(done.status).not.toBe('approval_required');
    expect(seen).toEqual([null]);
  });

  // A gate that reads live state (a stop names the agent's running task) can
  // say something else by the time the card is approved.
  test('a call whose sentence changed after its card was approved is blocked, not run', async () => {
    let intent = 'Start a helper on the task "draft"';
    const ran: string[] = [];
    const f = setup(probe(() => ({ actionCategory: 'spawn_agent', intent }), () => { ran.push(intent); }), 'start_helper', {});
    const card = await f.park();
    expect(approvalIntentFields(card).intent_action).toBe('Start a helper on the task "draft"');
    intent = 'Start a helper on the task "send the report"';
    f.approvals.approve(card.id, 'dashboard');
    const done = await f.delegateNow();
    expect(ran).toEqual([]);
    expect(done.toolCalls[0]!.error).toContain('what it would do changed after approval');
    expect(listWorkflowEffects(f.run.id).find((e) => e.route === 'agent-tool:1')).toMatchObject({ status: 'blocked' });
  });

  // The fence runs at every checkpoint inside the call too. A sentence the
  // call's own effect changed (a stop no longer has a task to cancel) is not
  // a change after approval, and a refusal there would say "not started"
  // about an effect that happened.
  test('a sentence the call itself changed does not refuse it partway through', async () => {
    let intent = 'Start a helper on the task "draft"';
    const f = setup(probe(() => ({ actionCategory: 'spawn_agent', intent }), () => {
      intent = 'Start a helper';
      checkpointExecution();
    }), 'start_helper', {});
    const { done } = await f.approveThrough();
    expect(done.toolCalls[0]!.error).toBeUndefined();
    expect(String(done.toolCalls[0]!.result)).toContain('ok');
  });

  test('a call whose sentence is unchanged runs under its approval', async () => {
    const ran: string[] = [];
    const f = setup(probe(() => SPAWN, () => { ran.push('ran'); }), 'start_helper', {});
    const { done } = await f.approveThrough();
    expect(ran).toEqual(['ran']);
    expect(String(done.toolCalls[0]!.result)).toContain('ok');
  });
});
