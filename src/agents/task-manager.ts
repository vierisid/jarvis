/**
 * Agent Task Manager — Background Async Task Runner
 *
 * Manages sub-agent tasks as background Promises. When a task is launched,
 * runSubAgent() fires without blocking — the caller gets a task ID and can
 * check status / collect results later.
 *
 * ## Safety contract (Phase 0)
 *
 * Every task launched here is authority-gated and audited. Before P0.1 this
 * class called `runSubAgent` with no authority engine, no audit trail and no
 * emergency controller, and `runSubAgent` reads "no engine" as "no gate" —
 * so background agents were the one sub-agent path in the codebase that ran
 * completely ungoverned, while the workflow delegator forwarded authority
 * correctly. The components are pulled from the orchestrator at LAUNCH time
 * (see `AuthoritySource`), not captured at construction, because the daemon
 * wires them into the orchestrator after this class is built.
 *
 * ## Initiator, and what a non-user-initiated agent may do (P0.1)
 *
 * `launch()` requires an explicit `initiator`. The roadmap notes that the
 * concept of a non-user-initiated agent had no representation anywhere; this
 * is it, deliberately kept to one bit rather than a new permission model.
 *
 *   `user`   — a person asked for this, directly or one step removed: they
 *              typed it, spoke it, or the primary agent called `manage_agents`
 *              while answering them. Gated by the authority engine exactly as
 *              before, with no extra ceiling.
 *   `system` — nothing a person said started this: an ambient trigger, a
 *              timer, a passive classifier, an overheard sentence. Gated by
 *              the engine AND capped at `write` impact, so it can read and
 *              mutate local state but can never send email, browse, run a
 *              command, install, pay, delete or terminate — regardless of the
 *              numeric authority level or any per-action override.
 *
 * `system` is the DEFAULT when `initiator` is omitted. That is intentional:
 * a future caller that forgets the field gets the restrictive answer rather
 * than the permissive one.
 */

import {
  runSubAgent,
  type SubAgentResult,
  type ProgressCallback,
  type SubAgentAuthorityContext,
} from './sub-agent-runner.ts';
import type { AgentInstance } from './agent.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import type { Impact } from '../roles/authority.ts';

export type AsyncTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** See the class doc for what each value permits. */
export type TaskInitiator = 'user' | 'system';

/**
 * Impact ceiling applied to a non-user-initiated run. `write` covers
 * read_data, write_data, send_message, spawn_agent and control_app; it
 * excludes access_browser and send_email (external) and everything
 * destructive.
 */
export const SYSTEM_INITIATED_IMPACT_CEILING: Impact = 'write';

/**
 * Anything that can hand over the live authority wiring. The orchestrator
 * implements this; tests can pass a literal.
 */
export type AuthoritySource = {
  getAuthorityContext(): SubAgentAuthorityContext;
};

/** Default cap on tasks running at once across the whole daemon. */
export const DEFAULT_MAX_CONCURRENT_TASKS = 3;

/**
 * Default per-task wall clock. Long enough for a real research run over many
 * tool calls, short enough that a wedged agent doesn't hold a concurrency
 * slot for the rest of the daemon's life.
 */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000;

export type AsyncTask = {
  id: string;
  agentId: string;
  agentName: string;
  specialistId: string;
  task: string;
  status: AsyncTaskStatus;
  /** Who caused this task to exist. See the class doc. */
  initiator: TaskInitiator;
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
};

export type LaunchOptions = {
  agent: AgentInstance;
  task: string;
  context: string;
  llmManager: LLMManager;
  toolRegistry: ToolRegistry;
  onProgress?: ProgressCallback;
  onComplete?: (task: AsyncTask) => void;
  /**
   * Who caused this task. Omitting it means `system` — the restrictive
   * answer. Pass `user` only where a person's request is genuinely upstream.
   */
  initiator?: TaskInitiator;
  /** Override the per-task wall clock for this launch. */
  timeoutMs?: number;
};

/** Thrown by `launch()` when the global concurrency cap is already reached. */
export class TaskCapacityError extends Error {
  constructor(public readonly running: number, public readonly max: number) {
    super(
      `Too many agent tasks already running (${running}/${max}). ` +
      `Wait for one to finish, or cancel one, before starting another.`,
    );
    this.name = 'TaskCapacityError';
  }
}

export type AgentTaskManagerOptions = {
  /**
   * Where to read the authority engine / audit trail / emergency controller
   * from at launch time. Omitting it leaves tasks ungated, which is only
   * appropriate in tests and embedded use — production wires the
   * orchestrator.
   */
  authoritySource?: AuthoritySource;
  maxConcurrent?: number;
  taskTimeoutMs?: number;
};

export type TaskLifecycleEvent = 'launch' | 'complete' | 'fail';
export type TaskLifecycleListener = (event: TaskLifecycleEvent, task: AsyncTask) => void;

export class AgentTaskManager {
  private tasks = new Map<string, AsyncTask>();
  private listeners = new Set<TaskLifecycleListener>();
  private readonly authoritySource: AuthoritySource | undefined;
  private readonly maxConcurrent: number;
  private readonly taskTimeoutMs: number;
  /** Abort controllers for in-flight runs, keyed by task id. */
  private aborts = new Map<string, AbortController>();

