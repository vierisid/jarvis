import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { AuthorityEngine, type AuthorityConfig } from './engine.ts';
import type { ActionCategory } from '../roles/authority.ts';
// Phase 6.6 — pins the merge semantics of the new
// /api/authority/config/quick-override endpoint. The merge logic is
// imported as a shared helper here AND in api-routes.ts; that way the
// test verifies the same code the route runs (no risk of drift between
// a duplicated test fixture and the production path).
import { applyQuickOverride } from './quick-override.ts';

function makeConfig(): AuthorityConfig {
  return {
    default_level: 3,
    governed_categories: ['send_email', 'make_payment'],
    overrides: [],
    context_rules: [],
    learning: { enabled: true, suggest_threshold: 5 },
    emergency_state: 'normal',
  };
}

describe('quick-override', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  test('appends a new global override when none exists for the action', () => {
    const cfg = applyQuickOverride(makeConfig(), {
      action: 'send_email',
      allow: true,
    });
    expect(cfg.overrides).toHaveLength(1);
    expect(cfg.overrides[0]!).toMatchObject({
      action: 'send_email',
      allowed: true,
      requires_approval: false,
    });
    expect((cfg.overrides[0] as any).role_id).toBeUndefined();
  });

  test('updates the existing global override instead of duplicating', () => {
    const initial = applyQuickOverride(makeConfig(), {
      action: 'send_email',
      allow: true,
    });
    const revoked = applyQuickOverride(initial, {
      action: 'send_email',
      allow: false,
    });
    expect(revoked.overrides).toHaveLength(1);
    expect(revoked.overrides[0]!.allowed).toBe(false);
  });

  test('keeps role-scoped overrides separate from global ones', () => {
    let cfg = makeConfig();
    cfg = applyQuickOverride(cfg, { action: 'send_email', allow: true });
    cfg = applyQuickOverride(cfg, {
      action: 'send_email',
      allow: false,
      role_id: 'researcher',
    });
    expect(cfg.overrides).toHaveLength(2);
    const global = cfg.overrides.find(
      (o) => (o as any).role_id === undefined && o.action === 'send_email',
    );
    const scoped = cfg.overrides.find((o) => (o as any).role_id === 'researcher');
    expect(global!.allowed).toBe(true);
    expect(scoped!.allowed).toBe(false);
  });

  test('an applied override actually changes engine authorization', () => {
    const baseCfg = makeConfig();
    const baseEngine = new AuthorityEngine(baseCfg);
    // Agent at level 8 — send_email requires 7, so they pass the numeric
    // gate. Without an override, governed_categories still requires approval.
    const params = {
      agentId: 'a',
      agentAuthorityLevel: 8,
      agentRoleId: 'pa',
      toolName: 'send_email',
      toolCategory: 'email',
      actionCategory: 'send_email' as ActionCategory,
      temporaryGrants: new Map<string, ActionCategory[]>(),
    };
    const baseDecision = baseEngine.checkAuthority(params);
    // send_email is in governed_categories → allowed but requires approval
    expect(baseDecision.allowed).toBe(true);
    expect(baseDecision.requiresApproval).toBe(true);

    const grantedCfg = applyQuickOverride(baseCfg, {
      action: 'send_email',
      allow: true,
    });
    const grantedEngine = new AuthorityEngine(grantedCfg);
    const grantedDecision = grantedEngine.checkAuthority(params);
    // After override allowing send_email globally, no approval needed.
    expect(grantedDecision.allowed).toBe(true);
    expect(grantedDecision.requiresApproval).toBe(false);
  });
});
