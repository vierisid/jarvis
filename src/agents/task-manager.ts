/**
 * Agent Task Manager — Background Async Task Runner
 *
 * Manages sub-agent tasks as background Promises. When a task is launched,
 * runSubAgent() fires without blocking — the caller gets a task ID and can
 * check status / collect results later.
 */

import { runSubAgent, type SubAgentResult, type ProgressCallback } from './sub-agent-runner.ts';
import type { AgentInstance } from './agent.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';

export type AsyncTaskStatus = 'running' | 'completed' | 'failed';

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
};

export type LaunchOptions = {
  agent: AgentInstance;
  task: string;
  context: string;
  llmManager: LLMManager;
  toolRegistry: ToolRegistry;
  onProgress?: ProgressCallback;
  onComplete?: (task: AsyncTask) => void;
};

export type TaskLifecycleEvent = 'launch' | 'complete' | 'fail';
export type TaskLifecycleListener = (event: TaskLifecycleEvent, task: AsyncTask) => void;

export class AgentTaskManager {
  private tasks = new Map<string, AsyncTask>();
  private listeners = new Set<TaskLifecycleListener>();

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
    const { agent, task, context, llmManager, toolRegistry, onProgress, onComplete } = opts;

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
    this.emit('launch', asyncTask);

    // Fire runSubAgent without awaiting — runs in background
    runSubAgent({
      agent,
      task,
      context,
      llmManager,
      toolRegistry,
      onProgress,
    }).then((result) => {
      asyncTask.status = 'completed';
      asyncTask.completedAt = Date.now();
      asyncTask.result = result;
      console.log(`[TaskManager] Task ${taskId} completed (${asyncTask.agentName})`);
      this.emit('complete', asyncTask);
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
    });

    return taskId;
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
