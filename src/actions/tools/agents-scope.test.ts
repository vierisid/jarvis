import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { AgentOrchestrator } from '../../agents/orchestrator.ts';
import { AgentTaskManager } from '../../agents/task-manager.ts';
import { runSubAgent, type RunSubAgentOptions } from '../../agents/sub-agent-runner.ts';
import { AuthorityEngine } from '../../authority/engine.ts';
import { ApprovalManager } from '../../authority/approval.ts';
import { AuditTrail } from '../../authority/audit.ts';
import { EmergencyController } from '../../authority/emergency.ts';
import { ToolRegistry } from './registry.ts';
import { createManageAgentsTool, hasManagedRegistry, listPersistentAgents, spawnPersistentAgent, startPersistentAgent,
  type AgentToolDeps } from './agents.ts';
import type { RoleDefinition } from '../../roles/types.ts';
import type { LLMManager } from '../../llm/manager.ts';
import type { LLMMessage, LLMToolCall } from '../../llm/provider.ts';

/**
 * #1044: `manage_agents` status, collect and list answered a sub-agent about
 * every agent and task, so one could read the results of work it had no part
 * in. A sub-agent now sees only itself and the agents it started, directly or
 * through agents of its own; the primary and the dashboard still see all. And
 * a managed agent's tool registry goes when the agent does, however it goes.
 *
 * No shipped sub-agent registry holds `manage_agents` today
 * (`createScopedToolRegistry` builds from BUILTIN_TOOLS, which has none), so
 * the sub-agent here is handed a registry that does, as #1014's tests do.
 */

function role(id: string, tools: string[], level: number): RoleDefinition {
  return { id, name: id.toUpperCase(), description: 'A role.', responsibilities: ['Things'], autonomous_actions: [],
    approval_required: [], tools, authority_level: level } as unknown as RoleDefinition;
}

const PA = role('pa', ['delegation', 'general'], 8);
const WORKER = role('worker', ['delegation', 'general'], 6);
const INFO = role('info', ['general'], 8);

