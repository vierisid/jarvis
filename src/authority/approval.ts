/**
 * Approval Manager — Handles the lifecycle of approval requests.
 *
 * Persists to SQLite: pending -> approved -> claimed -> executed (with a receipt).
 *
 * A decision and its execution are separate writes, so a crash can fall
 * between them. The claim marks that one executor took the approved request
 * before dispatch; the receipt records what that execution produced. After a
 * restart, an approved row without a receipt is reconciled as `not_started`
 * (never claimed: nothing happened) or `unknown` (claimed by a previous
 * process: the effect may have happened). Neither is replayed; both wait for
 * the user, who can run a not-started row once or close either.
 */

import { getDb, generateId } from '../vault/schema.ts';
import type { ActionCategory } from '../roles/authority.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed';
export type ApprovalUrgency = 'urgent' | 'normal';

/**
 * How an approved request gets executed:
 *  - 'inline': the authority gate that created it is blocked on
 *    waitForResolution and executes the tool itself, so the result flows
 *    back through the task envelope to the conversation tier. Resolution
 *    endpoints must only flip the status, never execute.
 *  - 'deferred': nobody is waiting; whichever endpoint approves it runs
 *    the tool via DeferredExecutor (the legacy fire-and-forget path).
 *  - 'workflow': a durable workflow effect owns dispatch and continuation.
 *    Approval endpoints resolve only; the workflow scheduler resumes the run.
 */
export type ApprovalExecutionMode = 'inline' | 'deferred' | 'workflow';

/** What a receipt says the execution produced. */
export type ApprovalReceiptOutcome = 'committed' | 'failed' | 'blocked';

/**
 * What happened to an approved request's execution:
 *  - committed, failed, blocked: a receipt; the row is `executed`.
 *  - not_started: reconciled after a restart. Approved, never claimed, so no
 *    effect happened. The user may run it once or close it.
 *  - unknown: reconciled after a restart. Claimed by a previous process that
 *    never wrote a receipt, so the effect may have happened. Never run again
 *    automatically; the user checks what happened and closes it.
 *  - closed: the user resolved a not_started or unknown row without running it.
 */
export type ApprovalExecutionOutcome = ApprovalReceiptOutcome | 'not_started' | 'unknown' | 'closed';

export type ApprovalRequest = {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  tool_arguments: string; // JSON string
  action_category: ActionCategory;
  urgency: ApprovalUrgency;
  reason: string;
  context: string;
  status: ApprovalStatus;
  execution_mode: ApprovalExecutionMode;
  decided_at: number | null;
  decided_by: string | null;
  executed_at: number | null;
  execution_result: string | null;
  created_at: number;
  /** Set when an executor took the approved request; null until then. */
  execution_claimed_at?: number | null;
  execution_claimed_by?: string | null;
  /** The daemon process that claimed it; a different boot never wrote our receipt. */
  execution_boot_id?: string | null;
  execution_outcome?: ApprovalExecutionOutcome | null;
  resolved_at?: number | null;
  resolved_by?: string | null;
  resolution_note?: string | null;
};

/**
 * One word for where a request stands, for lists and cards. Pending rows
 * await a decision; approved rows are awaiting execution, in flight, or
 * reconciled; executed rows carry their receipt's outcome.
 */
export type ApprovalExecutionState =
  | 'pending' | 'denied' | 'expired'
  | 'awaiting_execution' | 'in_flight'
  | ApprovalExecutionOutcome;

export function executionState(request: ApprovalRequest): ApprovalExecutionState {
  if (request.status === 'executed') return request.execution_outcome ?? 'committed';
  if (request.status !== 'approved') return request.status;
  if (request.execution_outcome) return request.execution_outcome;
  return request.execution_claimed_at ? 'in_flight' : 'awaiting_execution';
}

const UNRESOLVED = `status = 'approved' AND execution_outcome IN ('not_started', 'unknown')`;

/**
 * One id per process, so every manager in this daemon agrees on which claims
 * are its own. Tests pass an explicit id to stand in for a previous boot.
 */
const PROCESS_BOOT_ID = generateId();

export class ApprovalManager {
  /** Identity of this process. A claim carrying another boot id never got its receipt from us. */
  readonly bootId: string;

  constructor(bootId: string = PROCESS_BOOT_ID) {
    this.bootId = bootId;
  }

