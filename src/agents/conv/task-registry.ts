/**
 * TaskRegistry - store of in-flight and recently-completed tasks.
 *
 * The conversation LLM reads from this to build its "in-flight tasks" context
 * block. The dispatcher writes to it as tasks transition through their
 * lifecycle. Older completed tasks are evicted so the registry stays small.
 *
 * Subscriptions: callers can listen for status changes (used by the conv-tier
 * orchestrator to re-invoke the conv LLM when a task completes).
 *
 * Persistence: every create/transition is journaled to the `tasks` SQLite
 * table so paused (needs_input) tasks survive daemon restarts - the user's
 * eventual clarification reply still resumes the saved conversation buffer.
 * The in-memory Map is a cache; on boot, `hydrate()` rebuilds it from the
 * table and reconciles any tasks that were mid-flight at shutdown (running/
 * queued -> failed, since the LLM call doesn't survive the process).
 *
 * A null DB resolver disables persistence (used by unit tests that don't
 * care about durability), so the registry still works in pure in-memory mode.
 */

import type { Database } from 'bun:sqlite';
import type { LLMMessage } from '../../llm/provider.ts';
import type { TaskRecord, TaskRequest, TaskResultEnvelope, TaskStatus } from './task-envelope.ts';
import { newTaskId } from './task-envelope.ts';

type Listener = (record: TaskRecord) => void;
type DbResolver = () => Database | null;

export class TaskRegistry {
  private tasks: Map<string, TaskRecord> = new Map();
  private listeners: Set<Listener> = new Set();
  private readonly maxKeepCompleted: number;
  private resolveDb: DbResolver;

  constructor(opts?: { maxKeepCompleted?: number; db?: DbResolver | Database | null }) {
    // How many completed/failed/cancelled tasks to retain in-memory for the
    // `details_ref` lookup. Older records get evicted from the cache when
    // this is exceeded (DB rows are pruned on the same trigger).
    this.maxKeepCompleted = opts?.maxKeepCompleted ?? 25;
    if (opts?.db === undefined || opts.db === null) {
      this.resolveDb = () => null;
    } else if (typeof opts.db === 'function') {
      this.resolveDb = opts.db;
    } else {
      const db = opts.db;
      this.resolveDb = () => db;
    }
  }

