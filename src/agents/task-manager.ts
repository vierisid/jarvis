/**
 * Agent Task Manager — Background Async Task Runner
 *
 * Manages sub-agent tasks as background Promises. When a task is launched,
 * runSubAgent() fires without blocking — the caller gets a task ID and can
 * check status / collect results later.
 */

import { runSubAgent, type SubAgentResult, type ProgressCallback, type RunSubAgentOptions } from './sub-agent-runner.ts';
import type { AgentInstance } from './agent.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import { outsideApprovalScope } from '../authority/approved-action-scope.ts';

export type AsyncTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type AsyncTask = {
  id: string;
  agentId: string;
  agentName: string;
  specialistId: string;
  task: string;
  status: AsyncTaskStatus;
  startedAt: number;
  completedAt: number | null;
  result: SubAgentResult | null;
  /**
   * Concise ambient-display summary of `result.response`, populated by the
   * daemon shortly after completion via a one-shot LLM call. Used by the
   * sub-pebble bubble to show a glance-readable version of long responses.
   * Null until the summary lands (or if summarization failed).
   */
  summary: string | null;
  /**
   * Set when `cancel()` asked the run to stop. The status stays `running`
   * until the loop has actually returned (it may be inside a tool call that
   * cannot be interrupted), then becomes `cancelled`.
   */
  cancelRequested?: string;
};

export type LaunchOptions = {
  agent: AgentInstance;
  task: string;
  context: string;
  llmManager: LLMManager;
  toolRegistry: ToolRegistry;
  onProgress?: ProgressCallback;
  onComplete?: (task: AsyncTask) => void;
  /** Authority gate for the background sub-agent; passed straight to runSubAgent. */
  authority?: Pick<RunSubAgentOptions, 'authorityEngine' | 'auditTrail' | 'emergencyController' | 'temporaryGrants' | 'profile' | 'taintGating'>;
  /** Provider kinds for the tool-relevance eligibility gate; passed straight to runSubAgent. */
  toolFilterProviders?: RunSubAgentOptions['toolFilterProviders'];
};

export type TaskLifecycleEvent = 'launch' | 'complete' | 'fail' | 'cancel';
export type TaskLifecycleListener = (event: TaskLifecycleEvent, task: AsyncTask) => void;

/**
 * How many background agent tasks may run at once. Each is its own sub-agent
 * loop of up to 100 LLM calls, and nothing else bounds how many a turn or the
 * dashboard can start, so an unbounded fan-out is exactly the traffic shape a
 * hosted per-key rate limit exists to stop. Five is well past what a person
 * follows at once.
 */
export const MAX_RUNNING_TASKS = 5;

/** launch() refused because MAX_RUNNING_TASKS are already running. */
export class TaskCapacityError extends Error {
  constructor() {
    super(`${MAX_RUNNING_TASKS} agent tasks are already running. Wait for one to finish.`);
    this.name = 'TaskCapacityError';
  }
}

/** launch() refused because the emergency controller has paused or killed the system. */
export class TaskHaltedError extends Error {
  constructor(readonly state: string) {
    super(`[SYSTEM ${state.toUpperCase()}] No agent task can start while the system is ${state}.`);
    this.name = 'TaskHaltedError';
  }
}

export class AgentTaskManager {
  private tasks = new Map<string, AsyncTask>();
  private listeners = new Set<TaskLifecycleListener>();
  /** One per running task: aborting it stops that task's loop (#963). */
  private aborts = new Map<string, AbortController>();

  /** `runSubAgentFn` is a test seam; production gets the real runner. */
  constructor(private readonly runSubAgentFn: typeof runSubAgent = runSubAgent) {}

  /**
   * Tasks currently running. A cancelled task counts until its loop has
   * actually returned: the abort stops the model call in flight and every
   * call after it, but a tool already running finishes first, and the slot is
   * released when the run does (#963).
   */
  runningCount(): number {
    let n = 0;
    for (const task of this.tasks.values()) if (task.status === 'running') n++;
    return n;
  }

  /** Whether launch() would accept another task right now. */
  canLaunch(): boolean {
    return this.runningCount() < MAX_RUNNING_TASKS;
  }

  /**
   * Subscribe to lifecycle events (launch / complete / fail) for every task
   * that flows through this manager. Returns an unsubscribe function.
   * Used by the daemon's ambient UI to spawn / update / close sub-pebble
   * overlays as background work runs.
   */
  subscribeLifecycle(listener: TaskLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TaskLifecycleEvent, task: AsyncTask): void {
    for (const listener of this.listeners) {
      try {
        listener(event, task);
      } catch (err) {
        console.error('[TaskManager] lifecycle listener error:', err);
      }
    }
  }

