import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AgentOrchestrator } from './orchestrator.ts';
import type { RoleDefinition } from '../roles/types.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager, approvalNeedsClick, type ApprovalRequest } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor, isAgentStopCard } from '../authority/deferred-executor.ts';
import { approvalIntentFields } from '../authority/approval-delivery.ts';
import { assignPersistentAgentTask } from '../actions/tools/agents.ts';
import { EmergencyController, setActiveEmergencyController } from '../authority/emergency.ts';
import { runAsApproved } from '../authority/approved-action-scope.ts';
import { gateVoiceApprovalResolution } from '../roles/authority.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { createDelegateTool } from '../actions/tools/delegate.ts';
import {
  createManageAgentsTool, spawnPersistentAgent, terminatePersistentAgent, type AgentToolDeps,
} from '../actions/tools/agents.ts';
import { AgentTaskManager } from './task-manager.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { LLMToolCall } from '../llm/provider.ts';
import { AgentLifecycleRefusal } from './lifecycle-gate.ts';
import { applyApprovalDecision } from '../daemon/approval-decision.ts';
import { createApiRoutes, type ApiContext } from '../daemon/api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';
import { RealtimeTaint } from './realtime-taint.ts';

/**
 * #963: stopping a background agent is a governed act, gated at the sink
 * (`orchestrator.terminateAgent`), and when it goes ahead the agent's task
 * loop actually stops.
 */

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => { setActiveEmergencyController(null); closeDb(); });

function role(id: string, tools: string[], level = 5): RoleDefinition {
  return { id, name: id, description: id, responsibilities: [], autonomous_actions: [], approval_required: [],
    tools, authority_level: level } as unknown as RoleDefinition;
}

