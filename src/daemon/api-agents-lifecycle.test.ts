import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { ApprovalManager, type ApprovalRequest } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { EmergencyController } from '../authority/emergency.ts';
import { AgentTaskManager, MAX_RUNNING_TASKS } from '../agents/task-manager.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { AGENT_CONTEXT_MAX_CHARS, AGENT_TASK_MAX_CHARS, createManageAgentsTool } from '../actions/tools/agents.ts';
import { maxWaitingSpawnCards } from '../agents/lifecycle-gate.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { LLMManager } from '../llm/manager.ts';

/**
 * POST /api/agents, the dashboard spawn dialog -- and, through the room
 * action `agents/spawn_agent`, the voice classifier (#973). It never passes the
 * tool layer, so before #932 an approval-required spawn_agent was ignored here.
 */

type Handler = (req: Request) => Response | Promise<Response>;

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

function role(id: string, tools: string[]): RoleDefinition {
  return {
    id, name: id, description: id, responsibilities: [], autonomous_actions: [], approval_required: [],
    tools, authority_level: 5,
  } as unknown as RoleDefinition;
}

function harness(overrides: AuthorityConfig['overrides'] = [], opts: { llm?: LLMManager } = {}) {
  const orch = new AgentOrchestrator();
  orch.setAuthorityEngine(new AuthorityEngine({
    default_level: 5, governed_categories: [], overrides, context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal',
  }));
  const approvals = new ApprovalManager();
  orch.setApprovalManager(approvals);
  const audit = new AuditTrail();
  orch.setAuditTrail(audit);
  const emergency = new EmergencyController();
  orch.setEmergencyController(emergency);
  const cards: ApprovalRequest[] = [];
  orch.setApprovalCallback((r) => cards.push(r));
  const primary = orch.createPrimary(role('pa', ['delegation']));
  const specialists = new Map([['spec', role('spec', ['browser'])]]);
  let loops = 0;
  // With `opts.llm` the task runs the REAL sub-agent loop on that model.
  const taskManager = opts.llm ? new AgentTaskManager()
    : new AgentTaskManager((() => { loops++; return new Promise(() => {}); }) as never);
  const llm = opts.llm ?? ({} as LLMManager);
  const registry = new ToolRegistry();
  registry.register(createManageAgentsTool({ orchestrator: orch, llmManager: llm, specialists, taskManager }));
  orch.setToolRegistry(registry);
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} } } as JarvisConfig,
    emergencyController: emergency,
    agentService: {
      getTaskManager: () => taskManager,
      getOrchestrator: () => orch,
      getLLMManager: () => llm,
      getSpecialists: () => specialists,
    },
  } as unknown as ApiContext);
  const post = (routes['/api/agents'] as { POST: Handler }).POST;
  const spawn = (body: unknown) => post(new Request('http://localhost/api/agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  const subAgents = () => orch.getAllAgents().filter((a) => a.id !== primary.id);
  const emergencyRoute = (action: 'kill') =>
    (routes[`/api/authority/emergency/${action}`] as { POST: Handler }).POST(new Request(`http://localhost/api/authority/emergency/${action}`, { method: 'POST' }));
  const stop = (id: string) => (routes['/api/agents/:id'] as { DELETE: Handler }).DELETE(
    Object.assign(new Request(`http://localhost/api/agents/${id}`, { method: 'DELETE' }), { params: { id } }));
  return { spawn, stop, registry, audit, cards, approvals, primary, emergency, emergencyRoute, subAgents, taskManager, loops: () => loops };
}

describe('POST /api/agents goes through the spawn sink (#932)', () => {
  it('raises a card and answers 202 when spawn_agent requires approval, spawning nothing', async () => {
    const h = harness([{ action: 'spawn_agent', allowed: true, requires_approval: true }]);
    const res = await h.spawn({ specialist: 'spec', task: 'look into it' });
    expect(res.status).toBe(202);
    const body = await res.json() as { approval_required: boolean; approval_id: string; message: string };
    expect(body.approval_required).toBe(true);
    expect(h.cards.map((c) => c.id)).toEqual([body.approval_id]);
    expect(JSON.parse(h.cards[0]!.tool_arguments)).toMatchObject({ action: 'spawn', specialist: 'spec', task: 'look into it' });
    expect(h.subAgents()).toHaveLength(0);
    expect(h.loops()).toBe(0);
  });

  it('is refused with 409 under emergency Pause', async () => {
    const h = harness();
    h.emergency.pause();
    const res = await h.spawn({ specialist: 'spec', task: 'look into it' });
    expect(res.status).toBe(409);
    expect(h.subAgents()).toHaveLength(0);
    expect(h.loops()).toBe(0);
  });

  it('is refused with 403 on a spawn_agent deny', async () => {
    const h = harness([{ action: 'spawn_agent', allowed: false }]);
    expect((await h.spawn({ specialist: 'spec' })).status).toBe(403);
    expect(h.subAgents()).toHaveLength(0);
  });

  it('still spawns and starts the task when nothing asks for approval', async () => {
    const h = harness();
    const res = await h.spawn({ specialist: 'spec', task: 'look into it' });
    expect(res.status).toBe(201);
    expect(h.subAgents()).toHaveLength(1);
    expect(h.loops()).toBe(1);
    expect(h.cards).toHaveLength(0);
  });
});

describe('the dashboard Kill stops a running background task (#987)', () => {
  it('cancels the task, and its loop makes no model call after Kill', async () => {
    let calls = 0;
    const llm = {
      chatTier: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 1));
        return { content: '', finish_reason: 'tool_use', model: 'm',
          tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: {} }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    } as unknown as LLMManager;
    const h = harness([], { llm });
    const res = await h.spawn({ specialist: 'spec', task: 'look into it' });
    expect(res.status).toBe(201);
    const [task] = h.taskManager.listTasks();
    for (let i = 0; i < 200 && calls < 3; i++) await new Promise((r) => setTimeout(r, 2));
    expect(calls).toBeGreaterThanOrEqual(3);

    const atKill = calls;
    expect((await h.emergencyRoute('kill')).status).toBe(200);
    for (let i = 0; i < 500 && task!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 50));

    // Without the cancel the loop ran on to its 100-call cap with every tool
    // refused, and the task then reported `completed`.
    expect(calls).toBe(atKill);
    expect(task!.status).toBe('cancelled');
    expect(h.taskManager.runningCount()).toBe(0);
  });
});