  /**
   * Launch a sub-agent task in the background. Returns task ID immediately.
   */
  launch(opts: LaunchOptions): string {
    const { agent, task, context, llmManager, toolRegistry, onProgress, onComplete, authority, toolFilterProviders } = opts;
    // The authoritative check, before anything is recorded: callers ask
    // canLaunch() first for a friendly answer, but this is what holds.
    if (!this.canLaunch()) throw new TaskCapacityError();
    // A task is a model loop that spends tokens; under Pause or Kill only its
    // tools would be refused, so it must not start at all (#932).
    const emergency = authority?.emergencyController;
    if (emergency && !emergency.canExecute()) throw new TaskHaltedError(emergency.getState());

    const taskId = crypto.randomUUID();
    const asyncTask: AsyncTask = {
      id: taskId,
      agentId: agent.id,
      agentName: agent.agent.role.name,
      specialistId: agent.agent.role.id,
      task,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
      result: null,
      summary: null,
    };

    this.tasks.set(taskId, asyncTask);
    const abort = new AbortController();
    this.aborts.set(taskId, abort);
    this.emit('launch', asyncTask);

    // Fire runSubAgent without awaiting — runs in background. Outside any
    // approval scope, completion handlers included: an approved `manage_agents
    // spawn` starts its task from inside the approval, and nothing the task
    // runs must inherit it (#932).
    outsideApprovalScope(() => this.runSubAgentFn({
      agent,
      task,
      context,
      llmManager,
      toolRegistry,
      onProgress,
      toolFilterProviders,
      ...(authority ?? {}),
      signal: abort.signal,
    }).then((result) => {
      this.aborts.delete(taskId);
      asyncTask.completedAt = Date.now();
      // A cancel that landed after the loop had already returned its answer
      // stopped nothing: the run completed, and its result stands.
      if (asyncTask.cancelRequested !== undefined && result.canceled) {
        asyncTask.status = 'cancelled';
        asyncTask.result = { ...result, success: false, canceled: true,
          response: `Task cancelled: ${asyncTask.cancelRequested}` };
        console.log(`[TaskManager] Task ${taskId} cancelled (${asyncTask.agentName})`);
        this.emit('cancel', asyncTask);
        onComplete?.(asyncTask);
        return;
      }
      asyncTask.status = 'completed';
      asyncTask.result = result;
      console.log(`[TaskManager] Task ${taskId} completed (${asyncTask.agentName})`);
      this.emit('complete', asyncTask);
      onComplete?.(asyncTask);
    }).catch((err) => {
      this.aborts.delete(taskId);
      asyncTask.status = asyncTask.cancelRequested !== undefined ? 'cancelled' : 'failed';
      asyncTask.completedAt = Date.now();
      asyncTask.result = {
        success: false,
        response: `Task failed: ${err instanceof Error ? err.message : String(err)}`,
        toolsUsed: [],
        tokensUsed: { input: 0, output: 0 },
        terminationReason: 'error',
        messages: [],
      };
      console.error(`[TaskManager] Task ${taskId} failed (${asyncTask.agentName}):`, err);
      this.emit(asyncTask.status === 'cancelled' ? 'cancel' : 'fail', asyncTask);
      onComplete?.(asyncTask);
    }));

    return taskId;
  }

  /**
   * Stop a running task (#963): aborts its loop, so the model call in flight
   * is cancelled and no further model call or tool dispatch starts. Returns
   * false when the task is unknown or not running. Not an authority decision:
   * who may stop an agent is decided by `orchestrator.terminateAgent`, which
   * calls this.
   */
  cancel(taskId: string, reason = 'cancelled'): boolean {
    const task = this.tasks.get(taskId);
    const abort = this.aborts.get(taskId);
    if (!task || task.status !== 'running' || !abort) return false;
    if (task.cancelRequested === undefined) task.cancelRequested = reason;
    abort.abort(reason);
    return true;
  }

  /** Cancel every running task of `agentId`; returns how many were asked to stop. */
  cancelAgentTasks(agentId: string, reason = 'cancelled'): number {
    let n = 0;
    for (const task of this.tasks.values()) {
      if (task.agentId === agentId && this.cancel(task.id, reason)) n++;
    }
    return n;
  }

  /**
   * Get a task by its ID.
   */
  getTask(taskId: string): AsyncTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Attach a post-hoc summary to an already-completed task. The daemon
   * fires this after running the task's response through a one-shot LLM
   * summarizer so the sub-pebble bubble can show a digestible version of
   * long outputs.
   */
  setSummary(taskId: string, summary: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.summary = summary;
  }

  /**
   * Find the current/most recent task for an agent.
   */
  getAgentTask(agentId: string): AsyncTask | undefined {
    let latest: AsyncTask | undefined;
    for (const task of this.tasks.values()) {
      if (task.agentId === agentId) {
        if (!latest || task.startedAt > latest.startedAt) {
          latest = task;
        }
      }
    }
    return latest;
  }

  /**
   * Check if an agent is currently running a task.
   */
  isAgentBusy(agentId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.agentId === agentId && task.status === 'running') {
        return true;
      }
    }
    return false;
  }

  /**
   * List all tasks, optionally filtered by status.
   */
  listTasks(filter?: { status?: AsyncTaskStatus }): AsyncTask[] {
    const all = Array.from(this.tasks.values());
    if (filter?.status) {
      return all.filter(t => t.status === filter.status);
    }
    return all;
  }

  /**
   * Remove completed/failed tasks older than maxAge (default 60 min). The
   * longer retention lets the ambient sub-pebble surface late task summaries;
   * the trade-off is more completed records (with result/summary strings) held
   * in the map at steady state.
   */
  cleanup(maxAgeMs = 60 * 60_000): number {
    let removed = 0;
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running' && task.completedAt && now - task.completedAt > maxAgeMs) {
        this.tasks.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
