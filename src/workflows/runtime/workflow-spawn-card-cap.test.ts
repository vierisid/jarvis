import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS, getWorkflowDb } from '../db';
import { TimerWaitpointScheduler } from '../timer-scheduler';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { ToolRegistry } from '../../actions/tools/registry';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { maxWaitingSpawnCards } from '../../agents/lifecycle-gate';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';

/**
 * #1017: a workflow card for an act that starts an agent counts against the
 * per-source cap #1012 put on waiting start requests, as a deferred card does.
 * The source is the flow: every run of a repeatedly triggered workflow is a
 * new run, so a per-run count would bound nothing.
 */

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-workflow-spawn-cap-'));
  initWorkflowDb(join(directory, 'workflow.db'));
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

const PIECE = '@jarvispieces/piece-jarvis-agent';
const ROLE = { id: 'coordinator', name: 'Workflow role', description: '', responsibilities: [], tools: ['delegation'] as string[] };

/**
 * A flow whose one step delegates (or, with `starts`, starts that flow); `newRun`
 * starts another run of it, as a trigger firing again does.
 */
function flow(name = 'Delegated routine', starts?: string) {
  const f = createFlow({});
  const step: FlowTriggerNode = starts
    ? { name: 'start', type: 'PIECE', displayName: 'start', settings: { pieceName: '@jarvispieces/piece-jarvis-trigger',
        pieceVersion: '0.0.1', actionName: 'run_workflow', input: { flowId: starts } } }
    : { name: 'delegate', type: 'PIECE', displayName: 'delegate', settings: { pieceName: PIECE,
        pieceVersion: '0.0.1', actionName: 'delegate', input: { goal: 'Coordinate', maxIterations: 3, role: ROLE.id } } };
  const version = createDraftVersion({ flowId: f.id, displayName: name, trigger: { name: 'trigger', type: 'EMPTY', nextAction: step } });
  return { flowId: f.id, newRun: () => createFlowRun({ flowId: f.id, flowVersionId: version.id, status: 'RUNNING' }) };
}

/**
 * Spawns governed for the workflow, so each delegation and each spawn-capable
 * call the delegated agent makes is parked on a card. The delegated agent
 * makes one call, `name(args)`, from `registry`.
 */
function services(approvals: ApprovalManager, call?: { name: string; args: Record<string, unknown>; registry: ToolRegistry },
  governed: string[] = ['spawn_agent'], audit = new AuditTrail()) {
  const child = () => ({ id: 'child', agent: { role: ROLE, authority: { allowed_tools: ROLE.tools, max_authority_level: 10 } },
    setTask() {}, activate() {}, idle() {}, addMessage() {}, getMessages: () => [] });
  const registry = call?.registry ?? new ToolRegistry();
  return buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    toolRegistry: registry,
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: governed as never, overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: audit, approvalManager: approvals,
    agentOrchestrator: { getPrimary: () => ({ id: 'primary' }), getProfileFor: () => null, getTaintGating: () => null, spawnSubAgent: child, reapAgent: () => {} } as never,
    agentSpecialists: new Map([[ROLE.id, ROLE]]) as never,
    agentScopedRegistry: () => registry,
    llmManager: { chatTier: async (_tier: string, _origin: string, messages: Array<{ role: string }>) =>
      !call || messages.some((m) => m.role === 'tool')
        ? { content: 'done', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }
        : { content: '', finish_reason: 'tool_use', tool_calls: [{ id: 'call-1', name: call.name, arguments: call.args }], usage: { input_tokens: 1, output_tokens: 1 } },
    } as never,
    channelService: {} as never, wsService: {} as never });
}

const delegateIn = (s: ReturnType<typeof services>, runId: string) => s.agentDelegate!({ goal: 'Coordinate', maxIterations: 3, role: ROLE.id },
  { runId, projectId: DEFAULT_IDS.project, stepName: 'delegate', executionPath: [] });

const startCards = (approvals: ApprovalManager) => approvals.getPending().filter((r) => r.action_category === 'spawn_agent');

