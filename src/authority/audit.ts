/**
 * Audit Trail — Logs every tool execution decision for review.
 */

import { getDb, generateId } from '../vault/schema.ts';
import type { ActionCategory } from '../roles/authority.ts';

export type AuthorityDecisionType = 'allowed' | 'denied' | 'approval_required';

/**
 * The resolution channel for an approval decision. `click` is the
 * dashboard card path; `voice` is the spoken-yes/no path; `system` is for
 * automatic decisions (heartbeat-driven cleanup, expired requests, etc.).
 * `null` is allowed for backward compatibility with rows written before
 * this column existed.
 */
export type ResolutionChannel = 'click' | 'voice' | 'system';

export type AuditEntry = {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  action_category: ActionCategory;
  authority_decision: AuthorityDecisionType;
  approval_id: string | null;
  executed: number; // 0 or 1
  execution_time_ms: number | null;
  created_at: number;
  channel: ResolutionChannel | null;
};

export class AuditTrail {
  /**
   * Log a tool execution decision.
   */
  log(entry: {
    agent_id: string;
    agent_name: string;
    tool_name: string;
    action_category: ActionCategory;
    authority_decision: AuthorityDecisionType;
    approval_id?: string | null;
    executed: boolean;
    execution_time_ms?: number | null;
    /** Resolution channel for forensics. Optional; defaults to null. */
    channel?: ResolutionChannel | null;
  }): AuditEntry {
    const db = getDb();
    const id = generateId();
    const now = Date.now();

    db.run(
      `INSERT INTO audit_trail (id, agent_id, agent_name, tool_name, action_category, authority_decision, approval_id, executed, execution_time_ms, created_at, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.agent_id,
        entry.agent_name,
        entry.tool_name,
        entry.action_category,
        entry.authority_decision,
        entry.approval_id ?? null,
        entry.executed ? 1 : 0,
        entry.execution_time_ms ?? null,
        now,
        entry.channel ?? null,
      ]
    );

    return {
      id,
      agent_id: entry.agent_id,
      agent_name: entry.agent_name,
      tool_name: entry.tool_name,
      action_category: entry.action_category as ActionCategory,
      authority_decision: entry.authority_decision,
      approval_id: entry.approval_id ?? null,
      executed: entry.executed ? 1 : 0,
      execution_time_ms: entry.execution_time_ms ?? null,
      created_at: now,
      channel: entry.channel ?? null,
    };
  }

  /**
   * Query audit entries with filters.
   */
  query(filters?: {
    agentId?: string;
    action?: ActionCategory;
    tool?: string;
    decision?: AuthorityDecisionType;
    since?: number;
    limit?: number;
  }): AuditEntry[] {
    const db = getDb();
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters?.agentId) {
      conditions.push('agent_id = ?');
      values.push(filters.agentId);
    }
    if (filters?.action) {
      conditions.push('action_category = ?');
      values.push(filters.action);
    }
    if (filters?.tool) {
      conditions.push('tool_name = ?');
      values.push(filters.tool);
    }
    if (filters?.decision) {
      conditions.push('authority_decision = ?');
      values.push(filters.decision);
    }
    if (filters?.since) {
      conditions.push('created_at >= ?');
      values.push(filters.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit ?? 100;

    return db.query(
      `SELECT * FROM audit_trail ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...[...values, limit] as any[]) as AuditEntry[];
  }

  /**
   * Get aggregate statistics.
   */
  getStats(since?: number): {
    total: number;
    allowed: number;
    denied: number;
    approvalRequired: number;
    byCategory: Record<string, number>;
  } {
    const db = getDb();
    const sinceClause = since ? `WHERE created_at >= ${since}` : '';

    const totals = db.query(
      `SELECT authority_decision, COUNT(*) as count FROM audit_trail ${sinceClause} GROUP BY authority_decision`
    ).all() as { authority_decision: string; count: number }[];

    const categories = db.query(
      `SELECT action_category, COUNT(*) as count FROM audit_trail ${sinceClause} GROUP BY action_category`
    ).all() as { action_category: string; count: number }[];

    const stats = {
      total: 0,
      allowed: 0,
      denied: 0,
      approvalRequired: 0,
      byCategory: {} as Record<string, number>,
    };

    for (const row of totals) {
      stats.total += row.count;
      if (row.authority_decision === 'allowed') stats.allowed = row.count;
      if (row.authority_decision === 'denied') stats.denied = row.count;
      if (row.authority_decision === 'approval_required') stats.approvalRequired = row.count;
    }

    for (const row of categories) {
      stats.byCategory[row.action_category] = row.count;
    }

    return stats;
  }
}