/** A model that never finishes on its own: one cheap tool call per turn. */
function busyModel() {
  let calls = 0;
  const llm = {
    chatTier: async (_t: string, _s: string, _m: unknown[], o?: { signal?: AbortSignal }) => {
      o?.signal?.throwIfAborted();
      calls++;
      // Slow enough that 100 iterations (the loop's own cap) take seconds, so
      // a task that ends inside a test ended because it was stopped.
      await new Promise((r) => setTimeout(r, 20));
      return { content: '', finish_reason: 'tool_use', model: 'm', tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: {} }],
        usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as LLMManager;
  return { llm, calls: () => calls };
}

function harness(opts: { overrides?: AuthorityConfig['overrides']; level?: number } = {}) {
  const orch = new AgentOrchestrator();
  orch.setAuthorityEngine(new AuthorityEngine({ default_level: opts.level ?? 3, governed_categories: [],
    overrides: opts.overrides ?? [], context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
  const approvals = new ApprovalManager();
  orch.setApprovalManager(approvals);
  const audit = new AuditTrail();
  orch.setAuditTrail(audit);
  const emergency = new EmergencyController();
  orch.setEmergencyController(emergency);
  const cards: ApprovalRequest[] = [];
  orch.setApprovalCallback((r) => cards.push(r));
  const primary = orch.createPrimary(role('pa', ['delegation'], opts.level ?? 5));
  const model = busyModel();
  const taskManager = new AgentTaskManager();
  orch.setTaskCanceller((agentId) => { taskManager.cancelAgentTasks(agentId, 'agent stopped'); });
  const deps: AgentToolDeps = { orchestrator: orch, llmManager: model.llm, specialists: new Map([['spec', role('spec', [])]]), taskManager };
  const registry = new ToolRegistry();
  registry.register(createManageAgentsTool(deps));
  registry.register({ name: 'noop', description: 'noop', category: 'general', parameters: {}, execute: async () => 'ok' });
  orch.setToolRegistry(registry);
  const executor = new DeferredExecutor(approvals, audit);
  executor.setToolRegistry(registry);
  executor.setEmergencyController(emergency);
  executor.setAuthorityEngine(orch.getAuthorityEngine()!);
  /** A persistent agent whose task loop is running. */
  const running = async () => {
    const { agent } = spawnPersistentAgent(deps, 'spec');
    const taskId = taskManager.launch({ agent, task: 't', context: '', llmManager: model.llm, toolRegistry: registry });
    for (let i = 0; i < 200 && model.calls() < 2; i++) await new Promise((r) => setTimeout(r, 2));
    return { agent, taskId };
  };
  const stopRows = () => audit.query({ action: 'terminate_agent' }).filter((r) => r.tool_name === 'terminate_agent(spec)');
  const settled = async (taskId: string) => {
    for (let i = 0; i < 500 && taskManager.getTask(taskId)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 2));
  };
  return { orch, approvals, audit, emergency, cards, primary, model, taskManager, deps, executor, running, stopRows, settled };
}

async function refusal(fn: () => unknown): Promise<AgentLifecycleRefusal> {
  try { await fn(); } catch (err) { if (err instanceof AgentLifecycleRefusal) return err; throw err; }
  throw new Error('expected an AgentLifecycleRefusal');
}

describe('stopping an agent is gated at the sink (#963)', () => {
  it('terminate_agent denied: the agent and its loop are left alone, and the refusal is audited', async () => {
    const h = harness({ overrides: [{ action: 'terminate_agent', allowed: false }] });
    const { agent, taskId } = await h.running();
    const err = await refusal(() => terminatePersistentAgent(h.deps, agent.id));
    expect(err.kind).toBe('denied');
    expect(h.orch.getAgent(agent.id)).toBeDefined();
    expect(h.taskManager.getTask(taskId)!.status).toBe('running');
    expect(h.cards).toHaveLength(0);
    expect(h.stopRows().map((r) => [r.authority_decision, r.executed])).toEqual([['denied', 0]]);
    h.taskManager.cancel(taskId);
    await h.settled(taskId);
  });

  it('at the default level a stop raises a card and stops nothing yet', async () => {
    const h = harness();
    const { agent, taskId } = await h.running();
    const err = await refusal(() => terminatePersistentAgent(h.deps, agent.id));
    expect(err.kind).toBe('approval_required');
    expect(h.cards.map((c): Array<string | null> => [c.id, c.tool_name, c.action_category])).toEqual([[err.approvalId as string | null, 'manage_agents', 'terminate_agent']]);
    expect(JSON.parse(h.cards[0]!.tool_arguments)).toEqual({ action: 'terminate', agent_id: agent.id, task_id: taskId });
    expect(h.orch.getAgent(agent.id)).toBeDefined();
    expect(h.taskManager.getTask(taskId)!.status).toBe('running');
    // terminate_agent is destructive: the card is click-only, never approved by voice.
    expect(gateVoiceApprovalResolution('terminate_agent', 0.99).kind).toBe('clarify');
    h.taskManager.cancel(taskId);
    await h.settled(taskId);
  });

  it('approving that card stops the agent AND its loop', async () => {
    const h = harness();
    const { agent, taskId } = await h.running();
    const err = await refusal(() => terminatePersistentAgent(h.deps, agent.id));
    h.approvals.approve(err.approvalId!, 'dashboard');
    const out = await h.executor.executeApproved(err.approvalId!, 'dashboard');
    expect(out).toContain('"terminated"');
    expect(h.orch.getAgent(agent.id)).toBeUndefined();
    await h.settled(taskId);
    const atStop = h.model.calls();
    await new Promise((r) => setTimeout(r, 40));
    expect(h.taskManager.getTask(taskId)!.status).toBe('cancelled');
    expect(h.model.calls()).toBe(atStop);
    expect(h.cards).toHaveLength(1);
    expect(h.stopRows().some((r) => r.authority_decision === 'approval_required' && r.executed === 1
      && r.approval_id === err.approvalId)).toBe(true);
  });

  it('when authority allows it outright, terminate stops the loop at once', async () => {
    const h = harness({ level: 10 });
    const { agent, taskId } = await h.running();
    terminatePersistentAgent(h.deps, agent.id);
    await h.settled(taskId);
    expect(h.taskManager.getTask(taskId)!.status).toBe('cancelled');
    expect(h.stopRows().map((r) => [r.authority_decision, r.executed])).toEqual([['allowed', 1]]);
  });

  it('a stop is not refused for emergency state', async () => {
    const h = harness({ level: 10 });
    const { agent, taskId } = await h.running();
    h.emergency.kill();
    terminatePersistentAgent(h.deps, agent.id);
    await h.settled(taskId);
    expect(h.taskManager.getTask(taskId)!.status).toBe('cancelled');
  });

  it('a voice session auto-approval never covers a stop; a card does', async () => {
    const h = harness();
    const { agent, taskId } = await h.running();
    await runAsApproved({ categories: ['terminate_agent'], approvalId: null, source: 'realtime_auto' }, async () => {
      expect((await refusal(() => h.orch.terminateAgent(agent.id))).kind).toBe('approval_required');
    });
    expect(h.orch.getAgent(agent.id)).toBeDefined();
    await runAsApproved({ categories: ['terminate_agent'], approvalId: 'a1', source: 'approval' }, async () => h.orch.terminateAgent(agent.id));
    expect(h.orch.getAgent(agent.id)).toBeUndefined();
    await h.settled(taskId);
  });

  it('a realtime manage_agents terminate raises a card even when authority allows it outright', async () => {
    const h = harness({ level: 10 });
    const { agent, taskId } = await h.running();
    const out = await h.orch.executeRealtimeToolCall('manage_agents', { action: 'terminate', agent_id: agent.id }, { taint: new RealtimeTaint() });
    expect(out).toContain('[AWAITING_APPROVAL]');
    expect(h.cards).toHaveLength(1);
    expect(h.orch.getAgent(agent.id)).toBeDefined();
    expect(h.taskManager.getTask(taskId)!.status).toBe('running');
    h.taskManager.cancel(taskId);
    await h.settled(taskId);
  });

  it('requestTerminationApproval (the voice cancel) raises a card whatever the engine allows, and refuses on a deny', async () => {
    const allowed = harness({ level: 10 });
    const a = await allowed.running();
    const card = allowed.orch.requestTerminationApproval(a.agent.id, { toolName: 'manage_agents', toolArguments: { action: 'terminate', agent_id: a.agent.id } });
    expect(allowed.cards.map((c) => c.id)).toEqual([card.id]);
    expect(allowed.orch.getAgent(a.agent.id)).toBeDefined();
    // Asked twice, still one card.
    allowed.orch.requestTerminationApproval(a.agent.id, { toolName: 'manage_agents', toolArguments: { action: 'terminate', agent_id: a.agent.id } });
    expect(allowed.approvals.getPending()).toHaveLength(1);
    allowed.taskManager.cancel(a.taskId);
    await allowed.settled(a.taskId);

    const denied = harness({ overrides: [{ action: 'terminate_agent', allowed: false }] });
    const d = await denied.running();
    expect((await refusal(() => denied.orch.requestTerminationApproval(d.agent.id,
      { toolName: 'manage_agents', toolArguments: { action: 'terminate', agent_id: d.agent.id } }))).kind).toBe('denied');
    expect(denied.cards).toHaveLength(0);
    denied.taskManager.cancel(d.taskId);
    await denied.settled(d.taskId);
  });

  it('a model manage_agents terminate goes through one card and stops the loop', async () => {
    const h = harness();
    const { agent, taskId } = await h.running();
    h.orch.setDeferredExecutor(h.executor);
    h.orch.setApprovalCallback((r) => { h.cards.push(r); queueMicrotask(() => h.approvals.approve(r.id, 'dashboard')); });
    await (h.orch as unknown as { executeTool: (c: LLMToolCall, s: undefined, t: Set<string>, scope: null) => Promise<unknown> })
      .executeTool({ id: 't1', name: 'manage_agents', arguments: { action: 'terminate', agent_id: agent.id } }, undefined, new Set(), null);
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]!.action_category).toBe('terminate_agent');
    expect(approvalNeedsClick(h.cards[0]!)).toBe(false);
    expect(h.orch.getAgent(agent.id)).toBeUndefined();
    await h.settled(taskId);
    expect(h.taskManager.getTask(taskId)!.status).toBe('cancelled');
  });

  it('cleaning up a finished delegation is not a stop anybody approves', async () => {
    const h = harness({ overrides: [{ action: 'terminate_agent', allowed: false }] });
    h.orch.getToolRegistry()!.register(createDelegateTool({ orchestrator: h.orch, specialists: h.deps.specialists,
      llmManager: { chatTier: async () => ({ content: 'done', finish_reason: 'end_turn', tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1 } }) } as unknown as LLMManager }));
    const out = String(await h.orch.getToolRegistry()!.execute('delegate_task', { specialist: 'spec', task: 'x', context: '' }));
    expect(out).toContain('completed');
    expect(h.orch.getAllAgents()).toHaveLength(1);
  });
});