describe('workflow cards that start an agent count against the waiting-start cap (#1017)', () => {
  test('a repeatedly triggered workflow stops raising start cards at the cap, and the run past it waits for a place (#1039)', async () => {
    const approvals = new ApprovalManager();
    const audit = new AuditTrail();
    const s = services(approvals, undefined, ['spawn_agent'], audit);
    const routine = flow();
    const cap = maxWaitingSpawnCards();
    for (let i = 0; i < cap; i++) {
      expect((await delegateIn(s, routine.newRun().id)).status).toBe('approval_required');
    }
    expect(startCards(approvals)).toHaveLength(cap);
    const over = routine.newRun();
    // No card, and no failure (owner, 2026-10-21: defer, don't fail): the
    // step waits, undecided, and raises its card when a place frees.
    const reply = await delegateIn(s, over.id);
    expect(reply.status).toBe('approval_required');
    expect(reply.approval).toMatchObject({ approvalId: '', code: 'APPROVALS_WAITING' });
    expect(reply.approval!.hold).toContain(`${cap} requests to start an agent or a workflow are already waiting`);
    expect(startCards(approvals)).toHaveLength(cap);
    expect(listWorkflowEffects(over.id).map((e) => [e.route, e.status, e.decision, e.approvalId])).toEqual([['agent', 'pending', 'unresolved', null]]);
    // Audited once as needing approval, unexecuted and with no card yet, so a flood shows in the trail.
    expect(audit.query({ action: 'spawn_agent' }).filter((r) => r.agent_id === `workflow:${over.id}`)
      .map((r) => [r.authority_decision, r.executed, r.approval_id])).toEqual([['approval_required', 0, null]]);
  });

  test('a card whose run has ended does not use up the budget', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const routine = flow();
    const cap = maxWaitingSpawnCards();
    const stale = Array.from({ length: cap }, () => routine.newRun());
    for (const run of stale) await delegateIn(s, run.id);
    // Stopped from the workflow UI with their cards still pending: approving
    // one of those cards would resume nothing.
    for (const run of stale) updateRun(run.id, { status: 'STOPPED' });
    expect(startCards(approvals)).toHaveLength(cap);
    expect((await delegateIn(s, routine.newRun().id)).status).toBe('approval_required');
  });

  test('a spawn the delegated agent asks for past the cap parks the step until a place frees (#1039)', async () => {
    const approvals = new ApprovalManager();
    const registry = new ToolRegistry();
    registry.register({ name: 'start_helper', category: 'delegation', description: 'Synthetic spawn', parameters: {},
      authorityGate: () => ({ actionCategory: 'spawn_agent', intent: 'Start a helper' }), execute: async () => 'ok' });
    const audit = new AuditTrail();
    const s = services(approvals, { name: 'start_helper', args: {}, registry }, ['spawn_agent'], audit);
    const routine = flow();
    const cap = maxWaitingSpawnCards();
    // This run's delegation is approved before the budget fills up...
    const first = routine.newRun();
    const outer = await delegateIn(s, first.id);
    approvals.approve(outer.approval!.approvalId, 'dashboard');
    for (let i = 0; i < cap; i++) await delegateIn(s, routine.newRun().id);
    // ...and its agent's spawn finds no room: the step waits with it, as it does on a card.
    const done = await delegateIn(s, first.id);
    expect(done.status).toBe('approval_required');
    expect(done.approval).toMatchObject({ approvalId: '', code: 'APPROVALS_WAITING' });
    expect(startCards(approvals)).toHaveLength(cap);
    expect(listWorkflowEffects(first.id).find((e) => e.route === 'agent-tool:1')).toMatchObject({ status: 'pending', decision: 'unresolved', approvalId: null });
    // Its rows, the sub-agent gate's and the boundary's, say it needed approval and name no card: there is none yet.
    expect(audit.query({ action: 'spawn_agent' }).filter((r) => r.tool_name === 'start_helper')
      .map((r) => [r.authority_decision, r.approval_id])).toEqual([['approval_required', null], ['approval_required', null]]);
    // A place frees: the scheduler wakes the run, and the call raises its own card.
    updateRun(first.id, { status: 'PAUSED' });
    approvals.deny(startCards(approvals)[0]!.id, 'dashboard');
    new TimerWaitpointScheduler(15_000).tick();
    expect(getWorkflowDb().query(`SELECT flow_run_id AS id FROM workflow_job WHERE json_extract(payload, '$.executionType') = 'RESUME'`).all())
      .toEqual([{ id: first.id }]);
    updateRun(first.id, { status: 'RUNNING' });
    const asked = await delegateIn(s, first.id);
    expect(asked.status).toBe('approval_required');
    expect(approvals.getRequest(asked.approval!.approvalId)!.tool_name).toBe('start_helper');
  });

  test('a workflow a step starts counts against the same budget', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const target = flow('Started routine');
    const starter = flow('Starting routine', target.flowId);
    const startIn = (runId: string) => s.workflowsStart!({ flowId: target.flowId } as never,
      { runId, projectId: DEFAULT_IDS.project, stepName: 'start', executionPath: [] } as never);
    const cap = maxWaitingSpawnCards();
    // Starting a workflow asks as a start, and fills the flow's budget the same way.
    for (let i = 0; i < cap; i++) expect((await startIn(starter.newRun().id)).approval).toBeDefined();
    expect(startCards(approvals)).toHaveLength(cap);
    expect((await startIn(starter.newRun().id)).approval).toMatchObject({ approvalId: '', code: 'APPROVALS_WAITING' });
    expect(startCards(approvals)).toHaveLength(cap);
  });

  test('another flow has its own budget', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const busy = flow('Busy routine');
    const cap = maxWaitingSpawnCards();
    for (let i = 0; i < cap; i++) await delegateIn(s, busy.newRun().id);
    expect((await delegateIn(s, flow('Quiet routine').newRun().id)).status).toBe('approval_required');
    expect(startCards(approvals)).toHaveLength(cap + 1);
  });

  test('a decided card no longer counts', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const routine = flow();
    const cap = maxWaitingSpawnCards();
    for (let i = 0; i < cap; i++) await delegateIn(s, routine.newRun().id);
    approvals.deny(startCards(approvals)[0]!.id, 'dashboard');
    expect((await delegateIn(s, routine.newRun().id)).status).toBe('approval_required');
    expect(startCards(approvals)).toHaveLength(cap);
  });

  test('a spawn a delegated agent asks for counts against its flow\'s budget too', async () => {
    const approvals = new ApprovalManager();
    const registry = new ToolRegistry();
    registry.register({ name: 'start_helper', category: 'delegation', description: 'Synthetic spawn', parameters: {},
      authorityGate: () => ({ actionCategory: 'spawn_agent', intent: 'Start a helper' }), execute: async () => 'ok' });
    const s = services(approvals, { name: 'start_helper', args: {}, registry });
    const routine = flow();
    const cap = maxWaitingSpawnCards();
    // One delegation approved, whose agent's call then waits on a start card of its own.
    const first = routine.newRun();
    const outer = await delegateIn(s, first.id);
    approvals.approve(outer.approval!.approvalId, 'dashboard');
    const parked = await delegateIn(s, first.id);
    expect(parked.status).toBe('approval_required');
    expect(approvals.getRequest(parked.approval!.approvalId)!.tool_name).toBe('start_helper');
    // The rest of the budget is used by delegations of later runs.
    for (let i = 1; i < cap; i++) expect((await delegateIn(s, routine.newRun().id)).status).toBe('approval_required');
    expect(startCards(approvals)).toHaveLength(cap);
    expect((await delegateIn(s, routine.newRun().id)).approval).toMatchObject({ approvalId: '', code: 'APPROVALS_WAITING' });
  });

  test('a stop is never capped', async () => {
    const approvals = new ApprovalManager();
    const registry = new ToolRegistry();
    registry.register({ name: 'stop_helper', category: 'delegation', description: 'Synthetic stop', parameters: {},
      authorityGate: () => ({ actionCategory: 'terminate_agent', intent: 'Stop a helper' }), execute: async () => 'ok' });
    const s = services(approvals, { name: 'stop_helper', args: {}, registry }, ['spawn_agent', 'terminate_agent']);
    const routine = flow();
    const cap = maxWaitingSpawnCards();
    // This run's delegation is approved before the budget fills up...
    const run = routine.newRun();
    const outer = await delegateIn(s, run.id);
    approvals.approve(outer.approval!.approvalId, 'dashboard');
    for (let i = 0; i < cap; i++) expect((await delegateIn(s, routine.newRun().id)).status).toBe('approval_required');
    expect(startCards(approvals)).toHaveLength(cap);
    // ...and its agent's stop still gets its card.
    const parked = await delegateIn(s, run.id);
    expect(parked.status).toBe('approval_required');
    expect(approvals.getRequest(parked.approval!.approvalId)!.action_category).toBe('terminate_agent');
  });

  test('a waiting stop does not use up the start budget', async () => {
    const approvals = new ApprovalManager();
    const registry = new ToolRegistry();
    registry.register({ name: 'stop_helper', category: 'delegation', description: 'Synthetic stop', parameters: {},
      authorityGate: () => ({ actionCategory: 'terminate_agent', intent: 'Stop a helper' }), execute: async () => 'ok' });
    const s = services(approvals, { name: 'stop_helper', args: {}, registry }, ['spawn_agent', 'terminate_agent']);
    const routine = flow();
    const run = routine.newRun();
    const outer = await delegateIn(s, run.id);
    approvals.approve(outer.approval!.approvalId, 'dashboard');
    expect((await delegateIn(s, run.id)).status).toBe('approval_required');
    expect(approvals.getPending().map((r) => r.action_category)).toEqual(['terminate_agent']);
    const cap = maxWaitingSpawnCards();
    for (let i = 0; i < cap; i++) expect((await delegateIn(s, routine.newRun().id)).status).toBe('approval_required');
    expect(startCards(approvals)).toHaveLength(cap);
  });
});
