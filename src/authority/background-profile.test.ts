import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { ApprovalManager } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { AuthorityEngine, applyProfile, type AuthorityConfig, type AuthorityCheckParams } from './engine.ts';
import { buildBackgroundProfile, DEFAULT_BACKGROUND_GOVERNED } from './background-profile.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import type { ToolDefinition } from '../actions/tools/registry.ts';
import type { RoleDefinition } from '../roles/types.ts';

function makeConfig(overrides: Partial<AuthorityConfig> = {}): AuthorityConfig {
  return {
    default_level: 3,
    governed_categories: ['send_email', 'send_message', 'make_payment'],
    overrides: [],
    context_rules: [],
    learning: { enabled: true, suggest_threshold: 5 },
    emergency_state: 'normal',
    ...overrides,
  };
}

function makeParams(overrides: Partial<AuthorityCheckParams> = {}): AuthorityCheckParams {
  return {
    agentId: 'bg',
    agentAuthorityLevel: 5,
    agentRoleId: 'personal-assistant',
    toolName: 'run_command',
    toolCategory: 'terminal',
    actionCategory: 'execute_command',
    temporaryGrants: new Map(),
    ...overrides,
  };
}

describe('buildBackgroundProfile', () => {
  test('defaults govern machine-changing and outbound categories, not reads', () => {
    const p = buildBackgroundProfile(undefined);
    expect(p.governed_categories).toEqual([...DEFAULT_BACKGROUND_GOVERNED]);
    expect(p.governed_categories).toContain('execute_command');
    expect(p.governed_categories).toContain('write_data');
    expect(p.governed_categories).toContain('send_email');
    expect(p.governed_categories).not.toContain('read_data');
    expect(p.governed_categories).not.toContain('access_browser');
    expect(p.level_cap).toBeUndefined();
  });

  test('an explicit empty list opts out of the extra gating', () => {
    const p = buildBackgroundProfile({ governed_categories: [] });
    expect(p.governed_categories).toEqual([]);
  });

  test('unknown categories are dropped, known ones kept', () => {
    const p = buildBackgroundProfile({ governed_categories: ['execute_command', 'launch_nukes'] });
    expect(p.governed_categories).toEqual(['execute_command']);
  });

  test('a list with no valid entries falls back to the defaults, not to opt-out', () => {
    const p = buildBackgroundProfile({ governed_categories: ['exec_command'] });
    expect(p.governed_categories).toEqual([...DEFAULT_BACKGROUND_GOVERNED]);
  });

  test('a non-array value (schemaless JSON row) falls back to the defaults', () => {
    const p = buildBackgroundProfile({ governed_categories: 'execute_command' as unknown as string[] });
    expect(p.governed_categories).toEqual([...DEFAULT_BACKGROUND_GOVERNED]);
    const q = buildBackgroundProfile({ governed_categories: [42, null] as unknown as string[] });
    expect(q.governed_categories).toEqual([...DEFAULT_BACKGROUND_GOVERNED]);
  });

  test('level cap is clamped to 1..10 and floored', () => {
    expect(buildBackgroundProfile({ level_cap: 4.7 }).level_cap).toBe(4);
    expect(buildBackgroundProfile({ level_cap: 0 }).level_cap).toBe(1);
    expect(buildBackgroundProfile({ level_cap: 99 }).level_cap).toBe(10);
    expect(buildBackgroundProfile({ level_cap: Number.NaN }).level_cap).toBeUndefined();
  });
});