  /**
   * Create a new approval request and persist to DB.
   */
  createRequest(params: {
    agentId: string;
    agentName: string;
    toolName: string;
    toolArguments: Record<string, unknown>;
    actionCategory: ActionCategory;
    urgency: ApprovalUrgency;
    reason: string;
    context: string;
    executionMode?: ApprovalExecutionMode;
  }): ApprovalRequest {
    const db = getDb();
    const id = generateId();
    const now = Date.now();
    const toolArgs = JSON.stringify(params.toolArguments);
    const executionMode = params.executionMode ?? 'deferred';

    db.run(
      `INSERT INTO approval_requests (id, agent_id, agent_name, tool_name, tool_arguments, action_category, urgency, reason, context, status, execution_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, params.agentId, params.agentName, params.toolName, toolArgs, params.actionCategory, params.urgency, params.reason, params.context, executionMode, now]
    );

    return {
      id,
      agent_id: params.agentId,
      agent_name: params.agentName,
      tool_name: params.toolName,
      tool_arguments: toolArgs,
      action_category: params.actionCategory as ActionCategory,
      urgency: params.urgency,
      reason: params.reason,
      context: params.context,
      status: 'pending',
      execution_mode: executionMode,
      decided_at: null,
      decided_by: null,
      executed_at: null,
      execution_result: null,
      created_at: now,
      execution_claimed_at: null,
      execution_claimed_by: null,
      execution_boot_id: null,
      execution_outcome: null,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    };
  }

  /**
   * Get a request by ID.
   */
  getRequest(requestId: string): ApprovalRequest | null {
    const db = getDb();
    const row = db.query('SELECT * FROM approval_requests WHERE id = ?').get(requestId) as ApprovalRequest | null;
    return row;
  }

  /**
   * Find a request by short ID prefix (for Telegram/Discord commands).
   */
  findByShortId(shortId: string): ApprovalRequest | null {
    const db = getDb();
    const row = db.query('SELECT * FROM approval_requests WHERE id LIKE ? AND status = ?')
      .get(`${shortId}%`, 'pending') as ApprovalRequest | null;
    return row;
  }

  /**
   * Approve a pending request.
   */
  approve(requestId: string, decidedBy: string): ApprovalRequest | null {
    const db = getDb();
    const now = Date.now();

    const result = db.run(
      `UPDATE approval_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`,
      [now, decidedBy, requestId]
    );

    if (result.changes === 0) return null;
    return this.getRequest(requestId);
  }

  /**
   * Deny a pending request.
   */
  deny(requestId: string, decidedBy: string): ApprovalRequest | null {
    const db = getDb();
    const now = Date.now();

    const result = db.run(
      `UPDATE approval_requests SET status = 'denied', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`,
      [now, decidedBy, requestId]
    );

    if (result.changes === 0) return null;
    return this.getRequest(requestId);
  }

  /**
   * Hand an inline request over to the deferred path (used when the
   * blocked authority gate times out waiting for the user). Conditional
   * on the request still being pending+inline so it cannot race the
   * approve endpoints into a double execution: if the user approved
   * first, this returns false and the (still-blocked) gate executes;
   * if the demotion lands first, the approve endpoints see 'deferred'
   * and execute via DeferredExecutor as before.
   */
  demoteToDeferred(requestId: string): boolean {
    const db = getDb();
    const result = db.run(
      `UPDATE approval_requests SET execution_mode = 'deferred' WHERE id = ? AND status = 'pending' AND execution_mode = 'inline'`,
      [requestId]
    );
    return result.changes > 0;
  }

  /**
   * Startup sweep: demote ALL pending inline requests to deferred. An
   * inline request only makes sense while the authority gate that created
   * it is blocked waiting on it; after a daemon restart no such gate
   * exists, so approving one would flip the status without anything
   * executing the tool. Returns the number of demoted requests.
   */
  demoteAllPendingInline(): number {
    const db = getDb();
    const result = db.run(
      `UPDATE approval_requests SET execution_mode = 'deferred' WHERE status = 'pending' AND execution_mode = 'inline'`
    );
    return result.changes;
  }

  /**
   * Take an approved request for execution. Exactly one caller wins: the
   * update is conditional on the row being approved and unclaimed, or
   * reconciled as not started, which is the user's explicit second run.
   * Returns false when another executor holds it, when it was reconciled as
   * `unknown` (its effect may already have happened), or when it was closed.
   */
  claimExecution(requestId: string, claimedBy: string): boolean {
    const db = getDb();
    const result = db.run(
      `UPDATE approval_requests
         SET execution_claimed_at = ?, execution_claimed_by = ?, execution_boot_id = ?, execution_outcome = NULL
       WHERE id = ? AND status = 'approved' AND execution_claimed_at IS NULL
         AND (execution_outcome IS NULL OR execution_outcome = 'not_started')`,
      [Date.now(), claimedBy, this.bootId, requestId]
    );
    return result.changes > 0;
  }

  /**
   * Record the receipt of an approved request's execution. `committed` is
   * the tool returning, `failed` the tool throwing, `blocked` a refusal under
   * emergency state. Only an approved row can receive a receipt; returns
   * whether one was written.
   */
  markExecuted(requestId: string, executionResult: string, outcome: ApprovalReceiptOutcome = 'committed'): boolean {
    const db = getDb();
    const now = Date.now();

    const result = db.run(
      `UPDATE approval_requests SET status = 'executed', executed_at = ?, execution_result = ?, execution_outcome = ?
       WHERE id = ? AND status = 'approved'`,
      [now, executionResult, outcome, requestId]
    );
    return result.changes > 0;
  }

  /**
   * Startup reconciliation, run once before anything can execute. Pending
   * inline rows lose their gate on restart and go to the deferred path. An
   * approved row with a claim from another process and no receipt is
   * `unknown`: the effect may have happened. An approved row never claimed
   * is `not_started`: nothing happened. Neither is run here. Workflow-owned
   * rows are left alone; their truth is the workflow effect record.
   */
  reconcileAfterRestart(): { demotedInline: number; notStarted: number; interrupted: number } {
    const db = getDb();
    const demotedInline = this.demoteAllPendingInline();
    const interrupted = db.run(
      `UPDATE approval_requests SET execution_outcome = 'unknown'
       WHERE status = 'approved' AND execution_claimed_at IS NOT NULL AND execution_outcome IS NULL
         AND execution_mode != 'workflow' AND (execution_boot_id IS NULL OR execution_boot_id != ?)`,
      [this.bootId]
    ).changes;
    const notStarted = db.run(
      `UPDATE approval_requests SET execution_outcome = 'not_started'
       WHERE status = 'approved' AND execution_claimed_at IS NULL AND execution_outcome IS NULL
         AND execution_mode != 'workflow'`
    ).changes;
    return { demotedInline, notStarted, interrupted };
  }

  /**
   * Approved rows that need the user: reconciled as not started or unknown
   * and not yet closed. These are absent from `getPending()` on purpose;
   * approving them again is impossible and running them is a separate,
   * explicit decision.
   */
  getUnresolved(): ApprovalRequest[] {
    const db = getDb();
    return db.query(
      `SELECT * FROM approval_requests WHERE ${UNRESOLVED} ORDER BY decided_at DESC, created_at DESC`
    ).all() as ApprovalRequest[];
  }

  /**
   * Resolve an unresolved row without running it. The status stays
   * `approved`, which is what the user decided; the outcome says the
   * execution was closed and by whom.
   */
  closeUnresolved(requestId: string, resolvedBy: string, note?: string): boolean {
    const db = getDb();
    const result = db.run(
      `UPDATE approval_requests SET execution_outcome = 'closed', resolved_at = ?, resolved_by = ?, resolution_note = ?
       WHERE id = ? AND ${UNRESOLVED}`,
      [Date.now(), resolvedBy, note ?? null, requestId]
    );
    return result.changes > 0;
  }

  /**
   * Get all pending requests.
   */
  getPending(): ApprovalRequest[] {
    const db = getDb();
    return db.query(
      `SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at DESC`
    ).all() as ApprovalRequest[];
  }

  /**
   * Get approval history with optional filters.
   */
  getHistory(opts?: {
    limit?: number;
    action?: ActionCategory;
    agentId?: string;
    status?: ApprovalStatus;
  }): ApprovalRequest[] {
    const db = getDb();
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (opts?.action) {
      conditions.push('action_category = ?');
      values.push(opts.action);
    }
    if (opts?.agentId) {
      conditions.push('agent_id = ?');
      values.push(opts.agentId);
    }
    if (opts?.status) {
      conditions.push('status = ?');
      values.push(opts.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;

    return db.query(
      `SELECT * FROM approval_requests ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...[...values, limit] as any[]) as ApprovalRequest[];
  }

  /**
   * Expire old pending requests.
   */
  expireOld(maxAgeMs: number): number {
    const db = getDb();
    const cutoff = Date.now() - maxAgeMs;

    const result = db.run(
      `UPDATE approval_requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?`,
      [cutoff]
    );
    return result.changes;
  }

  /**
   * Block until a pending request resolves (approved / denied / expired / executed),
   * or until the timeout fires or the optional signal aborts — whichever comes
   * first. Polling-based so it stays robust across the approve/deny paths
   * (REST endpoint, channel handler, etc.) without needing to instrument every
   * resolution site with event emission.
   *
   * Returns the latest request state. If the request is missing, throws.
   * If the timeout fires or the signal aborts, returns the still-pending
   * request — callers should treat `status === 'pending'` as a timeout/abort
   * and respond accordingly.
   */
  async waitForResolution(
    requestId: string,
    opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<ApprovalRequest> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000; // 5 min default
    const pollMs = opts.pollMs ?? 250;
    const start = Date.now();

    while (true) {
      const current = this.getRequest(requestId);
      if (!current) throw new Error(`Approval request ${requestId} not found`);
      if (current.status !== 'pending') return current;

      if (opts.signal?.aborted) return current;
      if (Date.now() - start >= timeoutMs) return current;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
