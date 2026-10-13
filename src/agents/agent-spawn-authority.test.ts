import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { AgentInstance, canSpawnChildren } from './agent.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { loadRole } from '../roles/loader.ts';
import type { RoleDefinition } from '../roles/types.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager, type ApprovalRequest } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import { EmergencyController } from '../authority/emergency.ts';
import { runAsApproved, spendApproval } from '../authority/approved-action-scope.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import {
  assignPersistentAgentTask, createManageAgentsTool, spawnPersistentAgent, startPersistentAgent, type AgentToolDeps,
} from '../actions/tools/agents.ts';
import { AgentTaskManager, TaskHaltedError } from './task-manager.ts';
import type { RunSubAgentOptions } from './sub-agent-runner.ts';
import type { LLMManager } from '../llm/manager.ts';
import { AgentLifecycleRefusal } from './lifecycle-gate.ts';
import { createDelegateTool } from '../actions/tools/delegate.ts';
import { TAINT_PROFILE_LABEL } from '../authority/taint-gating.ts';
import { approvalIntentFields } from '../authority/approval-delivery.ts';
import type { LLMToolCall } from '../llm/provider.ts';

function makeEngine(
  overrides: AuthorityConfig['overrides'] = [],
  contextRules: AuthorityConfig['context_rules'] = [],
): AuthorityEngine {
  return new AuthorityEngine({
    default_level: 5,
    governed_categories: [],
    overrides,
    context_rules: contextRules,
    learning: { enabled: false, suggest_threshold: 5 },
    emergency_state: 'normal',
  });
}

const ROLES_DIR = join(import.meta.dir, '../../roles');

function makeRole(overrides: Partial<RoleDefinition>): RoleDefinition {
  return {
    id: 'test-role',
    name: 'Test Role',
    description: 'A test role.',
    responsibilities: ['Test things'],
    autonomous_actions: [],
    approval_required: [],
    tools: [],
    authority_level: 5,
    ...overrides,
  } as RoleDefinition;
}

describe('canSpawnChildren', () => {
  it('is true for a role that declares the delegation tool (no sub_roles)', () => {
    const role = makeRole({ tools: ['browser', 'delegation'] });
    expect(canSpawnChildren(role)).toBe(true);
  });

  it('is true for a role with sub_roles templates (legacy path)', () => {
    const role = makeRole({
      sub_roles: [
        {
          role_id: 'helper',
          name: 'Helper',
          description: 'helps',
          spawned_by: 'test-role',
          reports_to: 'test-role',
          max_budget_per_task: 1000,
        },
      ],
    });
    expect(canSpawnChildren(role)).toBe(true);
  });

  it('is false for a leaf role with neither', () => {
    const role = makeRole({ tools: ['browser'], sub_roles: [] });
    expect(canSpawnChildren(role)).toBe(false);
  });
});

describe('AgentInstance default authority', () => {
  it('grants can_spawn_children to delegation-capable roles', () => {
    const agent = new AgentInstance(makeRole({ tools: ['delegation'] }));
    expect(agent.agent.authority.can_spawn_children).toBe(true);
  });

  it('denies can_spawn_children to leaf roles', () => {
    const agent = new AgentInstance(makeRole({ tools: ['browser'] }));
    expect(agent.agent.authority.can_spawn_children).toBe(false);
  });
});