describe('AuthorityEngine with a profile', () => {
  test('main agent at level 5 runs execute_command without approval', () => {
    const engine = new AuthorityEngine(makeConfig());
    const d = engine.checkAuthority(makeParams());
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  test('same call under the background profile requires approval', () => {
    const engine = new AuthorityEngine(makeConfig());
    const d = engine.checkAuthority(makeParams({ profile: buildBackgroundProfile(undefined) }));
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
    expect(d.reason).toContain('background agent');
  });

  test('profile leaves ungoverned read and browse actions autonomous', () => {
    const engine = new AuthorityEngine(makeConfig());
    const profile = buildBackgroundProfile(undefined);
    for (const actionCategory of ['read_data', 'access_browser'] as const) {
      const d = engine.checkAuthority(makeParams({ actionCategory, profile }));
      expect(d.allowed).toBe(true);
      expect(d.requiresApproval).toBe(false);
    }
  });

  test('dropping send_email from the shared list does not ungate it for the background agent', () => {
    const engine = new AuthorityEngine(makeConfig({ governed_categories: [] }));
    const open = engine.checkAuthority(makeParams({ agentAuthorityLevel: 7, actionCategory: 'send_email' }));
    expect(open.requiresApproval).toBe(false);
    const bg = engine.checkAuthority(makeParams({ agentAuthorityLevel: 7, actionCategory: 'send_email', profile: buildBackgroundProfile(undefined) }));
    expect(bg.requiresApproval).toBe(true);
  });

  test('a global always-allow override cannot lift the profile gate', () => {
    const engine = new AuthorityEngine(makeConfig({
      overrides: [{ action: 'execute_command', allowed: true }],
    }));
    const base = engine.checkAuthority(makeParams());
    expect(base.requiresApproval).toBe(false);
    const gated = engine.checkAuthority(makeParams({ profile: buildBackgroundProfile(undefined) }));
    expect(gated.allowed).toBe(true);
    expect(gated.requiresApproval).toBe(true);
  });

  test('a temporary grant cannot lift the profile gate either', () => {
    const engine = new AuthorityEngine(makeConfig());
    const grants = new Map([['bg', ['execute_command' as const]]]);
    const d = engine.checkAuthority(makeParams({ temporaryGrants: grants, profile: buildBackgroundProfile(undefined) }));
    expect(d.requiresApproval).toBe(true);
  });

  test('profile never lifts a base denial', () => {
    const engine = new AuthorityEngine(makeConfig({
      overrides: [{ action: 'execute_command', allowed: false }],
    }));
    const d = engine.checkAuthority(makeParams({ profile: buildBackgroundProfile({ governed_categories: [] }) }));
    expect(d.allowed).toBe(false);
  });

  test('level cap denies actions above it even when the role level suffices', () => {
    const engine = new AuthorityEngine(makeConfig());
    const d = engine.checkAuthority(makeParams({
      agentAuthorityLevel: 9,
      actionCategory: 'execute_command',
      profile: buildBackgroundProfile({ level_cap: 4, governed_categories: [] }),
    }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('level cap 4');
  });

  test('applyProfile is a no-op with an empty profile', () => {
    const base = { allowed: true, requiresApproval: false, reason: 'x', actionCategory: 'execute_command' as const };
    expect(applyProfile(base, { label: 'p' })).toEqual(base);
  });

  test('describeRulesForAgent lists profile categories and the capped level', () => {
    const engine = new AuthorityEngine(makeConfig());
    const text = engine.describeRulesForAgent(5, 'personal-assistant', buildBackgroundProfile({ level_cap: 4 }));
    expect(text).toContain('Your authority level: 4/10');
    expect(text).toContain('- execute_command');
    expect(text).toContain('- send_email');
  });
});

describe('AgentOrchestrator profile gate', () => {
  const role: RoleDefinition = {
    id: 'personal-assistant',
    name: 'PA',
    description: 'test',
    responsibilities: [],
    tools: ['terminal'],
    authority_level: 5,
  } as unknown as RoleDefinition;

  function makeOrchestrator(withProfile: boolean) {
    const calls: string[] = [];
    const tool: ToolDefinition = {
      name: 'run_command',
      description: 'test',
      category: 'terminal',
      parameters: {},
      execute: async () => { calls.push('ran'); return 'ok'; },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(registry);
    orch.setAuthorityEngine(new AuthorityEngine(makeConfig()));
    if (withProfile) orch.setAuthorityProfile(buildBackgroundProfile(undefined));
    orch.createPrimary(role);
    return { orch, calls };
  }

  test('without a profile the tool runs', async () => {
    const { orch, calls } = makeOrchestrator(false);
    const result = await (orch as unknown as { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }) => Promise<unknown> }).executeTool({ id: 't1', name: 'run_command', arguments: {} });
    expect(calls).toEqual(['ran']);
    expect(result).toBe('ok');
  });

  test('with the background profile and no approval manager the tool does not run (fail closed)', async () => {
    const { orch, calls } = makeOrchestrator(true);
    const result = await (orch as unknown as { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }) => Promise<unknown> }).executeTool({ id: 't1', name: 'run_command', arguments: {} });
    expect(calls).toEqual([]);
    expect(String(result)).toContain('[APPROVAL UNAVAILABLE]');
  });

  test('with an engine wired but no primary agent the tool does not run', async () => {
    const tool: ToolDefinition = {
      name: 'run_command', description: 'test', category: 'terminal', parameters: {},
      execute: async () => 'ran',
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(registry);
    orch.setAuthorityEngine(new AuthorityEngine(makeConfig()));
    const result = await (orch as unknown as { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }) => Promise<unknown> }).executeTool({ id: 't1', name: 'run_command', arguments: {} });
    expect(String(result)).toContain('[AUTHORITY DENIED]');
  });
});

describe('AgentOrchestrator profile gate with an approval manager (production path)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  test('creates a deferred approval request, notifies, and does not run the tool', async () => {
    const calls: string[] = [];
    const tool: ToolDefinition = {
      name: 'run_command', description: 'test', category: 'terminal', parameters: {},
      execute: async () => { calls.push('ran'); return 'ok'; },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const role = {
      id: 'personal-assistant', name: 'PA', description: 'test', responsibilities: [], tools: ['terminal'], authority_level: 5,
    } as unknown as RoleDefinition;

    const approvals = new ApprovalManager();
    const audit = new AuditTrail();
    const delivered: string[] = [];
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(registry);
    orch.setAuthorityEngine(new AuthorityEngine(makeConfig()));
    orch.setAuthorityProfile(buildBackgroundProfile(undefined));
    orch.setApprovalManager(approvals);
    orch.setAuditTrail(audit);
    orch.setApprovalCallback((r) => { delivered.push(r.id); });
    orch.createPrimary(role);

    const result = await (orch as unknown as { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }) => Promise<unknown> }).executeTool({ id: 't1', name: 'run_command', arguments: { command: 'rm -rf /' } });

    expect(calls).toEqual([]);
    expect(String(result)).toContain('[AWAITING_APPROVAL]');
    const pending = approvals.getPending();
    expect(pending.length).toBe(1);
    const request = pending[0]!;
    expect(request.tool_name).toBe('run_command');
    expect(request.execution_mode).toBe('deferred');
    expect(request.reason).toContain('background agent');
    expect(delivered).toEqual([request.id]);
  });
});
