import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { AuthorityEngine, type AuthorityConfig } from './engine.ts';
import { ApprovalManager } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import { AuthorityLearner } from './learning.ts';
import { EmergencyController } from './emergency.ts';
import { getActionForTool } from './tool-action-map.ts';
import type { ActionCategory } from '../roles/authority.ts';

function makeConfig(overrides?: Partial<AuthorityConfig>): AuthorityConfig {
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

function makeCheckParams(overrides?: Partial<Parameters<AuthorityEngine['checkAuthority']>[0]>) {
  return {
    agentId: 'agent-1',
    agentAuthorityLevel: 5,
    agentRoleId: 'personal-assistant',
    toolName: 'browser_navigate',
    toolCategory: 'browser',
    actionCategory: 'access_browser' as ActionCategory,
    temporaryGrants: new Map<string, ActionCategory[]>(),
    ...overrides,
  };
}

// --- AuthorityEngine ---

describe('AuthorityEngine', () => {
  test('allows action when level meets requirement', () => {
    const engine = new AuthorityEngine(makeConfig());
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 5,
      actionCategory: 'access_browser', // requires 5
    }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  test('denies action when level is below requirement', () => {
    const engine = new AuthorityEngine(makeConfig());
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 4,
      actionCategory: 'execute_command', // requires 5
    }));
    expect(decision.allowed).toBe(false);
  });

  test('requires approval for governed categories', () => {
    const engine = new AuthorityEngine(makeConfig());
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 7,
      actionCategory: 'send_email', // requires 7, governed
    }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  test('does not require approval for non-governed categories', () => {
    const engine = new AuthorityEngine(makeConfig());
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 5,
      actionCategory: 'access_browser', // not governed
    }));
    expect(decision.requiresApproval).toBe(false);
  });

  test('per-action override: explicit deny', () => {
    const engine = new AuthorityEngine(makeConfig({
      overrides: [{ action: 'access_browser', allowed: false }],
    }));
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 10, // would normally allow
    }));
    expect(decision.allowed).toBe(false);
  });

  test('per-action override: explicit allow with approval', () => {
    const engine = new AuthorityEngine(makeConfig({
      overrides: [{ action: 'send_email', role_id: 'personal-assistant', allowed: true, requires_approval: true }],
    }));
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 7,
      actionCategory: 'send_email',
    }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  test('per-action override: explicit allow without approval', () => {
    const engine = new AuthorityEngine(makeConfig({
      overrides: [{ action: 'send_email', allowed: true }],
    }));
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 7,
      actionCategory: 'send_email',
    }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  test('role-specific override takes priority over global', () => {
    const engine = new AuthorityEngine(makeConfig({
      overrides: [
        { action: 'send_email', allowed: false }, // global: deny
        { action: 'send_email', role_id: 'personal-assistant', allowed: true }, // role: allow
      ],
    }));
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 7,
      actionCategory: 'send_email',
    }));
    expect(decision.allowed).toBe(true);
  });

  test('temporary grants override everything', () => {
    const engine = new AuthorityEngine(makeConfig({
      overrides: [{ action: 'make_payment', allowed: false }], // Explicitly denied
    }));
    const grants = new Map<string, ActionCategory[]>();
    grants.set('agent-1', ['make_payment']);

    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 1, // Way below requirement
      actionCategory: 'make_payment',
      temporaryGrants: grants,
    }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  test('context rule: time_range', () => {
    const now = new Date();
    const engine = new AuthorityEngine(makeConfig({
      context_rules: [{
        id: 'no-email-at-night',
        action: 'send_email',
        condition: 'time_range',
        params: { start_hour: now.getHours(), end_hour: now.getHours() + 1 },
        effect: 'deny',
        description: 'No emails during current hour',
      }],
    }));
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 7,
      actionCategory: 'send_email',
    }));
    expect(decision.allowed).toBe(false);
    expect(decision.contextRule).toBe('no-email-at-night');
  });

  test('context rule: tool_name', () => {
    const engine = new AuthorityEngine(makeConfig({
      context_rules: [{
        id: 'no-delete-command',
        action: 'execute_command',
        condition: 'tool_name',
        params: { tool_name: 'run_command' },
        effect: 'require_approval',
        description: 'Shell commands need approval',
      }],
    }));
    const decision = engine.checkAuthority(makeCheckParams({
      agentAuthorityLevel: 5,
      toolName: 'run_command',
      actionCategory: 'execute_command',
    }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  test('describeRulesForAgent returns readable text', () => {
    const engine = new AuthorityEngine(makeConfig());
    const rules = engine.describeRulesForAgent(5, 'personal-assistant');
    expect(rules).toContain('authority level: 5/10');
    expect(rules).toContain('send_email');
    expect(rules).toContain('make_payment');
  });

  test('all 13 action categories are checkable', () => {
    const engine = new AuthorityEngine(makeConfig({ governed_categories: [] }));
    const categories: ActionCategory[] = [
      'read_data', 'write_data', 'delete_data',
      'send_message', 'send_email',
      'execute_command', 'install_software',
      'make_payment', 'modify_settings',
      'spawn_agent', 'terminate_agent',
      'access_browser', 'control_app',
    ];

    for (const cat of categories) {
      const decision = engine.checkAuthority(makeCheckParams({
        agentAuthorityLevel: 10,
        actionCategory: cat,
      }));
      expect(decision.allowed).toBe(true);
    }
  });
});

// --- Tool Action Map ---

describe('getActionForTool', () => {
  test('maps known tools by name', () => {
    expect(getActionForTool('run_command', 'terminal')).toBe('execute_command');
    expect(getActionForTool('read_file', 'file-ops')).toBe('read_data');
    expect(getActionForTool('write_file', 'file-ops')).toBe('write_data');
    expect(getActionForTool('browser_navigate', 'browser')).toBe('access_browser');
    expect(getActionForTool('desktop_click', 'desktop')).toBe('control_app');
    expect(getActionForTool('delegate_task', 'delegation')).toBe('spawn_agent');
  });

  test('falls back to category map for unknown tools', () => {
    expect(getActionForTool('some_browser_tool', 'browser')).toBe('access_browser');
    expect(getActionForTool('some_terminal_tool', 'terminal')).toBe('execute_command');
  });

  test('defaults to read_data for completely unknown tools', () => {
    expect(getActionForTool('unknown_tool', 'unknown_category')).toBe('read_data');
  });
});

// --- EmergencyController ---

describe('EmergencyController', () => {
  test('starts in normal state', () => {
    const ec = new EmergencyController();
    expect(ec.getState()).toBe('normal');
    expect(ec.canExecute()).toBe(true);
  });

  test('pause blocks execution', () => {
    const ec = new EmergencyController();
    ec.pause();
    expect(ec.getState()).toBe('paused');
    expect(ec.canExecute()).toBe(false);
  });

  test('resume restores execution', () => {
    const ec = new EmergencyController();
    ec.pause();
    ec.resume();
    expect(ec.getState()).toBe('normal');
    expect(ec.canExecute()).toBe(true);
  });

  test('kill blocks execution', () => {
    const ec = new EmergencyController();
    ec.kill();
    expect(ec.getState()).toBe('killed');
    expect(ec.canExecute()).toBe(false);
  });

  test('cannot pause from killed state', () => {
    const ec = new EmergencyController();
    ec.kill();
    ec.pause();
    expect(ec.getState()).toBe('killed');
  });

  test('reset restores from killed', () => {
    const ec = new EmergencyController();
    ec.kill();
    ec.reset();
    expect(ec.getState()).toBe('normal');
    expect(ec.canExecute()).toBe(true);
  });

  test('fires state change callback', () => {
    const ec = new EmergencyController();
    const states: string[] = [];
    ec.setStateChangeCallback(s => states.push(s));
    ec.pause();
    ec.resume();
    expect(states).toEqual(['paused', 'normal']);
  });
});

// --- ApprovalManager (requires DB) ---

describe('ApprovalManager', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  test('creates and retrieves approval request', () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'agent-1',
      agentName: 'Personal Assistant',
      toolName: 'send_email',
      toolArguments: { to: 'test@example.com', subject: 'hi' },
      actionCategory: 'send_email',
      urgency: 'urgent',
      reason: 'Governed action',
      context: 'User asked to send email',
    });

    expect(req.id).toBeTruthy();
    expect(req.status).toBe('pending');
    expect(req.urgency).toBe('urgent');

    const retrieved = mgr.getRequest(req.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tool_name).toBe('send_email');
  });

  test('approve changes status', () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });

    const approved = mgr.approve(req.id, 'dashboard');
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('approved');
    expect(approved!.decided_by).toBe('dashboard');
  });

  test('deny changes status', () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });

    const denied = mgr.deny(req.id, 'telegram');
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe('denied');
  });

  test('cannot approve already decided request', () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });

    mgr.deny(req.id, 'dashboard');
    const result = mgr.approve(req.id, 'dashboard');
    expect(result).toBeNull();
  });

  test('getPending returns only pending', () => {
    const mgr = new ApprovalManager();
    mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });
    const req2 = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'make_payment',
      toolArguments: {}, actionCategory: 'make_payment',
      urgency: 'urgent', reason: 'test2', context: '',
    });
    mgr.approve(req2.id, 'dashboard');

    const pending = mgr.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.tool_name).toBe('send_email');
  });

  test('findByShortId works', () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });

    const found = mgr.findByShortId(req.id.slice(0, 8));
    expect(found).not.toBeNull();
    expect(found!.id).toBe(req.id);
  });

  test('execution_mode defaults to deferred and persists when set inline', () => {
    const mgr = new ApprovalManager();
    const deferred = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });
    expect(deferred.execution_mode).toBe('deferred');
    expect(mgr.getRequest(deferred.id)!.execution_mode).toBe('deferred');

    const inline = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'manage_workflow',
      toolArguments: {}, actionCategory: 'modify_settings',
      urgency: 'normal', reason: 'test', context: '',
      executionMode: 'inline',
    });
    expect(inline.execution_mode).toBe('inline');
    expect(mgr.getRequest(inline.id)!.execution_mode).toBe('inline');
  });

  test('demoteToDeferred succeeds only while pending', () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'manage_workflow',
      toolArguments: {}, actionCategory: 'modify_settings',
      urgency: 'normal', reason: 'test', context: '',
      executionMode: 'inline',
    });

    expect(mgr.demoteToDeferred(req.id)).toBe(true);
    expect(mgr.getRequest(req.id)!.execution_mode).toBe('deferred');

    // Already deferred — nothing to demote.
    expect(mgr.demoteToDeferred(req.id)).toBe(false);
  });

  test('demoteToDeferred fails after approval (inline gate keeps execution)', () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'manage_workflow',
      toolArguments: {}, actionCategory: 'modify_settings',
      urgency: 'normal', reason: 'test', context: '',
      executionMode: 'inline',
    });

    mgr.approve(req.id, 'dashboard');
    expect(mgr.demoteToDeferred(req.id)).toBe(false);
    expect(mgr.getRequest(req.id)!.execution_mode).toBe('inline');
  });

  test('markExecuted updates fields', () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });
    mgr.approve(req.id, 'dashboard');
    mgr.markExecuted(req.id, 'Email sent successfully');

    const updated = mgr.getRequest(req.id);
    expect(updated!.status).toBe('executed');
    expect(updated!.execution_result).toBe('Email sent successfully');
  });

  test('inline flow: gate waits, approve flips status, executor runs tool once', async () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'manage_workflow',
      toolArguments: { action: 'create' }, actionCategory: 'modify_settings',
      urgency: 'normal', reason: 'test', context: '',
      executionMode: 'inline',
    });

    let executions = 0;
    const registry = {
      execute: async () => { executions++; return '{"ok":true}'; },
    } as unknown as ToolRegistry;
    const executor = new DeferredExecutor(mgr, new AuditTrail());
    executor.setToolRegistry(registry);

    // Simulate the blocked authority gate: wait, then execute on approval.
    const gate = (async () => {
      const resolved = await mgr.waitForResolution(req.id, { timeoutMs: 5000, pollMs: 10 });
      expect(resolved.status).toBe('approved');
      return executor.executeApproved(req.id);
    })();

    // Simulate the approve endpoint: flip status, skip execution (inline).
    const approved = mgr.approve(req.id, 'dashboard');
    expect(approved!.execution_mode).toBe('inline');

    const result = await gate;
    expect(result).toBe('{"ok":true}');
    expect(executions).toBe(1);
    expect(mgr.getRequest(req.id)!.status).toBe('executed');
  });

  test('executeApproved refuses to run while system is paused', async () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });
    mgr.approve(req.id, 'dashboard');

    let executions = 0;
    const registry = {
      execute: async () => { executions++; return 'sent'; },
    } as unknown as ToolRegistry;
    const executor = new DeferredExecutor(mgr, new AuditTrail());
    executor.setToolRegistry(registry);
    const emergency = new EmergencyController();
    executor.setEmergencyController(emergency);
    emergency.pause();

    const result = await executor.executeApproved(req.id);
    expect(result).toContain('[SYSTEM PAUSED]');
    expect(result).toContain('NOT executed');
    expect(executions).toBe(0);
    // Request is closed out, not left as an approved zombie.
    expect(mgr.getRequest(req.id)!.status).toBe('executed');
  });

  test('waitForResolution returns early when the signal aborts', async () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'manage_workflow',
      toolArguments: {}, actionCategory: 'modify_settings',
      urgency: 'normal', reason: 'test', context: '',
      executionMode: 'inline',
    });

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const start = Date.now();
    const resolved = await mgr.waitForResolution(req.id, {
      timeoutMs: 10_000,
      pollMs: 10,
      signal: ctrl.signal,
    });
    expect(resolved.status).toBe('pending');
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('expireOld expires old pending requests', () => {
    const mgr = new ApprovalManager();
    mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'send_email',
      toolArguments: {}, actionCategory: 'send_email',
      urgency: 'normal', reason: 'test', context: '',
    });

    // Expire with very large max age — nothing should expire
    const noneExpired = mgr.expireOld(999999999);
    expect(noneExpired).toBe(0);

    // Manually update created_at to the past so expiry works
    getDb().run('UPDATE approval_requests SET created_at = created_at - 10000');
    const expired = mgr.expireOld(5000);
    expect(expired).toBe(1);

    const pending = mgr.getPending();
    expect(pending.length).toBe(0);
  });
});

