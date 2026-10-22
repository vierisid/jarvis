import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { updateFlowStatus } from '../db/repos/flow';
import { stopRunsOfDeletedFlow, stopRunsOfTurnedOffFlow } from '../db/repos/flow-turn-off';
import { createWaitpoint, getWaitpoint } from '../db/repos/waitpoint';
import { createWorkflowRoutes } from '../api/routes';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { getWorkflowDb } from '../db';
import { ToolRegistry } from '../../actions/tools/registry';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController, setActiveEmergencyController } from '../../authority/emergency';
import { releaseDeferredSteps } from './deferred-cards';
import { saveWorkflowEffect } from '../db/repos/workflow-effect';
import { PAUSED_REASON } from './emergency-hold';
import { ApprovalManager } from '../../authority/approval';
import { maxWaitingSpawnCards } from '../../agents/lifecycle-gate';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { GOVERNANCE_REFUSALS, maxWaitingWorkflowCards, WorkflowEffectBoundary } from './effect-boundary';
import { resumeCompletedChildRuns } from './child-run-scheduler';
import { TimerWaitpointScheduler } from '../timer-scheduler';

/**
 * #1039: #1038 capped the workflow cards that start an agent, per flow. Every
 * other governed workflow effect still raised a card per run with no count,
 * and `send_message` (a notify step) is governed by default, so a webhook
 * flow with a notify step queued a card, a toast and a channel card per hit.
 * And a top-level run that failed after raising its card left it pending.
 */

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-workflow-card-budget-'));
  initWorkflowDb(join(directory, 'workflow.db'));
});
afterEach(() => { setActiveEmergencyController(null); closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

const ROLE = { id: 'coordinator', name: 'Workflow role', description: '', responsibilities: [], tools: ['delegation'] as string[] };

function flow(name: string, step: FlowTriggerNode) {
  const f = createFlow({});
  const version = createDraftVersion({ flowId: f.id, displayName: name, trigger: { name: 'trigger', type: 'EMPTY', nextAction: step } });
  return { flowId: f.id, newRun: (parentRunId?: string) => createFlowRun({ flowId: f.id, flowVersionId: version.id, status: 'RUNNING',
    ...(parentRunId ? { parentRunId, failParentOnFailure: true } : {}) }) };
}
const notifyFlow = (name = 'Webhook notifier') => flow(name, { name: 'notify', type: 'PIECE', displayName: 'notify',
  settings: { pieceName: '@jarvispieces/piece-jarvis-notify', pieceVersion: '0.0.1', actionName: 'notify', input: { message: 'hi' } } });
/** A notify step, then a delegate step: both kinds of card from one flow. */
const mixedFlow = (name = 'Notify then delegate') => flow(name, { name: 'notify', type: 'PIECE', displayName: 'notify',
  settings: { pieceName: '@jarvispieces/piece-jarvis-notify', pieceVersion: '0.0.1', actionName: 'notify', input: { message: 'hi' } },
  nextAction: { name: 'delegate', type: 'PIECE', displayName: 'delegate',
    settings: { pieceName: '@jarvispieces/piece-jarvis-agent', pieceVersion: '0.0.1', actionName: 'delegate', input: { goal: 'Coordinate', role: ROLE.id } } } });

/** The shipped default: `send_message` governed (config/types.ts). */
const DEFAULT_GOVERNED = ['send_email', 'send_message', 'make_payment'];

function services(approvals: ApprovalManager, governed: string[] = DEFAULT_GOVERNED,
  call?: { name: string; args: Record<string, unknown>; registry: ToolRegistry }, audit = new AuditTrail(),
  emergency = new EmergencyController()) {
  const child = () => ({ id: 'child', agent: { role: ROLE, authority: { allowed_tools: ROLE.tools, max_authority_level: 10 } },
    setTask() {}, activate() {}, idle() {}, addMessage() {}, getMessages: () => [] });
  const registry = call?.registry ?? new ToolRegistry();
  return buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    toolRegistry: registry,
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: governed as never, overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: emergency, auditTrail: audit, approvalManager: approvals,
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

const ctx = (runId: string, stepName: string) => ({ runId, projectId: DEFAULT_IDS.project, stepName, executionPath: [] as Array<[string, number]> });
const notifyIn = (s: ReturnType<typeof services>, runId: string) =>
  s.notify!({ message: 'hi', channels: ['dashboard'], priority: 'normal' }, ctx(runId, 'notify'));
const delegateIn = (s: ReturnType<typeof services>, runId: string) =>
  s.agentDelegate!({ goal: 'Coordinate', role: ROLE.id }, ctx(runId, 'delegate'));
const pendingOf = (approvals: ApprovalManager, category: string) =>
  approvals.getPending().filter((r) => r.execution_mode === 'workflow' && r.action_category === category);

/** What a step past its budget gets back: it waits, with no card, saying why (#1039, owner: defer, don't fail). */
function expectDeferred(reply: { approval?: { approvalId: string; waitpointId: string; hold?: string; code?: string } }) {
  expect(reply.approval).toMatchObject({ approvalId: '', code: 'APPROVALS_WAITING' });
  expect(getWaitpoint(reply.approval!.waitpointId)!.type).toBe('DEFER');
  return reply.approval!;
}
/** The runs the scheduler has queued a continuation for, in the order it queued them. */
const resumedRuns = () => (getWorkflowDb().query(`SELECT flow_run_id AS id FROM workflow_job WHERE job_type='RUN_FLOW'
  AND json_extract(payload, '$.executionType')='RESUME' ORDER BY rowid`).all() as Array<{ id: string }>).map((r) => r.id);
const tick = () => new TimerWaitpointScheduler(15_000).tick();
/** Turn an enabled flow off, as the API does (it stamps `disabled_at`). Enabled directly: readiness needs a piece catalog. */
const turnOff = (flowId: string) => {
  getWorkflowDb().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flowId]);
  expect(updateFlowStatus(flowId, 'DISABLED').turnedOff).toBe(true);
};
/** The engine parked the run on the waitpoint its step got back. */
const park = (runId: string) => updateRun(runId, { status: 'PAUSED' });
/** The engine picked up the run's continuation and re-ran the step. */
const wake = (runId: string) => updateRun(runId, { status: 'RUNNING' });

describe('every governed workflow card counts against its flow\'s budget (#1039)', () => {
  test('a burst past the budget waits instead of failing: no card past the cap, nothing refused, nothing lost', async () => {
    const approvals = new ApprovalManager();
    const audit = new AuditTrail();
    const s = services(approvals, DEFAULT_GOVERNED, undefined, audit);
    const hook = notifyFlow();
    const cap = maxWaitingWorkflowCards();
    for (let i = 0; i < cap; i++) expect((await notifyIn(s, hook.newRun().id)).approval!.approvalId).not.toBe('');
    expect(pendingOf(approvals, 'send_message')).toHaveLength(cap);
    // The webhook admits 60 runs of one flow a minute; none past the budget raises a card, and none fails.
    const over: string[] = [];
    for (let i = 0; i < 60 - cap; i++) {
      const run = hook.newRun();
      over.push(run.id);
      const waiting = expectDeferred(await notifyIn(s, run.id));
      // What the run shows while it waits: how many are ahead, and that it raises its card when one is decided.
      expect(waiting.hold).toContain(`${cap} requests from this workflow, other than to start or stop an agent, are already waiting for your decision (the limit is ${cap})`);
      if (i > 0) expect(waiting.hold).toContain(`and ${i} earlier step${i === 1 ? ' is' : 's are'} waiting for a place`);
      park(run.id);
    }
    expect(pendingOf(approvals, 'send_message')).toHaveLength(cap);
    // Kept, undecided: the record waits for its turn.
    const [record] = listWorkflowEffects(over[0]!);
    expect([record!.status, record!.decision, record!.approvalId, record!.outcome]).toEqual(['pending', 'unresolved', null, undefined]);
    expect(record!.deferral).toMatchObject({ budget: 'other' });
    // Not a refusal: audited once as needing approval, unexecuted, with no card, so a flood shows in the trail.
    const trail = () => audit.query({ action: 'send_message' }).filter((r) => r.agent_id === `workflow:${over[0]}`)
      .map((r) => [r.authority_decision, r.executed, r.approval_id]);
    expect(trail()).toEqual([['approval_required', 0, null]]);
    expect(GOVERNANCE_REFUSALS.has('APPROVALS_WAITING')).toBe(false);
    // Asked again before a place frees, it still waits, keeps its place and its waitpoint, and raises nothing.
    wake(over[0]!);
    const again = expectDeferred(await notifyIn(s, over[0]!));
    expect(again.waitpointId).toBe(record!.waitpointId!);
    expect(listWorkflowEffects(over[0]!)[0]!.deferral).toEqual(record!.deferral!);
    // Once per wait, not once per ask.
    expect(trail()).toEqual([['approval_required', 0, null]]);
    expect(pendingOf(approvals, 'send_message')).toHaveLength(cap);
  });

  test('past 100 waiting, a step says so rather than counting the whole queue', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const cap = maxWaitingWorkflowCards();
    for (let i = 0; i < cap; i++) await notifyIn(s, hook.newRun().id);
    let last = '';
    for (let i = 0; i <= 101; i++) last = expectDeferred(await notifyIn(s, hook.newRun().id)).hold!;
    expect(last).toContain(`${cap} requests from this workflow`);
    expect(last).toContain('and 100 or more earlier steps are waiting for a place');
  });

  test('a decided card lets the oldest waiting step raise its card, and a newer step queues behind it', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const cap = maxWaitingWorkflowCards();
    const carded: string[] = [];
    for (let i = 0; i < cap; i++) {
      const run = hook.newRun();
      carded.push((await notifyIn(s, run.id)).approval!.approvalId);
    }
    const waiting = [hook.newRun(), hook.newRun(), hook.newRun()];
    for (const run of waiting) { expectDeferred(await notifyIn(s, run.id)); park(run.id); }
    tick();
    expect(resumedRuns()).toEqual([]);
    // A card is denied: one place frees. A step arriving now does not take it from the steps already waiting.
    approvals.deny(carded[0]!, 'dashboard');
    const late = hook.newRun();
    expectDeferred(await notifyIn(s, late.id));
    park(late.id);
    tick();
    expect(resumedRuns()).toEqual([waiting[0]!.id]);
    // Released, it is not released twice, and the place it holds is not handed to another.
    tick();
    expect(resumedRuns()).toEqual([waiting[0]!.id]);
    // Woken and not yet at its step again, it still holds the place.
    wake(waiting[0]!.id);
    tick();
    expect(resumedRuns()).toEqual([waiting[0]!.id]);
    // The engine re-runs the step: it now raises its card.
    const raised = (await notifyIn(s, waiting[0]!.id)).approval!;
    expect(raised.approvalId).not.toBe('');
    expect(approvals.getRequest(raised.approvalId)!.status).toBe('pending');
    expect(pendingOf(approvals, 'send_message')).toHaveLength(cap);
    // Approving a card frees a place too, and the next oldest gets it.
    approvals.approve(carded[1]!, 'dashboard');
    tick();
    expect(resumedRuns()).toEqual([waiting[0]!.id, waiting[1]!.id]);
  });

  test('a waiting step whose run ends gives up its place to the next', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const cap = maxWaitingWorkflowCards();
    const carded: string[] = [];
    for (let i = 0; i < cap; i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const stopped = hook.newRun(), next = hook.newRun();
    for (const run of [stopped, next]) { expectDeferred(await notifyIn(s, run.id)); park(run.id); }
    cancelFlowRun(stopped.id);
    expect(listWorkflowEffects(stopped.id).map((e) => e.status)).toEqual(['blocked']);
    // And a card whose run ends frees a place, as a decided one does.
    updateRun(approvals.getRequest(carded[2]!)!.agent_id.slice('workflow:'.length), { status: 'FAILED', finishTime: Date.now() });
    tick();
    expect(resumedRuns()).toEqual([next.id]);
  });

  test('a step held by Pause waits for a place on Resume instead of failing', async () => {
    const approvals = new ApprovalManager();
    const emergency = new EmergencyController();
    const s = services(approvals, DEFAULT_GOVERNED, undefined, new AuditTrail(), emergency);
    const hook = notifyFlow();
    const cap = maxWaitingWorkflowCards();
    for (let i = 0; i < cap; i++) await notifyIn(s, hook.newRun().id);
    emergency.pause();
    const held = Array.from({ length: 45 }, () => hook.newRun());
    for (const run of held) expect((await notifyIn(s, run.id)).approval!.hold).toBe(PAUSED_REASON);
    emergency.resume();
    // Resume re-runs each held step: every one waits for a place, none fails.
    for (const run of held) expectDeferred(await notifyIn(s, run.id));
    expect(held.flatMap((run) => listWorkflowEffects(run.id).map((e) => e.status))).toEqual(held.map(() => 'pending'));
    expect(pendingOf(approvals, 'send_message')).toHaveLength(cap);
  });

  test('turning the workflow off, or deleting it, stops its waiting runs, and they never raise a card', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const doomed = notifyFlow('Deleted');
    const cap = maxWaitingWorkflowCards();
    const carded: string[] = [];
    for (let i = 0; i < cap; i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    for (let i = 0; i < cap; i++) carded.push((await notifyIn(s, doomed.newRun().id)).approval!.approvalId);
    const off = hook.newRun(), gone = doomed.newRun();
    for (const run of [off, gone]) { expectDeferred(await notifyIn(s, run.id)); park(run.id); }
    turnOff(hook.flowId);
    stopRunsOfTurnedOffFlow(hook.flowId);
    stopRunsOfDeletedFlow(doomed.flowId);
    for (const run of [off, gone]) {
      expect(getFlowRun(run.id)!.status).toBe('STOPPED');
      expect(listWorkflowEffects(run.id).map((e) => e.status)).toEqual(['blocked']);
    }
    for (const id of carded) approvals.deny(id, 'dashboard');
    tick();
    expect(resumedRuns()).toEqual([]);
  });

  test('a waiting run of a workflow turned off since is stopped when its turn comes, not woken', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const cap = maxWaitingWorkflowCards();
    const carded: string[] = [];
    for (let i = 0; i < cap; i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const run = hook.newRun();
    expectDeferred(await notifyIn(s, run.id));
    park(run.id);
    // Turned off, and the daemon went down before it stopped the runs.
    turnOff(hook.flowId);
    approvals.deny(carded[0]!, 'dashboard');
    tick();
    expect(resumedRuns()).toEqual([]);
    expect(getFlowRun(run.id)!.status).toBe('STOPPED');
  });

  test('a waiting step is released by Jarvis, never by a resume URL', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) await notifyIn(s, hook.newRun().id);
    const run = hook.newRun();
    const waiting = expectDeferred(await notifyIn(s, run.id));
    park(run.id);
    // A DEFER the effect no longer names (one an earlier pass left) is refused by its type, not only by its owner.
    const loose = createWaitpoint({ flowRunId: run.id, projectId: DEFAULT_IDS.project, stepName: 'notify', type: 'DEFER' });
    const routes = createWorkflowRoutes();
    for (const id of [waiting.waitpointId, loose.id]) {
      const response = await routes['/api/webhooks/waitpoints/:id']!.POST!(
        Object.assign(new Request(`http://localhost/api/webhooks/waitpoints/${id}`, { method: 'POST', body: '{}' }), { params: { id } }));
      expect(response.status).toBe(403);
      expect(getWaitpoint(id)!.resumedAt).toBeNull();
    }
    const listed = await routes['/api/workflow-runs/:runId/waitpoints']!.GET!(
      Object.assign(new Request(`http://localhost/api/workflow-runs/${run.id}/waitpoints`), { params: { runId: run.id } }));
    const { waitpoints } = await listed.json() as { waitpoints: Array<{ type: string; resumeUrl: string | null }> };
    expect(waitpoints.map((wp) => [wp.type, wp.resumeUrl])).toEqual([['DEFER', null], ['DEFER', null]]);
  });

  test('nothing is released while Jarvis is paused or stopped; Resume releases it', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const carded: string[] = [];
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const run = hook.newRun();
    expectDeferred(await notifyIn(s, run.id));
    park(run.id);
    approvals.deny(carded[0]!, 'dashboard');
    const controller = new EmergencyController();
    setActiveEmergencyController(controller);
    controller.pause();
    // Asked directly as well as through the tick, which returns early on its own.
    expect(releaseDeferredSteps()).toBe(0);
    tick();
    controller.kill();
    expect(releaseDeferredSteps()).toBe(0);
    expect(resumedRuns()).toEqual([]);
    controller.reset();
    tick();
    expect(resumedRuns()).toEqual([run.id]);
  });

  test('under Pause a waiting run of a turned-off workflow is left as it is, as the approval scheduler leaves it', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const carded: string[] = [];
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const run = hook.newRun();
    expectDeferred(await notifyIn(s, run.id));
    park(run.id);
    turnOff(hook.flowId);
    approvals.deny(carded[0]!, 'dashboard');
    const controller = new EmergencyController();
    setActiveEmergencyController(controller);
    controller.pause();
    expect(releaseDeferredSteps()).toBe(0);
    expect(getFlowRun(run.id)!.status).toBe('PAUSED');
    controller.resume();
    releaseDeferredSteps();
    expect(getFlowRun(run.id)!.status).toBe('STOPPED');
  });

  test('a step paused while it waits keeps its place and its waitpoint', async () => {
    const approvals = new ApprovalManager();
    const emergency = new EmergencyController();
    const s = services(approvals, DEFAULT_GOVERNED, undefined, new AuditTrail(), emergency);
    const hook = notifyFlow();
    const carded: string[] = [];
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const older = hook.newRun();
    const first = expectDeferred(await notifyIn(s, older.id));
    const since = listWorkflowEffects(older.id)[0]!.deferral!.since;
    const newer = hook.newRun();
    expectDeferred(await notifyIn(s, newer.id));
    park(newer.id);
    // The engine runs the older step again under Pause: it is held, and still waiting.
    emergency.pause();
    expect((await notifyIn(s, older.id)).approval!.hold).toBe(PAUSED_REASON);
    emergency.resume();
    const again = expectDeferred(await notifyIn(s, older.id));
    expect(again.waitpointId).toBe(first.waitpointId);
    expect(listWorkflowEffects(older.id)[0]!.deferral!.since).toBe(since);
    park(older.id);
    approvals.deny(carded[0]!, 'dashboard');
    tick();
    expect(resumedRuns()).toEqual([older.id]);
  });

  test('a released step that Pause holds at its step keeps its place through the Pause and the Resume', async () => {
    const approvals = new ApprovalManager();
    const emergency = new EmergencyController();
    const s = services(approvals, DEFAULT_GOVERNED, undefined, new AuditTrail(), emergency);
    const hook = notifyFlow();
    const carded: string[] = [];
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const older = hook.newRun(), newer = hook.newRun();
    for (const run of [older, newer]) { expectDeferred(await notifyIn(s, run.id)); park(run.id); }
    approvals.deny(carded[0]!, 'dashboard');
    tick();
    expect(resumedRuns()).toEqual([older.id]);
    // Its continuation runs while Jarvis is paused: the step is held at the boundary, and the job ends.
    wake(older.id);
    emergency.pause();
    setActiveEmergencyController(emergency);
    expect((await notifyIn(s, older.id)).approval!.hold).toBe(PAUSED_REASON);
    getWorkflowDb().run("UPDATE workflow_job SET status = 'SUCCEEDED' WHERE flow_run_id = ?", [older.id]);
    park(older.id);
    emergency.resume();
    // Resume wakes the held step; the newer one is not released into its place.
    tick();
    expect(resumedRuns()).toEqual([older.id, older.id]);
    tick();
    expect(resumedRuns()).toEqual([older.id, older.id]);
  });

  test('a held step lends its place only to its own record, not to an earlier loop pass of the same step', async () => {
    const approvals = new ApprovalManager();
    const emergency = new EmergencyController();
    const s = services(approvals, DEFAULT_GOVERNED, undefined, new AuditTrail(), emergency);
    const looped = flow('Looping notifier', { name: 'loop', type: 'LOOP_ON_ITEMS', displayName: 'loop', settings: { items: '{{trigger.items}}' },
      firstLoopAction: { name: 'notify', type: 'PIECE', displayName: 'notify',
        settings: { pieceName: '@jarvispieces/piece-jarvis-notify', pieceVersion: '0.0.1', actionName: 'notify', input: { message: 'hi' } } } } as never);
    const pass = (runId: string, i: number) => s.notify!({ message: 'hi', channels: ['dashboard'], priority: 'normal' },
      { runId, projectId: DEFAULT_IDS.project, stepName: 'notify', executionPath: [['loop', i]] as Array<[string, number]> });
    const carded: string[] = [];
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) carded.push((await pass(looped.newRun().id, 0)).approval!.approvalId);
    // Pass 0 of this run waits, is released, and its step fails before asking again: its record stays pending.
    const run = looped.newRun();
    expectDeferred(await pass(run.id, 0));
    park(run.id);
    approvals.deny(carded[0]!, 'dashboard');
    tick();
    expect(resumedRuns()).toEqual([run.id]);
    getWorkflowDb().run("UPDATE workflow_job SET status = 'FAILED' WHERE flow_run_id = ?", [run.id]);
    // Pass 1 takes the free place and asks.
    wake(run.id);
    expect((await pass(run.id, 1)).approval!.approvalId).not.toBe('');
    const other = looped.newRun();
    expectDeferred(await pass(other.id, 0));
    park(other.id);
    // Pass 2 is held by Pause at the same step name, and released by Resume.
    emergency.pause();
    setActiveEmergencyController(emergency);
    expect((await pass(run.id, 2)).approval!.hold).toBe(PAUSED_REASON);
    park(run.id);
    emergency.resume();
    approvals.deny(carded[1]!, 'dashboard');
    tick();
    // The place goes to the step that is waiting, not to pass 0, which no HOLD of its own keeps.
    expect(resumedRuns()).toEqual([run.id, run.id, other.id]);
  });

  test('two steps that began waiting in the same millisecond go in the order they were recorded', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const carded: string[] = [];
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const a = hook.newRun(), b = hook.newRun();
    for (const run of [a, b]) { expectDeferred(await notifyIn(s, run.id)); park(run.id); }
    const [ea] = listWorkflowEffects(a.id), [eb] = listWorkflowEffects(b.id);
    saveWorkflowEffect({ ...eb!, deferral: { ...eb!.deferral!, since: ea!.deferral!.since } });
    approvals.deny(carded[0]!, 'dashboard');
    tick();
    expect(resumedRuns()).toEqual([a.id]);
    // And asked again, the later one counts the earlier as ahead of it, never the other way round.
    wake(b.id);
    expect(expectDeferred(await notifyIn(s, b.id)).hold).toContain('and 1 earlier step is waiting for a place');
  });

  test('a waiting run of a turned-off workflow still executing keeps its place until it stops', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const carded: string[] = [];
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const executing = hook.newRun();
    expectDeferred(await notifyIn(s, executing.id));
    // Turned off after that run began; a run started by hand since is not affected (Q-06).
    getWorkflowDb().run("UPDATE flow SET status = 'DISABLED', disabled_at = ? WHERE id = ?", [executing.created, hook.flowId]);
    const later = hook.newRun();
    getWorkflowDb().run('UPDATE flow_run SET created = ? WHERE id = ?', [executing.created + 1000, later.id]);
    expectDeferred(await notifyIn(s, later.id));
    park(later.id);
    approvals.deny(carded[0]!, 'dashboard');
    tick();
    // The executing run is ahead and holds the place; it is not stopped mid-step.
    expect(resumedRuns()).toEqual([]);
    expect(getFlowRun(executing.id)!.status).toBe('RUNNING');
    // Once it parks, the turn-off stops it and the place passes on.
    park(executing.id);
    tick();
    expect(getFlowRun(executing.id)!.status).toBe('STOPPED');
    tick();
    expect(resumedRuns()).toEqual([later.id]);
  });

  test('a released step that did not ask again when its run woke gives up its place', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const carded: string[] = [];
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) carded.push((await notifyIn(s, hook.newRun().id)).approval!.approvalId);
    const gone = hook.newRun(), next = hook.newRun();
    for (const run of [gone, next]) { expectDeferred(await notifyIn(s, run.id)); park(run.id); }
    approvals.deny(carded[0]!, 'dashboard');
    tick();
    expect(resumedRuns()).toEqual([gone.id]);
    // Its continuation ran, but the step failed before it reached the boundary,
    // and the run went on and parked somewhere else: its record is still pending.
    getWorkflowDb().run("UPDATE workflow_job SET status = 'FAILED' WHERE flow_run_id = ?", [gone.id]);
    createWaitpoint({ flowRunId: gone.id, projectId: DEFAULT_IDS.project, stepName: 'later', type: 'TIMER' });
    expect(listWorkflowEffects(gone.id).map((e) => e.status)).toEqual(['pending']);
    tick();
    expect(resumedRuns()).toEqual([gone.id, next.id]);
    // And a newcomer does not count it as ahead.
    wake(next.id);
    expect((await notifyIn(s, next.id)).approval!.approvalId).not.toBe('');
  });

  test('a run holds one place: a later step that waits retires the earlier one', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals, [...DEFAULT_GOVERNED, 'spawn_agent']);
    const flooded = mixedFlow();
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) await notifyIn(s, flooded.newRun().id);
    for (let i = 0; i < maxWaitingSpawnCards(); i++) await delegateIn(s, flooded.newRun().id);
    const run = flooded.newRun();
    const notifyWait = expectDeferred(await notifyIn(s, run.id));
    // The notify step failed and the run went on to its delegate step, which waits too.
    expectDeferred(await delegateIn(s, run.id));
    expect(getWaitpoint(notifyWait.waitpointId)!.resumedAt).not.toBeNull();
    // So a newcomer's notify step is not queued behind the one the run left.
    expect(expectDeferred(await notifyIn(s, flooded.newRun().id)).hold).not.toContain('earlier step');
  });

  test('the budget is the decision\'s category, the one the card records, not the category the step was invoked as', async () => {
    const approvals = new ApprovalManager();
    const governed = [...DEFAULT_GOVERNED, 'spawn_agent'];
    const s = services(approvals, governed);
    const boundary = new WorkflowEffectBoundary({ approvalManager: approvals, auditTrail: new AuditTrail(), emergencyController: new EmergencyController(),
      authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: governed as never, overrides: [],
        context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }) });
    // Invoked as a write that also starts an agent: only the start needs approval, so the fold decides as spawn_agent.
    const startingWrite = (runId: string) => boundary.invoke({ context: ctx(runId, 'notify'), piece: '@jarvispieces/piece-jarvis-notify',
      action: 'notify', route: 'synthetic', toolName: 'write_and_start', category: 'write_data', categories: ['write_data', 'spawn_agent'],
      toolCategory: 'delegation', request: {}, prepare: () => ({ arguments: {}, target: {} }), execute: async () => 'ok' });
    // The other budget full, the start budget empty: it asks as a start.
    const busyOther = notifyFlow('Busy notifier');
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) await notifyIn(s, busyOther.newRun().id);
    const asked = await startingWrite(busyOther.newRun().id);
    expect(asked.approval!.approvalId).not.toBe('');
    expect(approvals.getRequest(asked.approval!.approvalId)!.action_category).toBe('spawn_agent');
    // The start budget full, the other budget empty: it waits.
    const busyStart = mixedFlow('Busy starter');
    for (let i = 0; i < maxWaitingSpawnCards(); i++) await delegateIn(s, busyStart.newRun().id);
    expectDeferred(await startingWrite(busyStart.newRun().id));
  });

  test('another flow has its own budget', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const busy = notifyFlow('Busy');
    const cap = maxWaitingWorkflowCards();
    for (let i = 0; i < cap; i++) await notifyIn(s, busy.newRun().id);
    expect((await notifyIn(s, notifyFlow('Quiet').newRun().id)).approval!.approvalId).not.toBe('');
  });

  test('a flood of notify cards does not use up the start budget, nor start cards the notify budget', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals, [...DEFAULT_GOVERNED, 'spawn_agent']);
    const cap = maxWaitingWorkflowCards();
    const spawnCap = maxWaitingSpawnCards();
    const flooded = mixedFlow();
    for (let i = 0; i < cap; i++) await notifyIn(s, flooded.newRun().id);
    expectDeferred(await notifyIn(s, flooded.newRun().id));
    // The start budget is #1038's, with its message, untouched by the notify cards.
    for (let i = 0; i < spawnCap; i++) expect((await delegateIn(s, flooded.newRun().id)).approval!.approvalId).not.toBe('');
    const start = expectDeferred(await delegateIn(s, flooded.newRun().id));
    expect(start.hold).toContain(`${spawnCap} requests to start an agent or a workflow are already waiting`);
    // And the other way round.
    const starting = mixedFlow('Starting');
    for (let i = 0; i < spawnCap; i++) await delegateIn(s, starting.newRun().id);
    expect((await notifyIn(s, starting.newRun().id)).approval!.approvalId).not.toBe('');
  });

  test('a stop is never capped, whatever else the flow has waiting', async () => {
    const approvals = new ApprovalManager();
    const registry = new ToolRegistry();
    registry.register({ name: 'stop_helper', category: 'delegation', description: 'Synthetic stop', parameters: {},
      authorityGate: () => ({ actionCategory: 'terminate_agent', intent: 'Stop a helper' }), execute: async () => 'ok' });
    const s = services(approvals, [...DEFAULT_GOVERNED, 'spawn_agent', 'terminate_agent'], { name: 'stop_helper', args: {}, registry });
    const routine = mixedFlow();
    const run = routine.newRun();
    const outer = await delegateIn(s, run.id);
    approvals.approve(outer.approval!.approvalId, 'dashboard');
    for (let i = 0; i < maxWaitingWorkflowCards(); i++) await notifyIn(s, routine.newRun().id);
    for (let i = 0; i < maxWaitingSpawnCards(); i++) await delegateIn(s, routine.newRun().id);
    expectDeferred(await notifyIn(s, routine.newRun().id));
    const parked = await delegateIn(s, run.id);
    expect(parked.status).toBe('approval_required');
    expect(approvals.getRequest(parked.approval!.approvalId)!.action_category).toBe('terminate_agent');
  });
});