describe('spawnSubAgent authority gate', () => {
  // Regression for "Jarvis says it cannot spawn sub-agents despite max
  // authority": the default personal-assistant role ships the delegation
  // tool but no sub_roles, and the old sub_roles-derived flag refused
  // every spawn from it.
  it('lets the real personal-assistant role spawn a real specialist', () => {
    const pa = loadRole(join(ROLES_DIR, 'personal-assistant.yaml'));
    const specialist = loadRole(join(ROLES_DIR, 'specialists/research-analyst.yaml'));

    const orch = new AgentOrchestrator();
    const primary = orch.createPrimary(pa);
    expect(primary.agent.authority.can_spawn_children).toBe(true);

    const child = orch.spawnSubAgent(primary.id, specialist);
    expect(child.agent.parent_id).toBe(primary.id);
    // Specialists are leaves: no delegation tool, no sub_roles.
    expect(child.agent.authority.can_spawn_children).toBe(false);
  });

  it('refuses spawning from a leaf role with a message naming the role (no engine wired)', () => {
    const leaf = makeRole({ id: 'leaf-role', tools: ['browser'] });
    const someRole = makeRole({ id: 'other' });

    const orch = new AgentOrchestrator();
    const primary = orch.createPrimary(leaf);

    expect(() => orch.spawnSubAgent(primary.id, someRole)).toThrow(/leaf-role/);
  });
});

describe('authority engine as prime decider for spawning', () => {
  it('an explicit spawn_agent DENY blocks even a delegation-capable role', () => {
    const pa = makeRole({ id: 'pa', tools: ['delegation'] });
    const specialist = makeRole({ id: 'spec', tools: ['browser'] });

    const orch = new AgentOrchestrator();
    orch.setAuthorityEngine(
      makeEngine([{ action: 'spawn_agent', allowed: false }]),
    );
    const primary = orch.createPrimary(pa);
    expect(primary.agent.authority.can_spawn_children).toBe(true);

    expect(() => orch.spawnSubAgent(primary.id, specialist)).toThrow(
      /Authority denied/,
    );
  });

  it('an explicit spawn_agent ALLOW unblocks a role without the delegation tool', () => {
    const limited = makeRole({ id: 'limited', tools: ['browser'] });
    const specialist = makeRole({ id: 'spec', tools: ['browser'] });

    const orch = new AgentOrchestrator();
    orch.setAuthorityEngine(
      makeEngine([{ action: 'spawn_agent', allowed: true, requires_approval: false }]),
    );
    const primary = orch.createPrimary(limited);
    expect(primary.agent.authority.can_spawn_children).toBe(false);

    const child = orch.spawnSubAgent(primary.id, specialist);
    expect(child.agent.parent_id).toBe(primary.id);
  });

  it('with an engine wired and no overrides, the level check decides (spawn_agent requires level 1)', () => {
    const pa = makeRole({ id: 'pa', tools: ['delegation'], authority_level: 5 });
    const specialist = makeRole({ id: 'spec', tools: ['browser'] });

    const orch = new AgentOrchestrator();
    orch.setAuthorityEngine(makeEngine());
    const primary = orch.createPrimary(pa);

    const child = orch.spawnSubAgent(primary.id, specialist);
    expect(child.agent.parent_id).toBe(primary.id);
  });

  it('a role-scoped deny only blocks that role', () => {
    const pa = makeRole({ id: 'pa', tools: ['delegation'] });
    const specialist = makeRole({ id: 'spec', tools: ['browser'] });

    const orch = new AgentOrchestrator();
    orch.setAuthorityEngine(
      makeEngine([{ action: 'spawn_agent', role_id: 'someone-else', allowed: false }]),
    );
    const primary = orch.createPrimary(pa);

    const child = orch.spawnSubAgent(primary.id, specialist);
    expect(child.agent.parent_id).toBe(primary.id);
  });
});

/**
 * The wiring a daemon gives the spawn sink: engine, approvals, audit, the
 * emergency controller, and `manage_agents` registered so a card has a call to
 * run. The task runner records each loop it is asked to start and never ends.
 */