// --- AuditTrail (requires DB) ---

describe('AuditTrail', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  test('logs and queries audit entries', () => {
    const trail = new AuditTrail();

    trail.log({
      agent_id: 'a1', agent_name: 'PA',
      tool_name: 'browser_navigate', action_category: 'access_browser',
      authority_decision: 'allowed', executed: true, execution_time_ms: 150,
    });

    trail.log({
      agent_id: 'a1', agent_name: 'PA',
      tool_name: 'send_email', action_category: 'send_email',
      authority_decision: 'approval_required', executed: false,
    });

    const all = trail.query();
    expect(all.length).toBe(2);

    const browserOnly = trail.query({ action: 'access_browser' });
    expect(browserOnly.length).toBe(1);
    expect(browserOnly[0]!.tool_name).toBe('browser_navigate');
  });

  test('getStats aggregates correctly', () => {
    const trail = new AuditTrail();

    trail.log({ agent_id: 'a1', agent_name: 'PA', tool_name: 't1', action_category: 'read_data', authority_decision: 'allowed', executed: true });
    trail.log({ agent_id: 'a1', agent_name: 'PA', tool_name: 't2', action_category: 'write_data', authority_decision: 'allowed', executed: true });
    trail.log({ agent_id: 'a1', agent_name: 'PA', tool_name: 't3', action_category: 'send_email', authority_decision: 'denied', executed: false });

    const stats = trail.getStats();
    expect(stats.total).toBe(3);
    expect(stats.allowed).toBe(2);
    expect(stats.denied).toBe(1);
    expect(stats.byCategory['read_data']).toBe(1);
    expect(stats.byCategory['send_email']).toBe(1);
  });
});