describe('lifecycle cards are capped per source, and their text is bounded (#989)', () => {
  const needsApproval: AuthorityConfig['overrides'] = [{ action: 'spawn_agent', allowed: true, requires_approval: true }];

  it(`refuses a distinct spawn card past ${maxWaitingSpawnCards()} waiting, raising no card and notifying nobody`, async () => {
    const h = harness(needsApproval);
    const cap = maxWaitingSpawnCards();
    expect(cap).toBe(MAX_RUNNING_TASKS);
    for (let i = 0; i < cap; i++) expect((await h.spawn({ specialist: 'spec', task: `task number ${i}` })).status).toBe(202);
    expect(h.cards).toHaveLength(cap);

    const rowsBefore = h.audit.getStats().total;
    const over = await h.spawn({ specialist: 'spec', task: 'one more, different again' });
    expect(over.status).toBe(429);
    // The refusal is on the record: one row, nothing executed, no card.
    const rows = h.audit.query({ limit: 5 }).filter((r) => r.action_category === 'spawn_agent');
    expect(h.audit.getStats().total).toBe(rowsBefore + 1);
    expect(rows[0]).toMatchObject({ authority_decision: 'denied', approval_id: null, tool_name: 'spawn_agent(spec)' });
    expect(Boolean(rows[0]!.executed)).toBe(false);
    expect(((await over.json()) as { error: string }).error).toContain('already waiting');
    expect(h.cards).toHaveLength(cap);
    expect(h.approvals.getPending()).toHaveLength(cap);
    expect(h.subAgents()).toHaveLength(0);

    // The same request again is the same question: answered with its card, not refused.
    const again = await h.spawn({ specialist: 'spec', task: 'task number 0' });
    expect(again.status).toBe(202);
    expect(((await again.json()) as { approval_id: string }).approval_id).toBe(h.cards[0]!.id);

    // Deciding one frees a place.
    h.approvals.deny(h.cards[1]!.id, 'test');
    expect((await h.spawn({ specialist: 'spec', task: 'now there is room' })).status).toBe(202);
    expect(h.cards).toHaveLength(cap + 1);
  });

  it('counts waiting cards by the source the card names, so a restart does not reset the budget', async () => {
    const h = harness(needsApproval);
    // Cards left by an earlier process: same role name, an id that no longer exists.
    for (let i = 0; i < maxWaitingSpawnCards(); i++) {
      h.approvals.createRequest({ agentId: `old-primary-${i}`, agentName: h.primary.agent.role.name, toolName: 'manage_agents',
        toolArguments: { action: 'spawn', specialist: 'spec', task: `old ${i}` }, actionCategory: 'spawn_agent',
        urgency: 'normal', reason: 'r', context: 'c', executionMode: 'deferred' });
    }
    expect((await h.spawn({ specialist: 'spec', task: 'a new one' })).status).toBe(429);
    expect(h.cards).toHaveLength(0);
  });

  it('does not count a request_approval card under spawn_agent against the budget', async () => {
    const h = harness(needsApproval);
    for (let i = 0; i < maxWaitingSpawnCards(); i++) {
      h.approvals.createRequest({ agentId: h.primary.id, agentName: h.primary.agent.role.name, toolName: 'request_approval',
        toolArguments: { action_category: 'spawn_agent', reason: `asked ${i}` }, actionCategory: 'spawn_agent',
        urgency: 'normal', reason: 'r', context: 'c', executionMode: 'deferred' });
    }
    expect((await h.spawn({ specialist: 'spec', task: 'mine' })).status).toBe(202);
  });

  it('runs exactly what the card shows: characters a card cannot display are removed (#989)', async () => {
    const h = harness(needsApproval);
    // Tag characters spell hidden ASCII ("evil") that no card displays.
    const hidden = [...'evil'].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
    const res = await h.spawn({ specialist: 'spec', task: `tidy my notes${hidden} \u2764\uFE0F`, context: `ctx\u200B${hidden}` });
    expect(res.status).toBe(202);
    const args = JSON.parse(h.cards[0]!.tool_arguments) as { task: string; context: string };
    expect(args.task).toBe('tidy my notes \u2764');
    expect(args.context).toBe('ctx');
  });

  it('never refuses a stop card for a flood of start cards', async () => {
    const h = harness();
    expect((await h.spawn({ specialist: 'spec' })).status).toBe(201);
    const agentId = h.subAgents()[0]!.id;
    for (let i = 0; i < maxWaitingSpawnCards() + 2; i++) {
      h.approvals.createRequest({ agentId: h.primary.id, agentName: h.primary.agent.role.name, toolName: 'manage_agents',
        toolArguments: { action: 'spawn', specialist: 'spec', task: `flood ${i}` }, actionCategory: 'spawn_agent',
        urgency: 'normal', reason: 'r', context: 'c', executionMode: 'deferred' });
    }
    // terminate_agent needs level 9; this primary is 5, so the stop asks.
    const res = await h.stop(agentId);
    expect(res.status).toBe(202);
    expect(h.cards.map((c) => c.action_category)).toEqual(['terminate_agent']);
  });

  it(`rejects a task over ${AGENT_TASK_MAX_CHARS} characters before anything is spawned or carded`, async () => {
    const h = harness(needsApproval);
    const res = await h.spawn({ specialist: 'spec', task: 'x'.repeat(AGENT_TASK_MAX_CHARS + 1) });
    expect(res.status).toBe(400);
    expect(h.cards).toHaveLength(0);
    expect(h.subAgents()).toHaveLength(0);
    expect(h.loops()).toBe(0);
  });

  it('bounds a task given to an existing agent through manage_agents assign too', async () => {
    const h = harness();
    expect((await h.spawn({ specialist: 'spec' })).status).toBe(201);
    const agentId = h.subAgents()[0]!.id;
    const out = await h.registry.get('manage_agents')!.execute({ action: 'assign', agent_id: agentId, task: 'z'.repeat(AGENT_TASK_MAX_CHARS + 1) });
    expect(String(out)).toContain(`the limit is ${AGENT_TASK_MAX_CHARS}`);
    expect(h.loops()).toBe(0);
    expect(String(await h.registry.get('manage_agents')!.execute({ action: 'assign', agent_id: agentId, task: 'fine\u{E0065}\u{E0076}' }))).toContain('task_id');
    expect(h.loops()).toBe(1);
    // The task that runs carries no character a card cannot show.
    expect(h.taskManager.listTasks()[0]!.task).toBe('fine');
  });

  it(`rejects a context over ${AGENT_CONTEXT_MAX_CHARS} characters the same way`, async () => {
    const h = harness(needsApproval);
    const res = await h.spawn({ specialist: 'spec', task: 'short', context: 'y'.repeat(AGENT_CONTEXT_MAX_CHARS + 1) });
    expect(res.status).toBe(400);
    expect(h.cards).toHaveLength(0);
  });

  it('shows a task and context at the limit whole on the card: what is read is what runs', async () => {
    const h = harness(needsApproval);
    const task = `${'t'.repeat(AGENT_TASK_MAX_CHARS - 4)} END`;
    const context = `${'c'.repeat(AGENT_CONTEXT_MAX_CHARS - 4)} FIN`;
    expect((await h.spawn({ specialist: 'spec', task, context })).status).toBe(202);
    const [card] = h.cards;
    expect(JSON.parse(card!.tool_arguments)).toMatchObject({ task, context });
    const intent = (JSON.parse(card!.context) as { intent: string }).intent;
    expect(intent).toContain(`"${task}"`);
    expect(intent).toContain(`"${context}"`);
    expect(intent).not.toContain('...');
  });
});