function lifecycleHarness(opts: {
  overrides?: AuthorityConfig['overrides'];
  contextRules?: AuthorityConfig['context_rules'];
} = {}) {
  const orch = new AgentOrchestrator();
  orch.setAuthorityEngine(makeEngine(opts.overrides ?? [], opts.contextRules ?? []));
  const approvals = new ApprovalManager();
  orch.setApprovalManager(approvals);
  const audit = new AuditTrail();
  orch.setAuditTrail(audit);
  const emergency = new EmergencyController();
  orch.setEmergencyController(emergency);
  const cards: ApprovalRequest[] = [];
  orch.setApprovalCallback((request) => cards.push(request));
  const primary = orch.createPrimary(makeRole({ id: 'pa', name: 'PA', tools: ['delegation'] }));
  const specialist = makeRole({ id: 'spec', name: 'Spec', tools: ['browser'] });
  const runs: RunSubAgentOptions[] = [];
  const taskManager = new AgentTaskManager(((o: RunSubAgentOptions) => {
    runs.push(o);
    return new Promise(() => {});
  }) as unknown as ConstructorParameters<typeof AgentTaskManager>[0]);
  const deps: AgentToolDeps = {
    orchestrator: orch,
    llmManager: {} as LLMManager,
    specialists: new Map([['spec', specialist]]),
    taskManager,
  };
  const registry = new ToolRegistry();
  registry.register(createManageAgentsTool(deps));
  orch.setToolRegistry(registry);
  const executor = new DeferredExecutor(approvals, audit);
  executor.setToolRegistry(registry);
  executor.setEmergencyController(emergency);
  const subAgents = () => orch.getAllAgents().filter((a) => a.id !== primary.id);
  const spawnRows = () => audit.query({ action: 'spawn_agent' }).filter((r) => r.tool_name === 'spawn_agent(spec)');
  return { orch, approvals, audit, emergency, cards, primary, specialist, runs, taskManager, deps, executor, subAgents, spawnRows };
}

const APPROVAL_OVERRIDE: AuthorityConfig['overrides'] = [{ action: 'spawn_agent', allowed: true, requires_approval: true }];

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<AgentLifecycleRefusal> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    if (err instanceof AgentLifecycleRefusal) return err;
    throw err;
  }
  throw new Error('expected an AgentLifecycleRefusal, got none');
}