describe('DELETE /api/agents/:id goes through the stop sink (#963)', () => {
  const del = (h: ReturnType<typeof harness>, id: string) => {
    const routes = createApiRoutes({ daemonStartedAt: Date.now(), healthMonitor: {} as ApiContext['healthMonitor'],
      config: { llm: { providers: {} } } as JarvisConfig,
      agentService: { getTaskManager: () => h.taskManager, getOrchestrator: () => h.orch,
        getLLMManager: () => h.model.llm, getSpecialists: () => h.deps.specialists },
    } as unknown as ApiContext);
    const route = routes['/api/agents/:id'] as { DELETE: (r: Request & { params: { id: string } }) => Promise<Response> | Response };
    return route.DELETE(Object.assign(new Request(`http://localhost/api/agents/${id}`, { method: 'DELETE' }), { params: { id } }));
  };

  it('answers 202 with a card when the stop needs approval, and the loop keeps running', async () => {
    const h = harness();
    const { agent, taskId } = await h.running();
    const res = await del(h, agent.id);
    expect(res.status).toBe(202);
    const body = await res.json() as { approval_id: string };
    expect(h.cards.map((c) => c.id)).toEqual([body.approval_id]);
    expect(h.taskManager.getTask(taskId)!.status).toBe('running');
    h.taskManager.cancel(taskId);
    await h.settled(taskId);
  });

  it('answers 403 on a deny, and 200 with the loop stopped when allowed', async () => {
    const denied = harness({ overrides: [{ action: 'terminate_agent', allowed: false }] });
    const d = await denied.running();
    expect((await del(denied, d.agent.id)).status).toBe(403);
    denied.taskManager.cancel(d.taskId);
    await denied.settled(d.taskId);

    const allowed = harness({ level: 10 });
    const a = await allowed.running();
    expect((await del(allowed, a.agent.id)).status).toBe(200);
    await allowed.settled(a.taskId);
    expect(allowed.taskManager.getTask(a.taskId)!.status).toBe('cancelled');
  });
});