function setup() {
  // Starting and stopping agents allowed outright, so asks nobody.
  const engine = new AuthorityEngine({ default_level: 5, governed_categories: [],
    overrides: [{ action: 'spawn_agent', allowed: true }, { action: 'terminate_agent', allowed: true }],
    context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' });
  const audit = new AuditTrail();
  const orch = new AgentOrchestrator();
  orch.setAuthorityEngine(engine);
  orch.setApprovalManager(new ApprovalManager());
  orch.setAuditTrail(audit);
  orch.setEmergencyController(new EmergencyController());
  const primary = orch.createPrimary(PA);
  const turns: Record<string, Array<LLMToolCall[]>> = {};
  const step = new Map<string, number>();
  const llm = {
    chatTier: async (_t: string, _o: string, messages: LLMMessage[]) => {
      const agent = /^You are (\S+?)\./.exec(String(messages[0]?.content ?? ''))?.[1] ?? '?';
      const n = step.get(agent) ?? 0;
      step.set(agent, n + 1);
      const calls = turns[agent]?.[n];
      return calls
        ? { content: '', finish_reason: 'tool_use', tool_calls: calls, usage: { input_tokens: 1, output_tokens: 1 } }
        : { content: 'done', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as LLMManager;
  // A task's result says whose it was.
  const taskManager = new AgentTaskManager((async (o: RunSubAgentOptions) =>
    ({ success: true, response: `result of ${o.task}`, toolsUsed: [], tokensUsed: { input: 1, output: 1 }, terminationReason: 'completed', messages: [] })
  ) as unknown as ConstructorParameters<typeof AgentTaskManager>[0]);
  const deps: AgentToolDeps = { orchestrator: orch, llmManager: llm, specialists: new Map([[INFO.id, INFO]]), taskManager };
  const registry = new ToolRegistry();
  registry.register(createManageAgentsTool(deps));
  orch.setToolRegistry(registry);
  const worker = orch.spawnSubAgent(primary.id, WORKER);
  /** The worker makes `calls`, one per turn; returns each reply by call id. */
  const asWorker = async (...calls: Array<Record<string, unknown>>) => {
    turns.WORKER = calls.map((args, i) => [{ id: `w${i}`, name: 'manage_agents', arguments: args }]);
    step.delete('WORKER');
    const result = await runSubAgent({ agent: worker, task: 'Do the job', context: '', llmManager: llm, toolRegistry: registry,
      authorityEngine: engine, auditTrail: audit, temporaryGrants: new Map() });
    return calls.map((_, i) => String(result.messages.find((m) => m.role === 'tool' && m.tool_call_id === `w${i}`)?.content ?? ''));
  };
  const settled = async () => {
    while (taskManager.listTasks({ status: 'running' }).length > 0) await new Promise((r) => setTimeout(r, 1));
  };
  return { orch, primary, worker, deps, taskManager, asWorker, settled };
}

describe('manage_agents reads are scoped to the caller\'s own agents (#1044)', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  test('a sub-agent cannot read an agent or task the primary started', async () => {
    const s = setup();
    const { spawned, assignment } = await startPersistentAgent(s.deps, { specialist: 'info', task: 'the owner\'s private job' });
    await s.settled();
    const [status, collect, agentStatus, list] = await s.asWorker(
      { action: 'status', task_id: assignment!.task_id },
      { action: 'collect', task_id: assignment!.task_id },
      { action: 'status', agent_id: spawned.agent.id },
      { action: 'list' },
    );
    for (const reply of [status, collect, agentStatus, list]) expect(reply).not.toContain('private job');
    expect(status).toContain('not found');
    expect(collect).toContain('not found');
    expect(agentStatus).toContain('not found');
    expect(list).not.toContain(spawned.agent.id);
  });

  test('a stop it asks about another\'s finished task does not tell it the task, the role, or that the agent exists', async () => {
    const s = setup();
    const { spawned, assignment } = await startPersistentAgent(s.deps, { specialist: 'info', task: 'the owner\'s private job' });
    await s.settled();
    const [stop] = await s.asWorker({ action: 'terminate', agent_id: spawned.agent.id, task_id: assignment!.task_id });
    expect(stop).toContain('nothing was stopped');
    expect(stop).not.toContain('private job');
    expect(stop).not.toContain('INFO');
    // And nothing was stopped.
    expect(s.orch.getAgent(spawned.agent.id)).toBeDefined();
  });

  test('every stop refusal reads the same whether the agent exists or not, and a stop names nothing', async () => {
    const s = setup();
    const { spawned, assignment } = await startPersistentAgent(s.deps, { specialist: 'info', task: 'the owner\'s private job' });
    await s.settled();
    // An agent that is not a managed one (the worker's sibling, started with spawnSubAgent).
    const plain = s.orch.spawnSubAgent(s.primary.id, INFO);
    const id = spawned.agent.id;
    const replies = await s.asWorker(
      { action: 'terminate', agent_id: 'no-such-agent', task_id: assignment!.task_id },
      { action: 'terminate', agent_id: plain.id },
      { action: 'terminate', agent_id: id, task_id: 'no-such-task' },
      { action: 'terminate', agent_id: id, task_id: assignment!.task_id },
    );
    const strip = (reply: string, agentId: string) => reply.replace(agentId, '<id>');
    const [missing, notManaged, wrongTask, finished] = [strip(replies[0]!, 'no-such-agent'), strip(replies[1]!, plain.id),
      strip(replies[2]!, id), strip(replies[3]!, id)];
    expect(missing).toContain('nothing was stopped');
    expect(notManaged).toBe(missing);
    expect(wrongTask).toBe(missing);
    expect(finished).toBe(missing);
    expect(s.orch.getAgent(id)).toBeDefined();
    // And a stop that goes ahead does not name the role it stopped.
    const [stopped] = await s.asWorker({ action: 'terminate', agent_id: id });
    expect(s.orch.getAgent(id)).toBeUndefined();
    expect(stopped).toContain('terminated');
    expect(stopped).not.toContain('INFO');
  });

  test('it still reads the agents it started itself', async () => {
    const s = setup();
    const [spawnReply] = await s.asWorker({ action: 'spawn', specialist: 'info', task: 'my own job' });
    const agentId = (JSON.parse(spawnReply!.slice(spawnReply!.indexOf('{'), spawnReply!.lastIndexOf('}') + 1)) as { agent_id: string }).agent_id;
    await s.settled();
    const taskId = s.taskManager.listTasks().find((t) => t.agentId === agentId)!.id;
    const [collect, list] = await s.asWorker({ action: 'collect', task_id: taskId }, { action: 'list' });
    expect(collect).toContain('result of my own job');
    expect(list).toContain(agentId);
  });

  test('the primary and the dashboard still see every agent and task', async () => {
    const s = setup();
    const { spawned } = await startPersistentAgent(s.deps, { specialist: 'info', task: 'the owner\'s private job' });
    await s.settled();
    const all = listPersistentAgents(s.deps);
    expect(all.agents.map((a) => a.agent_id)).toContain(spawned.agent.id);
    expect(all.tasks.map((t) => t.task)).toContain('the owner\'s private job');
  });
});

describe('a managed agent\'s registry goes with the agent (#1044)', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  test('reaped directly, or as part of its parent', () => {
    const s = setup();
    const one = spawnPersistentAgent(s.deps, 'info').agent;
    const two = spawnPersistentAgent(s.deps, 'info').agent;
    expect(hasManagedRegistry(one.id)).toBe(true);
    s.orch.reapAgent(one.id);
    expect(hasManagedRegistry(one.id)).toBe(false);
    // The agent service's stop reaps the primary, and every agent with it.
    s.orch.reapAgent(s.primary.id);
    expect(hasManagedRegistry(two.id)).toBe(false);
  });
});