describe('the spawn sink gates every path that reaches it (#932)', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  // The dashboard spawn dialog (POST /api/agents) and the pebble's voice fast
  // path both call startPersistentAgent, and neither passes the tool layer.
  it('an approval-required spawn raises a card for the whole request and starts nothing', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });

    const err = await refusal(startPersistentAgent(h.deps, { specialist: 'spec', task: 'research the thing' }));

    expect(err.kind).toBe('approval_required');
    expect(err.approvalId).not.toBeNull();
    expect(h.subAgents()).toHaveLength(0);
    expect(h.runs).toHaveLength(0);
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]!.id).toBe(err.approvalId!);
    expect(h.cards[0]!.tool_name).toBe('manage_agents');
    expect(h.cards[0]!.action_category).toBe('spawn_agent');
    expect(JSON.parse(h.cards[0]!.tool_arguments)).toEqual({ action: 'spawn', specialist: 'spec', task: 'research the thing' });
    expect(h.spawnRows().map((r) => [r.authority_decision, r.executed, r.approval_id]))
      .toEqual([['approval_required', 0, err.approvalId]]);
  });

  it('approving that card spawns the agent and starts its task, without a second card', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    const err = await refusal(startPersistentAgent(h.deps, { specialist: 'spec', task: 'research the thing' }));

    h.approvals.approve(err.approvalId!, 'dashboard');
    const result = await h.executor.executeApproved(err.approvalId!, 'dashboard');

    expect(result).toContain('"assignment"');
    expect(h.subAgents()).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.task).toBe('research the thing');
    expect(h.cards).toHaveLength(1);
    expect(h.spawnRows().some((r) => r.authority_decision === 'approval_required' && r.executed === 1
      && r.approval_id === err.approvalId)).toBe(true);
  });

  it('one approval buys one spawn', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    await runAsApproved({ categories: ['spawn_agent'], approvalId: 'a1', source: 'approval' }, async () => {
      h.orch.spawnSubAgent(h.primary.id, h.specialist);
      expect((await refusal(() => h.orch.spawnSubAgent(h.primary.id, h.specialist))).kind).toBe('approval_required');
    });
    expect(h.subAgents()).toHaveLength(1);
  });

  it('an approval for another category does not cover a spawn', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    await runAsApproved({ categories: ['write_data'], approvalId: 'a1', source: 'approval' }, async () => {
      expect((await refusal(() => h.orch.spawnSubAgent(h.primary.id, h.specialist))).kind).toBe('approval_required');
    });
    expect(h.subAgents()).toHaveLength(0);
  });

  it('a require_approval context rule written against manage_agents applies on the paths that skip the tool layer', async () => {
    const h = lifecycleHarness({ contextRules: [{ id: 'r1', action: 'spawn_agent', condition: 'tool_name',
      params: { tool_name: 'manage_agents' }, effect: 'require_approval', description: 'ask before agents' }] });
    const err = await refusal(startPersistentAgent(h.deps, { specialist: 'spec' }));
    expect(err.kind).toBe('approval_required');
    expect(h.subAgents()).toHaveLength(0);
  });

  it('under emergency Pause a spawn is refused, audited, and nothing starts', async () => {
    const h = lifecycleHarness();
    h.emergency.pause();

    const err = await refusal(startPersistentAgent(h.deps, { specialist: 'spec', task: 'research the thing' }));

    expect(err.kind).toBe('halted');
    expect(err.message).toContain('PAUSED');
    expect(h.subAgents()).toHaveLength(0);
    expect(h.runs).toHaveLength(0);
    expect(h.cards).toHaveLength(0);
    expect(h.spawnRows().map((r) => [r.authority_decision, r.executed])).toEqual([['denied', 0]]);
  });

  it('under Kill a spawn is refused even with an approval in hand', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    h.emergency.kill();
    await runAsApproved({ categories: ['spawn_agent'], approvalId: 'a1', source: 'approval' }, async () => {
      expect((await refusal(() => h.orch.spawnSubAgent(h.primary.id, h.specialist))).kind).toBe('halted');
    });
    expect(h.subAgents()).toHaveLength(0);
  });

  it('under Pause an idle agent cannot be handed a task: its loop would spend tokens', async () => {
    const h = lifecycleHarness();
    const { agent } = spawnPersistentAgent(h.deps, 'spec');
    h.emergency.pause();
    await expect(assignPersistentAgentTask(h.deps, { agentId: agent.id, task: 'research the thing' }))
      .rejects.toBeInstanceOf(TaskHaltedError);
    expect(h.runs).toHaveLength(0);
  });

  it('every spawn writes an audit row naming what was spawned', () => {
    const h = lifecycleHarness();
    h.orch.spawnSubAgent(h.primary.id, h.specialist);
    expect(h.spawnRows().map((r) => [r.agent_id, r.authority_decision, r.executed]))
      .toEqual([[h.primary.id, 'allowed', 1]]);
  });

  it('a denied spawn writes a denied row', async () => {
    const h = lifecycleHarness({ overrides: [{ action: 'spawn_agent', allowed: false }] });
    expect((await refusal(() => h.orch.spawnSubAgent(h.primary.id, h.specialist))).kind).toBe('denied');
    expect(h.spawnRows().map((r) => [r.authority_decision, r.executed])).toEqual([['denied', 0]]);
  });

  // The realtime voice gate auto-approves `requiresApproval` by documented
  // policy; the sink honours that decision rather than refusing it again.
  it('a realtime spawn the voice policy auto-approved is not refused again at the sink', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    const out = await h.orch.executeRealtimeToolCall('manage_agents', { action: 'spawn', specialist: 'spec' });
    expect(out).not.toContain('Error');
    expect(h.subAgents()).toHaveLength(1);
    expect(h.cards).toHaveLength(0);
  });

  // An approved `manage_agents assign` is a spawn_agent approval that spawns
  // nothing, so it is still unspent when the task starts. A loop that
  // inherited it could start an agent on it.
  it('the approval scope does not reach the background loop the approved call starts', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    const agent = await runAsApproved({ categories: ['spawn_agent'], approvalId: 'a0', source: 'approval' },
      async () => spawnPersistentAgent(h.deps, 'spec').agent);
    let seen: string | null = 'unset';
    const tm = h.taskManager as unknown as { runSubAgentFn: (o: RunSubAgentOptions) => Promise<unknown> };
    tm.runSubAgentFn = (async () => {
      seen = spendApproval('spawn_agent')?.approvalId ?? null;
      return new Promise(() => {});
    }) as never;
    await runAsApproved({ categories: ['spawn_agent'], approvalId: 'a1', source: 'approval' },
      () => assignPersistentAgentTask(h.deps, { agentId: agent.id, task: 'research the thing' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toBeNull();
  });
});