describe('the daemon wires the stop to the task loops (#963)', () => {
  it('the agent service hands the orchestrator its task manager canceller', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../daemon/agent-service.ts', import.meta.url), 'utf8');
    expect(src).toContain("this.orchestrator.setTaskCanceller((agentId) => { taskManager.cancelAgentTasks(agentId, 'agent stopped'); });");
    // Shutdown is cleanup, not a stop anybody approves.
    expect(src).toContain('this.orchestrator.reapAgent(primary.id);');
    expect(src).not.toContain('.terminateAgent(');
  });
});

describe('stopping an agent, after review (#963)', () => {
  for (const state of ['paused', 'killed'] as const) {
    it(`a Stop agent card approved through the shared handler works while ${state}`, async () => {
      const h = harness();
      const { agent, taskId } = await h.running();
      try {
        const err = await refusal(() => terminatePersistentAgent(h.deps, agent.id));
        setActiveEmergencyController(h.emergency);
        if (state === 'paused') h.emergency.pause(); else h.emergency.kill();
        const outcome = await applyApprovalDecision('approve', err.approvalId!, 'dashboard', {
          approvalManager: h.approvals, deferredExecutor: h.executor, auditTrail: h.audit,
        });
        expect(outcome.status).toBe('approved');
        expect(h.approvals.getRequest(err.approvalId!)?.execution_outcome).toBe('committed');
        expect(h.orch.getAgent(agent.id)).toBeUndefined();
      } finally {
        h.taskManager.cancel(taskId);
        await h.settled(taskId);
      }
    });
  }

  it('under Kill, at the default level, a stop card still runs and the loop stops', async () => {
    const h = harness();
    const { agent, taskId } = await h.running();
    h.emergency.kill();
    const err = await refusal(() => terminatePersistentAgent(h.deps, agent.id));
    h.approvals.approve(err.approvalId!, 'dashboard');
    const out = await h.executor.executeApproved(err.approvalId!, 'dashboard');
    expect(out).not.toContain('NOT executed');
    expect(h.orch.getAgent(agent.id)).toBeUndefined();
    await h.settled(taskId);
    expect(h.taskManager.getTask(taskId)!.status).toBe('cancelled');
  });

  it('the emergency exemption carries a stop card and nothing else', () => {
    const card = (tool_name: string, action_category: string, args: unknown) =>
      ({ tool_name, action_category, tool_arguments: JSON.stringify(args) }) as never;
    expect(isAgentStopCard(card('manage_agents', 'terminate_agent', { action: 'terminate', agent_id: 'a' }))).toBe(true);
    expect(isAgentStopCard(card('manage_agents', 'terminate_agent', { action: 'terminate', agent_id: 'a', task_id: 't' }))).toBe(true);
    expect(isAgentStopCard(card('manage_agents', 'terminate_agent', { action: 'terminate', agent_id: 'a', task: 'x' }))).toBe(false);
    expect(isAgentStopCard(card('manage_agents', 'spawn_agent', { action: 'terminate', agent_id: 'a' }))).toBe(false);
    expect(isAgentStopCard(card('manage_agents', 'terminate_agent', { action: 'spawn', agent_id: 'a' }))).toBe(false);
    expect(isAgentStopCard(card('run_command', 'terminate_agent', { action: 'terminate', agent_id: 'a' }))).toBe(false);
  });

  it('under Kill, any other approved card is still refused', async () => {
    const h = harness();
    const req = h.approvals.createRequest({ agentId: 'pa', agentName: 'pa', toolName: 'manage_agents',
      toolArguments: { action: 'spawn', specialist: 'spec' }, actionCategory: 'spawn_agent', urgency: 'normal', reason: 'r', context: '' });
    h.approvals.approve(req.id, 'dashboard');
    h.emergency.kill();
    expect(await h.executor.executeApproved(req.id, 'dashboard')).toContain('NOT executed');
    expect(h.orch.getAllAgents()).toHaveLength(1);
  });

  it('the stop card names the agent and the task it would cancel', async () => {
    const h = harness();
    const { agent, taskId } = await h.running();
    await refusal(() => terminatePersistentAgent(h.deps, agent.id));
    expect(approvalIntentFields(h.cards[0]!).intent_action).toBe('Stop the spec background agent and cancel its task "t"');
    h.taskManager.cancel(taskId);
    await h.settled(taskId);
  });

  it('a stop card approved after its task ended does not stop the task the agent is on now', async () => {
    const h = harness();
    const { agent, taskId } = await h.running();
    const err = await refusal(() => terminatePersistentAgent(h.deps, agent.id));
    h.taskManager.cancel(taskId);
    await h.settled(taskId);
    await assignPersistentAgentTask(h.deps, { agentId: agent.id, task: 'something new' });
    const next = h.taskManager.getAgentTask(agent.id)!;
    expect(next.id).not.toBe(taskId);
    h.approvals.approve(err.approvalId!, 'dashboard');
    const out = await h.executor.executeApproved(err.approvalId!, 'dashboard');
    expect(out).toMatch(/no longer running|changed after approval/);
    expect(h.orch.getAgent(agent.id)).toBeDefined();
    expect(h.taskManager.getTask(next.id)!.status).toBe('running');
    h.taskManager.cancel(next.id);
    await h.settled(next.id);
  });

  it('a realtime stop for an agent that does not exist raises no card', async () => {
    const h = harness();
    const out = await h.orch.executeRealtimeToolCall('manage_agents', { action: 'terminate', agent_id: 'ghost' }, { taint: new RealtimeTaint() });
    expect(out).toContain('no background agent');
    const primary = await h.orch.executeRealtimeToolCall('manage_agents', { action: 'terminate', agent_id: h.primary.id }, { taint: new RealtimeTaint() });
    expect(primary).toContain('no background agent');
    expect(h.cards).toHaveLength(0);
    expect(h.approvals.getPending()).toHaveLength(0);
  });

  it('a realtime stop asked twice, with junk keys, is one card', async () => {
    const h = harness({ level: 10 });
    const { agent, taskId } = await h.running();
    await h.orch.executeRealtimeToolCall('manage_agents', { action: 'terminate', agent_id: agent.id }, { taint: new RealtimeTaint() });
    await h.orch.executeRealtimeToolCall('manage_agents', { action: 'terminate', agent_id: agent.id, junk: 'x' }, { taint: new RealtimeTaint() });
    expect(h.approvals.getPending()).toHaveLength(1);
    expect(JSON.parse(h.approvals.getPending()[0]!.tool_arguments)).toEqual({ action: 'terminate', agent_id: agent.id });
    h.taskManager.cancel(taskId);
    await h.settled(taskId);
  });
});

