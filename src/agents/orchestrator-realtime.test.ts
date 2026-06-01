import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { AgentOrchestrator } from './orchestrator.ts';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { AuditTrail } from '../authority/audit.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import type { RoleDefinition } from '../roles/types.ts';

const ROLE = {
  id: 'personal-assistant',
  name: 'PA',
  authority_level: 5,
  tools: [],
  sub_roles: [],
} as unknown as RoleDefinition;

function authorityConfig(overrides?: Partial<AuthorityConfig>): AuthorityConfig {
  return {
    default_level: 3,
    governed_categories: [],
    overrides: [],
    context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 },
    emergency_state: 'normal',
    ...overrides,
  };
}

let executed: string[] = [];
function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  const readFile: ToolDefinition = {
    name: 'read_file', // maps to actionCategory 'read_data'
    description: 'Read a file',
    category: 'file-ops',
    parameters: { path: { type: 'string', description: 'path', required: true } },
    execute: async (p) => { executed.push(`read_file:${p.path}`); return `contents of ${p.path}`; },
  };
  reg.register(readFile);
  return reg;
}

function makeOrchestrator(authConfig: AuthorityConfig): { orch: AgentOrchestrator; audit: AuditTrail } {
  const orch = new AgentOrchestrator();
  orch.setToolRegistry(makeRegistry());
  orch.setAuthorityEngine(new AuthorityEngine(authConfig));
  const audit = new AuditTrail();
  orch.setAuditTrail(audit);
  orch.createPrimary(ROLE);
  return { orch, audit };
}

describe('orchestrator.executeRealtimeToolCall (auto-approve bridge)', () => {
  beforeEach(() => { initDatabase(':memory:'); executed = []; });
  afterEach(() => { closeDb(); });

  test('allowed tool executes and returns the result', async () => {
    const { orch, audit } = makeOrchestrator(authorityConfig());
    const out = await orch.executeRealtimeToolCall('read_file', { path: '/etc/hosts' });
    expect(out).toBe('contents of /etc/hosts');
    expect(executed).toEqual(['read_file:/etc/hosts']);
    const log = audit.query({ limit: 10 });
    expect(log[0]!.channel).toBe('voice');
    expect(log[0]!.authority_decision).toBe('allowed');
    expect(log[0]!.executed).toBe(1);
  });

  test('requiresApproval is AUTO-APPROVED (executes) and audited as approval_required', async () => {
    // Force read_data to require approval via an override.
    const cfg = authorityConfig({ overrides: [{ action: 'read_data', allowed: true, requires_approval: true }] });
    const { orch, audit } = makeOrchestrator(cfg);
    const out = await orch.executeRealtimeToolCall('read_file', { path: '/x' });
    expect(out).toBe('contents of /x');           // executed despite needing approval
    expect(executed).toEqual(['read_file:/x']);
    const log = audit.query({ limit: 10 });
    expect(log[0]!.authority_decision).toBe('approval_required');
    expect(log[0]!.executed).toBe(1);             // auto-approved
  });

  test('hard deny is enforced — tool does NOT execute', async () => {
    const cfg = authorityConfig({ overrides: [{ action: 'read_data', allowed: false }] });
    const { orch } = makeOrchestrator(cfg);
    const out = await orch.executeRealtimeToolCall('read_file', { path: '/x' });
    expect(out).toContain('[AUTHORITY DENIED]');
    expect(executed).toEqual([]);
  });

  test('blocked_categories backstop blocks even under auto-approve', async () => {
    const { orch } = makeOrchestrator(authorityConfig());
    const out = await orch.executeRealtimeToolCall('read_file', { path: '/x' }, { blockedCategories: ['read_data'] });
    expect(out).toContain('[BLOCKED]');
    expect(executed).toEqual([]);
  });

  test('unknown tool returns an error string, never throws', async () => {
    const { orch } = makeOrchestrator(authorityConfig());
    const out = await orch.executeRealtimeToolCall('does_not_exist', {});
    expect(out.toLowerCase()).toContain('error');
  });
});
