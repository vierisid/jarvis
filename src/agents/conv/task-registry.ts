/**
 * TaskRegistry - in-memory store of in-flight and recently-completed tasks.
 *
 * The conversation LLM reads from this to build its "in-flight tasks" context
 * block. The dispatcher writes to it as tasks transition through their
 * lifecycle. Older completed tasks are evicted so the registry stays small.
 *
 * Subscriptions: callers can listen for status changes (used by the conv-tier
 * orchestrator to re-invoke the conv LLM when a task completes).
 */

import type { TaskRecord, TaskRequest, TaskResultEnvelope, TaskStatus } from './task-envelope.ts';
import { newTaskId } from './task-envelope.ts';

type Listener = (record: TaskRecord) => void;

export class TaskRegistry {
  private tasks: Map<string, TaskRecord> = new Map();
  private listeners: Set<Listener> = new Set();
  private readonly maxKeepCompleted: number;

  constructor(opts?: { maxKeepCompleted?: number }) {
    // How many completed/failed/cancelled tasks to retain for the
    // `details_ref` lookup. Older records get evicted when this is exceeded.
    this.maxKeepCompleted = opts?.maxKeepCompleted ?? 25;
  }

  /**
   * Create a fresh task record in `queued` state. Caller should attach an
   * AbortController and transition to `running` when the task tier starts.
   */
  create(request: TaskRequest, subsystem: string): TaskRecord {
    const now = Date.now();
    const record: TaskRecord = {
      id: newTaskId(),
      request,
      subsystem,
      status: 'queued',
      startedAt: now,
      updatedAt: now,
    };
    this.tasks.set(record.id, record);
    this.notify(record);
    return record;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  /** All tasks currently in queued/running/needs_input state. */
  inFlight(): TaskRecord[] {
    return Array.from(this.tasks.values()).filter(t =>
      t.status === 'queued' || t.status === 'running' || t.status === 'needs_input',
    );
  }

  /** Most recently updated completed/failed/cancelled tasks (newest first). */
  recentResults(limit: number = 5): TaskRecord[] {
    const done = Array.from(this.tasks.values()).filter(t =>
      t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
    );
    return done.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  transition(id: string, status: TaskStatus, result?: TaskResultEnvelope): TaskRecord | null {
    const record = this.tasks.get(id);
    if (!record) return null;
    record.status = status;
    record.updatedAt = Date.now();
    if (result) record.result = result;
    this.notify(record);
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.evictOldCompleted();
    }
    return record;
  }

  /**
   * Abort a running task. Resolves true if the task was found and signalled,
   * false otherwise. The actual transition to `cancelled` happens when the
   * task tier's abort listener fires.
   */
  abort(id: string): boolean {
    const record = this.tasks.get(id);
    if (!record) return false;
    if (record.status !== 'running' && record.status !== 'queued' && record.status !== 'needs_input') {
      return false;
    }
    record.abortController?.abort();
    return true;
  }

  setAbortController(id: string, ctrl: AbortController): void {
    const record = this.tasks.get(id);
    if (record) record.abortController = ctrl;
  }

  /**
   * Subscribe to status transitions. Returns an unsubscribe function.
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(record: TaskRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (err) {
        console.warn('[TaskRegistry] Listener threw:', err);
      }
    }
  }

  private evictOldCompleted(): void {
    const done = Array.from(this.tasks.values()).filter(t =>
      t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
    );
    if (done.length <= this.maxKeepCompleted) return;

    // Drop oldest completed tasks beyond the keep window.
    done.sort((a, b) => a.updatedAt - b.updatedAt);
    const overflow = done.length - this.maxKeepCompleted;
    for (let i = 0; i < overflow; i++) {
      this.tasks.delete(done[i]!.id);
    }
  }
}
