import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { AgentInstance, canSpawnChildren } from './agent.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { loadRole } from '../roles/loader.ts';
import type { RoleDefinition } from '../roles/types.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';

function makeEngine(overrides: AuthorityConfig['overrides'] = []): AuthorityEngine {
  return new AuthorityEngine({
    default_level: 5,
    governed_categories: [],
    overrides,
    context_rules: [],
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
