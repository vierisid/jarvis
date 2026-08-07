/**
 * P0.5 — research-analyst browse authority.
 *
 * `access_browser` requires authority level 5. `research-analyst` ships at
 * level 4 and, under the shipped `active_role: personal-assistant` (level 5),
 * `spawnSubAgent` caps a child at `min(4, 5 - 1) = 4`. So a research agent
 * was handed browser tools it could never call.
 *
 * The fix is a scoped grant derived from the tools the agent actually holds,
 * NOT a raised authority_level (which would also unlock execute_command and
 * control_app) and NOT a temporary grant (which would override an explicit
 * user deny). These tests pin all three properties.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { AgentInstance, scopedGrantsForTools } from './agent.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { loadRole } from '../roles/loader.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import type { RoleDefinition } from '../roles/types.ts';

const ROLES_DIR = join(import.meta.dir, '../../roles');

function makeEngine(config: Partial<AuthorityConfig> = {}): AuthorityEngine {
  return new AuthorityEngine({
    default_level: 3,
    governed_categories: [],
    overrides: [],
    context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 },
    emergency_state: 'normal',
    ...config,
  });
}

function makeRole(overrides: Partial<RoleDefinition>): RoleDefinition {
  return {
    id: 'test-role',
    name: 'Test Role',
    description: 'A test role.',
    responsibilities: ['Test things'],
    autonomous_actions: [],
    approval_required: [],
    tools: [],
    authority_level: 4,
    ...overrides,
  } as RoleDefinition;
}

describe('scopedGrantsForTools', () => {
  it('grants access_browser to a browser-holding agent and nothing else', () => {
    expect(scopedGrantsForTools(['browser', 'terminal', 'file-ops'])).toEqual(['access_browser']);
  });

  it('grants nothing to an agent without the browser tool', () => {
    expect(scopedGrantsForTools(['terminal', 'file-ops'])).toEqual([]);
  });
});

describe('the shipped research-analyst spawn', () => {
  it('still lands below the level access_browser requires', () => {
    // If this ever stops being true the grant may be removable -- but note
    // that raising research-analyst to 5 does NOT fix it, because the spawn
    // rule caps the child at parent - 1.
    const personalAssistant = loadRole(join(ROLES_DIR, 'personal-assistant.yaml'));
    const researchAnalyst = loadRole(join(ROLES_DIR, 'specialists/research-analyst.yaml'));

    const orchestrator = new AgentOrchestrator();
    orchestrator.setAuthorityEngine(makeEngine());
    const primary = orchestrator.createPrimary(personalAssistant);
    const child = orchestrator.spawnSubAgent(primary.id, researchAnalyst);

    expect(child.agent.authority.max_authority_level).toBeLessThan(5);
    expect(child.agent.authority.scoped_grants).toContain('access_browser');
  });

  it('can browse with the grant, and could not without it', () => {
    const personalAssistant = loadRole(join(ROLES_DIR, 'personal-assistant.yaml'));
    const researchAnalyst = loadRole(join(ROLES_DIR, 'specialists/research-analyst.yaml'));

    const engine = makeEngine();
    const orchestrator = new AgentOrchestrator();
    orchestrator.setAuthorityEngine(engine);
    const primary = orchestrator.createPrimary(personalAssistant);
    const child = orchestrator.spawnSubAgent(primary.id, researchAnalyst);

    const params = {
      agentId: child.id,
      agentAuthorityLevel: child.agent.authority.max_authority_level,
      agentRoleId: child.agent.role.id,
      toolName: 'browser_navigate',
      toolCategory: 'browser',
      actionCategory: 'access_browser' as const,
      temporaryGrants: new Map(),
    };

    expect(engine.checkAuthority(params).allowed).toBe(false);
    expect(
      engine.checkAuthority({ ...params, scopedGrants: child.agent.authority.scoped_grants }).allowed,
    ).toBe(true);
  });
});

describe('a scoped grant is narrower than raising the level', () => {
  const agent = () => new AgentInstance(makeRole({ tools: ['browser', 'terminal'], authority_level: 4 }));

  it('does not unlock the other level-5 actions', () => {
    const engine = makeEngine();
    const a = agent();
    const base = {
      agentId: a.id,
      agentAuthorityLevel: a.agent.authority.max_authority_level,
      agentRoleId: a.agent.role.id,
      toolCategory: 'terminal',
      temporaryGrants: new Map(),
      scopedGrants: a.agent.authority.scoped_grants,
    };

    expect(engine.checkAuthority({
      ...base, toolName: 'run_command', actionCategory: 'execute_command',
    }).allowed).toBe(false);
    expect(engine.checkAuthority({
      ...base, toolName: 'launch_app', actionCategory: 'control_app',
    }).allowed).toBe(false);
  });

  it('loses to an explicit user deny, unlike a temporary grant', () => {
    const engine = makeEngine({
      overrides: [{ action: 'access_browser', allowed: false }],
    });
    const a = agent();
    const params = {
      agentId: a.id,
      agentAuthorityLevel: a.agent.authority.max_authority_level,
      agentRoleId: a.agent.role.id,
      toolName: 'browser_navigate',
      toolCategory: 'browser',
      actionCategory: 'access_browser' as const,
      temporaryGrants: new Map(),
      scopedGrants: a.agent.authority.scoped_grants,
    };

    expect(engine.checkAuthority(params).allowed).toBe(false);

    // A temporary grant, by contrast, wins over the same deny -- which is why
    // the scoped grant is a separate mechanism rather than a reuse of that one.
    expect(engine.checkAuthority({
      ...params,
      temporaryGrants: new Map([[a.id, ['access_browser' as const]]]),
    }).allowed).toBe(true);
  });

  it('still respects the governed-category approval gate', () => {
    const engine = makeEngine({ governed_categories: ['access_browser'] });
    const a = agent();
    const decision = engine.checkAuthority({
      agentId: a.id,
      agentAuthorityLevel: a.agent.authority.max_authority_level,
      agentRoleId: a.agent.role.id,
      toolName: 'browser_navigate',
      toolCategory: 'browser',
      actionCategory: 'access_browser',
      temporaryGrants: new Map(),
      scopedGrants: a.agent.authority.scoped_grants,
    });
    expect(decision.requiresApproval).toBe(true);
  });
});

describe('a parent that withholds the browser tool withholds the grant', () => {
  it('gives the child no browse grant', () => {
    const engine = makeEngine();
    const orchestrator = new AgentOrchestrator();
    orchestrator.setAuthorityEngine(engine);

    const parent = orchestrator.createPrimary(
      makeRole({ id: 'parent', tools: ['delegation', 'file-ops'], authority_level: 9 }),
    );
    const child = orchestrator.spawnSubAgent(
      parent.id,
      makeRole({ id: 'child', tools: ['browser', 'file-ops'], authority_level: 4 }),
    );

    expect(child.agent.authority.allowed_tools).not.toContain('browser');
    expect(child.agent.authority.scoped_grants).toEqual([]);
  });
});