// --- AuthorityLearner (requires DB) ---

describe('AuthorityLearner', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  test('no suggestions below threshold', () => {
    const learner = new AuthorityLearner(3);
    learner.recordDecision('send_email', 'send_email', true);
    learner.recordDecision('send_email', 'send_email', true);

    expect(learner.getSuggestions().length).toBe(0);
  });

  test('suggests after threshold consecutive approvals', () => {
    const learner = new AuthorityLearner(3);
    learner.recordDecision('send_email', 'send_email', true);
    learner.recordDecision('send_email', 'send_email', true);
    learner.recordDecision('send_email', 'send_email', true);

    const suggestions = learner.getSuggestions();
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]!.actionCategory).toBe('send_email');
    expect(suggestions[0]!.consecutiveApprovals).toBe(3);
  });

  test('denial resets consecutive count', () => {
    const learner = new AuthorityLearner(3);
    learner.recordDecision('send_email', 'send_email', true);
    learner.recordDecision('send_email', 'send_email', true);
    learner.recordDecision('send_email', 'send_email', false); // reset
    learner.recordDecision('send_email', 'send_email', true);

    expect(learner.getSuggestions().length).toBe(0);
  });

  test('markSuggestionSent prevents re-suggestion', () => {
    const learner = new AuthorityLearner(2);
    learner.recordDecision('send_email', 'send_email', true);
    learner.recordDecision('send_email', 'send_email', true);

    expect(learner.getSuggestions().length).toBe(1);

    learner.markSuggestionSent('send_email', 'send_email');
    expect(learner.getSuggestions().length).toBe(0);
  });
});
