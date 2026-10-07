import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, updateDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { getDelegation } from '../db/repos/delegation';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { enqueue } from '../db/repos/job-queue';
import { ToolRegistry, type ToolGate } from '../../actions/tools/registry';
import { ActionOutcomeError } from '../../actions/action-outcome';
import type { ActionCategory } from '../../roles/authority';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { WorkflowEffectBoundary } from './effect-boundary';
import { checkpointExecution } from '../../actions/execution-scope';
import { digest } from './effect-context';
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
const ROLE = { id: 'note-writer', name: 'Workflow role', description: '', responsibilities: [], tools: ['file-ops', 'terminal'] };
const ARGS = { path: '/tmp/synthetic', content: 'hello' };
type Turn = { call: string; args?: Record<string, unknown> } | 'finish';
const WRITE_THEN_FINISH: Turn[] = [{ call: 'write_file', args: ARGS }, 'finish'];

/** The run and version live in the database; everything in memory can be rebuilt on the same ids. */
function createRun(input: Record<string, unknown> = {}, loop = false) {
  const flow = createFlow({});
  const delegate: FlowTriggerNode = { name: 'delegate', type: 'PIECE', displayName: 'delegate', settings: { pieceName: PIECE,
    pieceVersion: '0.0.1', actionName: 'delegate', input: { goal: 'Save the note', maxIterations: 4, role: ROLE.id, ...input } } };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Delegated routine', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: loop ? { name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.items}}' }, firstLoopAction: delegate } : delegate } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  return { flow, version, run };
}
const delegationId = (runId: string, path: Array<[string, number]> = []) => 'wfd_' + digest([runId, 'delegate', path]);

type Options = {
  /** What the model asks for, turn by turn; it finishes once every scripted call has a result. */
  script?: Turn[];
  authority?: Partial<{ default_level: number; governed_categories: string[]; overrides: unknown[] }>;
  childLevel?: number;
  /** Behaviour of the synthetic tools. */
  writeThrows?: boolean;
  /** The write pauses the system and hits the boundary's fence while it runs. */
  writeInterrupts?: boolean;
  readFails?: boolean;
  /** The read cancels the run while the turn is still going. */
  readCancels?: boolean;
  /** A per-call gate on the write, read afresh on every call (the real write_file's depends on the disk, #522). */
  writeGate?: () => ToolGate | null;
  /** The write pins its arguments before they are gated (the real file tools' freezeArguments, #522). */
  writeFreeze?: boolean;
  /** The read pauses the system after it ran, so the NEXT call meets the runner's emergency check. */
  readPauses?: boolean;
  /** Each spawn gets its own child id, as the real orchestrator's do, instead of always 'child'. */
  distinctChildren?: boolean;
};

/** Real backends, boundary, Authority and SQLite; only the model and the tools are scripted. */
function backends(ids: ReturnType<typeof createRun>, opts: Options = {}) {
  const script = opts.script ?? WRITE_THEN_FINISH;
  let effects = 0, llmCalls = 0;
  const writes: Array<Record<string, unknown>> = [];
  const registry = new ToolRegistry();
  registry.register({ name: 'write_file', category: 'file-ops', description: 'Synthetic write', parameters: {},
    ...(opts.writeGate ? { authorityGate: () => opts.writeGate!() } : {}),
    ...(opts.writeFreeze ? { freezeArguments: (p: Record<string, unknown>) => ({ ...p, frozen: true }) } : {}),
    execute: async (p: Record<string, unknown>) => { writes.push(p); effects++; if (opts.writeThrows) throw new Error('disk full'); if (opts.writeInterrupts) { emergency.pause(); checkpointExecution(); } return 'saved'; } });
  registry.register({ name: 'read_file', category: 'file-ops', description: 'Synthetic read', parameters: {},
    execute: async () => { if (opts.readFails) throw new ActionOutcomeError({ status: 'error', code: 'SYNTHETIC', message: 'unreadable', effect: 'not_started' }); if (opts.readCancels) cancelFlowRun(ids.run.id); if (opts.readPauses) emergency.pause(); return 'contents'; } });
  registry.register({ name: 'run_script', category: 'terminal', description: 'Synthetic command', parameters: {}, execute: async () => { effects++; return 'ran'; } });
  registry.register({ name: 'run_command', category: 'terminal', description: 'Synthetic shell', parameters: {}, execute: async () => { effects++; return 'ran'; } });
  // A gated tool: approvable in a flow step through its adapter, never here.
  registry.register({ name: 'run_skill', category: 'automation', description: 'Synthetic skill replay', parameters: {},
    authorityGate: () => ({ actionCategory: 'send_email', intent: 'click Send (sends email)' }),
    execute: async () => { effects++; return 'replayed'; } });
  // #638, signal one: the real `ui_act` name, so `rawUiGate` judges it as a raw
  // UI action requiring mandatory review. In NONE of bounded/opaque/gated,
  // which is the shape that passes this route's two set checks.
  registry.register({ name: 'ui_act', category: 'ui', description: 'Synthetic UI action', parameters: {},
    captureApprovalGuard: () => () => true,
    execute: async () => { effects++; return 'clicked'; } });
  // #638, signal two: a tool that declares it binds a live subject but that
  // nobody registered in `REVIEWED_UI_TOOLS`. This is the case with NO upstream
  // protection -- `rawUiGate` says nothing about it, so `gate.confirm` is not
  // 'always' and `sub-agent-runner.ts` lets it through to this route. Its
  // category is governed in the tests below, so it would otherwise take a card
  // and a waitpoint with no surface in the record.
  // #638, signal three: a tool whose own `authorityGate` throws, which is how
  // `resolveToolGate` manufactures `confirm: 'always'` for a tool that is in no
  // set and declares no guard -- the producer `surfaceBoundRefusal` cannot see.
  registry.register({ name: 'wobbly_gate', category: 'automation', description: 'Synthetic tool with a failing gate', parameters: {},
    authorityGate: () => { throw new Error('gate could not read the filesystem'); },
    execute: async () => { effects++; return 'ran'; } });
  registry.register({ name: 'tap_widget', category: 'ui', description: 'Synthetic unregistered surface tool', parameters: {},
    authorityGate: () => ({ actionCategory: 'control_app', intent: 'tap a widget' }),
    captureApprovalGuard: () => () => true,
    execute: async () => { effects++; return 'tapped'; } });
  const authority = new AuthorityEngine({ default_level: opts.authority?.default_level ?? 10,
    governed_categories: (opts.authority?.governed_categories ?? ['write_data']) as any, overrides: (opts.authority?.overrides ?? []) as any,
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const emergency = new EmergencyController();
  const auditTrail = new AuditTrail();
  let spawned = 0;
  const child = () => {
    const history: Array<{ role: string; content: unknown }> = [];
    spawned++;
    return { id: opts.distinctChildren ? `child-${spawned}` : 'child', agent: { role: ROLE, authority: { allowed_tools: ROLE.tools, max_authority_level: opts.childLevel ?? 10 } },
      setTask() {}, activate() {}, idle() {}, addMessage: (role: string, content: unknown) => history.push({ role, content }),
      getMessages: () => history };
  };
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    toolRegistry: registry, authorityEngine: authority, emergencyController: emergency, auditTrail,
    approvalManager: approvals,
    agentOrchestrator: { getPrimary: () => ({ id: 'primary' }), spawnSubAgent: child, terminateAgent: () => {} } as any,
    agentSpecialists: new Map([[ROLE.id, ROLE]]) as any,
    agentScopedRegistry: () => registry,
    llmManager: { chatTier: async (_tier: string, _origin: string, messages: Array<{ role: string }>) => {
      llmCalls++;
      // The next scripted turn is the one after as many answered tool calls as the log holds.
      const answered = messages.filter(m => m.role === 'tool').length;
      const turn = script[answered];
      if (!turn || turn === 'finish') return { content: 'Saved the note', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } };
      return { content: '', finish_reason: 'tool_use', tool_calls: [{ id: `call-${answered + 1}`, name: turn.call, arguments: turn.args ?? {} }],
        usage: { input_tokens: 1, output_tokens: 1 } };
    } } as any,
    channelService: {} as any, wsService: {} as any });
  const context = (path: Array<[string, number]> = []) => ({ runId: ids.run.id, projectId: DEFAULT_IDS.project, stepName: 'delegate', executionPath: path });
  const delegate = (extra: Record<string, unknown> = {}, path: Array<[string, number]> = []) =>
    services.agentDelegate!({ goal: 'Save the note', maxIterations: 4, role: ROLE.id, ...extra }, context(path));
  const route = (body: Record<string, unknown> = {}) => createJarvisAgentDelegateRoute(services)({
    req: new Request('http://127.0.0.1/v1/jarvis/agent/delegate', { method: 'POST',
      headers: { 'X-Jarvis-Step-Name': 'delegate', 'X-Jarvis-Execution-Path': '[]' },
      body: JSON.stringify({ goal: 'Save the note', maxIterations: 4, role: ROLE.id, ...body }) }),
    claims: { runId: ids.run.id, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {} });
  return { services, approvals, emergency, authority, auditTrail, delegate, route, effects: () => effects, llmCalls: () => llmCalls,
    writes };
}

