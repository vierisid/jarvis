/**
 * Manage Agents Tool — Multi-Agent Hierarchy
 *
 * Allows the primary agent to spawn persistent sub-agents, assign them tasks
 * (async), check status, collect results, and terminate them.
 *
 * For quick sync delegation (spawn → run → return → terminate in one call),
 * use delegate_task instead.
 */

import type { AgentOrchestrator } from '../../agents/orchestrator.ts';
import type { LLMManager } from '../../llm/manager.ts';
import type { RoleDefinition } from '../../roles/types.ts';
import type { ToolDefinition, ToolGate } from './registry.ts';
import { forCard } from '../../util/card-text.ts';
import type { AgentTaskManager, AsyncTask } from '../../agents/task-manager.ts';
import { createScopedToolRegistry, type ProgressCallback } from '../../agents/sub-agent-runner.ts';

export type AgentToolDeps = {
  orchestrator: AgentOrchestrator;
  llmManager: LLMManager;
  specialists: Map<string, RoleDefinition>;
  taskManager: AgentTaskManager;
  onProgress?: ProgressCallback;
  /** Fires when an assigned task settles -- success OR failure (the
   *  'done' progress event only fires on the success path). */
  onTaskComplete?: (task: AsyncTask) => void;
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

// Track scoped registries for persistent agents so they can be reused across tasks
const agentRegistries = new Map<string, ReturnType<typeof createScopedToolRegistry>>();

export type PersistentAgentSummary = {
  agent_id: string;
  name: string;
  specialist: string;
  status: string;
  current_task: string | null;
  busy: boolean;
};

/**
 * What the dashboard dialog, the pebble's voice fast path and the tool's own
 * `spawn` ask for: a specialist, and optionally its first task.
 */
export type PersistentAgentRequest = { specialist: string; task?: string; context?: string };

/**
 * The registered call that redoes `request` once approved: what a card raised
 * at the spawn sink runs (#932). One `manage_agents spawn` carrying the task, so
 * approving it starts the agent AND its task, not an idle agent.
 */
function spawnCall(request: PersistentAgentRequest) {
  return {
    toolName: 'manage_agents',
    toolArguments: {
      action: 'spawn',
      specialist: request.specialist,
      ...(request.task ? { task: request.task } : {}),
      ...(request.context ? { context: request.context } : {}),
    },
  };
}

export function spawnPersistentAgent(deps: AgentToolDeps, specialistId: string, request?: PersistentAgentRequest) {
  if (!specialistId) {
    throw new HttpError(400, 'A specialist role is required to spawn an agent.');
  }

  const role = deps.specialists.get(specialistId);
  if (!role) {
    throw new HttpError(400, `Unknown specialist "${specialistId}". Available: ${Array.from(deps.specialists.keys()).join(', ')}`);
  }

  const primary = deps.orchestrator.getPrimary();
  if (!primary) {
    throw new HttpError(503, 'No primary agent exists');
  }

  // Gated at the sink (orchestrator.spawnSubAgent): Pause/Kill, the engine,
  // approval and the audit row. On a decision that needs approval it raises a
  // card for the whole request and throws AgentLifecycleRefusal.
  const agent = deps.orchestrator.spawnSubAgent(primary.id, role, {
    via: spawnCall(request ?? { specialist: specialistId }),
  });
  const scopedRegistry = createScopedToolRegistry(agent.agent.authority.allowed_tools);
  agentRegistries.set(agent.id, scopedRegistry);

  // A persistent agent should start idle until it has a task.
  agent.idle();

  console.log(`[ManageAgents] Spawned ${role.name} (${agent.id}) with ${scopedRegistry.count()} tools`);

  return {
    agent,
    summary: {
      agent_id: agent.id,
      name: role.name,
      specialist: specialistId,
      status: agent.status,
      tools_available: scopedRegistry.count(),
      tool_categories: agent.agent.authority.allowed_tools,
    },
  };
}

/**
 * Spawn a specialist and, when asked, start its first task: the one entry the
 * dashboard spawn dialog, the pebble's voice fast path and `manage_agents
 * spawn` share. Throws AgentLifecycleRefusal when the spawn is refused or is
 * waiting on a card.
 */
export async function startPersistentAgent(deps: AgentToolDeps, request: PersistentAgentRequest) {
  const task = request.task?.trim() || undefined;
  const context = request.context?.trim() || undefined;
  // Refuse BEFORE spawning: a cap hit after it would leave an idle agent
  // behind for a task that never started.
  if (task && !deps.taskManager.canLaunch()) {
    throw new HttpError(429, 'Too many agent tasks are already running. Wait for one to finish.');
  }
  const spawned = spawnPersistentAgent(deps, request.specialist, { specialist: request.specialist, task, context });
  if (!task) return { spawned, assignment: null };
  try {
    return { spawned, assignment: await assignPersistentAgentTask(deps, { agentId: spawned.agent.id, task, context }) };
  } catch (err) {
    // What was asked for (and possibly approved) is the agent AND its task.
    // Half of it -- an idle agent nobody asked for -- is removed rather than
    // left behind (a cap race, or Pause landing between spawn and launch).
    agentRegistries.delete(spawned.agent.id);
    try {
      deps.orchestrator.reapAgent(spawned.agent.id);
    } catch { /* the original error is the one to report */ }
    throw err;
  }
}

export async function assignPersistentAgentTask(
  deps: AgentToolDeps,
  params: { agentId: string; task: string; context?: string }
) {
  const { agentId, task, context = '' } = params;
  if (!agentId) throw new HttpError(400, '"agentId" is required');
  if (!task) throw new HttpError(400, '"task" is required');

  const agent = deps.orchestrator.getAgent(agentId);
  if (!agent) throw new HttpError(404, `Agent "${agentId}" not found. Use list to see active agents.`);

  if (deps.taskManager.isAgentBusy(agentId)) {
    throw new HttpError(409, `Agent "${agent.agent.role.name}" is already running a task.`);
  }
  // The manager enforces the same cap; asking first gives the caller a
  // sentence instead of a stack trace from inside launch().
  if (!deps.taskManager.canLaunch()) {
    throw new HttpError(429, 'Too many agent tasks are already running. Wait for one to finish, then assign this one.');
  }

  const scopedRegistry = agentRegistries.get(agentId);
  if (!scopedRegistry) {
    throw new HttpError(500, `No tool registry for agent "${agentId}". Was it spawned via manage_agents?`);
  }

  deps.onProgress?.({
    type: 'text',
    agentName: agent.agent.role.name,
    agentId,
    data: `[Assigning task to ${agent.agent.role.name}...]`,
  });

  // Same authority engine and effective profile as the parent (see
  // delegate.ts): a background sub-agent is not a way around the gate.
  const taskId = deps.taskManager.launch({
    agent,
    task,
    context,
    llmManager: deps.llmManager,
    toolRegistry: scopedRegistry,
    onProgress: deps.onProgress,
    onComplete: deps.onTaskComplete,
    toolFilterProviders: deps.orchestrator.getToolFilterProviders?.(),
    authority: {
      authorityEngine: deps.orchestrator.getAuthorityEngine() ?? undefined,
      auditTrail: deps.orchestrator.getAuditTrail() ?? undefined,
      emergencyController: deps.orchestrator.getEmergencyController() ?? undefined,
      temporaryGrants: deps.orchestrator.getTemporaryGrants(),
      profile: deps.orchestrator.getEffectiveProfile(),
      taintGating: deps.orchestrator.getTaintGating(),
    },
  });

  console.log(`[ManageAgents] Assigned task ${taskId} to ${agent.agent.role.name}`);

  return {
    task_id: taskId,
    agent_id: agentId,
    agent_name: agent.agent.role.name,
    status: 'running',
    message: `Task assigned to ${agent.agent.role.name}. Use status or collect to check progress.`,
  };
}

export function listPersistentAgents(deps: AgentToolDeps) {
  const allAgents = deps.orchestrator.getAllAgents();
  const primary = deps.orchestrator.getPrimary();
  const subAgents = allAgents.filter(a => a.id !== primary?.id);

  const agents: PersistentAgentSummary[] = subAgents.map(a => ({
    agent_id: a.id,
    name: a.agent.role.name,
    specialist: a.agent.role.id,
    status: a.agent.status,
    current_task: a.agent.current_task,
    busy: deps.taskManager.isAgentBusy(a.id),
  }));

  const tasks = deps.taskManager.listTasks().map(t => {
    // Trim and clip the agent's response so the strip can render an inline
    // preview after completion without flooding the small panel. Strip
    // markdown noise (asterisks, leading list markers) and collapse
    // whitespace so the snippet reads cleanly in a 2-line clamp.
    const rawResponse = t.result?.response ?? '';
    const cleaned = rawResponse
      .replace(/^\s*[-*•]\s+/gm, '')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const result_preview = cleaned ? cleaned.slice(0, 200) : null;
    return {
      task_id: t.id,
      agent_name: t.agentName,
      status: t.status,
      task: t.task.slice(0, 200),
      elapsed_seconds: Math.round(((t.completedAt ?? Date.now()) - t.startedAt) / 1000),
      completed_at: t.completedAt ?? null,
      result_preview,
    };
  });

  return {
    active_agents: agents.length,
    agents,
    tasks_total: tasks.length,
    tasks_running: tasks.filter(t => t.status === 'running').length,
    tasks,
  };
}

export function terminatePersistentAgent(deps: AgentToolDeps, agentId: string, opts: { taskId?: string } = {}) {
  if (!agentId) throw new HttpError(400, '"agentId" is required');

  if (deps.orchestrator.getPrimary()?.id === agentId) {
    throw new HttpError(400, 'Cannot terminate the primary agent.');
  }

  const agent = deps.orchestrator.getAgent(agentId);
  if (!agent) throw new HttpError(404, `Agent "${agentId}" not found`);
  if (!agentRegistries.has(agentId)) {
    throw new HttpError(404, `Agent "${agentId}" is not a persistent managed agent.`);
  }

  const name = agent.agent.role.name;
  const runningTasks = deps.taskManager.listTasks({ status: 'running' }).filter((t) => t.agentId === agentId);
  // A stop asked about a task (the voice "cancel the amber one", or a card
  // raised while one was running) is a stop of THAT task. If it has ended
  // since, the agent may be on a task the person never saw: nothing is stopped.
  if (opts.taskId !== undefined) {
    const pinned = deps.taskManager.getTask(opts.taskId);
    if (!pinned || pinned.agentId !== agentId) {
      throw new HttpError(404, `Task "${opts.taskId}" is not ${name}'s.`);
    }
    if (pinned.status !== 'running') {
      throw new HttpError(409, `${name}'s task "${forCard(pinned.task, 80)}" is no longer running; nothing was stopped.`);
    }
  }
  const taskId = opts.taskId ?? runningTasks[0]?.id;
  // Gated at the sink (orchestrator.terminateAgent, #963): a stop that needs
  // approval raises a card for this call and throws AgentLifecycleRefusal, and
  // the agent and its registry stay as they are until the card is approved.
  // When it goes ahead the agent's running task loop is aborted, not left
  // calling the model behind a removed record.
  deps.orchestrator.terminateAgent(agentId, { via: stopCall(agentId, taskId) });
  agentRegistries.delete(agentId);

  console.log(`[ManageAgents] Terminated ${name} (${agentId})`);

  return {
    terminated: agentId,
    name,
    stopped_tasks: runningTasks.length,
    // "Asked to stop", not "cancelled": a tool call already running finishes
    // first, and the task shows as cancelled once its loop has returned.
    message: runningTasks.length > 0 ? `${name} removed; its running task was asked to stop.` : `${name} terminated.`,
  };
}

/**
 * The registered call that redoes a stop once approved: what its card runs.
 * `taskId` pins the task the stop is about, so a card approved after that task
 * ended cannot stop the agent's next one.
 */
export function stopCall(agentId: string, taskId?: string) {
  return { toolName: 'manage_agents',
    toolArguments: { action: 'terminate', agent_id: agentId, ...(taskId ? { task_id: taskId } : {}) } };
}

/** What a stop card names: the agent's role and the task it would cancel. */
export type AgentLookup = (agentId: string, taskId?: string) => { name: string; task: string | null } | null;

/**
 * The card sentence for the calls that start work (#932 review). A spawn card
 * used to read "Manage agents" while the approved call also started a task the
 * person never saw; a sentence here is what the card shows, and the approval
 * executor refuses a run whose recomputed sentence differs from the approved
 * one. Values quoted with their quotes escaped, the free-text task last.
 */
export function manageAgentsGate(params: Record<string, unknown>, lookup?: AgentLookup): ToolGate | null {
  const quoted = (v: unknown, max?: number) => JSON.stringify(forCard(v, max));
  const task = typeof params.task === 'string' && params.task.trim() ? params.task : null;
  const context = typeof params.context === 'string' && params.context.trim() ? params.context : null;
  const withContext = context ? ` with context ${quoted(context, 300)}` : '';
  if (params.action === 'spawn') {
    const who = `Start a ${forCard(params.specialist, 60) || 'specialist'} background agent`;
    return { actionCategory: 'spawn_agent', intent: task ? `${who}${withContext} on the task ${quoted(task)}` : who };
  }
  if (params.action === 'terminate') {
    // Stopping work is `terminate_agent` (#963), not the spawn_agent the tool
    // maps to statically. It needs level 9; `above_level` turns a shortfall
    // into a card, the same answer the stop sink gives on every other path.
    // Named by role and task, read live: the sentence then changes when the
    // agent or its task does, and the approval executor refuses a card whose
    // sentence changed after it was approved.
    const id = typeof params.agent_id === 'string' ? params.agent_id : '';
    const seen = lookup?.(id, typeof params.task_id === 'string' ? params.task_id : undefined) ?? null;
    const who = seen ? `the ${forCard(seen.name, 60)} background agent` : `background agent ${forCard(id, 60)}`;
    return { actionCategory: 'terminate_agent', confirm: 'above_level',
      intent: seen?.task ? `Stop ${who} and cancel its task ${quoted(seen.task, 300)}` : `Stop ${who}` };
  }
  if (params.action === 'assign' && task) {
    return { actionCategory: 'spawn_agent',
      intent: `Give background agent ${forCard(params.agent_id, 60)}${withContext} the task ${quoted(task)}` };
  }
  return null;
}

export function createManageAgentsTool(deps: AgentToolDeps): ToolDefinition {
  return {
    name: 'manage_agents',
    description: [
      'Manage persistent sub-agents for complex or parallel work.',
      'Use this when you need agents that stay alive across multiple tasks or run in parallel.',
      'For quick one-shot tasks, use delegate_task instead.',
      '',
      'Actions:',
      '  spawn     — Create a persistent specialist agent (returns agent_id); with "task", also start it on that task',
      '  assign    — Send a task to an existing agent (async, returns task_id)',
      '  status    — Check agent or task status',
      '  collect   — Get full result of a completed task',
      '  list      — Show all active agents and tasks',
      '  terminate — Stop an agent: cancels its running task and removes it (may need the user\'s approval)',
      '',
      'Available specialists: ' + Array.from(deps.specialists.keys()).join(', '),
      '',
      'Workflow: spawn → assign → status/collect → terminate',
    ].join('\n'),
    category: 'delegation',
    authorityGate: (params) => manageAgentsGate(params, (agentId, taskId) => {
      const agent = deps.orchestrator.getAgent(agentId);
      if (!agent) return null;
      const task = taskId ? deps.taskManager.getTask(taskId) : deps.taskManager.listTasks({ status: 'running' })
        .find((t) => t.agentId === agentId);
      return { name: agent.agent.role.name, task: task && task.agentId === agentId ? task.task : null };
    }),
    parameters: {
      action: {
        type: 'string',
        description: 'The action: spawn, assign, status, collect, list, terminate',
        required: true,
      },
      specialist: {
        type: 'string',
        description: 'Specialist role ID (required for spawn)',
        required: false,
      },
      agent_id: {
        type: 'string',
        description: 'Agent ID (required for assign, terminate; optional for status)',
        required: false,
      },
      task_id: {
        type: 'string',
        description: 'Task ID (for status, collect; for terminate, stop only if this task is still running)',
        required: false,
      },
      task: {
        type: 'string',
        description: 'Task description (required for assign; optional for spawn, which then starts it)',
        required: false,
      },
      context: {
        type: 'string',
        description: 'Background context for the task (optional for assign and spawn)',
        required: false,
      },
    },
    execute: async (params) => {
      const action = params.action as string;

      switch (action) {
        case 'spawn':
          return await handleSpawn(deps, params);
        case 'assign':
          return handleAssign(deps, params);
        case 'status':
          return handleStatus(deps, params);
        case 'collect':
          return handleCollect(deps, params);
        case 'list':
          return handleList(deps);
        case 'terminate':
          return handleTerminate(deps, params);
        default:
          return `Error: Unknown action "${action}". Use: spawn, assign, status, collect, list, terminate`;
      }
    },
  };
}

async function handleSpawn(deps: AgentToolDeps, params: Record<string, unknown>): Promise<string> {
  try {
    const { spawned, assignment } = await startPersistentAgent(deps, {
      specialist: params.specialist as string,
      task: typeof params.task === 'string' ? params.task : undefined,
      context: typeof params.context === 'string' ? params.context : undefined,
    });
    return JSON.stringify(assignment ? { ...spawned.summary, assignment } : spawned.summary);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleAssign(deps: AgentToolDeps, params: Record<string, unknown>): Promise<string> {
  try {
    return JSON.stringify(await assignPersistentAgentTask(deps, {
      agentId: params.agent_id as string,
      task: params.task as string,
      context: params.context as string | undefined,
    }));
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function handleStatus(deps: AgentToolDeps, params: Record<string, unknown>): string {
  const taskId = params.task_id as string;
  const agentId = params.agent_id as string;

  if (taskId) {
    const task = deps.taskManager.getTask(taskId);
    if (!task) return `Error: Task "${taskId}" not found`;

    const elapsed = task.completedAt
      ? task.completedAt - task.startedAt
      : Date.now() - task.startedAt;

    return JSON.stringify({
      task_id: task.id,
      agent_name: task.agentName,
      status: task.status,
      task: task.task,
      elapsed_ms: elapsed,
      elapsed_seconds: Math.round(elapsed / 1000),
      has_result: task.result !== null,
    });
  }

  if (agentId) {
    const agent = deps.orchestrator.getAgent(agentId);
    if (!agent) return `Error: Agent "${agentId}" not found`;

    const agentTask = deps.taskManager.getAgentTask(agentId);
    return JSON.stringify({
      agent_id: agentId,
      name: agent.agent.role.name,
      status: agent.agent.status,
      current_task: agent.agent.current_task,
      busy: deps.taskManager.isAgentBusy(agentId),
      latest_task: agentTask ? {
        task_id: agentTask.id,
        status: agentTask.status,
        task: agentTask.task,
      } : null,
    });
  }

  // No ID given — return summary
  return handleList(deps);
}

function handleCollect(deps: AgentToolDeps, params: Record<string, unknown>): string {
  const taskId = params.task_id as string;
  if (!taskId) return 'Error: "task_id" is required for collect';

  const task = deps.taskManager.getTask(taskId);
  if (!task) return `Error: Task "${taskId}" not found`;

  if (task.status === 'running') {
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    return JSON.stringify({
      task_id: task.id,
      status: 'running',
      agent_name: task.agentName,
      elapsed_seconds: elapsed,
      message: 'Task is still running. Check back later.',
    });
  }

  const result = task.result!;
  const toolsList = result.toolsUsed.length > 0
    ? result.toolsUsed.join(', ')
    : 'none';

  return JSON.stringify({
    task_id: task.id,
    status: task.status,
    agent_name: task.agentName,
    success: result.success,
    response: result.response,
    tools_used: toolsList,
    tokens_used: result.tokensUsed.input + result.tokensUsed.output,
    elapsed_seconds: Math.round(((task.completedAt ?? Date.now()) - task.startedAt) / 1000),
  });
}

function handleList(deps: AgentToolDeps): string {
  return JSON.stringify(listPersistentAgents(deps));
}

function handleTerminate(deps: AgentToolDeps, params: Record<string, unknown>): string {
  try {
    return JSON.stringify(terminatePersistentAgent(deps, params.agent_id as string,
      typeof params.task_id === 'string' ? { taskId: params.task_id } : {}));
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