describe('the spawn sink, after review (#932)', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  // The tool layer hard-denies a level shortfall for manage_agents (it has no
  // `confirm`), so the paths that skip it must not turn one into a card.
  it('a level shortfall is a denial on the dashboard and voice entry too, never a card', async () => {
    const h = lifecycleHarness();
    h.orch.setAuthorityEngine(new AuthorityEngine({ default_level: 0, governed_categories: [], overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
    h.primary.agent.authority.max_authority_level = 0;
    const err = await refusal(startPersistentAgent(h.deps, { specialist: 'spec', task: 'research the thing' }));
    expect(err.kind).toBe('denied');
    expect(h.cards).toHaveLength(0);
    await runAsApproved({ categories: ['spawn_agent'], approvalId: 'a1', source: 'approval' }, async () => {
      expect((await refusal(() => h.orch.spawnSubAgent(h.primary.id, h.specialist))).kind).toBe('denied');
    });
    expect(h.subAgents()).toHaveLength(0);
  });

  // The model path: the tool layer raises the one card, the approved call
  // spends it at the sink, and nobody is asked twice.
  function inlineApprovals(h: ReturnType<typeof lifecycleHarness>) {
    h.orch.setDeferredExecutor(h.executor);
    h.orch.setApprovalCallback((r) => {
      h.cards.push(r);
      queueMicrotask(() => h.approvals.approve(r.id, 'dashboard'));
    });
    return (call: LLMToolCall) => (h.orch as unknown as {
      executeTool: (c: LLMToolCall, s: undefined, t: Set<string>, scope: null) => Promise<unknown>;
    }).executeTool(call, undefined, new Set(), null);
  }

  it('a model manage_agents spawn with a task takes one card, one agent, one task', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    const execute = inlineApprovals(h);
    await execute({ id: 't1', name: 'manage_agents', arguments: { action: 'spawn', specialist: 'spec', task: 'research the thing' } });
    expect(h.cards).toHaveLength(1);
    expect(h.subAgents()).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
  });

  it('a model delegate_task takes one card and spawns its specialist once', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    let spawns = 0;
    const real = h.orch.spawnSubAgent.bind(h.orch);
    h.orch.spawnSubAgent = ((...a: Parameters<typeof real>) => { spawns++; return real(...a); }) as typeof real;
    h.orch.getToolRegistry()!.register(createDelegateTool({ orchestrator: h.orch, specialists: h.deps.specialists,
      llmManager: { chatTier: async () => ({ content: 'done', finish_reason: 'end_turn', tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1 } }) } as unknown as LLMManager }));
    const execute = inlineApprovals(h);
    const out = String(await execute({ id: 't1', name: 'delegate_task', arguments: { specialist: 'spec', task: 'look', context: '' } }));
    expect(out).toContain('completed');
    expect(h.cards).toHaveLength(1);
    expect(spawns).toBe(1);
    expect(h.spawnRows().filter((r) => r.executed === 1)).toHaveLength(1);
  });

  it('an approval the call did not use is gone once the call has settled', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    let later: Promise<unknown> = Promise.resolve();
    await runAsApproved({ categories: ['spawn_agent'], approvalId: 'a1', source: 'approval' }, async () => {
      later = new Promise((r) => setTimeout(r, 5)).then(() => refusal(() => h.orch.spawnSubAgent(h.primary.id, h.specialist)));
    });
    expect(((await later) as AgentLifecycleRefusal).kind).toBe('approval_required');
    expect(h.subAgents()).toHaveLength(0);
  });

  it('the first spawn uses the approval up even when it did not need it', async () => {
    const h = lifecycleHarness();
    await runAsApproved({ categories: ['spawn_agent'], approvalId: 'a1', source: 'approval' }, async () => {
      h.orch.spawnSubAgent(h.primary.id, h.specialist);
      h.orch.setAuthorityEngine(makeEngine(APPROVAL_OVERRIDE));
      expect((await refusal(() => h.orch.spawnSubAgent(h.primary.id, h.specialist))).kind).toBe('approval_required');
    });
    expect(h.subAgents()).toHaveLength(1);
  });

  it('a voice or workflow grant never answers an approval the taint gate asked for; a card does', async () => {
    const h = lifecycleHarness();
    h.orch.setAuthorityProfile({ label: TAINT_PROFILE_LABEL, governed_categories: ['spawn_agent'] });
    for (const source of ['realtime_auto', 'workflow_effect'] as const) {
      await runAsApproved({ categories: ['spawn_agent'], approvalId: null, source }, async () => {
        expect((await refusal(() => h.orch.spawnSubAgent(h.primary.id, h.specialist))).kind).toBe('approval_required');
      });
    }
    expect(h.subAgents()).toHaveLength(0);
    await runAsApproved({ categories: ['spawn_agent'], approvalId: 'a1', source: 'approval' },
      async () => h.orch.spawnSubAgent(h.primary.id, h.specialist));
    expect(h.subAgents()).toHaveLength(1);
  });

  it('the same request asked again answers with the card already waiting', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    const first = await refusal(startPersistentAgent(h.deps, { specialist: 'spec', task: 'research the thing' }));
    const again = await refusal(startPersistentAgent(h.deps, { specialist: 'spec', task: 'research the thing' }));
    expect(again.approvalId).toBe(first.approvalId);
    expect(h.approvals.getPending()).toHaveLength(1);
    const other = await refusal(startPersistentAgent(h.deps, { specialist: 'spec', task: 'something else' }));
    expect(other.approvalId).not.toBe(first.approvalId);
  });

  it('the card says what the agent will be told to do', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    await refusal(startPersistentAgent(h.deps, { specialist: 'spec', task: 'email "everyone" the plan', context: 'from the notes' }));
    const { intent_action } = approvalIntentFields(h.cards[0]!);
    expect(intent_action).toBe('Start a spec background agent with context "from the notes" on the task "email \\"everyone\\" the plan"');
  });

  it('a realtime spawn is auto-approved only for the category that asked', async () => {
    const h = lifecycleHarness({ overrides: APPROVAL_OVERRIDE });
    const out = await h.orch.executeRealtimeToolCall('manage_agents', { action: 'spawn', specialist: 'spec' });
    expect(out).not.toContain('Error');
    expect(h.spawnRows().map((r) => [r.authority_decision, r.executed, r.channel])).toEqual([['approval_required', 1, 'voice']]);
  });

  it('a spawn whose task then fails to start leaves no idle agent behind', async () => {
    const h = lifecycleHarness();
    const real = h.taskManager.launch.bind(h.taskManager);
    h.taskManager.launch = ((o: Parameters<typeof real>[0]) => { h.emergency.pause(); return real(o); }) as typeof real;
    await expect(startPersistentAgent(h.deps, { specialist: 'spec', task: 'research the thing' })).rejects.toBeInstanceOf(TaskHaltedError);
    expect(h.subAgents()).toHaveLength(0);
  });
});