describe('a run that ends before it parks closes its cards (#1039)', () => {
  test('a top-level run that failed after raising its card has the card closed by the sweep', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const run = hook.newRun();
    const reply = await notifyIn(s, run.id);
    // The engine failed the run before it published PAUSED.
    updateRun(run.id, { status: 'FAILED', finishTime: Date.now() });
    expect(approvals.getRequest(reply.approval!.approvalId)!.status).toBe('pending');
    const closed: string[] = [];
    resumeCompletedChildRuns((id) => closed.push(id));
    const card = approvals.getRequest(reply.approval!.approvalId)!;
    expect([card.status, card.decided_by]).toEqual(['denied', 'workflow-completion']);
    expect(listWorkflowEffects(run.id).map((e) => [e.status, (e.outcome as { code?: string } | undefined)?.code])).toEqual([['blocked', 'WORKFLOW_FINISHED']]);
    // Reported once, so the daemon drops it from the dashboard and channels.
    expect(closed).toEqual([reply.approval!.approvalId]);
    resumeCompletedChildRuns((id) => closed.push(id));
    expect(closed).toEqual([reply.approval!.approvalId]);
  });

  test('a card approved for a run that then ended gets its receipt, and is reported too', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const run = notifyFlow().newRun();
    const reply = await notifyIn(s, run.id);
    approvals.approve(reply.approval!.approvalId, 'dashboard');
    updateRun(run.id, { status: 'FAILED', finishTime: Date.now() });
    const closed: string[] = [];
    resumeCompletedChildRuns((id) => closed.push(id));
    const card = approvals.getRequest(reply.approval!.approvalId)!;
    expect([card.status, card.execution_outcome]).toEqual(['executed', 'blocked']);
    expect(closed).toEqual([reply.approval!.approvalId]);
  });

  test('a paused, queued or running run keeps its card', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const ids: string[] = [];
    for (const status of ['PAUSED', 'QUEUED', 'RUNNING'] as const) {
      const run = hook.newRun();
      ids.push((await notifyIn(s, run.id)).approval!.approvalId);
      updateRun(run.id, { status });
    }
    resumeCompletedChildRuns();
    expect(ids.map((id) => approvals.getRequest(id)!.status)).toEqual(['pending', 'pending', 'pending']);
  });

  test('the scheduler hands each closed card to the daemon, and one failed update does not stop the rest', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const hook = notifyFlow();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run = hook.newRun();
      ids.push((await notifyIn(s, run.id)).approval!.approvalId);
      updateRun(run.id, { status: 'FAILED', finishTime: Date.now() });
    }
    const heard: string[] = [];
    new TimerWaitpointScheduler(15_000, (id) => { heard.push(id); if (heard.length === 1) throw new Error('socket gone'); }).tick();
    expect(heard.sort()).toEqual([...ids].sort());
    expect(ids.map((id) => approvals.getRequest(id)!.status)).toEqual(['denied', 'denied']);
  });

  test('a required child stopped because its parent ended has its cards reported too', async () => {
    const approvals = new ApprovalManager();
    const s = services(approvals);
    const parent = notifyFlow('Parent').newRun();
    const child = notifyFlow('Child').newRun(parent.id);
    const card = (await notifyIn(s, child.id)).approval!.approvalId;
    updateRun(child.id, { status: 'PAUSED' });
    updateRun(parent.id, { status: 'FAILED', finishTime: Date.now() });
    const heard: string[] = [];
    resumeCompletedChildRuns((id) => heard.push(id));
    expect(approvals.getRequest(card)!.status).toBe('denied');
    expect(heard).toEqual([card]);
  });
});