  /**
   * Load any persisted task rows back into the in-memory cache. MUST be
   * called before the registry sees its first read - typically right after
   * AgentService wires it.
   *
   * Reconciliation: tasks that were `running` or `queued` at shutdown are
   * marked `failed` with reason `daemon_restart` because the underlying LLM
   * call cannot resume. `needs_input` tasks survive intact (they're the
   * whole reason this persists). Completed/failed/cancelled records are
   * loaded so recentResults() has continuity across restarts.
   */
  hydrate(): void {
    const db = this.resolveDb();
    if (!db) return;
    let rows: TaskRow[];
    try {
      rows = db
        .query<TaskRow, []>('SELECT * FROM tasks ORDER BY updated_at DESC')
        .all();
    } catch (err) {
      console.warn('[TaskRegistry] hydrate failed, starting empty:', err);
      return;
    }
    const now = Date.now();
    for (const row of rows) {
      const record = rowToRecord(row);
      if (record.status === 'running' || record.status === 'queued') {
        record.status = 'failed';
        record.updatedAt = now;
        record.result = {
          task_id: record.id,
          status: 'failed',
          summary: 'Task was interrupted by a daemon restart and could not be resumed.',
          error: 'daemon_restart',
        };
        this.tasks.set(record.id, record);
        this.persist(record);
      } else {
        this.tasks.set(record.id, record);
      }
    }
    // Trim the in-memory cache to the keep-window - the DB still holds the
    // full history but recentResults() works off the Map.
    this.evictOldCompleted();
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
    this.persist(record);
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
    this.persist(record);
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
   * Save pause state (question + captured conversation buffer). Called by
   * the dispatcher when a task transitions to `needs_input`. Separate from
   * `transition` because the dispatcher mutates these fields directly on the
   * record reference and we want the DB to reflect that.
   */
  recordPauseState(id: string, question: string, pausedConversation: LLMMessage[]): void {
    const record = this.tasks.get(id);
    if (!record) return;
    record.question = question;
    record.pausedConversation = pausedConversation;
    record.updatedAt = Date.now();
    this.persist(record);
  }

  /**
   * Clear pause state (called when resume begins, before the runner is
   * re-invoked, so a subsequent failed resume doesn't replay stale state).
   */
  clearPauseState(id: string): void {
    const record = this.tasks.get(id);
    if (!record) return;
    record.question = undefined;
    record.pausedConversation = undefined;
    record.updatedAt = Date.now();
    this.persist(record);
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

    // Drop oldest completed tasks beyond the keep window from BOTH the cache
    // and the DB. The DB store is bounded by the same window so it doesn't
    // grow without limit; if you later want a longer history, lift the
    // maxKeepCompleted constructor option and the table follows.
    done.sort((a, b) => a.updatedAt - b.updatedAt);
    const overflow = done.length - this.maxKeepCompleted;
    const db = this.resolveDb();
    for (let i = 0; i < overflow; i++) {
      const victimId = done[i]!.id;
      this.tasks.delete(victimId);
      if (db) {
        try { db.run('DELETE FROM tasks WHERE id = ?', [victimId]); }
        catch (err) { console.warn('[TaskRegistry] evict delete failed:', err); }
      }
    }
  }

  /**
   * Mirror a record to the `tasks` table. Best-effort: persistence failures
   * never break the live registry (caller has already mutated the cache).
   */
  private persist(record: TaskRecord): void {
    const db = this.resolveDb();
    if (!db) return;
    try {
      db.run(
        `INSERT INTO tasks (
          id, status, tier, template, intent, original_message, subsystem,
          started_at, updated_at, result_json, question, paused_conversation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          tier = excluded.tier,
          template = excluded.template,
          intent = excluded.intent,
          original_message = excluded.original_message,
          subsystem = excluded.subsystem,
          updated_at = excluded.updated_at,
          result_json = excluded.result_json,
          question = excluded.question,
          paused_conversation = excluded.paused_conversation`,
        [
          record.id,
          record.status,
          record.request.tier,
          record.request.template,
          record.request.intent,
          record.request.original_message ?? null,
          record.subsystem,
          record.startedAt,
          record.updatedAt,
          record.result ? JSON.stringify(record.result) : null,
          record.question ?? null,
          record.pausedConversation ? JSON.stringify(record.pausedConversation) : null,
        ],
      );
    } catch (err) {
      console.warn('[TaskRegistry] persist failed:', err);
    }
  }
}

type TaskRow = {
  id: string;
  status: string;
  tier: string;
  template: string;
  intent: string;
  original_message: string | null;
  subsystem: string;
  started_at: number;
  updated_at: number;
  result_json: string | null;
  question: string | null;
  paused_conversation: string | null;
};

function rowToRecord(row: TaskRow): TaskRecord {
  const record: TaskRecord = {
    id: row.id,
    request: {
      tier: row.tier as TaskRecord['request']['tier'],
      template: row.template as TaskRecord['request']['template'],
      intent: row.intent,
      ...(row.original_message ? { original_message: row.original_message } : {}),
    },
    subsystem: row.subsystem,
    status: row.status as TaskStatus,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
  if (row.result_json) {
    try { record.result = JSON.parse(row.result_json) as TaskResultEnvelope; }
    catch { /* leave undefined; envelope is best-effort */ }
  }
  if (row.question) record.question = row.question;
  if (row.paused_conversation) {
    try { record.pausedConversation = JSON.parse(row.paused_conversation); }
    catch { /* drop unparseable buffer - task becomes effectively unresumable */ }
  }
  return record;
}
