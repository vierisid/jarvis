/**
 * The per-call tool gate at every authority gate site.
 *
 * run_skill is gated on the worst case of the skill's steps, and a category
 * above the agent's level becomes an approval card (never a silent run,
 * never a denial that makes a send-type skill unusable). record_skill start
 * always needs the person's confirmation: the text path asks, the realtime
 * path refuses, a sub-agent is denied. Tools are synthetic so the tests pin
 * the orchestrator's behaviour, not the skill store.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { AgentOrchestrator } from './orchestrator.ts';
import { AgentInstance } from './agent.ts';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { ApprovalManager, approvalNeedsClick, approvalIntentFromContext } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { runSubAgent } from './sub-agent-runner.ts';
import type { RoleDefinition } from '../roles/types.ts';

type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };
const exec = (o: AgentOrchestrator, name: string, args: Record<string, unknown> = {}) =>
  (o as unknown as Exec).executeTool({ id: 't', name, arguments: args }, undefined, new Set());

function roleAt(level: number): RoleDefinition {
  return {
    id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['terminal', 'browser', 'desktop'], authority_level: level,
  } as unknown as RoleDefinition;
}

function config(extra: Partial<AuthorityConfig> = {}): AuthorityConfig {
  return {
    default_level: 1,
    governed_categories: ['make_payment'],
    overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 },
    emergency_state: 'normal',
    ...extra,
  };
}

const str = (description: string) => ({ type: 'string', description, required: false });

function tools(calls: string[]): ToolDefinition[] {
  return [
    {
      name: 'run_skill', description: 't', category: 'ui', parameters: { name: str('skill') },
      execute: async () => { calls.push('run_skill'); return 'ran'; },
      authorityGate: (params) => {
        const skill = String(params.name ?? '');
        if (skill === 'gmail') return { actionCategory: 'send_email', actionCategories: ['send_email', 'control_app'], intent: 'Run skill "gmail": click Send (sends email)', confirm: 'above_level' };
        if (skill === 'shop') return { actionCategory: 'make_payment', intent: 'Run skill "shop": click Buy now (pays)', confirm: 'above_level' };
        if (skill === 'notes') return { actionCategory: 'control_app', intent: 'Run skill "notes": click OK', confirm: 'above_level' };
        if (skill === 'slack') return { actionCategory: 'control_app', actionCategories: ['control_app', 'send_message'], intent: 'Run skill "slack": press enter (sends a message)', confirm: 'above_level' };
        return null;
      },
    },
    {
      name: 'record_skill', description: 't', category: 'ui', parameters: { action: str('a'), name: str('n') },
      execute: async () => { calls.push('record_skill'); return 'recording'; },
      authorityGate: (params) => params.action === 'start' ? { actionCategory: 'control_app', intent: 'Start recording a skill', confirm: 'always' } : null,
    },
    {
      name: 'desktop_click', description: 't', category: 'desktop', parameters: {},
      execute: async () => { calls.push('desktop_click'); return 'clicked'; },
    },
  ];
}

function build(level: number, cfg: Partial<AuthorityConfig> = {}) {
  const calls: string[] = [];
  const registry = new ToolRegistry();
  for (const t of tools(calls)) registry.register(t);
  const approvals = new ApprovalManager();
  const orch = new AgentOrchestrator();
  orch.setToolRegistry(registry);
  orch.setAuthorityEngine(new AuthorityEngine(config(cfg)));
  orch.setApprovalManager(approvals);
  orch.setAuditTrail(new AuditTrail());
  orch.createPrimary(roleAt(level));
  return { orch, calls, approvals, registry };
}

describe('run_skill gate in the orchestrator', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('a level-5 agent runs a control_app-only skill autonomously', async () => {
    const { orch, calls } = build(5);
    expect(String(await exec(orch, 'run_skill', { name: 'notes' }))).toContain('ran');
    expect(calls).toEqual(['run_skill']);
  });

  test('a skill that reaches send_message is stopped by a config that governs it, although control_app is the higher level', async () => {
    const { orch, calls, approvals } = build(5, { governed_categories: ['send_message'] });
    const out = String(await exec(orch, 'run_skill', { name: 'slack' }));
    expect(out).toContain('[AWAITING_APPROVAL]');
    expect(calls).toEqual([]);
    expect(approvals.getPending()[0]!.action_category).toBe('send_message');
    expect(approvals.getPending()[0]!.reason).toContain('governed action');
    // and without that config it runs
    const clean = build(5);
    expect(String(await exec(clean.orch, 'run_skill', { name: 'slack' }))).toContain('ran');
  });

  test('a send-email skill stops a level-5 agent for approval, with the card naming the effect', async () => {
    const { orch, calls, approvals } = build(5);
    const out = String(await exec(orch, 'run_skill', { name: 'gmail' }));
    expect(out).toContain('[AWAITING_APPROVAL]');
    expect(out).toContain('send_email');
    expect(calls).toEqual([]);
    const pending = approvals.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.action_category).toBe('send_email');
    expect(pending[0]!.reason).toContain('above this agent\'s authority level');
    expect(pending[0]!.reason.endsWith('requires user approval')).toBe(true);
    expect(approvalIntentFromContext(pending[0]!)).toBe('Run skill "gmail": click Send (sends email)');
    expect(approvalNeedsClick(pending[0]!)).toBe(false);
  });

  test('a payment skill is also an approval, and the engine still governs it as make_payment', async () => {
    const { orch, calls, approvals } = build(5);
    const out = String(await exec(orch, 'run_skill', { name: 'shop' }));
    expect(out).toContain('[AWAITING_APPROVAL]');
    expect(calls).toEqual([]);
    expect(approvals.getPending()[0]!.action_category).toBe('make_payment');
    expect(approvals.getPending()[0]!.urgency).toBe('urgent');
  });

  test('a level-3 agent that cannot control apps is denied outright, not offered a card', async () => {
    const { orch, calls, approvals } = build(3);
    const out = String(await exec(orch, 'run_skill', { name: 'gmail' }));
    expect(out).toContain('[AUTHORITY DENIED]');
    expect(calls).toEqual([]);
    expect(approvals.getPending()).toHaveLength(0);
  });

  test('an explicit deny override on the effect still denies: only a pure level shortfall becomes a card', async () => {
    const { orch, calls, approvals } = build(5, { overrides: [{ action: 'send_email', allowed: false }] });
    const out = String(await exec(orch, 'run_skill', { name: 'gmail' }));
    expect(out).toContain('[AUTHORITY DENIED]');
    expect(calls).toEqual([]);
    expect(approvals.getPending()).toHaveLength(0);
  });

  test('a level-7 agent whose config governs send_email still gets the card (engine decision)', async () => {
    const { orch, calls, approvals } = build(7, { governed_categories: ['send_email'] });
    const out = String(await exec(orch, 'run_skill', { name: 'gmail' }));
    expect(out).toContain('[AWAITING_APPROVAL]');
    expect(calls).toEqual([]);
    expect(approvals.getPending()[0]!.reason).toContain('governed action');
  });

  test('a level-7 agent runs the send-email skill without a card when nothing governs it', async () => {
    const { orch, calls } = build(7);
    expect(String(await exec(orch, 'run_skill', { name: 'gmail' }))).toContain('ran');
    expect(calls).toEqual(['run_skill']);
  });

  test('a raw desktop click needs review even without a custom gate', async () => {
    const { orch, calls } = build(5);
    expect(String(await exec(orch, 'desktop_click'))).toContain('[AWAITING_APPROVAL]');
    expect(calls).toEqual([]);
  });
});

describe('record_skill confirmation', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('start always produces a click-only approval card, even for a level-9 agent', async () => {
    const { orch, calls, approvals } = build(9);
    const out = String(await exec(orch, 'record_skill', { action: 'start' }));
    expect(out).toContain('[AWAITING_APPROVAL]');
    expect(calls).toEqual([]);
    const req = approvals.getPending()[0]!;
    expect(req.action_category).toBe('control_app');
    expect(req.reason).toBe('record_skill requires user approval');
    expect(approvalNeedsClick(req)).toBe(true);
    expect(approvalIntentFromContext(req)).toBe('Start recording a skill');
  });

  test('stop is not gated beyond its floor', async () => {
    const { orch, calls } = build(5);
    expect(String(await exec(orch, 'record_skill', { action: 'stop', name: 'x' }))).toContain('recording');
    expect(calls).toEqual(['record_skill']);
  });

  test('a realtime voice session cannot start a recording', async () => {
    const { orch, calls } = build(9);
    const out = await orch.executeRealtimeToolCall('record_skill', { action: 'start' });
    expect(out).toContain('[BLOCKED]');
    expect(out).toContain('confirmation in the dashboard');
    expect(calls).toEqual([]);
    // but a plain skill run at level 9 still goes through
    expect(await orch.executeRealtimeToolCall('run_skill', { name: 'notes' })).toContain('ran');
  });

  test('a realtime session does not get the level substitution: the denial stands', async () => {
    const { orch, calls } = build(5);
    const out = await orch.executeRealtimeToolCall('run_skill', { name: 'gmail' });
    expect(out).toContain('[AUTHORITY DENIED]');
    expect(calls).toEqual([]);
  });

  test('a sub-agent is denied a recording outright', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry();
    for (const t of tools(calls)) registry.register(t);
    const engine = new AuthorityEngine(config());
    const agent = new AgentInstance({ ...roleAt(9), id: 'software-engineer' } as RoleDefinition);
    let turn = 0;
    const usage = { input_tokens: 0, output_tokens: 0 };
    const llm = {
      chatTier: async () => {
        turn += 1;
        return turn === 1
          ? { content: '', tool_calls: [{ id: 'c1', name: 'record_skill', arguments: { action: 'start' } }], usage, finish_reason: 'tool_use' }
          : { content: 'done', tool_calls: [], usage, finish_reason: 'stop' };
      },
    };
    const result = await runSubAgent({
      agent, task: 'record it', context: '', llmManager: llm as never, toolRegistry: registry,
      authorityEngine: engine, auditTrail: new AuditTrail(), profile: null,
    });
    expect(calls).toEqual([]);
    expect(result.toolsUsed).toContain('record_skill');
  });
});