describe('the ungated stop primitives are called only from where they are meant to be (#963)', () => {
  it('reapAgent, cancel and cancelAgentTasks have exactly these production callers', async () => {
    const { Glob } = await import('bun');
    const { readFileSync } = await import('node:fs');
    const root = new URL('../', import.meta.url).pathname;
    const sites: string[] = [];
    for (const file of new Glob('**/*.ts').scanSync(root)) {
      if (file.endsWith('.test.ts')) continue;
      const lines = readFileSync(root + file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/\.reapAgent\(|\.cancelAgentTasks\(|taskManager\.cancel\(|\btm\??\.cancel\(/.test(line)) sites.push(file);
      });
    }
    expect(sites.sort()).toEqual([
      'actions/tools/agents.ts', // a spawn whose task then failed to start: its own fresh agent
      'actions/tools/delegate.ts', 'actions/tools/delegate.ts', // its own finished delegation
      'agents/orchestrator.ts', 'agents/orchestrator.ts', // terminateAgent after its gate, and reapAgent recursing into children
      'daemon/agent-service.ts', 'daemon/agent-service.ts', // the canceller, and shutdown
      'daemon/background-agent-service.ts', // shutdown
      'workflows/adapters/m7-agent-delegator.ts', // its own finished delegation
    ]);
  });
});
