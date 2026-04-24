/**
 * Approval Manager — Handles the lifecycle of approval requests.
 *
 * Persists to SQLite: pending → approved/denied → executed
 */

import { getDb, generateId } from '../vault/schema.ts';
import type { ActionCategory } from '../roles/authority.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed';
export type ApprovalUrgency = 'urgent' | 'normal';

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
  decided_at: number | null;
  decided_by: string | null;
  executed_at: number | null;
  execution_result: string | null;
  created_at: number;
};

export class ApprovalManager {
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
  }): ApprovalRequest {
    const db = getDb();
    const id = generateId();
    const now = Date.now();
    const toolArgs = JSON.stringify(params.toolArguments);

    db.run(
      `INSERT INTO approval_requests (id, agent_id, agent_name, tool_name, tool_arguments, action_category, urgency, reason, context, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, params.agentId, params.agentName, params.toolName, toolArgs, params.actionCategory, params.urgency, params.reason, params.context, now]
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
      decided_at: null,
      decided_by: null,
      executed_at: null,
      execution_result: null,
      created_at: now,
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
   * Mark an approved request as executed with its result.
   */
  markExecuted(requestId: string, executionResult: string): void {
    const db = getDb();
    const now = Date.now();

    db.run(
      `UPDATE approval_requests SET status = 'executed', executed_at = ?, execution_result = ? WHERE id = ?`,
      [now, executionResult, requestId]
    );
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
   * or until the timeout fires — whichever comes first. Polling-based so it stays
   * robust across the approve/deny paths (REST endpoint, channel handler, etc.)
   * without needing to instrument every resolution site with event emission.
   *
   * Returns the latest request state. If the request is missing, throws.
   * If the timeout fires, returns the still-pending request — callers should
   * treat `status === 'pending'` as a timeout and respond accordingly.
   */
  async waitForResolution(
    requestId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<ApprovalRequest> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000; // 5 min default
    const pollMs = opts.pollMs ?? 250;
    const start = Date.now();

    while (true) {
      const current = this.getRequest(requestId);
      if (!current) throw new Error(`Approval request ${requestId} not found`);
      if (current.status !== 'pending') return current;

      if (Date.now() - start >= timeoutMs) return current;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