const audit = () => (getWorkflowDb().query('SELECT agent_id, tool_name, authority_decision, executed FROM audit_trail ORDER BY rowid')
  .all() as Array<Record<string, unknown>>).map(row => [row.agent_id, row.tool_name, row.authority_decision, Boolean(row.executed)]);

describe('delegated approvals through the workflow effect boundary', () => {
  test('a governed tool parks the delegation before any effect, bound to run, step, tool, arguments and principal', async () => {
    const ids = createRun();
    const f = backends(ids);
    const reply = await f.delegate();
    expect(reply.status).toBe('approval_required');
    expect(reply.approval).toMatchObject({ effectId: expect.any(String), approvalId: expect.any(String), waitpointId: expect.any(String) });
    expect(f.effects()).toBe(0);
    expect(f.llmCalls()).toBe(1);

    const effects = listWorkflowEffects(ids.run.id);
    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatchObject({ route: 'agent', status: 'succeeded', result: { dispatch: 'authorized' }, target: { role: ROLE.id } });
    expect(effects[1]).toMatchObject({ route: 'agent-tool:1', status: 'pending', toolName: 'write_file', actionCategory: 'write_data',
      decision: 'approval_required', stepName: 'delegate', versionId: ids.version.id, arguments: ARGS,
      target: { tool: 'write_file', sequence: 1, principal: { agentId: 'child', agentRoleId: ROLE.id, agentAuthorityLevel: 10 } },
      approvalId: reply.approval!.approvalId, waitpointId: reply.approval!.waitpointId });
    const [pending] = f.approvals.getPending();
    expect(f.approvals.getPending()).toHaveLength(1);
    expect(pending).toMatchObject({ tool_name: 'write_file', execution_mode: 'workflow', action_category: 'write_data',
      agent_name: `Workflow: Delegated routine as ${ROLE.id}` });
    // Frozen arguments, canonical key order; the approval is bound to exactly these.
    expect(JSON.parse(pending!.tool_arguments)).toEqual(ARGS);
    expect(JSON.parse(pending!.context)).toMatchObject({ effectId: reply.approval!.effectId, runId: ids.run.id, stepName: 'delegate',
      versionId: ids.version.id, target: { tool: 'write_file', sequence: 1, principal: { agentRoleId: ROLE.id } } });

    const checkpoint = getDelegation(delegationId(ids.run.id));
    expect(checkpoint).toMatchObject({ status: 'paused', runId: ids.run.id, stepName: 'delegate', roleId: ROLE.id,
      goal: 'Save the note', sequence: 1, iteration: 0, taint: [], failedToolCalls: [],
      pending: { toolCall: { id: 'call-1', name: 'write_file', arguments: ARGS }, sequence: 1, remaining: [], iteration: 0,
        approval: reply.approval, principal: { agentId: 'child', agentRoleId: ROLE.id, agentAuthorityLevel: 10 } } });
    expect(checkpoint!.messages.at(-1)).toMatchObject({ role: 'assistant' });
    // The sub-agent gate's row is under the run too (#730), not the spawned
    // child's id, which nothing ties back to the run.
    expect(audit()).toEqual([
      [`workflow:${ids.run.id}`, 'workflow_delegate', 'allowed', true],
      [`workflow:${ids.run.id}`, 'write_file', 'approval_required', false],
      [`workflow:${ids.run.id}`, 'write_file', 'approval_required', false],
    ]);
    // The boundary's row says who was judged; the gate's row says which
    // sub-agent decided, under the step it ran in.
    const names = (getWorkflowDb().query('SELECT agent_name FROM audit_trail WHERE tool_name = ? ORDER BY rowid').all('write_file') as Array<{ agent_name: string }>);
    expect(names[0]!.agent_name).toContain(`as ${ROLE.id} (level 10)`);
    expect(names[1]!.agent_name).toBe(`Workflow ${ids.run.id} / delegate / ${ROLE.name} (sub-agent child)`);
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
    expect(getDelegation(delegationId(ids.run.id))).toMatchObject({ status: 'completed', messages: [], result: { status: 'completed' } });
    // The boundary audits the dispatch it made under the approval; the gate wrote nothing new.
    expect(audit().at(-1)).toEqual([`workflow:${ids.run.id}`, 'write_file', 'approval_required', true]);
    expect(audit()).toHaveLength(4);

    // The engine running the step again gets the record, not a new conversation, with the declaration it asks with now.
    expect(await f.delegate()).toEqual(done);
    expect((await f.delegate({ requiredTools: ['read_file'] })).outcome).toMatchObject({ status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED', effect: 'not_started' });
    expect(f.effects()).toBe(1);
    expect(f.llmCalls()).toBe(2);
  });

  test('a call that reaches a stricter category at dispatch than at review is blocked, not run under the old approval', async () => {
    // Reviewed as a plain write; by the time it is approved, the same frozen
    // arguments name a path that runs as code (#522).
    let raised = false;
    const ids = createRun();
    const f = backends(ids, { writeGate: () => (raised ? { actionCategory: 'execute_command', intent: 'Write a shell startup file' } : null) });
    const parked = await f.delegate();
    expect(parked.status).toBe('approval_required');
    raised = true;
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate();
    expect(f.effects()).toBe(0);
    expect(done.toolCalls[0]!.error).toContain('now reaches execute_command');
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'blocked' });
  });

  test('a sub-agent below a gated call\'s level gets an approval, not a denial, and it runs once approved', async () => {
    // A write the gate raises to execute_command (a shell rc, #522), asked
    // by a level-3 sub-agent: the chat gate's above-level substitution.
    const ids = createRun();
    const f = backends(ids, { childLevel: 3, authority: { default_level: 3 },
      writeGate: () => ({ actionCategory: 'execute_command', confirm: 'above_level', intent: 'Write a file that can run as code' }) });
    const parked = await f.delegate();
    expect(parked.status).toBe('approval_required');
    expect(f.effects()).toBe(0);
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate();
    expect(f.effects()).toBe(1);
    expect(done.toolCalls[0]!.result).toContain('saved');
  });

  test('a sub-agent\'s call is frozen before it is gated, and the approved run gets the frozen arguments', async () => {
    const ids = createRun();
    const f = backends(ids, { writeFreeze: true });
    const parked = await f.delegate();
    expect(parked.status).toBe('approval_required');
    // The durable record holds what will run: the frozen arguments.
    expect(JSON.parse(f.approvals.getRequest(parked.approval!.approvalId)!.tool_arguments)).toMatchObject({ frozen: true });
    f.approvals.approve(parked.approval!.approvalId, 'test');
    await f.delegate();
    expect(f.writes).toEqual([{ ...ARGS, frozen: true }]);
  });

  test('without the gate asking for it, the same shortfall is still a denial', async () => {
    const ids = createRun();
    const f = backends(ids, { childLevel: 3, authority: { default_level: 3 }, writeGate: () => ({ actionCategory: 'execute_command', intent: 'Write a file' }) });
    const done = await f.delegate();
    expect(f.effects()).toBe(0);
    expect(done.toolCalls[0]!.error).toContain('AUTHORITY DENIED');
  });

  test('a call whose category is unchanged at dispatch still runs under its approval', async () => {
    const ids = createRun();
    const f = backends(ids, { writeGate: () => ({ actionCategory: 'write_data', intent: 'Write a note' }) });
    const parked = await f.delegate();
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate();
    expect(f.effects()).toBe(1);
    expect(done.toolCalls[0]!.result).toContain('saved');
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

  test('an expired approval resumes the same way', async () => {
    const ids = createRun();
    const f = backends(ids);
    const parked = await f.delegate();
    expect(f.approvals.expireOld(-1)).toBe(1);
    expect(f.approvals.getRequest(parked.approval!.approvalId)!.status).toBe('expired');
    const done = await f.delegate();
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toContain('Workflow approval expired');
    expect(f.effects()).toBe(0);
  });

  test('a role-scoped rule that requires approval parks the run even when the category is not governed globally', async () => {
    const ids = createRun();
    const f = backends(ids, { authority: { governed_categories: [],
      overrides: [{ action: 'write_data', role_id: ROLE.id, allowed: true, requires_approval: true }] } });
    const reply = await f.delegate();
    expect(reply.status).toBe('approval_required');
    expect(f.effects()).toBe(0);
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'pending', decision: 'approval_required' });
    f.approvals.approve(reply.approval!.approvalId, 'test');
    expect((await f.delegate()).status).toBe('completed');
    expect(f.effects()).toBe(1);
  });

  test('a level the sub-agent holds is judged as the sub-agent, not as the workflow', async () => {
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'run_script' }, 'finish'],
      authority: { default_level: 3, governed_categories: ['execute_command'] }, childLevel: 6 });
    const reply = await f.delegate();
    expect(reply.status).toBe('approval_required');
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', toolName: 'run_script', actionCategory: 'execute_command', status: 'pending' });
    f.approvals.approve(reply.approval!.approvalId, 'test');
    const done = await f.delegate();
    expect(done).toMatchObject({ status: 'completed', outcome: { status: 'succeeded' } });
    expect(f.effects()).toBe(1);
  });

  test('a tool the direct tool piece refuses as opaque is refused here too, before any record', async () => {
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'run_command', args: { command: 'rm -rf /' } }, 'finish'],
      authority: { governed_categories: ['execute_command'] } });
    const done = await f.delegate({ requiredTools: ['run_command'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toMatch(/^\[APPROVAL DENIED\] run_command: Unsupported workflow capability/);
    expect(done.outcome).toMatchObject({ status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED' });
    expect(f.effects()).toBe(0);
    expect(f.approvals.getPending()).toEqual([]);
    expect(listWorkflowEffects(ids.run.id).map(e => e.route)).toEqual(['agent']);
  });

  test('a gated tool is refused here too: its adapter only runs on the flow step path', async () => {
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'run_skill', args: { name: 'gmail-send' } }, 'finish'],
      authority: { governed_categories: ['send_email'] } });
    const done = await f.delegate({ requiredTools: ['run_skill'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toMatch(/^\[APPROVAL DENIED\] run_skill: Unsupported workflow capability/);
    expect(done.toolCalls[0]!.error).toMatch(/only approvable through its typed adapter/);
    // Nothing replayed, no record, and no card that would have named only the tool.
    expect(f.effects()).toBe(0);
    expect(f.approvals.getPending()).toEqual([]);
    expect(listWorkflowEffects(ids.run.id).map(e => e.route)).toEqual(['agent']);
  });

  /**
   * #638. Why a surface-bound approval must never reach this boundary.
   *
   * A workflow waitpoint is designed to wait; `ui_act`'s element ids come from
   * a process-local counter that restarts at 1; and its own in-execute checks
   * compare the CURRENT entry for an id against ITSELF -- so after a restart
   * every one of them passes while the id names a different element on a
   * different surface. `captureApprovalGuard`'s object-identity test is the
   * control that catches that, and the boundary cannot hold one: its record is
   * durable and that closure is not.
   *
   * The dispatch recheck cannot stand in. `validateTarget` on this route
   * compares severity and only refuses a call that got STRICTER; once the
   * addressed entry is gone `uiActTool.authorityGate` returns null and the
   * recomputed category is LOWER. It is blind in the one direction the failure
   * takes.
   *
   * These two tests pin the two signals separately, because only one of them
   * has no upstream equivalent -- see each.
   */
  test('a raw UI action never dispatches and never takes a card, by whichever layer gets there first (#638)', async () => {
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'ui_act', args: { element_id: 7, action: 'click' } }, 'finish'],
      authority: { governed_categories: ['control_app'] } });
    const done = await f.delegate({ requiredTools: ['ui_act'] });
    expect(done.status).toBe('completed');
    // TITLE CORRECTED after review: this test cannot establish "by this route
    // itself", and said so in its body while claiming it in its name.
    // `sub-agent-runner.ts` refuses `ui_act` first -- `rawUiGate` makes it
    // `confirm: 'always'` and a sub-agent may not request a confirmation -- so
    // this passes identically with and without the route's own refusal, which
    // is also why #638 was never exploitable. What it pins is the OUTCOME, and
    // it stays meaningful if the upstream gate is relaxed. The route's own
    // predicate is pinned where it is observable: behaviourally by the
    // `tap_widget` test below, which has no upstream refusal, and directly over
    // all 14 names in `bounded-tools.test.ts`.
    expect(done.toolCalls[0]!.error).toMatch(
      /^\[(AUTHORITY|APPROVAL) DENIED\] ui_act\b.*(Sub-agents cannot request approvals|live UI surface|explicit confirmation)/);
    expect(f.effects()).toBe(0);
    expect(f.approvals.getPending()).toEqual([]);
    expect(listWorkflowEffects(ids.run.id).map(e => e.route)).toEqual(['agent']);
  });

  /**
   * #638, the third producer of `confirm: 'always'` -- the one
   * `surfaceBoundRefusal` cannot see.
   *
   * `resolveToolGate` manufactures `confirm: 'always'` when a tool's own
   * `authorityGate` THROWS (`tool-action-map.ts`), for any tool, UI or not. So
   * `rawUiGate` says nothing, the tool declares no guard, and the route's
   * surface predicate passes it.
   *
   * REVIEW RAISED THIS AS REACHABLE, AND IT IS NOT -- measured here, which is
   * why the test exists. `sub-agent-runner.ts` computes `resolveToolGate` over
   * the same tool and arguments, so it hits the same throw and the same
   * fallback, and denies with its own message before `governedTools` is reached.
   * The assertion below accepts either refusal for that reason.
   *
   * What the review got right is the hazard in the first draft's ANSWER to it.
   * That draft forwarded `confirmation` into the boundary, which recomputes it
   * on every invoke while the stored approval context is frozen at creation --
   * so a gate that throws only at RESUME would fail an already-granted approval
   * with "approval predates required UI review" and park its waitpoint, and it
   * would label a non-UI card a UI effect. The forwarding is gone and this route
   * denies instead, which is what the rest of the subsystem already does and
   * needs no state to be right.
   *
   * A throwing gate is not maintenance fiction: the fallback exists precisely
   * because gates read the filesystem and the sidecar list.
   */
  test('a tool whose own gate THROWS never dispatches and never takes a card (#638)', async () => {
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'wobbly_gate', args: { x: 1 } }, 'finish'],
      authority: { governed_categories: ['write_data'] } });
    const done = await f.delegate({ requiredTools: ['wobbly_gate'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toMatch(
      /^\[AUTHORITY DENIED\] wobbly_gate requires the user's (confirmation|explicit confirmation)/);
    // The three things a mandatory-review call must not leave behind on this
    // route: a dispatch, a card, and a durable record for the call.
    expect(f.effects()).toBe(0);
    expect(f.approvals.getPending()).toEqual([]);
    expect(listWorkflowEffects(ids.run.id).map(e => e.route)).toEqual(['agent']);
  });

  test('a tool that declares a surface binding nobody registered is refused HERE, with nothing upstream to catch it (#638)', async () => {
    // The case with no other defence. `tap_widget` carries a
    // `captureApprovalGuard` and is absent from `REVIEWED_UI_TOOLS`, so
    // `rawUiGate` says nothing, `gate.confirm` is not 'always', and the
    // sub-agent gate passes it straight through. Its category is governed, so
    // before this refusal it took an approval card and a MANUAL waitpoint with
    // no surface anywhere in the record.
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'tap_widget', args: { widget: 'Pay' } }, 'finish'],
      authority: { governed_categories: ['control_app'] } });
    const done = await f.delegate({ requiredTools: ['tap_widget'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toMatch(/^\[APPROVAL DENIED\] tap_widget: Unsupported workflow capability/);
    expect(done.toolCalls[0]!.error).toMatch(/cannot stay bound to the screen it was reviewed against/);
    // The three things that must not exist: no dispatch, no durable record for
    // the call, and above all no CARD -- a pending card is a click the user can
    // spend on an action nothing is holding the surface for.
    expect(f.effects()).toBe(0);
    expect(f.approvals.getPending()).toEqual([]);
    expect(listWorkflowEffects(ids.run.id).map(e => e.route)).toEqual(['agent']);
  });

  /**
   * #672. A call that reaches this route and is parked or dispatched leaves a
   * row under the RUN (`workflow:<runId>`, written by the boundary) beside the
   * sub-agent gate's row under the child's own id. A call the route REFUSED
   * left only the child's row -- whose agent id is the spawned sub-agent's and
   * whose name is the role's, so nothing in it names the run or the step, and
   * a query for the run's audit (`/api/authority/audit?agentId=workflow:<id>`)
   * showed the delegation allowed and then nothing. `toolsInvoke` and
   * `pieceAuthorize` already audit their refusals there.
   *
   * Since #730 the gate's row is under the run as well, with the child and
   * the step in its name, so both rows below carry `workflow:<runId>`.
   */
  test('a refusal on this route is audited under the run, beside the sub-agent gate\'s own row (#672)', async () => {
    for (const [tool, args, governed] of [
      ['run_command', { command: 'rm -rf /' }, 'execute_command'],
      ['run_skill', { name: 'gmail-send' }, 'send_email'],
      ['tap_widget', { widget: 'Pay' }, 'control_app'],
    ] as const) {
      getWorkflowDb().run('DELETE FROM audit_trail');
      const ids = createRun();
      const f = backends(ids, { script: [{ call: tool, args }, 'finish'], authority: { governed_categories: [governed] } });
      const done = await f.delegate({ requiredTools: [tool] });
      expect(done.toolCalls[0]!.error).toMatch(new RegExp(`^\\[APPROVAL DENIED\\] ${tool}: Unsupported workflow capability`));
      const rows = audit().filter(row => row[1] === tool);
      // Both under the run since #730: the route's refusal and the sub-agent
      // gate's own row.
      expect({ tool, rows }).toEqual({ tool, rows: [
        [`workflow:${ids.run.id}`, tool, 'denied', false],
        [`workflow:${ids.run.id}`, tool, 'denied', false],
      ] });
      // The run's row names the step, and is in the category the gate judged,
      // so the two rows describe the same decision.
      const [runRow, childRow] = getWorkflowDb().query('SELECT agent_name, action_category FROM audit_trail WHERE agent_id = ? AND tool_name = ? ORDER BY rowid')
        .all(`workflow:${ids.run.id}`, tool) as Array<{ agent_name: string; action_category: string }>;
      expect(runRow!.agent_name).toBe(`Workflow ${ids.run.id} / delegate`);
      expect(childRow!.agent_name).toBe(`Workflow ${ids.run.id} / delegate / ${ROLE.name} (sub-agent child)`);
      expect(runRow!.action_category).toBe(childRow!.action_category);
      // Still nothing durable for the refused call itself.
      expect(listWorkflowEffects(ids.run.id).map(e => e.route)).toEqual(['agent']);
    }
  });

  /**
   * #672, the fourth refusal, which the first pass cannot reach (the
   * sub-agent's own gate denies `confirm: 'always'` first) but a RESUME can:
   * the runner hands the parked call straight back to this dispatch without
   * re-running its gate, and writes no row of its own on that path. So before
   * #672 this refusal left no audit row anywhere. And it is decided on a gate
   * recomputed now, so the row carries the worse of that and the parked call's
   * category -- the parked one alone would record a write that was refused as
   * a command.
   */
  test('a resumed call refused for confirmation is audited under the run, at the category that refused it (#672)', async () => {
    let raised = false;
    const ids = createRun();
    const f = backends(ids, { writeGate: () => (raised
      ? { actionCategory: 'execute_command', intent: 'Write a shell startup file', confirm: 'always' }
      : null) });
    const parked = await f.delegate();
    expect(parked.status).toBe('approval_required');
    raised = true;
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate();
    expect(f.effects()).toBe(0);
    expect(done.toolCalls[0]!.error).toMatch(/requires the user's explicit confirmation/);
    const rows = getWorkflowDb().query(
      'SELECT agent_id, authority_decision, action_category FROM audit_trail WHERE tool_name = ? ORDER BY rowid')
      .all('write_file') as Array<{ agent_id: string; authority_decision: string; action_category: string }>;
    expect(rows).toEqual([
      { agent_id: `workflow:${ids.run.id}`, authority_decision: 'approval_required', action_category: 'write_data' },
      // The sub-agent gate's row, under the run since #730.
      { agent_id: `workflow:${ids.run.id}`, authority_decision: 'approval_required', action_category: 'write_data' },
      { agent_id: `workflow:${ids.run.id}`, authority_decision: 'denied', action_category: 'execute_command' },
    ]);
  });

  /**
   * #730. The calls the sub-agent's OWN gate decides -- a denial, a call it
   * runs without approval, a suspension -- were audited only under the
   * spawned child's id and the role's name. A new child is spawned on every
   * resume and nothing records which child belonged to which run, so none of
   * them could be tied back to the run. They are written under the run now,
   * with the child and the step in the name.
   */
  test('the sub-agent gate\'s own decisions are audited under the run, across every spawn of a resumed delegation (#730)', async () => {
    const ids = createRun();
    // Spawn one parks the write; spawn two resumes it and then calls a tool
    // its own gate refuses (the gate throws, so it is `confirm: 'always'`).
    const f = backends(ids, { distinctChildren: true, script: [{ call: 'write_file', args: ARGS }, { call: 'wobbly_gate' }, 'finish'] });
    const parked = await f.delegate();
    expect(parked.status).toBe('approval_required');
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate();
    expect(done.toolCalls[1]!.error).toMatch(/AUTHORITY DENIED/);
    const gateRows = getWorkflowDb().query(
      "SELECT agent_id, agent_name, tool_name, authority_decision, executed FROM audit_trail WHERE agent_name LIKE '%(sub-agent %' ORDER BY rowid").all();
    expect(gateRows).toEqual([
      { agent_id: `workflow:${ids.run.id}`, agent_name: `Workflow ${ids.run.id} / delegate / ${ROLE.name} (sub-agent child-1)`,
        tool_name: 'write_file', authority_decision: 'approval_required', executed: 0 },
      { agent_id: `workflow:${ids.run.id}`, agent_name: `Workflow ${ids.run.id} / delegate / ${ROLE.name} (sub-agent child-2)`,
        tool_name: 'wobbly_gate', authority_decision: 'denied', executed: 0 },
    ]);
    // Nothing is left under a spawned child's id: the run's query is complete.
    expect(getWorkflowDb().query("SELECT COUNT(*) AS n FROM audit_trail WHERE agent_id LIKE 'child%'").get()).toEqual({ n: 0 });
  });

  test('a call the sub-agent runs without approval, and one it meets suspended, are audited under the run (#730)', async () => {
    const ids = createRun();
    const f = backends(ids, { readPauses: true,
      script: [{ call: 'read_file', args: { path: '/tmp/synthetic' } }, { call: 'write_file', args: ARGS }, 'finish'] });
    const done = await f.delegate();
    expect(done.toolCalls[1]!.error).toContain('[SYSTEM PAUSED]');
    expect(f.effects()).toBe(0);
    const rows = getWorkflowDb().query(
      "SELECT agent_id, agent_name, tool_name, action_category, authority_decision, executed FROM audit_trail WHERE tool_name IN ('read_file', 'write_file') ORDER BY rowid").all();
    expect(rows).toEqual([
      { agent_id: `workflow:${ids.run.id}`, agent_name: `Workflow ${ids.run.id} / delegate / ${ROLE.name} (sub-agent child)`,
        tool_name: 'read_file', action_category: 'read_data', authority_decision: 'allowed', executed: 1 },
      { agent_id: `workflow:${ids.run.id}`, agent_name: `Workflow ${ids.run.id} / delegate / ${ROLE.name} (sub-agent child)`,
        tool_name: 'write_file', action_category: 'write_data', authority_decision: 'denied', executed: 0 },
    ]);
  });

  /**
   * #731. The resumed call above is refused at this dispatch, so the boundary
   * never sees it -- and the `agent-tool:N` record the first pass parked stayed
   * `pending` with its approval granted, for good: no terminal state, and
   * nothing for an operator reading the run's effects to tell it was refused.
   * Reachable with a real tool, not only this synthetic gate:
   * `browser_upload_file`'s gate is null for a path that does not exist yet
   * (an ordinary governed write that parks) and `confirm: 'always'` once it
   * does. Now the record is `blocked` with the refusal as its reason, which is
   * what the boundary does for its own refusals, and stays blocked.
   */
  test('a resumed call refused at the dispatch marks its parked effect blocked with the reason, for good (#731)', async () => {
    let raised = false;
    const ids = createRun();
    const f = backends(ids, { writeGate: () => (raised
      ? { actionCategory: 'execute_command', intent: 'Write a shell startup file', confirm: 'always' }
      : null) });
    const parked = await f.delegate({ requiredTools: ['write_file'] });
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'pending' });
    raised = true;
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate({ requiredTools: ['write_file'] });
    expect(f.effects()).toBe(0);
    const refusal = done.toolCalls[0]!.error!;
    expect(refusal).toMatch(/requires the user's explicit confirmation/);
    const effect = listWorkflowEffects(ids.run.id)[1]!;
    expect(effect).toMatchObject({ route: 'agent-tool:1', status: 'blocked', decision: 'denied',
      approvalId: parked.approval!.approvalId, finishedAt: expect.any(Number) });
    // The reason an operator reads is the refusal the agent got.
    expect(refusal).toContain(effect.error!);
    expect(effect.reason).toBe(effect.error!);
    expect(effect.error).toMatch(/^Unsupported workflow capability: write_file requires the user's explicit confirmation/);

    // Terminal: the gate relaxing does not revive it, the scheduler has
    // nothing to resume, and asking again answers the same without running.
    raised = false;
    expect(resumeResolvedWorkflowEffects()).toBe(0);
    expect(await f.delegate({ requiredTools: ['write_file'] })).toEqual(done);
    expect(f.effects()).toBe(0);
    expect(listWorkflowEffects(ids.run.id)[1]).toEqual(effect);
  });

  test('a refusal blocks only the record of the call it refused, not another call parked at the same position (#731)', async () => {
    // A record at the same `agent-tool:N` bound to different arguments is a
    // different call (a turn re-run from an earlier checkpoint can produce
    // one). Blocking it would put this refusal's reason on a call nobody
    // refused, so it is left alone.
    let raised = false;
    const ids = createRun();
    const f = backends(ids, { writeGate: () => (raised
      ? { actionCategory: 'execute_command', intent: 'Write a shell startup file', confirm: 'always' }
      : null) });
    const parked = await f.delegate();
    const { saveDelegation } = await import('../db/repos/delegation');
    const checkpoint = getDelegation(delegationId(ids.run.id))!;
    saveDelegation({ ...checkpoint, pending: { ...checkpoint.pending!,
      toolCall: { ...checkpoint.pending!.toolCall, arguments: { path: '/tmp/other', content: 'other' } } } });
    raised = true;
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate();
    expect(done.toolCalls[0]!.error).toMatch(/requires the user's explicit confirmation/);
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'pending', arguments: ARGS });
  });

  test('a refusal never rewrites a record that already finished (#731)', async () => {
    // The call ran under its approval, and the process died before the
    // checkpoint said so, so the resume hands the same call back. If the
    // route now refuses it, the record that says it SUCCEEDED -- the replay
    // state a resumed conversation reads instead of acting again -- must not
    // be turned into a refusal that never happened.
    let raised = false;
    const ids = createRun();
    const f = backends(ids, { writeGate: () => (raised
      ? { actionCategory: 'execute_command', intent: 'Write a shell startup file', confirm: 'always' }
      : null) });
    const parked = await f.delegate();
    const { saveDelegation } = await import('../db/repos/delegation');
    const pausedCheckpoint = getDelegation(delegationId(ids.run.id))!;
    f.approvals.approve(parked.approval!.approvalId, 'test');
    await f.delegate();
    expect(f.effects()).toBe(1);
    const succeeded = listWorkflowEffects(ids.run.id)[1]!;
    expect(succeeded).toMatchObject({ route: 'agent-tool:1', status: 'succeeded' });
    saveDelegation(pausedCheckpoint);
    raised = true;
    const again = await f.delegate();
    expect(again.toolCalls[0]!.error).toMatch(/requires the user's explicit confirmation/);
    expect(f.effects()).toBe(1);
    expect(listWorkflowEffects(ids.run.id)[1]).toEqual(succeeded);
  });

  test('a first-pass refusal at the dispatch creates no effect record to block (#731)', async () => {
    // The control: the blocking above is of the PARKED record, and a refusal
    // that never parked has none. Nothing is invented for it.
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'run_command', args: { command: 'true' } }, 'finish'],
      authority: { governed_categories: ['execute_command'] } });
    const done = await f.delegate();
    expect(done.toolCalls[0]!.error).toMatch(/Unsupported workflow capability/);
    expect(listWorkflowEffects(ids.run.id).map(e => e.route)).toEqual(['agent']);
  });

  test('the refusal does not catch the reads this route legitimately carries (#638)', async () => {
    // Non-over-refusal, in the direction the obvious fix got wrong: calling
    // `toolEffectCapability` here, as the other two routes do, would also have
    // refused `ui_snapshot` and `list_sidecars` -- reads with no surface to bind
    // and no reason to be denied. The predicate is narrower on purpose, and
    // keyed on `rawUiGate` so even `ui_act`'s own `get_value` read survives it.
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'read_file', args: { path: '/tmp/synthetic' } }, 'finish'] });
    const done = await f.delegate({ requiredTools: ['read_file'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toBeUndefined();
    expect(String(done.toolCalls[0]!.result)).toContain('contents');
  });

  test('a required tool that failed with a typed outcome is not completed', async () => {
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'read_file', args: { path: '/tmp/synthetic' } }, 'finish'], readFails: true });
    const done = await f.delegate({ requiredTools: ['read_file'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.result).toContain('unreadable');
    expect(done.toolCalls[0]!.error).toContain('unreadable');
    expect(done.outcome).toMatchObject({ status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED' });
  });

  test('a tool that throws under its approval is a failed result the agent sees, and the effect stays failed', async () => {
    const ids = createRun();
    const f = backends(ids, { writeThrows: true });
    const parked = await f.delegate({ requiredTools: ['write_file'] });
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate({ requiredTools: ['write_file'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toContain('disk full');
    expect(done.outcome).toMatchObject({ status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED' });
    expect(f.effects()).toBe(1);
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'failed' });
    expect(await f.delegate({ requiredTools: ['write_file'] })).toEqual(done);
    expect(f.effects()).toBe(1);
  });

  test('an emergency during resume blocks the pending call for good, and the agent sees the denial', async () => {
    const ids = createRun();
    const f = backends(ids);
    const parked = await f.delegate({ requiredTools: ['write_file'] });
    f.approvals.approve(parked.approval!.approvalId, 'test');
    f.emergency.pause();
    const done = await f.delegate({ requiredTools: ['write_file'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).toMatch(/^\[APPROVAL DENIED\] write_file: Workflow effect blocked: system paused/);
    expect(done.outcome).toMatchObject({ status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED' });
    expect(f.effects()).toBe(0);
    // The boundary finalized the effect as blocked, as it does for a direct tool; clearing the emergency does not revive it.
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'blocked', decision: 'denied' });
    f.emergency.resume();
    expect(await f.delegate({ requiredTools: ['write_file'] })).toEqual(done);
    expect(f.effects()).toBe(0);
  });

  test('a refusal that leaves the effect untouched is this run\'s error, and the checkpoint keeps its state', async () => {
    const ids = createRun();
    const f = backends(ids);
    const parked = await f.delegate();
    // Another surface already took the call: the record is dispatching and the boundary refuses to replay it.
    const effect = listWorkflowEffects(ids.run.id)[1]!;
    getWorkflowDb().run("UPDATE workflow_effect SET status = 'dispatching' WHERE id = ?", [effect.id]);
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const refused = await f.delegate();
    expect(refused).toMatchObject({ status: 'error', error: expect.stringContaining('already claimed') });
    expect(f.effects()).toBe(0);
    expect(getDelegation(delegationId(ids.run.id))).toMatchObject({ status: 'paused' });
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

  test('every completed turn is checkpointed, and a cancelled run keeps no conversation', async () => {
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'read_file' }, { call: 'write_file', args: ARGS }, 'finish'] });
    const parked = await f.delegate();
    expect(parked.status).toBe('approval_required');
    const checkpoint = getDelegation(delegationId(ids.run.id))!;
    expect(checkpoint).toMatchObject({ status: 'paused', sequence: 2, pending: { sequence: 2, iteration: 1 } });
    expect(checkpoint.messages.filter(m => m.role === 'tool')).toHaveLength(1);
    expect(cancelFlowRun(ids.run.id).accepted).toBe(true);
    expect(getDelegation(delegationId(ids.run.id))).toBeNull();
  });

  test('a gate that required approval is never relaxed by the boundary\'s own recomputation', async () => {
    const ids = createRun();
    const f = backends(ids);
    const boundary = new WorkflowEffectBoundary({ authorityEngine: f.authority, emergencyController: f.emergency, auditTrail: f.auditTrail, approvalManager: f.approvals });
    let ran = 0;
    const invoke = (approvalRequired: boolean) => boundary.invoke({
      context: { runId: ids.run.id, projectId: DEFAULT_IDS.project, stepName: 'delegate', executionPath: [] },
      piece: PIECE, action: 'delegate', route: `agent-tool:${approvalRequired ? 2 : 1}`, toolName: 'read_file', category: 'read_data', toolCategory: 'file-ops',
      request: { toolName: 'read_file', arguments: {} }, prepare: () => ({ arguments: {}, target: { tool: 'read_file' } }),
      principal: { agentId: 'child', agentRoleId: ROLE.id, agentAuthorityLevel: 10, profile: null }, approvalRequired,
      execute: async () => { ran++; return 'contents'; } });
    // Reading is not governed here, so the boundary on its own runs it.
    expect(await invoke(false)).toEqual({ result: 'contents' });
    expect(ran).toBe(1);
    // The same call with the gate's requirement parks instead.
    const forced = await invoke(true);
    expect(forced.approval).toMatchObject({ approvalId: expect.any(String), waitpointId: expect.any(String) });
    expect(ran).toBe(1);
    expect(listWorkflowEffects(ids.run.id).find(e => e.route === 'agent-tool:2')).toMatchObject({ status: 'pending', decision: 'approval_required',
      reason: expect.stringContaining('approval required by the calling gate') });
  });

  test('every reached category is judged as the principal, and the gate\'s requirement still ratchets on top', async () => {
    const ids = createRun();
    const f = backends(ids);
    const boundary = new WorkflowEffectBoundary({ authorityEngine: f.authority, emergencyController: f.emergency, auditTrail: f.auditTrail, approvalManager: f.approvals });
    let ran = 0;
    const invoke = (route: string, categories: ActionCategory[] | undefined, approvalRequired: boolean) => boundary.invoke({
      context: { runId: ids.run.id, projectId: DEFAULT_IDS.project, stepName: 'delegate', executionPath: [] },
      piece: PIECE, action: 'delegate', route, toolName: 'read_file', category: 'read_data', toolCategory: 'file-ops',
      ...(categories ? { categories } : {}),
      request: { toolName: 'read_file', arguments: { route } }, prepare: () => ({ arguments: { route }, target: { tool: 'read_file' } }),
      principal: { agentId: 'child', agentRoleId: ROLE.id, agentAuthorityLevel: 10, profile: null }, approvalRequired,
      execute: async () => { ran++; return 'contents'; } });
    // read_data alone is not governed, so the nominal category would run.
    expect(await invoke('agent-tool:10', ['read_data'], false)).toEqual({ result: 'contents' });
    expect(ran).toBe(1);
    // The same nominal category, now declaring it also reaches write_data,
    // which IS governed: the fold parks it and the card is labelled with the
    // category that asked, not with the nominal one.
    const folded = await invoke('agent-tool:11', ['read_data', 'write_data'], false);
    expect(folded.approval).toBeDefined();
    expect(ran).toBe(1);
    expect(f.approvals.getRequest(folded.approval!.approvalId)!.action_category).toBe('write_data');
    // The fold and the ratchet compose: a gate that already required approval
    // cannot be relaxed by the fold, and the fold cannot bypass the ratchet.
    const both = await invoke('agent-tool:12', ['read_data', 'write_data'], true);
    expect(both.approval).toBeDefined();
    expect(ran).toBe(1);
  });

  test('a fence raised inside the tool under its approval is a failed effect the agent continues from, with its receipt', async () => {
    const ids = createRun();
    const f = backends(ids, { writeInterrupts: true });
    const parked = await f.delegate({ requiredTools: ['write_file'] });
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.delegate({ requiredTools: ['write_file'] });
    expect(done.status).toBe('completed');
    expect(done.toolCalls[0]!.error).not.toMatch(/APPROVAL DENIED/);
    expect(done.toolCalls[0]!.error).toContain('system paused');
    expect(done.outcome).toMatchObject({ status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED', effect: 'may_have_occurred' });
    expect(listWorkflowEffects(ids.run.id)[1]).toMatchObject({ route: 'agent-tool:1', status: 'failed', outcome: { code: 'TOOL_FAILED', effect: 'may_have_occurred' } });
    // The approval row is not the receipt for a workflow effect; the effect record is (A4 leaves workflow-owned rows to it).
    expect(f.approvals.getRequest(parked.approval!.approvalId)).toMatchObject({ status: 'approved' });
    expect(f.effects()).toBe(1);
  });

  test('a run cancelled inside a turn answers canceled and writes no conversation back', async () => {
    const ids = createRun();
    const f = backends(ids, { script: [{ call: 'read_file' }, { call: 'write_file', args: ARGS }, 'finish'], readCancels: true });
    const done = await f.delegate();
    expect(done).toMatchObject({ status: 'canceled', outcome: { status: 'error', code: 'AGENT_CANCELED' } });
    expect(getDelegation(delegationId(ids.run.id))).toBeNull();
    expect(f.effects()).toBe(0);
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

  test('each loop position is its own delegation with its own effects', async () => {
    const ids = createRun({}, true);
    const f = backends(ids);
    const first = await f.delegate({}, [['loop', 0]]);
    const second = await f.delegate({}, [['loop', 1]]);
    expect(first.status).toBe('approval_required');
    expect(second.status).toBe('approval_required');
    expect(first.approval!.effectId).not.toBe(second.approval!.effectId);
    expect(getDelegation(delegationId(ids.run.id, [['loop', 0]]))).toMatchObject({ status: 'paused', executionPath: [['loop', 0]] });
    expect(getDelegation(delegationId(ids.run.id, [['loop', 1]]))).toMatchObject({ status: 'paused', executionPath: [['loop', 1]] });
    expect(listWorkflowEffects(ids.run.id).map(e => [e.route, e.executionPath])).toEqual([
      ['agent', [['loop', 0]]], ['agent-tool:1', [['loop', 0]]], ['agent', [['loop', 1]]], ['agent-tool:1', [['loop', 1]]]]);
    f.approvals.approve(first.approval!.approvalId, 'test');
    expect((await f.delegate({}, [['loop', 0]])).status).toBe('completed');
    expect((await f.delegate({}, [['loop', 1]])).status).toBe('approval_required');
    expect(f.effects()).toBe(1);
  });

  test('the route maps the declared outcome to status codes and validates the declaration', async () => {
    const quiet = createRun();
    const g = backends(quiet, { script: ['finish'] });
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
      expect(getDelegation(delegationId(ids.run.id))).toMatchObject({ status: 'paused' });

      f.approvals.approve(f.approvals.getPending()[0]!.id, 'test');
      expect(resumeResolvedWorkflowEffects()).toBe(1);
      await worker.drain();
      expect(getFlowRun(ids.run.id)!.status).toBe('SUCCEEDED');
      expect(f.effects()).toBe(1);
      expect(listWorkflowEffects(ids.run.id).map(effect => [effect.route, effect.status])).toEqual([['agent', 'succeeded'], ['agent-tool:1', 'succeeded']]);
      expect(getDelegation(delegationId(ids.run.id))).toMatchObject({ status: 'completed',
        result: { status: 'completed', finalMessage: 'Saved the note', outcome: { status: 'succeeded' } } });
    } finally { await runtime.shutdown(); await api.stop(); }
  }, 60_000);
});
