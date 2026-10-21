import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { AgentTaskManager } from './task-manager.ts';
import { runSubAgent, type RunSubAgentOptions } from './sub-agent-runner.ts';
import { runAsActingAgent } from './acting-agent.ts';
import { AgentLifecycleRefusal } from './lifecycle-gate.ts';
import { applyProfile, AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { EmergencyController } from '../authority/emergency.ts';
import { buildTaintGating } from '../authority/taint-gating.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { createDelegateTool } from '../actions/tools/delegate.ts';
import { assignPersistentAgentTask, createManageAgentsTool, startPersistentAgent, type AgentToolDeps } from '../actions/tools/agents.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMToolCall } from '../llm/provider.ts';

/**
 * #1043 (owner decision): a deny or requires-approval override the owner
 * scoped to a role binds every specialist that role starts, directly or
 * through specialists of its own. An allow is never carried: restrictions
 * only tighten. Before, the engine matched a role override only on the role
 * being judged, so starting a specialist of another role walked around it.
 */

function role(id: string, tools: string[], level: number): RoleDefinition {
  return { id, name: id.toUpperCase(), description: 'A role.', responsibilities: ['Things'], autonomous_actions: [],
    approval_required: [], tools, authority_level: level } as unknown as RoleDefinition;
}

const PA = role('pa', ['delegation', 'terminal', 'browser', 'general'], 8);
const WORKER = role('worker', ['delegation', 'browser', 'general'], 6);
/** Its one builtin tool here, `get_system_info`, is a harmless read_data call. */
const INFO = role('info', ['general'], 8);

function scriptedModel(turns: Record<string, Array<LLMToolCall[]>>) {
  const step = new Map<string, number>();
  return {
    chatTier: async (_tier: string, _origin: string, messages: LLMMessage[]) => {
      const agent = /^You are (\S+?)\./.exec(String(messages[0]?.content ?? ''))?.[1] ?? '?';
      const n = step.get(agent) ?? 0;
      step.set(agent, n + 1);
      const calls = turns[agent]?.[n];
      return calls
        ? { content: '', finish_reason: 'tool_use', tool_calls: calls, usage: { input_tokens: 1, output_tokens: 1 } }
        : { content: `${agent} done`, finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as LLMManager;
}

function setup(overrides: AuthorityConfig['overrides'], turns: Record<string, Array<LLMToolCall[]>> = {}) {
  const engine = new AuthorityEngine({ default_level: 5, governed_categories: [], overrides,
    context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' });
  const audit = new AuditTrail();
  const orch = new AgentOrchestrator();
  orch.setAuthorityEngine(engine);
  orch.setApprovalManager(new ApprovalManager());
  orch.setAuditTrail(audit);
  orch.setEmergencyController(new EmergencyController());
  orch.setTaintGating(buildTaintGating());
  const primary = orch.createPrimary(PA);
  const llm = scriptedModel(turns);
  const specialists = new Map([[INFO.id, INFO], [WORKER.id, WORKER]]);
  const launched: RunSubAgentOptions[] = [];
  const taskManager = new AgentTaskManager((async (o: RunSubAgentOptions) => {
    launched.push(o);
    return { success: true, response: 'ok', toolsUsed: [], tokensUsed: { input: 1, output: 1 }, terminationReason: 'completed', messages: [] };
  }) as unknown as ConstructorParameters<typeof AgentTaskManager>[0]);
  const deps: AgentToolDeps = { orchestrator: orch, llmManager: llm, specialists, taskManager };
  const registry = new ToolRegistry();
  registry.register(createDelegateTool({ orchestrator: orch, llmManager: llm, specialists }));
  registry.register(createManageAgentsTool(deps));
  orch.setToolRegistry(registry);
  /** What INFO's `get_system_info` call was decided as, and whether it ran. */
  const infoRows = () => audit.query({ action: 'read_data' }).filter((r) => r.tool_name === 'get_system_info')
    .map((r) => [r.authority_decision, r.executed]);
  return { orch, primary, audit, deps, registry, launched, infoRows, llm };
}

const call = (id: string, name: string, args: Record<string, unknown>): LLMToolCall => ({ id, name, arguments: args });
const infoTurns = { INFO: [[call('i1', 'get_system_info', {})]] };

describe('a role override binds the specialists that role starts, and only ever tightens (#1043)', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  test('a deny on the primary\'s role binds a delegate_task specialist, over the specialist\'s own allow', async () => {
    const s = setup([
      { action: 'read_data', role_id: 'pa', allowed: false },
      // The specialist's own role-specific allow would otherwise win.
      { action: 'read_data', role_id: 'info', allowed: true },
    ], infoTurns);
    // The primary's turn calls delegate_task: nobody but the primary is acting.
    await s.registry.execute('delegate_task', { specialist: 'info', task: 'check the machine', context: '' });
    expect(s.infoRows()).toEqual([['denied', 0]]);
  });

  test('a requires-approval override on the primary\'s role makes the specialist ask', async () => {
    const s = setup([{ action: 'read_data', role_id: 'pa', allowed: true, requires_approval: true }], infoTurns);
    await s.registry.execute('delegate_task', { specialist: 'info', task: 'check the machine', context: '' });
    // Asked (and, with nobody to hold a card, not run), not allowed outright.
    expect(s.infoRows()).toEqual([['approval_required', 0]]);
  });

  test('an allow on the primary\'s role is never carried', async () => {
    const s = setup([
      { action: 'read_data', role_id: 'pa', allowed: true },
      { action: 'read_data', role_id: 'info', allowed: false },
    ], infoTurns);
    await s.registry.execute('delegate_task', { specialist: 'info', task: 'check the machine', context: '' });
    // The specialist's own deny stands.
    expect(s.infoRows()).toEqual([['denied', 0]]);
    expect(s.orch.getProfileFor(s.primary.id)).toBeNull();
  });

  test('an override on another role does not bind', async () => {
    const s = setup([{ action: 'read_data', role_id: 'someone-else', allowed: false }], infoTurns);
    await s.registry.execute('delegate_task', { specialist: 'info', task: 'check the machine', context: '' });
    expect(s.infoRows()).toEqual([['allowed', 1]]);
  });

  test('a persistent agent the primary starts carries it on every task, including one assigned later', async () => {
    const s = setup([{ action: 'send_email', role_id: 'pa', allowed: false },
      { action: 'send_message', role_id: 'pa', allowed: true, requires_approval: true }]);
    const { spawned } = await startPersistentAgent(s.deps, { specialist: 'info', task: 'first' });
    await assignPersistentAgentTask(s.deps, { agentId: spawned.agent.id, task: 'second' }).catch(() => undefined);
    for (const run of s.launched) {
      expect(run.profile?.denied_categories).toEqual(['send_email']);
      expect(run.profile?.governed_categories).toEqual(['send_message']);
    }
    expect(s.launched.length).toBeGreaterThan(0);
  });

  test('transitively: a specialist started by a specialist is bound by the primary\'s role', async () => {
    const s = setup([
      { action: 'read_data', role_id: 'pa', allowed: true, requires_approval: true },
    ], { WORKER: [[call('w1', 'delegate_task', { specialist: 'info', task: 'check the machine', context: '' })]], ...infoTurns });
    const worker = s.orch.spawnSubAgent(s.primary.id, WORKER);
    await runSubAgent({ agent: worker, task: 'Do the job', context: '', llmManager: s.llm, toolRegistry: s.registry,
      authorityEngine: s.orch.getAuthorityEngine()!, auditTrail: s.audit, temporaryGrants: new Map(),
      profile: s.orch.getProfileFor(worker.id), taintGating: s.orch.getTaintGating() });
    // The worker itself asked for nothing it was denied, and its specialist
    // asked for read_data: the primary's role governs it two levels down.
    expect(s.infoRows()).toEqual([['approval_required', 0]]);
    const info = s.orch.getAllAgents().find((a) => a.agent.role.id === 'info');
    // Reaped by delegate_task once its run is over.
    expect(info).toBeUndefined();
  });

  test('a specialist a sub-agent starts is bound by the sub-agent\'s role and by every role above it', () => {
    const s = setup([{ action: 'send_email', role_id: 'worker', allowed: false },
      { action: 'send_message', role_id: 'pa', allowed: false }]);
    const worker = s.orch.spawnSubAgent(s.primary.id, WORKER);
    const info = runAsActingAgent({ agentId: worker.id, profile: null, taint: [] }, () => s.orch.spawnSubAgent(s.primary.id, INFO));
    expect(s.orch.getProfileFor(info.id)?.denied_categories?.sort()).toEqual(['send_email', 'send_message']);
    // The worker itself is bound only by the role above it.
    expect(s.orch.getProfileFor(worker.id)?.denied_categories).toEqual(['send_message']);
  });

  test('a task a sub-agent assigns to an agent it did not start is bound by the sub-agent\'s own role', async () => {
    const s = setup([{ action: 'read_data', role_id: 'worker', allowed: false },
      { action: 'send_message', role_id: 'worker', allowed: true, requires_approval: true }]);
    s.deps.specialists.set('low', role('low', ['general'], 4));
    const { spawned } = await startPersistentAgent(s.deps, { specialist: 'low' });
    const worker = s.orch.spawnSubAgent(s.primary.id, WORKER);
    await runAsActingAgent({ agentId: worker.id, profile: null, taint: [] },
      () => assignPersistentAgentTask(s.deps, { agentId: spawned.agent.id, task: 'the worker\'s words' }));
    expect(s.launched).toHaveLength(1);
    expect(s.launched[0]!.profile?.denied_categories).toEqual(['read_data']);
    expect(s.launched[0]!.profile?.governed_categories).toEqual(['send_message']);
  });

  test('a deny on the role that started a sub-agent binds the sub-agent\'s own spawn at the lifecycle gate', () => {
    const s = setup([]);
    const worker = s.orch.spawnSubAgent(s.primary.id, WORKER);
    // Added after the worker started, and read at the sink: the worker's own
    // role has no override, its run profile is null and it read nothing, so
    // only the override on the role that started it can refuse this spawn.
    s.orch.getAuthorityEngine()!.addOverride({ action: 'spawn_agent', role_id: 'pa', allowed: false });
    expect(() => runAsActingAgent({ agentId: worker.id, profile: null, taint: [] },
      () => s.orch.spawnSubAgent(s.primary.id, INFO))).toThrow(AgentLifecycleRefusal);
    expect(s.orch.getAllAgents().some((a) => a.agent.role.id === 'info')).toBe(false);
  });

  test('the profile a role\'s child gets names both kinds, and is removed with the child', () => {
    const s = setup([{ action: 'send_email', role_id: 'pa', allowed: false },
      { action: 'send_message', role_id: 'pa', allowed: true, requires_approval: true }]);
    const child = s.orch.spawnSubAgent(s.primary.id, INFO);
    const profile = s.orch.getProfileFor(child.id);
    expect(profile?.denied_categories).toEqual(['send_email']);
    expect(profile?.governed_categories).toEqual(['send_message']);
    expect(profile?.label).toContain('pa');
    // A later change to the override is read live, as the engine reads it.
    s.orch.getAuthorityEngine()!.removeOverride('send_email', 'pa');
    expect(s.orch.getProfileFor(child.id)?.denied_categories).toBeUndefined();
    s.orch.reapAgent(child.id);
    expect(s.orch.getProfileFor(child.id)).toBeNull();
  });
});

describe('a profile deny cannot be lifted (#1043)', () => {
  test('it beats an allow, and replaces a pure level shortfall so no above-level approval can lift it', () => {
    const profile = { label: 'carried', denied_categories: ['execute_command' as const] };
    const allowed = applyProfile({ allowed: true, requiresApproval: false, reason: 'ok', actionCategory: 'execute_command' }, profile);
    expect(allowed).toMatchObject({ allowed: false, profileLabel: 'carried' });
    const short = applyProfile({ allowed: false, requiresApproval: false, reason: 'level', actionCategory: 'execute_command', deniedByLevel: true }, profile);
    expect(short.allowed).toBe(false);
    expect(short.deniedByLevel).toBeUndefined();
    // Another category is untouched.
    expect(applyProfile({ allowed: true, requiresApproval: false, reason: 'ok', actionCategory: 'read_data' }, profile).allowed).toBe(true);
  });
});
