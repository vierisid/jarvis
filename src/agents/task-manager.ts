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

export class AgentTaskManager {
  private tasks = new Map<string, AsyncTask>();

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
    };

    this.tasks.set(taskId, asyncTask);

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
   * Remove completed/failed tasks older than maxAge (default 10 min).
   */
  cleanup(maxAgeMs = 10 * 60_000): number {
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