  constructor(opts: AgentTaskManagerOptions = {}) {
    this.authoritySource = opts.authoritySource;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    if (!this.authoritySource) {
      console.warn(
        '[TaskManager] constructed without an authority source — background ' +
        'sub-agent tool calls will NOT be gated or audited. This is only safe in tests.',
      );
    }
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

  /** Number of tasks currently running. */
  runningCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === 'running') n++;
    return n;
  }

  /** The configured global cap, for callers that want to report it. */
  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Launch a sub-agent task in the background. Returns task ID immediately.
   *
   * Throws `TaskCapacityError` when the global concurrency cap is already
   * reached. Callers surface that to the user rather than queueing: a
   * background agent the user asked for and never got is better than a
   * silent queue that fires an hour later.
   */
  launch(opts: LaunchOptions): string {
    const { agent, task, context, llmManager, toolRegistry, onProgress, onComplete } = opts;
    const initiator: TaskInitiator = opts.initiator ?? 'system';

    const running = this.runningCount();
    if (running >= this.maxConcurrent) {
      throw new TaskCapacityError(running, this.maxConcurrent);
    }

    const taskId = crypto.randomUUID();
    const asyncTask: AsyncTask = {
      id: taskId,
      agentId: agent.id,
      agentName: agent.agent.role.name,
      specialistId: agent.agent.role.id,
      task,
      status: 'running',
      initiator,
      startedAt: Date.now(),
      completedAt: null,
      result: null,
      summary: null,
    };

    this.tasks.set(taskId, asyncTask);
    this.emit('launch', asyncTask);

    // Wall-clock bound + cancel path share one controller: runSubAgent maps
    // a TimeoutError reason to `timeout` and anything else to `cancelled`.
    const controller = new AbortController();
    this.aborts.set(taskId, controller);
    const timeoutMs = opts.timeoutMs ?? this.taskTimeoutMs;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (controller.signal.aborted) return;
          console.warn(`[TaskManager] Task ${taskId} hit its ${Math.round(timeoutMs / 1000)}s timeout — aborting`);
          controller.abort(new DOMException('Task wall-clock timeout', 'TimeoutError'));
        }, timeoutMs)
      : null;

    // Authority is read HERE, not in the constructor: the daemon wires the
    // engine into the orchestrator after this manager is built.
    const authority = this.authoritySource?.getAuthorityContext();

    // Fire runSubAgent without awaiting — runs in background
    runSubAgent({
      agent,
      task,
      context,
      llmManager,
      toolRegistry,
      onProgress,
      signal: controller.signal,
      ...(initiator === 'system' ? { impactCeiling: SYSTEM_INITIATED_IMPACT_CEILING } : {}),
      ...(authority?.authorityEngine ? { authorityEngine: authority.authorityEngine } : {}),
      ...(authority?.auditTrail ? { auditTrail: authority.auditTrail } : {}),
      ...(authority?.emergencyController ? { emergencyController: authority.emergencyController } : {}),
      // A non-user-initiated agent inherits NO temporary grants. Grants are
      // escalations a parent handed out during a user's turn; letting an
      // ambient agent ride on one would defeat the ceiling above.
      ...(authority && initiator === 'user' ? { temporaryGrants: authority.temporaryGrants } : {}),
    }).then((result) => {
      // Map the runner's termination reason onto the task status the UI and
      // API consume. A run stopped by its budget or wall clock did not do
      // what it was asked, so it reports `failed` -- rendering it as
      // completed would put a green dot on an unfinished job.
      asyncTask.status =
        result.terminationReason === 'cancelled' ? 'cancelled'
        : result.terminationReason === 'timeout' || result.terminationReason === 'token_budget' ? 'failed'
        : 'completed';
      asyncTask.completedAt = Date.now();
      asyncTask.result = result;
      console.log(`[TaskManager] Task ${taskId} ${asyncTask.status} (${asyncTask.agentName}, ${result.terminationReason})`);
      this.emit(asyncTask.status === 'failed' ? 'fail' : 'complete', asyncTask);
      onComplete?.(asyncTask);
    }).catch((err) => {
      asyncTask.status = 'failed';
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
      this.emit('fail', asyncTask);
      onComplete?.(asyncTask);
    }).finally(() => {
      if (timer) clearTimeout(timer);
      this.aborts.delete(taskId);
    });

    return taskId;
  }

  /**
   * Request cancellation of a running task. Returns false if the task is
   * unknown or already settled.
   *
   * Cooperative: the run stops at the next LLM-call or tool-call boundary,
   * so an in-flight tool finishes rather than being torn down half-done.
   * The task's `onComplete` still fires, with
   * `terminationReason: 'cancelled'`.
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    const controller = this.aborts.get(taskId);
    if (!controller) return false;
    console.log(`[TaskManager] Cancelling task ${taskId} (${task.agentName})`);
    controller.abort(new DOMException('Task cancelled', 'AbortError'));
    return true;
  }

  /**
   * Cancel every running task. Used on shutdown and by the emergency stop.
   * Returns the number of tasks signalled.
   */
  cancelAll(): number {
    let n = 0;
    for (const [id, task] of this.tasks) {
      if (task.status === 'running' && this.cancel(id)) n++;
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
