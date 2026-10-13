import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { ApprovalManager, type ApprovalRequest } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { EmergencyController } from '../authority/emergency.ts';
import { AgentTaskManager } from '../agents/task-manager.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { createManageAgentsTool } from '../actions/tools/agents.ts';
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

function harness(overrides: AuthorityConfig['overrides'] = []) {
  const orch = new AgentOrchestrator();
  orch.setAuthorityEngine(new AuthorityEngine({
    default_level: 5, governed_categories: [], overrides, context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal',
  }));
  orch.setApprovalManager(new ApprovalManager());
  orch.setAuditTrail(new AuditTrail());
  const emergency = new EmergencyController();
  orch.setEmergencyController(emergency);
  const cards: ApprovalRequest[] = [];
  orch.setApprovalCallback((r) => cards.push(r));
  const primary = orch.createPrimary(role('pa', ['delegation']));
  const specialists = new Map([['spec', role('spec', ['browser'])]]);
  let loops = 0;
  const taskManager = new AgentTaskManager((() => { loops++; return new Promise(() => {}); }) as never);
  const registry = new ToolRegistry();
  registry.register(createManageAgentsTool({ orchestrator: orch, llmManager: {} as LLMManager, specialists, taskManager }));
  orch.setToolRegistry(registry);
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} } } as JarvisConfig,
    agentService: {
      getTaskManager: () => taskManager,
      getOrchestrator: () => orch,
      getLLMManager: () => ({}) as LLMManager,
      getSpecialists: () => specialists,
    },
  } as unknown as ApiContext);
  const post = (routes['/api/agents'] as { POST: Handler }).POST;
  const spawn = (body: unknown) => post(new Request('http://localhost/api/agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  const subAgents = () => orch.getAllAgents().filter((a) => a.id !== primary.id);
  return { spawn, cards, emergency, subAgents, loops: () => loops };
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
